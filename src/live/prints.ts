/**
 * Individual prints from the running-trade tape, and what makes some of them a whale.
 *
 * ## The tape IS readable live, with one parameter nobody had tried
 *
 * `market.ts` records that `/order-trade/running-trade` with `order_by=1` returns the session's FIRST
 * hundred prints and that no ordering returns the most recent ones. Measured 2026-11-26 during the
 * open session, adding `sort=desc` does exactly that: the newest prints, 1 to 8 seconds behind the
 * clock. Also measured the same afternoon:
 *
 *   - `minimum_lot=N` filters server-side to prints of at least N lots, and the 100-row cap then spans
 *     minutes instead of seconds;
 *   - `trade_number=X` with `sort=desc` pages backwards from print X (X itself included);
 *   - without `symbols` the tape is market-wide, and `trade_number` is one market-wide sequence;
 *   - there is NO rupiah filter (`minimum_value` and friends are ignored), `symbols=A,B` returns
 *     nothing, and an unknown `market_board` value is a 400.
 *
 * Each row carries `action` — the AGGRESSOR side, `buy` or `sell` — which is what turns "a lot of
 * money traded" into "someone lifted the offer". Broker codes stay blank during the session (IDX
 * rule since December 2021), so nothing here can say who.
 *
 * ## Why the threshold is per stock
 *
 * Rp100 juta in a thin small-cap can be the day's event; Rp1 miliar in BBCA is ordinary. So a print
 * is judged against the stock's own liquidity (a tiered share of its 20-session average daily value) AND
 * against today's own prints (a multiple of today's average print). See `whaleThreshold`.
 *
 * Everything in this file is pure. Fetching lives in `confirm.ts`.
 */
import { readRaw } from "./tape.js";
import { numId, rupiahId, type Severity, type Signal } from "./signals.js";

/** One print, as the tape reports it, with only what the whale logic needs. */
export interface Print {
  /** Market-wide sequence number. Higher is later. */
  tradeNumber: number;
  /** `HH:MM:SS`, Jakarta wall clock, exactly as sent. */
  time: string;
  /** Seconds since midnight WIB, from `time`. */
  seconds: number;
  symbol: string;
  price: number;
  lots: number;
  /** Rupiah. From `value.raw` when present, otherwise lots × 100 × price. */
  value: number;
  /** The aggressor. */
  side: "buy" | "sell";
}

const toSeconds = (time: string): number | null => {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

/**
 * Read running-trade rows into prints.
 *
 * Kept: the regular board only, with a known aggressor. Dropped, and why:
 *   - negotiated (`NG`) and cash (`TN`) boards are bilateral deals with no aggressor, and a block
 *     crossed between two parties is not someone hitting the market;
 *   - rows whose `action` is blank — the opening and closing auctions print that way, with no
 *     aggressor to speak of;
 *   - rows missing a trade number, time, price or lot. Never zero-filled.
 */
export function parsePrints(rows: unknown[]): Print[] {
  const out: Print[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const board = typeof r.market_board === "string" ? r.market_board.trim().toUpperCase() : "";
    if (board && board !== "RG") continue;
    const action = typeof r.action === "string" ? r.action.trim().toLowerCase() : "";
    const side = action.endsWith("buy") ? "buy" : action.endsWith("sell") ? "sell" : null;
    if (!side) continue;
    const tradeNumber = readRaw(r.trade_number);
    const time = typeof r.time === "string" ? r.time.trim() : "";
    const seconds = toSeconds(time);
    const price = readRaw(r.price);
    const lots = readRaw(r.lot);
    const symbol = typeof r.code === "string" ? r.code.trim().toUpperCase() : "";
    if (tradeNumber === null || seconds === null || price === null || lots === null || !symbol || price <= 0 || lots <= 0) {
      continue;
    }
    const value = readRaw(r.value) ?? lots * 100 * price;
    out.push({ tradeNumber, time, seconds, symbol, price, lots, value, side });
  }
  return out;
}

/* ------------------------------ thresholds ------------------------------ */

export interface WhaleThresholds {
  /**
   * Liquidity tiers, highest ADV first. A stock takes the first tier whose `minAdv` its ADV20
   * reaches; one print must then be `share` of that ADV20 and at least `floor` rupiah.
   */
  tiers: readonly AdvTier[];
  /** Ceiling on the ADV-based figure, rupiah. */
  maxValue: number;
  /** Used instead of the ADV figure when the ADV could not be read. */
  fallbackValue: number;
  /** One print must also reach this multiple of today's average print, when that is known. */
  sessionMultiple: number;
  /** A sweep: same-side prints within this many seconds... */
  sweepSeconds: number;
  /** ...totalling at least this multiple of the stock's threshold... */
  sweepMultiple: number;
  /** ...across at least this many price levels. */
  sweepLevels: number;
  /** Prints counted toward a sweep or toward direction must be at least this share of the threshold. */
  fillShare: number;
  /** The dominant side's share of large-print value needed to name a direction. */
  dominance: number;
}

export interface AdvTier {
  /** Lowest ADV20 (rupiah) in this tier. */
  minAdv: number;
  /** Share of ADV20 one print must reach. */
  share: number;
  /** Rupiah floor for this tier. */
  floor: number;
}

/**
 * Owner-approved tiers (2026-11-26, after the first afternoon live test sent 182 whales in two
 * hours, half of them just over a flat Rp50 jt floor).
 *
 * Each tier's floor equals the top of the tier below it (1% × Rp100 M = Rp1 M, 0.5% × Rp250 M =
 * Rp1,25 M), so a slightly more liquid stock never gets a LOWER threshold than a slightly less
 * liquid one. Replayed on that afternoon's log: 182 whales became 48.
 */
export const WHALE_TIERS: readonly AdvTier[] = [
  { minAdv: 250_000_000_000, share: 0.0025, floor: 1_250_000_000 },
  { minAdv: 100_000_000_000, share: 0.005, floor: 1_000_000_000 },
  { minAdv: 5_000_000_000, share: 0.01, floor: 200_000_000 },
  { minAdv: 0, share: 0.05, floor: 100_000_000 },
];

/** Starting points. Calibrate from the log, not from intuition. */
export const WHALE_DEFAULTS: WhaleThresholds = {
  tiers: WHALE_TIERS,
  maxValue: 25_000_000_000,
  fallbackValue: 200_000_000,
  sessionMultiple: 10,
  sweepSeconds: 30,
  sweepMultiple: 2,
  sweepLevels: 2,
  fillShare: 0.1,
  dominance: 0.7,
};

export interface ThresholdInput {
  /** 20-session average daily traded value, rupiah. Null when it could not be read. */
  adv20: number | null;
  /** Today's average value per print (cumulative value / frequency). Null when unknown. */
  sessionMeanPrint: number | null;
}

export interface Threshold {
  /** Rupiah one print must reach to count as a whale print in this stock. */
  value: number;
  /** Which of the two measures set it, for the message and the log. */
  basis: "adv" | "session" | "fallback";
  adv20: number | null;
  sessionMeanPrint: number | null;
}

/** The tier a stock with this ADV20 falls in. */
export function tierFor(adv20: number, t: WhaleThresholds = WHALE_DEFAULTS): AdvTier {
  return t.tiers.find((tier) => adv20 >= tier.minAdv) ?? t.tiers[t.tiers.length - 1];
}

/** The smallest rupiah any stock's threshold can be: nothing under it can be a whale print. */
export function lowestFloor(t: WhaleThresholds = WHALE_DEFAULTS): number {
  return Math.min(t.fallbackValue, ...t.tiers.map((tier) => tier.floor));
}

/**
 * The rupiah one print must reach in THIS stock.
 *
 * Both measures must be met, so the threshold is the larger: the stock's tier share of its average
 * daily value (at least the tier floor, at most `maxValue`) — "large for this stock in general" — and
 * `sessionMultiple` × today's average print — "unusual for today". Without an ADV the fallback floor
 * stands in for the first measure.
 */
export function whaleThreshold(input: ThresholdInput, t: WhaleThresholds = WHALE_DEFAULTS): Threshold {
  const advPart =
    input.adv20 !== null && input.adv20 > 0
      ? (() => {
          const tier = tierFor(input.adv20, t);
          return Math.min(t.maxValue, Math.max(tier.floor, input.adv20 * tier.share));
        })()
      : null;
  const first = advPart ?? t.fallbackValue;
  const sessionPart =
    input.sessionMeanPrint !== null && input.sessionMeanPrint > 0 ? input.sessionMeanPrint * t.sessionMultiple : 0;
  const value = Math.max(first, sessionPart);
  const basis = sessionPart > first ? "session" : advPart !== null ? "adv" : "fallback";
  return { value, basis, adv20: input.adv20, sessionMeanPrint: input.sessionMeanPrint };
}

/** The `minimum_lot` to ask the tape for, so the server only sends prints worth looking at. */
export function minimumLotFor(threshold: number, price: number, t: WhaleThresholds = WHALE_DEFAULTS): number {
  if (price <= 0) return 1;
  return Math.max(1, Math.floor((threshold * t.fillShare) / (price * 100)));
}

/* ------------------------------ analysis ------------------------------ */

export interface Sweep {
  side: "buy" | "sell";
  from: string;
  to: string;
  value: number;
  prints: number;
  lowPrice: number;
  highPrice: number;
  levels: number;
}

export interface WhaleFinding {
  symbol: string;
  threshold: Threshold;
  /** The biggest single print at or above the threshold, if any. */
  largest: Print | null;
  /** Prints at or above the threshold. */
  bigPrints: Print[];
  /** The largest qualifying sweep, if any. */
  sweep: Sweep | null;
  /** Value of counted prints (at least `fillShare` of the threshold) by aggressor side. */
  buyValue: number;
  sellValue: number;
  /** `buy`/`sell` when one side has `dominance` of the counted value, `two-way` otherwise. */
  direction: "buy" | "sell" | "two-way";
  /** The dominant side's share, 0..1. */
  share: number;
  /** The latest trade number seen, so the next read can start after it. */
  lastTradeNumber: number;
  /** How far past the threshold it is, as a multiple. Comparable with other signals' surprise. */
  surprise: number;
}

/** Find the biggest same-side burst within `sweepSeconds` that spans enough price levels. */
function findSweep(prints: Print[], threshold: number, t: WhaleThresholds): Sweep | null {
  let best: Sweep | null = null;
  for (const side of ["buy", "sell"] as const) {
    const ps = prints.filter((p) => p.side === side).sort((a, b) => a.seconds - b.seconds || a.tradeNumber - b.tradeNumber);
    let start = 0;
    let sum = 0;
    for (let end = 0; end < ps.length; end++) {
      sum += ps[end].value;
      while (ps[end].seconds - ps[start].seconds > t.sweepSeconds) {
        sum -= ps[start].value;
        start++;
      }
      const window = ps.slice(start, end + 1);
      const prices = new Set(window.map((p) => p.price));
      if (sum >= threshold * t.sweepMultiple && prices.size >= t.sweepLevels && (!best || sum > best.value)) {
        const sorted = [...prices].sort((a, b) => a - b);
        best = {
          side,
          from: window[0].time,
          to: window[window.length - 1].time,
          value: sum,
          prints: window.length,
          lowPrice: sorted[0],
          highPrice: sorted[sorted.length - 1],
          levels: prices.size,
        };
      }
    }
  }
  return best;
}

/**
 * Judge one stock's recent prints against its threshold. Returns null when nothing qualifies.
 *
 * Qualifies on EITHER a single print at or above the threshold OR a sweep. Direction is named only
 * when one side holds `dominance` of the counted value; otherwise the finding is `two-way`, which is
 * large money changing hands rather than one side pressing.
 */
export function judgePrints(symbol: string, prints: Print[], threshold: Threshold, t: WhaleThresholds = WHALE_DEFAULTS): WhaleFinding | null {
  const mine = prints.filter((p) => p.symbol === symbol);
  if (!mine.length) return null;
  const counted = mine.filter((p) => p.value >= threshold.value * t.fillShare);
  const bigPrints = mine.filter((p) => p.value >= threshold.value).sort((a, b) => b.value - a.value);
  const sweep = findSweep(counted, threshold.value, t);
  if (!bigPrints.length && !sweep) return null;

  const buyValue = counted.filter((p) => p.side === "buy").reduce((s, p) => s + p.value, 0);
  const sellValue = counted.filter((p) => p.side === "sell").reduce((s, p) => s + p.value, 0);
  const total = buyValue + sellValue;
  const share = total > 0 ? Math.max(buyValue, sellValue) / total : 0;
  const direction = share >= t.dominance ? (buyValue >= sellValue ? "buy" : "sell") : "two-way";
  const largest = bigPrints[0] ?? null;
  const surprise = Math.max(largest ? largest.value / threshold.value : 0, sweep ? sweep.value / (threshold.value * t.sweepMultiple) : 0);

  return {
    symbol,
    threshold,
    largest,
    bigPrints,
    sweep,
    buyValue,
    sellValue,
    direction,
    share,
    lastTradeNumber: Math.max(...mine.map((p) => p.tradeNumber)),
    surprise,
  };
}

/* ------------------------------ words ------------------------------ */

/** HH:MM:SS as the tape gives it. Colons throughout, like every other time in the messages. */
const clock = (time: string) => time;
const SIDE_ID = { buy: "beli", sell: "jual" } as const;
const AGGRESSOR_ID = { buy: "HAKA", sell: "HAKI" } as const;

const severityOf = (surprise: number): Severity => (surprise >= 5 ? "critical" : surprise >= 2 ? "alert" : "watch");

/** How big a print is next to this stock's own yardsticks, in one Indonesian clause. */
function relativeId(value: number, th: Threshold): string {
  const parts: string[] = [];
  if (th.adv20) parts.push(`${numId((value / th.adv20) * 100, 1)}% nilai harian rata-rata`);
  if (th.sessionMeanPrint) parts.push(`${numId(value / th.sessionMeanPrint, 0)}x transaksi rata-rata hari ini`);
  return parts.join(", ");
}

/**
 * A confirmed whale as a Signal, in both languages.
 *
 * `triggers` are the Indonesian headlines of the anomalies that led here (empty for a print found by
 * the market-wide sweep). The text claims only what the tape shows: the aggressor side, the size,
 * the time. Never who.
 */
export function whaleSignal(
  f: WhaleFinding,
  triggers: string[],
  source: "confirm" | "sweep",
  t: WhaleThresholds = WHALE_DEFAULTS,
): Signal {
  const dir = f.direction;
  const headlineId =
    dir === "two-way"
      ? `${f.symbol}: transaksi besar dua arah`
      : `${f.symbol}: order ${SIDE_ID[dir]} besar (${AGGRESSOR_ID[dir]})`;
  // Laid out for a phone (owner, 2026-11-26: the first version read as one dense block). One fact per
  // line, each led by its own mark so the eye can skip to it; whaleText adds no bullet to these.
  const detailId: string[] = [];
  if (f.largest) {
    const p = f.largest;
    detailId.push(`💰 ${rupiahId(p.value)} sekali transaksi, ${numId(p.lots)} lot di ${numId(p.price)} (${clock(p.time)})`);
    const rel = relativeId(p.value, f.threshold);
    if (rel) detailId.push(`📊 Setara ${rel}`);
    // Not earlier alerts: the other prints over the threshold in the same stretch of tape that was read.
    if (f.bigPrints.length > 1) {
      const times = f.bigPrints.map((b) => b.seconds);
      const first = f.bigPrints[times.indexOf(Math.min(...times))].time;
      const last = f.bigPrints[times.indexOf(Math.max(...times))].time;
      const sum = f.bigPrints.reduce((acc, b) => acc + b.value, 0);
      detailId.push(`🔁 Total ${numId(f.bigPrints.length)} transaksi di atas ambang, ${rupiahId(sum)} (${clock(first)} sampai ${clock(last)})`);
    }
  }
  if (f.sweep) {
    const sw = f.sweep;
    const range = sw.lowPrice === sw.highPrice ? `di ${numId(sw.lowPrice)}` : `${numId(sw.lowPrice)} sampai ${numId(sw.highPrice)}`;
    detailId.push(`🧹 Sapuan ${SIDE_ID[sw.side]} ${rupiahId(sw.value)}: ${numId(sw.prints)} transaksi, harga ${range} (${clock(sw.from)} sampai ${clock(sw.to)})`);
  }
  const total = f.buyValue + f.sellValue;
  if (total > 0) {
    const lead = f.buyValue >= f.sellValue ? "buy" : "sell";
    detailId.push(
      `⚖️ ${numId(f.share * 100, 0)}% ${SIDE_ID[lead]}: beli ${rupiahId(f.buyValue)}, jual ${rupiahId(f.sellValue)} (transaksi minimal ${rupiahId(f.threshold.value * t.fillShare)})`,
    );
  }
  detailId.push(
    `🎯 Ambang whale saham ini ${rupiahId(f.threshold.value)}${f.threshold.basis === "fallback" ? " (ambang cadangan, nilai harian tidak terbaca)" : ""}`,
  );
  // The triggers are other alerts' headlines, "SYM: what"; the symbol is already in this headline.
  if (triggers.length) detailId.push(`🔎 Pemicu: ${triggers.map((x) => x.replace(new RegExp(`^${f.symbol}: `), "")).join("; ")}`);
  else if (source === "sweep") detailId.push("🔎 Ditemukan lewat pemantauan seluruh pasar");

  const headline =
    dir === "two-way" ? `${f.symbol}: large two-way prints` : `${f.symbol}: large ${dir} prints (aggressor ${dir})`;
  const detail: string[] = [];
  if (f.largest) detail.push(`${f.largest.time} ${f.largest.lots} lots at ${f.largest.price}, Rp ${(f.largest.value / 1e6).toFixed(0)} jt in one print.`);
  if (f.sweep) detail.push(`Sweep ${f.sweep.side} ${f.sweep.from}-${f.sweep.to}: Rp ${(f.sweep.value / 1e6).toFixed(0)} jt, ${f.sweep.levels} price levels.`);
  detail.push(`Threshold Rp ${(f.threshold.value / 1e6).toFixed(0)} jt (${f.threshold.basis}). Direction is the aggressor side only; who is not visible.`);

  const price = f.largest?.price ?? f.sweep?.highPrice ?? 0;
  return {
    kind: "whale",
    symbol: f.symbol,
    severity: severityOf(f.surprise),
    surprise: f.surprise,
    headline,
    detail,
    priceBucket: Math.round(price / Math.max(1, price * 0.01)),
    at: Date.now(),
    id: { headline: headlineId, detail: detailId },
  };
}

/** A short follow-up for a stock already announced, in Indonesian. */
export function followUpText(f: WhaleFinding, minutes: number): string {
  const total = f.buyValue + f.sellValue;
  const dir = f.direction === "two-way" ? "dua arah" : `${SIDE_ID[f.direction]} (${AGGRESSOR_ID[f.direction]})`;
  const price = f.largest?.price ?? f.sweep?.highPrice;
  return `🐋 ${f.symbol} lanjutan: ${dir}\n💰 ${rupiahId(total)} lagi dalam ${numId(minutes)} menit terakhir${price ? `, harga ${numId(price)}` : ""}`;
}
