/**
 * The live market sampler: what changed between two moments, and how big the prints were.
 *
 * ## Why this exists at all, and why it is not the running-trade tape
 *
 * The obvious way to watch for a big transaction is to read the running-trade tape. Measured against
 * the live API during an open session, that does not work: `/order-trade/running-trade` runs ABOUT
 * EIGHT TO TEN MINUTES BEHIND and refreshes in bursts. Its head sat unchanged for over three minutes
 * while the lag grew second for second, and `cache-control: max-age=1` with `x-cache: Miss from
 * cloudfront` puts the staleness at Stockbit's own origin rather than in a CDN. The project's API
 * notes say the same thing from the other direction: live data flows over WebSocket, and REST is the
 * snapshot. An alert built on that tape would be telling you about a trade that happened ten minutes
 * ago, which for a "big transaction just went through" alert is worse than saying nothing.
 *
 * What IS live over REST, measured the same way:
 *
 *   - `/order-trade/top-stock` — 100 most-active symbols with CUMULATIVE `value`, `lot` and
 *     `frequency`. Over 25 seconds DSSA moved +1,394,039,000 in value across +91 transactions and
 *     BBCA +55,665,000 across +19. One request, one hundred symbols, continuously updating.
 *   - the order book, and a symbol's cumulative volume — both tick continuously.
 *
 * **Superseded for deltas on 2026-11-26.** During that open session top-stock no longer behaved as a
 * cumulative counter (values fell between reads, frequencies went negative), so the whale watch now
 * differences each symbol's ORDER BOOK figures instead and uses top-stock only to rank. See
 * `sampleFromBook`. The arithmetic below is unchanged; only the source of the samples moved.
 *
 * ## The idea this module rests on
 *
 * `frequency` is a COUNT OF TRANSACTIONS. So between two snapshots:
 *
 *     Δvalue / Δfrequency  =  the average rupiah size of the trades that printed in that window
 *
 * A single enormous print is a large Δvalue against a Δfrequency of one or two. Ordinary churn is a
 * large Δvalue spread over hundreds. That ratio is the whole detector, and it needs no tape.
 *
 * It is an AVERAGE, not a single trade, and this module never pretends otherwise: with Δfrequency of
 * 40 it cannot tell one 4-billion print from forty 100-million ones. `confidence` reports that
 * honestly rather than burying it — see `TradeDelta`.
 *
 * ## Everything here is pure
 *
 * Fetching lives in `poller.ts`. This file turns snapshots into deltas and nothing else, so the
 * arithmetic that decides whether a user gets woken up is testable without a market being open.
 */

/** Stockbit returns numbers as `{raw, formatted}`. `raw` is a STRING, and it is the one to use. */
export interface RawNumber {
  raw: string;
  formatted?: string;
}

/**
 * Read a Stockbit numeric field.
 *
 * Every one of these arrives as `{raw: "477705146500", formatted: "477.7B"}`, and the first version
 * of this code read the object with `Number(...)`, got `NaN` for all 100 symbols, and concluded the
 * endpoint was frozen. It was not; the parser was. Hence a named function with a test rather than an
 * inline coercion: the failure it prevents is silent and looks exactly like "no market activity".
 */
export function readRaw(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    // Formatted strings carry separators; raw ones do not. Strip only separators, never digits.
    const n = Number(value.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === "object" && "raw" in value) return readRaw((value as RawNumber).raw);
  return null;
}

/**
 * Where a sample was read from.
 *
 * `top-stock` and the movers lists report DIFFERENT figures for the same symbol at the same moment
 * (measured 2026-11-25 after the close: BMRI 27.2B on top-stock against 524.3B on the movers
 * lists), so a delta is only ever taken between two samples from the same source. Differencing
 * across sources would report the gap between two services as a trade.
 */
export type SampleSource = "top-stock" | "movers" | "book";

/** One symbol at one instant. Cumulative-since-open figures, exactly as the exchange reports them. */
export interface SymbolSample {
  symbol: string;
  /** Absent means `top-stock`, which is what every sample was before the movers lists existed. */
  source?: SampleSource;
  /** For a movers sample: which lists it appeared on (`value`, `volume`, `frequency`). */
  lists?: string[];
  /** Cumulative traded VALUE in rupiah since the session opened. */
  value: number;
  /** Cumulative traded LOTS since the session opened. One IDX lot is 100 shares. */
  lot: number;
  /** Cumulative NUMBER OF TRANSACTIONS since the session opened. The denominator that matters. */
  frequency: number;
  /** Volume-weighted average price for the session, when the source provides it. */
  average: number | null;
}

export interface MarketSnapshot {
  /** When this was taken, epoch ms. */
  at: number;
  symbols: Map<string, SymbolSample>;
}

/** What happened to one symbol between two snapshots. */
export interface TradeDelta {
  symbol: string;
  /** Rupiah that traded in the window. */
  value: number;
  lots: number;
  /** How many transactions printed. Zero means nothing traded. */
  trades: number;
  /** Rupiah per transaction, averaged over the window. Null when nothing traded. */
  averageTradeValue: number | null;
  /** Seconds between the two snapshots. */
  seconds: number;
  /**
   * Cumulative session value for this symbol at the LATER snapshot, rupiah.
   *
   * Carried on the delta because every detector that asks "is this window unusual FOR THIS SYMBOL"
   * needs the symbol's own session baseline, and re-deriving it would mean handing the snapshots
   * around alongside the deltas.
   */
  sessionValue: number;
  /** Cumulative session transaction count at the later snapshot. */
  sessionFrequency: number;
  /**
   * How much weight `averageTradeValue` can carry.
   *
   * `single` — exactly one transaction printed, so the average IS that trade. This is the only case
   *   where "a transaction of X just went through" is literally true.
   * `few` — 2..5 transactions. A large average still means at least one large trade.
   * `averaged` — more than five. A large average means large trades ON AVERAGE and nothing about any
   *   individual one. An alert built on this must say so.
   */
  confidence: "single" | "few" | "averaged" | "none";
  /** Which source both samples came from. Absent means `top-stock`. */
  source?: SampleSource;
  /** For a movers delta: the lists the symbol was on at the later snapshot. */
  lists?: string[];
}

/**
 * Turn Stockbit's `top-stock` rows into a snapshot.
 *
 * Defensive about shape: rows that lack a usable code, value or frequency are skipped rather than
 * defaulted to zero. A zero would read as "this symbol stopped trading", which is a real market
 * event, and inventing one from a parse failure is how a screener cries wolf.
 */
export function snapshotFromTopStock(rows: unknown[], at = Date.now()): MarketSnapshot {
  const symbols = new Map<string, SymbolSample>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const symbol = typeof r.code === "string" ? r.code.trim().toUpperCase() : "";
    const value = readRaw(r.value);
    const lot = readRaw(r.lot);
    const frequency = readRaw(r.frequency);
    if (!symbol || value === null || frequency === null) continue;
    symbols.set(symbol, {
      symbol,
      value,
      lot: lot ?? 0,
      frequency,
      average: readRaw(r.average),
      source: "top-stock",
    });
  }
  return { at, symbols };
}

/** One movers list as fetched: its friendly name and its raw rows. */
export interface MoversList {
  list: string;
  rows: unknown[];
}

/**
 * Turn Stockbit's market-mover rows into samples.
 *
 * Rows carry the code under `stock_detail.code` and cumulative `value`, `volume` and `frequency`
 * for the day. `volume` is in LOTS: checked 2026-11-25 against value ÷ price ÷ 100 on BBCA
 * (1,646,496 vs 1,639,674), GOTO (59,080,490 vs 59,096,154) and TLKM (1,893,542 vs 1,902,312),
 * the small gaps being the day's average price against the last one.
 *
 * A symbol on several lists is one sample with every list recorded. A row without a usable code,
 * value or frequency is skipped, never zero-filled, for the reason `snapshotFromTopStock` gives.
 */
export function samplesFromMovers(lists: MoversList[]): Map<string, SymbolSample> {
  const out = new Map<string, SymbolSample>();
  for (const { list, rows } of lists) {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const detail = (r.stock_detail ?? {}) as Record<string, unknown>;
      const symbol = typeof detail.code === "string" ? detail.code.trim().toUpperCase() : "";
      const value = readRaw(r.value);
      const lot = readRaw(r.volume);
      const frequency = readRaw(r.frequency);
      if (!symbol || value === null || frequency === null || lot === null) continue;
      const seen = out.get(symbol);
      if (seen) {
        if (!seen.lists?.includes(list)) seen.lists = [...(seen.lists ?? []), list];
        continue;
      }
      out.set(symbol, { symbol, value, lot, frequency, average: null, source: "movers", lists: [list] });
    }
  }
  return out;
}

/**
 * Add movers samples to a top-stock snapshot, for the symbols top-stock does not already carry.
 *
 * top-stock wins wherever both have a symbol: it is the source measured live, and keeping one
 * source per symbol is what lets `diffSnapshots` refuse cross-source deltas.
 */
export function widenSnapshot(base: MarketSnapshot, extra: Map<string, SymbolSample>): MarketSnapshot {
  const symbols = new Map(base.symbols);
  for (const [symbol, sample] of extra) if (!symbols.has(symbol)) symbols.set(symbol, sample);
  return { at: base.at, symbols };
}

/**
 * What traded between two snapshots.
 *
 * Only symbols present in BOTH are reported: a symbol that appears in the later snapshot alone has
 * no baseline, and treating its cumulative total as a delta would report an entire session's volume
 * as if it had just happened. `top-stock` is a ranked list, so symbols genuinely do enter and leave
 * it between polls — this is the common case, not an edge one.
 */
export function diffSnapshots(before: MarketSnapshot, after: MarketSnapshot): TradeDelta[] {
  const seconds = Math.max(0, (after.at - before.at) / 1000);
  const out: TradeDelta[] = [];

  for (const [symbol, now] of after.symbols) {
    const then = before.symbols.get(symbol);
    if (!then) continue;
    const d = deltaBetween(then, now, seconds);
    if (d) out.push(d);
  }

  // Biggest rupiah first: that is the order a human wants to read, and it makes "top N" meaningful
  // without a second pass.
  return out.sort((a, b) => b.value - a.value);
}

/**
 * What traded for ONE symbol between two cumulative samples, or null when no honest delta exists.
 *
 * Null when the two samples came from different sources (two services, two sets of figures, see
 * `SampleSource`), and when any counter went backwards. A NEGATIVE delta is not a small trade: on a
 * cumulative counter it means the counter restarted, and clamping it to zero would silently report
 * "nothing traded" on the one reading where the truth is "the baseline is gone".
 */
export function deltaBetween(then: SymbolSample, now: SymbolSample, seconds: number): TradeDelta | null {
  if ((then.source ?? "top-stock") !== (now.source ?? "top-stock")) return null;

  const value = now.value - then.value;
  const trades = now.frequency - then.frequency;
  const lots = now.lot - then.lot;
  if (value < 0 || trades < 0 || lots < 0) return null;

  return {
    symbol: now.symbol,
    value,
    lots,
    trades,
    averageTradeValue: trades > 0 ? value / trades : null,
    seconds,
    sessionValue: now.value,
    sessionFrequency: now.frequency,
    confidence: trades === 0 ? "none" : trades === 1 ? "single" : trades <= 5 ? "few" : "averaged",
    ...(now.source === "movers" ? { source: "movers" as const, lists: now.lists ?? [] } : {}),
  };
}

/**
 * A symbol's cumulative session figures as its own order book reports them.
 *
 * This is the source the whale watch takes deltas from since 2026-11-26. That morning, during an
 * open session, `top-stock` stopped behaving like a cumulative counter: over twenty seconds TLKM's
 * `value` fell from 22.08B to 19.91B, 27 of its 100 rows carried a NEGATIVE `frequency`, and the
 * same symbols' order books reported several times more (BMRI 257.1B on the book against 53.7B on
 * top-stock, BBCA 950.4B against 35.2B). A counter that can fall is not a counter, and differencing
 * it produced thirteen false "new session" resets in one morning. The book's `value`, `frequency`
 * and `volume` only ever rose between reads, so deltas come from here, one request per symbol, and
 * top-stock is kept only to choose WHICH symbols are worth a request.
 *
 * `volumeShares` is in SHARES (see `orderbook.ts`), so it is divided into lots here.
 */
export function sampleFromBook(book: {
  symbol: string;
  value: number;
  frequency: number;
  volumeShares: number;
  average: number | null;
}): SymbolSample {
  return {
    symbol: book.symbol,
    source: "book",
    value: book.value,
    lot: book.volumeShares / 100,
    frequency: book.frequency,
    average: book.average,
  };
}

/** True when the two snapshots straddle a session reset, so their difference is meaningless. */
export function looksLikeSessionReset(before: MarketSnapshot, after: MarketSnapshot): boolean {
  let dropped = 0;
  let compared = 0;
  for (const [symbol, now] of after.symbols) {
    const then = before.symbols.get(symbol);
    if (!then || (then.source ?? "top-stock") !== (now.source ?? "top-stock")) continue;
    compared++;
    if (now.value < then.value) dropped++;
  }
  // One symbol going backwards is a data glitch; most of them going backwards is a new day. The
  // caller needs to tell those apart, because the first should be ignored and the second should
  // reset the baseline.
  return compared > 0 && dropped / compared > 0.5;
}
