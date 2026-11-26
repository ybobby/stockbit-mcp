/**
 * Fetching the live market, and holding just enough state to say what changed.
 *
 * `tape.ts` owns the arithmetic and is pure. This file owns the requests and the one piece of
 * mutable state the arithmetic needs — the previous snapshot — and nothing else.
 *
 * ## Which endpoint, and why not the obvious one
 *
 * Measured against the live API during an open session (2026-08-27):
 *
 * | source | freshness |
 * |---|---|
 * | `/order-trade/top-stock` | **live** — 100 symbols, cumulative value/lot/frequency, moving continuously |
 * | order book, symbol volume | **live** |
 * | `/order-trade/running-trade` | **8-10 minutes behind**, refreshed in bursts |
 *
 * So the watcher reads `top-stock`. One request covers the hundred most-active symbols, which is
 * also the only place a large transaction can occur — a stock with no turnover cannot print one.
 * The running-trade tape is deliberately not used for detection; it is available for CONTEXT, and
 * anything built on it has to say how old it is.
 *
 * ## Cost
 *
 * One HTTP request per poll, regardless of how many symbols are being watched. Watching all 100 and
 * watching one cost the same, so the interval can be short without hammering anything.
 */
import { getJson } from "../http/client.js";
import {
  diffSnapshots,
  looksLikeSessionReset,
  samplesFromMovers,
  snapshotFromTopStock,
  widenSnapshot,
  type MarketSnapshot,
  type MoversList,
  type TradeDelta,
} from "./tape.js";

/**
 * The movers lists `--wide` adds, by friendly name and wire value.
 *
 * top-stock is ranked by its own `value` field, so a cheap stock that trades a great many lots for
 * little rupiah rarely makes it. These three lists are where such stocks appear. Each returns at
 * most 50 rows (asking for more still gives 50). `value` is here too because on 2026-11-25 the
 * movers top-value list carried BBCA and BBRI while top-stock did not.
 *
 * Measured 2026-11-26: during the open session all three lists returned EMPTY (`mover_list: []`,
 * with a session label still naming the previous day). They were populated on 2026-11-25 only after
 * the close. So during trading hours `--wide` currently adds nothing; it is kept because it costs
 * three cheap requests and starts working the moment Stockbit fills the lists intraday.
 */
export const WIDE_LISTS: readonly { list: string; wire: string }[] = [
  { list: "value", wire: "MOVER_TYPE_TOP_VALUE" },
  { list: "volume", wire: "MOVER_TYPE_TOP_VOLUME" },
  { list: "frequency", wire: "MOVER_TYPE_TOP_FREQUENCY" },
];

/**
 * Read the movers lists. A list that fails is reported in `warnings` and left out: losing the
 * extra symbols for one poll is better than losing the whole poll, which top-stock still covers.
 */
export async function takeMoversLists(): Promise<{ lists: MoversList[]; warnings: string[] }> {
  const lists: MoversList[] = [];
  const warnings: string[] = [];
  for (const { list, wire } of WIDE_LISTS) {
    try {
      const body = await getJson("marketMover", { params: { mover_type: wire, limit: 50 } });
      const data = (body as { data?: { mover_list?: unknown } } | null)?.data;
      const rows = Array.isArray(data?.mover_list) ? (data.mover_list as unknown[]) : [];
      // An empty list is not an error: measured 2026-11-26, all three lists came back with
      // `mover_list: []` for the whole open session and filled only after the close, so empty is
      // the normal state while the market trades. `moversOnly: 0` on the pass already says it.
      lists.push({ list, rows });
    } catch (err) {
      warnings.push(`movers ${list}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { lists, warnings };
}

/**
 * Find the row array in a Stockbit envelope.
 *
 * The envelopes here have moved before — `{data}`, `{data:{data}}`, and a named key have all been
 * seen across this API — so this searches structurally rather than following a fixed path. A fixed
 * path that breaks returns an empty list, which reads as "the market went quiet".
 */
function findRows(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value.length && typeof value[0] === "object" ? value : [];
  if (value && typeof value === "object" && depth < 5) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = findRows(child, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

/**
 * One live reading of the hundred most-active symbols.
 *
 * Goes through `getJson` rather than minting a token and calling the transport directly. The first
 * version of this did the latter, and it was wrong in a way that only shows up after several minutes
 * of running:
 *
 *   - `ensureFresh` HAS NO FORCE PARAMETER. It returns the cached token while that token is
 *     unexpired, and a 401 is not an expiry. So a token retired by another process — the browser,
 *     the MCP server, the alert daemon, any of which can rotate the family — would 401, and every
 *     subsequent poll would re-send the same dead token and 401 identically, forever.
 *   - `getJson` handles exactly that: 401 once, then `forceRefresh(domain)`, then retry. Only
 *     `forceRefresh` clears the shared access cache, which is what stops another process restoring
 *     the dead token underneath us.
 *
 * It also brings the concurrency limiter, 429/5xx backoff, the request timeout and Cloudflare
 * challenge detection. None of the response caching comes with it — the 5s TTL lives in `cached()`
 * in `core/market.ts`, not here — so consecutive polls still hit the wire, which is the whole point.
 */
export async function takeMarketSnapshot(now = Date.now()): Promise<MarketSnapshot> {
  // Throws StockbitError on a non-2xx, which is what we want. A watcher that swallows an error and
  // reports an empty market is telling the user "nothing is happening" when the truth is
  // "I cannot see".
  const body = await getJson("topStock");
  const rows = findRows(body);
  const snapshot = snapshotFromTopStock(rows, now);
  if (snapshot.symbols.size === 0) {
    throw new Error("top-stock returned no readable rows — the response shape may have changed");
  }
  return snapshot;
}

/** What one poll produced. */
export interface PollResult {
  at: number;
  /** Null on the very first poll: a delta needs two snapshots. */
  deltas: TradeDelta[] | null;
  /** Why there is no delta, when there is none. */
  reason?: "first-poll" | "session-reset";
  symbolsSeen: number;
  /** With `wide`: how many symbols came only from the movers lists. */
  moversOnly?: number;
  /** With `wide`: movers lists that could not be read this poll. */
  warnings?: string[];
}

export interface MarketWatcherOptions {
  /** Also read the movers lists (value, volume, frequency) and watch the symbols they add. */
  wide?: boolean;
}

/**
 * A watcher over the live market.
 *
 * Holds the previous snapshot so consecutive polls can be differenced. Deliberately a class rather
 * than a closure: the interval, the baseline and the reset handling belong together, and a caller
 * that wants two independent watchers should get two independent baselines.
 */
export class MarketWatcher {
  private previous: MarketSnapshot | null = null;

  constructor(private readonly opts: MarketWatcherOptions = {}) {}

  /**
   * Read the market once: top-stock, plus the movers lists with `wide`. No differencing.
   *
   * Since 2026-11-26 deltas are taken from each symbol's order book (see `sampleFromBook` in
   * tape.ts), because top-stock's figures stopped behaving as cumulative counters. What this returns
   * is used only to decide which symbols deserve an order-book request.
   */
  async read(now = Date.now()): Promise<{ snapshot: MarketSnapshot } & Pick<PollResult, "moversOnly" | "warnings">> {
    let snapshot = await takeMarketSnapshot(now);
    if (!this.opts.wide) return { snapshot };
    const { lists, warnings } = await takeMoversLists();
    const before = snapshot.symbols.size;
    snapshot = widenSnapshot(snapshot, samplesFromMovers(lists));
    return { snapshot, moversOnly: snapshot.symbols.size - before, warnings };
  }

  /** Poll once and report what traded since the last poll, differencing top-stock itself. */
  async poll(now = Date.now()): Promise<PollResult> {
    const { snapshot, ...wide } = await this.read(now);
    const previous = this.previous;
    this.previous = snapshot;

    if (!previous) {
      return { at: snapshot.at, deltas: null, reason: "first-poll", symbolsSeen: snapshot.symbols.size, ...wide };
    }

    // A new trading day zeroes every cumulative counter. Differencing across that boundary would
    // report the whole previous session as a single window of activity, so the baseline is replaced
    // and this poll produces nothing. The NEXT poll is the first honest one.
    if (looksLikeSessionReset(previous, snapshot)) {
      return { at: snapshot.at, deltas: null, reason: "session-reset", symbolsSeen: snapshot.symbols.size, ...wide };
    }

    return { at: snapshot.at, deltas: diffSnapshots(previous, snapshot), symbolsSeen: snapshot.symbols.size, ...wide };
  }

  /** Throw the baseline away, so the next poll starts fresh. */
  reset(): void {
    this.previous = null;
  }

  /** Whether a delta is possible on the next poll. */
  get ready(): boolean {
    return this.previous !== null;
  }
}
