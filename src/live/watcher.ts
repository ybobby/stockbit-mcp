/**
 * One pass of the watcher: fetch, detect, filter, report.
 *
 * This is the only file that knows about all the pieces at once. The detectors are pure and the
 * alert engine is pure; this is where they meet the network, and keeping that boundary sharp is what
 * makes everything else testable without a market.
 *
 * ## Cost, and where the numbers come from
 *
 * `top-stock` covers a hundred symbols in ONE request, and is used only to RANK them, once every
 * five minutes, into a queue of 48. Each pass reads 12 order books from that queue: 3 hot slots every
 * pass and 9 that rotate (see `HOT_SLOTS`). Every detector, value-surge included, works from those
 * books: the book carries the symbol's cumulative value, transaction count and volume, so two
 * readings of it give an honest delta. Until 2026-11-26 value-surge differenced top-stock itself;
 * that morning top-stock's figures were seen falling between reads and going negative, which no
 * cumulative counter does. Reading a hundred books every interval against an unofficial API on the
 * user's own account is the thing the research was explicit about not doing, so the per-pass budget
 * stays at twelve.
 */
import { getJson } from "../http/client.js";
import { MarketWatcher, type PollResult } from "./poller.js";
import { deltaBetween, sampleFromBook, type SymbolSample } from "./tape.js";
import { parseOrderBook, type OrderBook } from "./orderbook.js";
import { inScope, type ResolvedScope } from "./scope.js";
import {
  awakening,
  bandApproach,
  bookImbalance,
  floorLocked,
  umaFlag,
  valueSurge,
  wallChange,
  topFiveBidPercent,
  ANOMALY_KINDS,
  DEFAULTS,
  type Signal,
  type SignalKind,
  type Thresholds,
} from "./signals.js";
import { AlertEngine, FATIGUE_DEFAULTS, type EngineResult } from "./alertengine.js";
import { WhaleConfirmer, type Flagged } from "./confirm.js";
import { followUpText, whaleSignal } from "./prints.js";
import type { WatchSpec } from "./promptspec.js";
import type { TradeDelta } from "./tape.js";

/**
 * The longest gap, in seconds, across which two order-book readings of one symbol are differenced.
 *
 * A rotating symbol is read about every five minutes, so seven leaves room for a slow pass. A symbol
 * that drops out of the queue and comes back later would otherwise be differenced against a reading
 * from half an hour ago, reporting thirty minutes of trading as one window. Past this gap the old
 * reading is discarded and the new one becomes the baseline.
 */
export const MAX_BOOK_GAP_SECONDS = 420;

/**
 * How the order-book requests are spent: 12 per pass, as before, but spread over a queue of 48.
 *
 * - `HOT_SLOTS` (3) are read EVERY pass: symbols that just produced an alert, then the top of the
 *   ranking. These keep a one-interval window, so the busiest names lose no sharpness.
 * - `ROTATION_SLOTS` (9) walk the rest of the queue in turn. With the queue re-ranked every
 *   `RANK_EVERY_MS` (5 minutes) at a one-minute interval, 9 × 5 = 45 symbols get one read each.
 *
 * 3 + 45 = `QUEUE_SIZE` (48) symbols per five minutes, against 12 when every pass read the same
 * busiest twelve. The request budget per pass is unchanged at 12 order books, and top-stock (plus
 * the movers lists) is read once per re-rank instead of every pass, so the total actually falls.
 * The cost: a rotating symbol's window is about five minutes, so its value-surge is an average over
 * five minutes and its alert can arrive up to five minutes late. That is why the hot slots exist.
 */
export const HOT_SLOTS = 3;
export const ROTATION_SLOTS = 9;
export const RANK_EVERY_MS = 5 * 60_000;
export const QUEUE_SIZE = HOT_SLOTS + ROTATION_SLOTS * 5;

/** How long a symbol that produced an alert keeps a hot slot. */
export const HOT_AFTER_ALERT_MS = 15 * 60_000;

/** With `wide`: how many places in the 48-symbol queue go to movers-only symbols, by default. */
export const DEFAULT_WIDE_BOOK_SLOTS = 16;

/** What the book-slot chooser needs to know about a symbol. */
export interface BookCandidate {
  symbol: string;
  /** Rupiah, as the ranking source reports it. Ranks the main slots. */
  value: number;
  /** Lots, as the ranking source reports it. Ranks the movers-only slots. */
  lots: number;
  source?: TradeDelta["source"] | SymbolSample["source"];
  lists?: string[];
}

/**
 * Which symbols get an order-book read this pass.
 *
 * Without movers symbols: the busiest by rupiah, up to `max`. With them, up to `wideSlots` go to
 * movers-only symbols ranked by LOTS, because those are the cheap names whose rupiah would never win
 * a slot. Slots one side cannot fill go to the other, so the total stays `max` and the request budget
 * does not grow. A symbol showing neither value nor lots is never read.
 *
 * Ranks on the CURRENT top-stock/movers reading rather than on a delta of it: since 2026-11-26 those
 * figures are not cumulative counters, so a delta of them means nothing. Ranking on the reading
 * keeps the chosen twelve fairly stable from one pass to the next, which is what lets each symbol's
 * order book be differenced against its previous reading.
 */
export function chooseBookCandidates<T extends BookCandidate>(items: T[], max: number, wideSlots: number): T[] {
  const active = items.filter((d) => d.value > 0 || d.lots > 0);
  const main = active.filter((d) => d.source !== "movers").sort((a, b) => b.value - a.value);
  const wide = active.filter((d) => d.source === "movers").sort((a, b) => b.lots - a.lots);
  const wideTake = Math.min(wide.length, Math.max(0, wideSlots), max);
  const mainTake = Math.min(main.length, max - wideTake);
  const extraWide = Math.min(wide.length - wideTake, max - wideTake - mainTake);
  return [...main.slice(0, mainTake), ...wide.slice(0, wideTake + extraWide)];
}

const LIST_ID: Record<string, string> = { value: "nilai", volume: "volume", frequency: "frekuensi" };

/**
 * Say, in both languages, that a signal came from a symbol only the movers lists carry.
 *
 * These are a different population from the top-stock hundred (cheaper, noisier, judged against a
 * lower rupiah floor), so a reader should be able to tell them apart without looking anything up.
 */
export function tagWide(signal: Signal, lists: string[] | undefined): Signal {
  const en = lists?.length ? lists.join("/") : "movers";
  const id = lists?.length ? lists.map((l) => LIST_ID[l] ?? l).join("/") : "movers";
  return {
    ...signal,
    detail: [...signal.detail, `From Stockbit's top ${en} movers list, outside the top-stock hundred.`],
    ...(signal.id
      ? { id: { headline: signal.id.headline, detail: [...signal.id.detail, `Saham ini masuk lewat daftar top ${id} bursa hari ini, di luar 100 saham utama.`] } }
      : {}),
  };
}

export interface PassResult {
  at: number;
  symbolsSeen: number;
  /** Null on the very first pass — a delta needs two snapshots. */
  deltas: TradeDelta[] | null;
  reason?: PollResult["reason"];
  signals: Signal[];
  engine: EngineResult | null;
  booksRead: string[];
  errors: string[];
  /** With `wide`: symbols at the last re-rank that only the movers lists carried. */
  moversOnly?: number;
  /** True on a pass that re-read top-stock and rebuilt the queue. */
  ranked?: boolean;
  /** Follow-up lines for stocks already announced as whales. Sent as they are, outside the engine. */
  followUps?: { symbol: string; text: string }[];
  /** What the confirmation stage did this pass, for the log. */
  whale?: { requests: number; confirmed: number; swept: number; slots: string[]; sweepGap: boolean };
}

/** Per-symbol memory the detectors need between passes. */
interface SymbolMemory {
  lastBook?: OrderBook;
  /** The cumulative figures from `lastBook`, and when they were read (epoch ms). */
  lastSample?: SymbolSample;
  lastAt?: number;
  /** Top-5 bid share of this stock's readings, oldest first, cleared on a gap. */
  imbalances?: number[];
  /** Previous session's total value, for the awakening detector. */
  previousSessionValue?: number;
}

export interface WatcherOptions {
  scope: ResolvedScope;
  spec: WatchSpec;
  thresholds?: Thresholds;
  /** Seconds of trading elapsed when the pass runs. Injected so this stays testable. */
  elapsedSeconds: () => number;
  /** Also watch the symbols on Stockbit's value, volume and frequency movers lists. */
  wide?: boolean;
  /** With `wide`: queue places reserved for movers-only symbols. Default {@link DEFAULT_WIDE_BOOK_SLOTS}. */
  wideBookSlots?: number;
  /**
   * No ceiling on how many alerts go out per pass or per session. The whale watch sets this: its
   * owner chose to keep every alert and tighten the detectors instead. Cooldowns, the quiet periods
   * and the market-wide collapse still apply.
   */
  uncapped?: boolean;
  /**
   * Confirm anomalies on the running-trade tape and sweep the whole market for large prints, so a
   * confirmed whale replaces the anomaly that flagged it. Pass a confirmer to control it (tests do);
   * `true` makes a default one. Off unless asked for, and only when the spec enables `whale`.
   */
  whale?: boolean | WhaleConfirmer;
  /**
   * Symbols to keep in the order-book queue whenever they appear in the ranking at all, ahead of the
   * lower-ranked ones: AlfeySaham's open positions and candidates. Read at every re-rank.
   */
  pinned?: () => string[];
}

/**
 * Which symbols get an order-book read this pass: the hot slots, then the next stretch of the queue.
 *
 * Pure, so the rotation can be tested without a market. `cursor` is where the rotation stopped last
 * time; the returned `cursor` is where it should start next time.
 */
export function pickThisPass<T extends { symbol: string }>(
  queue: T[],
  hot: string[],
  cursor: number,
  hotSlots = HOT_SLOTS,
  rotationSlots = ROTATION_SLOTS,
): { picked: T[]; cursor: number } {
  const bySymbol = new Map(queue.map((q) => [q.symbol, q]));
  const hotPicked: T[] = [];
  for (const symbol of [...hot, ...queue.map((q) => q.symbol)]) {
    if (hotPicked.length >= hotSlots) break;
    const q = bySymbol.get(symbol);
    if (q && !hotPicked.includes(q)) hotPicked.push(q);
  }
  const rest = queue.filter((q) => !hotPicked.includes(q));
  if (!rest.length) return { picked: hotPicked, cursor: 0 };
  const start = cursor % rest.length;
  const take = Math.min(rotationSlots, rest.length);
  const rotating = Array.from({ length: take }, (_, i) => rest[(start + i) % rest.length]);
  return { picked: [...hotPicked, ...rotating], cursor: start + take };
}

export class SignalWatcher {
  private readonly market: MarketWatcher;
  private readonly engine: AlertEngine;
  private readonly confirmer: WhaleConfirmer | null;
  private readonly memory = new Map<string, SymbolMemory>();
  private passes = 0;
  /** The ranked queue, when it was built, and where the rotation has got to. */
  private queue: (BookCandidate & { sample: SymbolSample })[] = [];
  private rankedAt: number | null = null;
  private cursor = 0;
  private symbolsSeen = 0;
  private moversOnly: number | undefined;
  /** Symbols that produced an alert, and when, for the hot slots. */
  private readonly alerted = new Map<string, number>();

  constructor(private readonly opts: WatcherOptions) {
    // The prompt's severity floor has to reach the engine, which is the only thing that enforces it.
    // Compiling it and then not wiring it up is exactly the silent half-obedience the prompt
    // compiler exists to prevent.
    this.engine = new AlertEngine({
      ...FATIGUE_DEFAULTS,
      floor: opts.spec.severityFloor,
      ...(opts.uncapped ? { maxPerInterval: Infinity, maxPerSession: Infinity } : {}),
    });
    this.market = new MarketWatcher({ wide: opts.wide === true });
    this.confirmer =
      opts.whale && opts.spec.kinds.includes("whale")
        ? opts.whale instanceof WhaleConfirmer
          ? opts.whale
          : new WhaleConfirmer()
        : null;
  }

  private enabled(kind: SignalKind): boolean {
    return this.opts.spec.kinds.includes(kind);
  }

  private mem(symbol: string): SymbolMemory {
    let m = this.memory.get(symbol);
    if (!m) {
      m = {};
      this.memory.set(symbol, m);
    }
    return m;
  }

  /** Record what each symbol traded on a previous day, so the awakening detector has a baseline. */
  seedPreviousSession(values: Record<string, number>): void {
    for (const [symbol, value] of Object.entries(values)) {
      this.mem(symbol.toUpperCase()).previousSessionValue = value;
    }
  }

  async pass(now = new Date()): Promise<PassResult> {
    const t = this.opts.thresholds ?? DEFAULTS;
    const at = now.getTime();
    const errors: string[] = [];

    // Re-rank every RANK_EVERY_MS. top-stock (and the movers lists) only RANK; deltas come from each
    // symbol's own order book, whose figures are cumulative. See `sampleFromBook`.
    const ranked = this.rankedAt === null || at - this.rankedAt >= RANK_EVERY_MS;
    if (ranked) {
      const read = await this.market.read(at);
      errors.push(...(read.warnings ?? []));
      const all: (BookCandidate & { sample: SymbolSample })[] = [];
      for (const sample of read.snapshot.symbols.values()) {
        if (!inScope(this.opts.scope, sample.symbol)) continue;
        all.push({
          symbol: sample.symbol,
          value: sample.value,
          lots: sample.lot,
          source: sample.source,
          ...(sample.lists ? { lists: sample.lists } : {}),
          sample,
        });
      }
      this.queue = chooseBookCandidates(all, QUEUE_SIZE, this.opts.wide ? (this.opts.wideBookSlots ?? DEFAULT_WIDE_BOOK_SLOTS) : 0);
      const pinned = new Set((this.opts.pinned?.() ?? []).map((x) => x.toUpperCase()));
      if (pinned.size) {
        // A pinned stock the ranking carries but the queue left out takes the place of the lowest-ranked.
        const inQueue = new Set(this.queue.map((q) => q.symbol));
        const missing = all.filter((a) => pinned.has(a.symbol) && !inQueue.has(a.symbol) && (a.value > 0 || a.lots > 0));
        if (missing.length) {
          const kept = this.queue.filter((q) => pinned.has(q.symbol));
          const others = this.queue.filter((q) => !pinned.has(q.symbol));
          this.queue = [...kept, ...missing, ...others].slice(0, QUEUE_SIZE);
        }
      }
      this.rankedAt = at;
      this.cursor = 0;
      this.symbolsSeen = read.snapshot.symbols.size;
      this.moversOnly = read.moversOnly;
    }
    const wideCount = this.moversOnly !== undefined ? { moversOnly: this.moversOnly } : {};

    for (const [symbol, when] of this.alerted) if (at - when > HOT_AFTER_ALERT_MS) this.alerted.delete(symbol);
    const hot = [...this.alerted.entries()].sort((a, b) => b[1] - a[1]).map(([symbol]) => symbol);
    const { picked: candidates, cursor } = pickThisPass(this.queue, hot, this.cursor);
    this.cursor = cursor;

    const signals: Signal[] = [];
    const deltas: TradeDelta[] = [];
    const booksRead: string[] = [];
    const bookInfo = new Map<string, { price: number; sessionMeanPrint: number | null }>();
    // Every detector reports through this, so a movers-only symbol is labelled whichever one fired.
    const add = (s: Signal | null, c: BookCandidate) => {
      if (s) signals.push(c.source === "movers" ? tagWide(s, c.lists) : s);
    };

    for (const c of candidates) {
      let book: OrderBook | null = null;
      try {
        book = parseOrderBook(await getJson("orderbook", { segments: { symbol: c.symbol } }));
      } catch (err) {
        errors.push(`${c.symbol}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!book) {
        errors.push(`${c.symbol}: order book did not parse`);
        continue;
      }
      booksRead.push(c.symbol);
      const m = this.mem(c.symbol);
      bookInfo.set(c.symbol, { price: book.lastPrice, sessionMeanPrint: book.frequency > 0 ? book.value / book.frequency : null });

      // The delta against this symbol's previous book, when there is an honest one to take.
      const sample = sampleFromBook(book);
      const seconds = m.lastAt !== undefined ? (at - m.lastAt) / 1000 : 0;
      const fresh = m.lastSample !== undefined && seconds > 0 && seconds <= MAX_BOOK_GAP_SECONDS;
      const raw = fresh && m.lastSample ? deltaBetween(m.lastSample, sample, seconds) : null;
      const d: TradeDelta | null = raw
        ? { ...raw, ...(c.source === "movers" ? { source: "movers" as const, lists: c.lists ?? [] } : {}) }
        : null;
      if (d) deltas.push(d);
      // A stale previous book is no baseline for the book detectors either.
      const previousBook = fresh ? m.lastBook : undefined;

      if (d && this.enabled("value-surge") && !(this.opts.spec.minValue !== null && d.value < this.opts.spec.minValue)) {
        // A symbol that has been firing all session gets a harder gate, per the adaptive rule.
        const widen = this.engine.widenFactor(d.symbol);
        const base: Thresholds =
          c.source === "movers" ? { ...t, minWindowValue: t.minWindowValueWide ?? t.minWindowValue } : t;
        const scaled: Thresholds =
          widen === 1 ? base : { ...base, concentration: base.concentration * widen, rate: base.rate * widen };
        add(
          valueSurge(
            { delta: d, sessionValue: d.sessionValue, sessionFrequency: d.sessionFrequency, elapsedSeconds: this.opts.elapsedSeconds() },
            scaled,
          ),
          c,
        );
      }

      if (this.enabled("awakening")) {
        const prev = m.previousSessionValue;
        if (prev !== undefined) add(awakening({ symbol: c.symbol, todayValue: book.value, previousSessionValue: prev }, t), c);
      }

      if (d && this.enabled("band-approach")) {
        add(bandApproach({ book, recentVolumeShares: d.lots * 100, windowSeconds: d.seconds }, t), c);
      }
      if (this.enabled("book-imbalance")) {
        add(bookImbalance({ book, previousPercents: fresh ? (m.imbalances ?? []) : [] }, t), c);
      }
      if (d && previousBook && this.enabled("wall-change")) {
        add(wallChange({ book, previous: previousBook, tradedShares: d.lots * 100 }, t), c);
      }
      if (this.enabled("uma-flag")) add(umaFlag(book), c);
      if (this.enabled("floor-locked")) add(floorLocked(book), c);

      m.lastBook = book;
      m.lastSample = sample;
      m.lastAt = at;
      const share = topFiveBidPercent(book);
      m.imbalances = share === null ? [] : [...(fresh ? (m.imbalances ?? []) : []), share].slice(-5);
    }

    // ---- whale confirmation: anomalies checked against the tape, plus the market-wide sweep ----
    let followUps: PassResult["followUps"];
    let whale: PassResult["whale"];
    if (this.confirmer) {
      const anomalies = signals.filter((sig) => ANOMALY_KINDS.has(sig.kind));
      const flagged: Flagged[] = [];
      for (const symbol of new Set(anomalies.map((sig) => sig.symbol))) {
        const info = bookInfo.get(symbol);
        if (!info) continue;
        const mineSignals = anomalies.filter((sig) => sig.symbol === symbol);
        flagged.push({
          symbol,
          price: info.price,
          sessionMeanPrint: info.sessionMeanPrint,
          windowSeconds: deltas.find((d) => d.symbol === symbol)?.seconds ?? 0,
          strength: Math.max(...mineSignals.map((sig) => sig.surprise)),
        });
      }
      const r = await this.confirmer.run(flagged, now);
      errors.push(...r.errors);
      for (const [symbol, finding] of r.confirmed) {
        const triggers = anomalies.filter((sig) => sig.symbol === symbol).map((sig) => sig.id?.headline ?? sig.headline);
        // The whale REPLACES the anomalies that led to it; the message names them as the trigger.
        for (let i = signals.length - 1; i >= 0; i--) {
          if (signals[i].symbol === symbol && ANOMALY_KINDS.has(signals[i].kind)) signals.splice(i, 1);
        }
        signals.push(whaleSignal(finding, triggers, "confirm"));
      }
      for (const finding of r.swept) signals.push(whaleSignal(finding, [], "sweep"));
      if (r.followUps.length) followUps = r.followUps.map((f) => ({ symbol: f.finding.symbol, text: followUpText(f.finding, f.minutes) }));
      whale = { requests: r.requests, confirmed: r.confirmed.size, swept: r.swept.length, slots: r.slots, sweepGap: r.sweepGap };
    }

    // On the first pass every book read is a fresh baseline, so nothing can be differenced yet.
    const firstPass = this.passes === 0;
    this.passes++;
    const noDelta = deltas.length === 0;

    // The severity floor lives on the engine (set from the spec in the constructor). Only the money
    // floor and the symbol filter have been applied above.
    const engine = this.engine.process(signals, now, this.queue.length || this.symbolsSeen);
    for (const sig of engine.emitted) this.alerted.set(sig.symbol, at);

    return {
      at,
      symbolsSeen: this.symbolsSeen,
      ...(ranked ? { ranked: true } : {}),
      ...(followUps ? { followUps } : {}),
      ...(whale ? { whale } : {}),
      deltas: noDelta ? null : deltas,
      ...(noDelta && firstPass ? { reason: "first-poll" as const } : {}),
      signals,
      engine,
      booksRead,
      errors,
      ...wideCount,
    };
  }

  get alertsSpent(): number {
    return this.engine.spent;
  }

  get overFiring(): SignalKind[] {
    return this.engine.overFiringKinds();
  }
}
