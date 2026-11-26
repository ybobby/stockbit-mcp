/**
 * The whale confirmation stage: from "something unusual" to "a large aggressive print".
 *
 * The screener (`watcher.ts`) finds anomalies in order books. This reads the running-trade tape for
 * the stocks it flags — and, once a minute, for the whole market — and keeps only prints that are
 * large FOR THAT STOCK (`whaleThreshold` in `prints.ts`). A confirmed stock gets a watch slot for a
 * while, so follow-through is reported without re-confirming.
 *
 * ## Request budget, per pass
 *
 * | part | at most |
 * |---|---|
 * | confirmation of flagged stocks | `maxConfirm` (5), one tape page each, two when the window is busy |
 * | watch slots | `maxSlots` (5), one tape page each |
 * | market-wide sweep | `sweepPages` (3) |
 * | average daily value (ADV20) | `maxAdvFetches` (5) stocks, two pages each, cached for the day |
 *
 * Everything goes through `getJson` and the closed route table (`runningTrade`, and `getBars` for the
 * daily history). Nothing here can place, change or cancel an order.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getJson } from "../http/client.js";
import { getBars } from "../core/bars.js";
import { stockbitDir } from "../paths.js";
import { wibTodayIso } from "../core/sessionclock.js";
import {
  judgePrints,
  minimumLotFor,
  parsePrints,
  whaleThreshold,
  WHALE_DEFAULTS,
  type Print,
  type Threshold,
  type WhaleFinding,
  type WhaleThresholds,
} from "./prints.js";

/** The running-trade rows of one response, wherever the envelope put them. */
function rowsOf(body: unknown): unknown[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const v of Object.values(data as Record<string, unknown>)) if (Array.isArray(v)) return v;
  }
  return [];
}

/** Raw rows carry the trade number even when a row is filtered out, and paging needs every one. */
function lowestTradeNumber(rows: unknown[]): number | null {
  let low: number | null = null;
  for (const r of rows) {
    const n = Number(String((r as { trade_number?: unknown })?.trade_number ?? "").replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0 && (low === null || n < low)) low = n;
  }
  return low;
}

export interface TapeRead {
  prints: Print[];
  /** Pages actually requested. */
  pages: number;
  /** True when the page limit ran out before reaching `since`, so some prints may be missing. */
  gap: boolean;
}

/**
 * Newest-first tape for one stock (or the whole market with `symbol` null), back to `since`.
 *
 * `since` is either a trade number (stop once reached) or a WIB second-of-day (stop once older).
 * Pages backwards with `trade_number`, which includes the boundary print itself, so duplicates are
 * dropped by trade number.
 */
export async function readTape(opts: {
  symbol: string | null;
  minimumLot: number;
  sinceTradeNumber?: number | null;
  sinceSeconds?: number | null;
  maxPages: number;
}): Promise<TapeRead> {
  const seen = new Map<number, Print>();
  let cursor: number | null = null;
  let pages = 0;
  let gap = false;
  while (pages < opts.maxPages) {
    const params: Record<string, string | number> = { order_by: 1, sort: "desc", limit: 100, minimum_lot: opts.minimumLot };
    if (opts.symbol) params.symbols = opts.symbol;
    if (cursor !== null) params.trade_number = cursor;
    const rows = rowsOf(await getJson("runningTrade", { params }));
    pages++;
    for (const p of parsePrints(rows)) seen.set(p.tradeNumber, p);
    const low = lowestTradeNumber(rows);
    if (rows.length < 100 || low === null) break;
    const reachedNumber = opts.sinceTradeNumber != null && low <= opts.sinceTradeNumber;
    const oldest = parsePrints(rows).reduce((m, p) => Math.min(m, p.seconds), Infinity);
    const reachedTime = opts.sinceSeconds != null && oldest <= opts.sinceSeconds;
    if (reachedNumber || reachedTime) break;
    if (opts.sinceTradeNumber == null && opts.sinceSeconds == null) break;
    if (cursor !== null && low >= cursor) break; // the server did not move; do not loop
    cursor = low;
    if (pages >= opts.maxPages) gap = true;
  }
  let prints = [...seen.values()];
  if (opts.sinceTradeNumber != null) prints = prints.filter((p) => p.tradeNumber > (opts.sinceTradeNumber as number));
  if (opts.sinceSeconds != null) prints = prints.filter((p) => p.seconds >= (opts.sinceSeconds as number));
  return { prints, pages, gap };
}

/* ------------------------------ ADV20 ------------------------------ */

/**
 * 20-session average daily traded value per stock, read once per day and kept on disk.
 *
 * Read from the paged daily history (`getBars`, two pages of twelve). `/charts/:symbol` would be one
 * request, but measured 2026-11-26 it carries no volume or value at all. Today's partial session is
 * excluded. A stock whose history cannot be read is remembered as null for the day, so it is not
 * retried every pass; the threshold then uses its fallback and says so.
 */
export class AdvCache {
  private day: string;
  private values = new Map<string, number | null>();

  constructor(
    private readonly file = join(stockbitDir(), "whale-adv.json"),
    now: Date = new Date(),
  ) {
    this.day = wibTodayIso(now);
    try {
      if (existsSync(this.file)) {
        const saved = JSON.parse(readFileSync(this.file, "utf8")) as { day?: string; values?: Record<string, number | null> };
        if (saved.day === this.day && saved.values) for (const [k, v] of Object.entries(saved.values)) this.values.set(k, v);
      }
    } catch {
      // A corrupt cache costs a re-read, nothing more.
    }
  }

  has(symbol: string): boolean {
    return this.values.has(symbol);
  }

  get(symbol: string): number | null {
    return this.values.get(symbol) ?? null;
  }

  /** Load one stock's ADV20. Returns the value (or null), and remembers it for the day. */
  async load(symbol: string, now: Date = new Date()): Promise<number | null> {
    const today = wibTodayIso(now);
    if (today !== this.day) {
      this.day = today;
      this.values.clear();
    }
    let adv: number | null = null;
    try {
      const series = await getBars({ symbol, bars: 21 });
      const past = series.bars.filter((b) => b.date < today && typeof b.value === "number" && b.value > 0).slice(-20);
      if (past.length >= 5) adv = past.reduce((s, b) => s + (b.value as number), 0) / past.length;
    } catch {
      adv = null;
    }
    this.values.set(symbol, adv);
    this.save();
    return adv;
  }

  private save(): void {
    try {
      mkdirSync(stockbitDir(), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ day: this.day, values: Object.fromEntries(this.values) }), "utf8");
    } catch {
      // Losing the cache costs requests tomorrow morning, nothing more.
    }
  }
}

/* ------------------------------ the stage ------------------------------ */

export interface ConfirmLimits {
  maxConfirm: number;
  maxSlots: number;
  sweepPages: number;
  confirmPages: number;
  maxAdvFetches: number;
  /** Lots for the market-wide sweep. See the design note in docs/WHALE-WATCH.md. */
  sweepMinimumLot: number;
  /** A slot closes after this long without a large print... */
  slotIdleMs: number;
  /** ...or this long after it opened, whichever comes first. */
  slotMaxMs: number;
  /** How far back a confirmation reads when the anomaly did not say. */
  defaultWindowSeconds: number;
}

export const CONFIRM_LIMITS: ConfirmLimits = {
  maxConfirm: 5,
  maxSlots: 5,
  sweepPages: 3,
  confirmPages: 2,
  maxAdvFetches: 5,
  sweepMinimumLot: 1000,
  slotIdleMs: 10 * 60_000,
  slotMaxMs: 30 * 60_000,
  defaultWindowSeconds: 300,
};

/** A stock the screener flagged, with what the confirmation needs to know about it. */
export interface Flagged {
  symbol: string;
  price: number;
  /** Today's average value per print, from the order book. Null when unknown. */
  sessionMeanPrint: number | null;
  /** How far back to read, seconds. */
  windowSeconds: number;
  /** Ranking key when more stocks are flagged than may be confirmed. */
  strength: number;
}

interface Slot {
  symbol: string;
  openedAt: number;
  lastBigAt: number;
  lastTradeNumber: number;
  price: number;
  sessionMeanPrint: number | null;
}

export interface ConfirmResult {
  /** Newly confirmed whales from flagged stocks, keyed by symbol. */
  confirmed: Map<string, WhaleFinding>;
  /** Whales the market-wide sweep found in stocks not confirmed above. */
  swept: WhaleFinding[];
  /** Further large prints in stocks already being watched. */
  followUps: { finding: WhaleFinding; minutes: number }[];
  /** Symbols currently holding a watch slot. */
  slots: string[];
  requests: number;
  errors: string[];
  /** True when the market-wide sweep ran out of pages before reaching the last print it saw. */
  sweepGap: boolean;
}

const wibSeconds = (now: Date): number => {
  const wib = new Date(now.getTime() + 7 * 3600_000);
  return wib.getUTCHours() * 3600 + wib.getUTCMinutes() * 60 + wib.getUTCSeconds();
};

/**
 * One trading day of confirmation state: the watch slots, the market-wide cursor, the ADV cache.
 * A new day gets a new instance, the same way the screener does.
 */
export class WhaleConfirmer {
  private readonly slots = new Map<string, Slot>();
  private sweepCursor: number | null = null;

  constructor(
    private readonly adv: AdvCache = new AdvCache(),
    private readonly t: WhaleThresholds = WHALE_DEFAULTS,
    private readonly limits: ConfirmLimits = CONFIRM_LIMITS,
    /** Whether to run the market-wide sweep. */
    private readonly sweep = true,
  ) {}

  private async thresholdFor(symbol: string, sessionMeanPrint: number | null, budget: { adv: number }, now: Date): Promise<Threshold | null> {
    if (!this.adv.has(symbol)) {
      if (budget.adv <= 0) return null;
      budget.adv--;
      await this.adv.load(symbol, now);
    }
    return whaleThreshold({ adv20: this.adv.get(symbol), sessionMeanPrint }, this.t);
  }

  async run(flagged: Flagged[], now: Date = new Date()): Promise<ConfirmResult> {
    const at = now.getTime();
    const nowSec = wibSeconds(now);
    const result: ConfirmResult = { confirmed: new Map(), swept: [], followUps: [], slots: [], requests: 0, errors: [], sweepGap: false };
    const budget = { adv: this.limits.maxAdvFetches };

    // ---- 1. confirm the strongest flagged stocks that are not already being watched ----
    const toConfirm = flagged
      .filter((f) => !this.slots.has(f.symbol))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, this.limits.maxConfirm);
    for (const f of toConfirm) {
      try {
        const th = await this.thresholdFor(f.symbol, f.sessionMeanPrint, budget, now);
        if (!th) continue;
        const read = await readTape({
          symbol: f.symbol,
          minimumLot: minimumLotFor(th.value, f.price, this.t),
          sinceSeconds: nowSec - Math.max(60, f.windowSeconds || this.limits.defaultWindowSeconds),
          maxPages: this.limits.confirmPages,
        });
        result.requests += read.pages;
        const finding = judgePrints(f.symbol, read.prints, th, this.t);
        if (finding) {
          result.confirmed.set(f.symbol, finding);
          this.open(f.symbol, finding, f.price, f.sessionMeanPrint, at);
        }
      } catch (err) {
        result.errors.push(`confirm ${f.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ---- 2. follow the stocks already holding a slot ----
    for (const slot of [...this.slots.values()]) {
      if (result.confirmed.has(slot.symbol)) continue;
      if (at - slot.lastBigAt > this.limits.slotIdleMs || at - slot.openedAt > this.limits.slotMaxMs) {
        this.slots.delete(slot.symbol);
        continue;
      }
      try {
        const th = whaleThreshold({ adv20: this.adv.get(slot.symbol), sessionMeanPrint: slot.sessionMeanPrint }, this.t);
        const read = await readTape({
          symbol: slot.symbol,
          minimumLot: minimumLotFor(th.value, slot.price, this.t),
          sinceTradeNumber: slot.lastTradeNumber,
          maxPages: 1,
        });
        result.requests += read.pages;
        const finding = judgePrints(slot.symbol, read.prints, th, this.t);
        if (read.prints.length) slot.lastTradeNumber = Math.max(slot.lastTradeNumber, ...read.prints.map((p) => p.tradeNumber));
        if (finding) {
          result.followUps.push({ finding, minutes: Math.max(1, Math.round((at - slot.lastBigAt) / 60_000)) });
          slot.lastBigAt = at;
          if (finding.largest) slot.price = finding.largest.price;
        }
      } catch (err) {
        result.errors.push(`slot ${slot.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ---- 3. the market-wide sweep ----
    if (this.sweep) {
      try {
        const read = await readTape({
          symbol: null,
          minimumLot: this.limits.sweepMinimumLot,
          sinceTradeNumber: this.sweepCursor,
          maxPages: this.sweepCursor === null ? 1 : this.limits.sweepPages,
        });
        result.requests += read.pages;
        result.sweepGap = read.gap;
        if (read.prints.length) this.sweepCursor = Math.max(this.sweepCursor ?? 0, ...read.prints.map((p) => p.tradeNumber));
        // A cheap pre-filter before any ADV is spent: nothing under the absolute floor can qualify.
        const bySymbol = new Map<string, Print[]>();
        for (const p of read.prints) {
          if (p.value < this.t.minValue * this.t.fillShare) continue;
          if (result.confirmed.has(p.symbol) || this.slots.has(p.symbol)) continue;
          (bySymbol.get(p.symbol) ?? bySymbol.set(p.symbol, []).get(p.symbol)!).push(p);
        }
        const ranked = [...bySymbol.entries()].sort((a, b) => Math.max(...b[1].map((p) => p.value)) - Math.max(...a[1].map((p) => p.value)));
        for (const [symbol, prints] of ranked) {
          if (Math.max(...prints.map((p) => p.value)) < this.t.minValue) continue;
          const th = await this.thresholdFor(symbol, null, budget, now);
          if (!th) continue; // ADV budget spent this pass; a later print will bring it back
          const finding = judgePrints(symbol, prints, th, this.t);
          if (finding) {
            result.swept.push(finding);
            this.open(symbol, finding, finding.largest?.price ?? prints[0].price, null, at);
          }
        }
      } catch (err) {
        result.errors.push(`sweep: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    result.slots = [...this.slots.keys()];
    return result;
  }

  private open(symbol: string, f: WhaleFinding, price: number, sessionMeanPrint: number | null, at: number): void {
    if (this.slots.size >= this.limits.maxSlots && !this.slots.has(symbol)) {
      // Full: the slot idle the longest makes room.
      const stalest = [...this.slots.values()].sort((a, b) => a.lastBigAt - b.lastBigAt)[0];
      if (stalest) this.slots.delete(stalest.symbol);
    }
    this.slots.set(symbol, { symbol, openedAt: at, lastBigAt: at, lastTradeNumber: f.lastTradeNumber, price, sessionMeanPrint });
  }
}
