/**
 * The signal engine: when a BUY or SELL message is worth sending, and what numbers it carries.
 *
 * Pure functions only. Every input is a value the caller already read — a daily analysis, a last
 * price, today's whale events — so a whole trading day replays in a unit test with no network.
 *
 * ## Two gates, both required
 *
 * A BUY needs the DAILY picture and the INTRADAY moment to agree:
 *
 *   - daily: `analyze()` leans bullish with enough score and confidence, and broker flow is not
 *     pointing the other way;
 *   - intraday: the price breaks above yesterday's high, or large money (a whale event from the
 *     whale watch's own log) lands while the price is up.
 *
 * Either one alone is noise. A bullish daily score with a flat tape is a stock that might move some
 * day; a whale print in a stock whose trend and broker flow are against it is the kind of spike that
 * reverses by the close. Requiring both is what keeps a full-intraday feed from flooding the chat.
 *
 * ## What it refuses to do
 *
 * - **Chase.** A stock already up more than `maxChasePct` today, or within a few percent of its
 *   auto-rejection ceiling, gets no BUY: the stop would sit far away and the upside is capped by rule.
 * - **Invent numbers.** A missing ATR or a missing previous bar means no plan and therefore no
 *   signal — never a default stop.
 * - **Trade.** It returns plans. Nothing in this module, or anything that imports it, can place an
 *   order (ADR-0012).
 */
import { roundToTick } from "../core/ticks.js";

export interface PillarBrief {
  name: string;
  score: number | null;
  reason: string;
}

/** What the morning analysis concluded about one symbol, frozen for the trading day. */
export interface DailyContext {
  symbol: string;
  /** Date of the last completed session the analysis used. */
  asOf: string | null;
  lean: "bullish" | "neutral" | "bearish";
  /** −100…+100. */
  score: number;
  /** 0–90. Evidence quality, not a probability. */
  confidence: number;
  prevClose: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  /** 14-session average true range, in rupiah. */
  atr: number | null;
  /** Today's auto-rejection ceiling, when the bands were readable. */
  ara: number | null;
  pillars: PillarBrief[];
}

export interface SignalConfig {
  /** Minimum daily composite score for a BUY. */
  minScore: number;
  /** Minimum daily confidence for a BUY. */
  minConfidence: number;
  /** No BUY when the stock is already up more than this today (percent). */
  maxChasePct: number;
  /** No BUY within this many percent of the ARA ceiling. */
  araBufferPct: number;
  /** Stop distance in ATRs below the entry. */
  stopAtr: number;
  /** Stop distance bounds, percent of entry. */
  minStopPct: number;
  maxStopPct: number;
  /** Targets as multiples of the risk (R). */
  target1R: number;
  target2R: number;
  /** Close a signal that has done nothing after this many trading days. */
  maxHoldDays: number;
}

export const DEFAULT_CONFIG: SignalConfig = {
  minScore: 35,
  minConfidence: 45,
  maxChasePct: 7,
  araBufferPct: 3,
  stopAtr: 1.5,
  minStopPct: 2,
  maxStopPct: 8,
  target1R: 1.5,
  target2R: 3,
  maxHoldDays: 10,
};

/** A whale-watch event on this symbol today, as read back from the whale log. */
export interface WhaleHit {
  kind: string;
  at: string;
  text: string;
}

export interface Tick {
  price: number;
  /** Percent change from the previous close, as the quote reports it. */
  changePct: number | null;
}

export interface BuyPlan {
  symbol: string;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  riskPct: number;
  /** Why the intraday gate opened, in Indonesian. */
  trigger: string;
  /** The daily evidence, in Indonesian, one line per pillar that said something. */
  reasons: string[];
}

export type EntryDecision = { ok: true; plan: BuyPlan } | { ok: false; reason: string };

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Percent change of the tick, computed from the previous close when the quote did not carry it. */
export function changePctOf(tick: Tick, prevClose: number | null): number | null {
  if (tick.changePct !== null && Number.isFinite(tick.changePct)) return tick.changePct;
  if (prevClose && prevClose > 0) return ((tick.price - prevClose) / prevClose) * 100;
  return null;
}

const PILLAR_ID: Record<string, string> = {
  brokerFlow: "Aliran broker",
  trend: "Tren harga",
  patterns: "Pola candle",
  valuation: "Valuasi",
};

function pillarLines(ctx: DailyContext): string[] {
  return ctx.pillars
    .filter((p) => p.score !== null && Math.abs(p.score) >= 10)
    .map((p) => `${PILLAR_ID[p.name] ?? p.name}: ${(p.score as number) > 0 ? "positif" : "negatif"} (${Math.round(p.score as number)})`);
}

/**
 * The half of the BUY rule that only the morning analysis decides: null when `ctx` may produce a BUY
 * today, else the reason it cannot. The loop uses it to watch only the symbols that can still buy.
 */
export function dailyGate(ctx: DailyContext, cfg: SignalConfig = DEFAULT_CONFIG): string | null {
  if (ctx.lean !== "bullish") return `daily-lean-${ctx.lean}`;
  if (ctx.score < cfg.minScore) return "daily-score-low";
  if (ctx.confidence < cfg.minConfidence) return "daily-confidence-low";
  const broker = ctx.pillars.find((p) => p.name === "brokerFlow");
  if (broker && broker.score !== null && broker.score < 0) return "broker-flow-negative";
  if (ctx.atr === null || ctx.prevHigh === null || ctx.prevLow === null) return "no-daily-bars";
  return null;
}

/** Should this tick open a BUY? Returns the plan, or the reason it did not. */
export function evaluateEntry(
  ctx: DailyContext,
  tick: Tick,
  whales: WhaleHit[],
  cfg: SignalConfig = DEFAULT_CONFIG,
): EntryDecision {
  if (!(tick.price > 0)) return { ok: false, reason: "no-price" };
  const gate = dailyGate(ctx, cfg);
  if (gate) return { ok: false, reason: gate };
  // dailyGate has checked these; repeated so the compiler can see it.
  if (ctx.atr === null || ctx.prevHigh === null || ctx.prevLow === null) return { ok: false, reason: "no-daily-bars" };

  const change = changePctOf(tick, ctx.prevClose);
  if (change === null) return { ok: false, reason: "no-change" };
  if (change > cfg.maxChasePct) return { ok: false, reason: "chasing" };
  if (ctx.ara !== null && tick.price >= ctx.ara * (1 - cfg.araBufferPct / 100)) return { ok: false, reason: "near-ara" };

  const bigMoney = whales.filter((w) => w.kind === "value-surge" || w.kind === "awakening");
  let trigger: string;
  if (tick.price > ctx.prevHigh && change > 0) {
    trigger = `Harga ${tick.price} menembus tertinggi kemarin (${ctx.prevHigh}).`;
  } else if (bigMoney.length > 0 && change > 0) {
    trigger = `Whale watch melihat transaksi besar masuk hari ini dan harga naik ${round2(change)}%.`;
  } else {
    return { ok: false, reason: "no-intraday-trigger" };
  }

  const entry = tick.price;
  let stopRaw = Math.max(ctx.prevLow, entry - cfg.stopAtr * ctx.atr);
  const minStop = entry * (1 - cfg.maxStopPct / 100);
  const maxStop = entry * (1 - cfg.minStopPct / 100);
  stopRaw = Math.min(Math.max(stopRaw, minStop), maxStop);
  const stop = roundToTick(stopRaw, "down");
  if (!(stop > 0 && stop < entry)) return { ok: false, reason: "bad-stop" };

  const risk = entry - stop;
  const target1 = roundToTick(entry + cfg.target1R * risk, "up");
  const target2 = roundToTick(entry + cfg.target2R * risk, "up");
  if (ctx.ara !== null && target1 > ctx.ara * 1.35) {
    // A first target past what two ARA sessions could reach is not a plan for a swing.
    return { ok: false, reason: "target-unreachable" };
  }

  return {
    ok: true,
    plan: {
      symbol: ctx.symbol,
      entry,
      stop,
      target1,
      target2,
      riskPct: round2((risk / entry) * 100),
      trigger,
      reasons: pillarLines(ctx),
    },
  };
}

/* ------------------------------------- exits ------------------------------------- */

export interface OpenSignal {
  id: string;
  symbol: string;
  openedAt: string;
  openedDay: string;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  /** True once target 1 printed; the stop then moves to the entry. */
  target1Hit: boolean;
}

export type ExitKind = "target1" | "target2" | "stop" | "breakeven" | "flip" | "distribution" | "time";

export interface ExitDecision {
  kind: ExitKind;
  /** True when the signal closes. `target1` alone keeps it open with a raised stop. */
  closes: boolean;
  price: number;
}

/** Trading days between two WIB dates, counting weekdays only. Holidays are not known here. */
export function weekdaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  let n = 0;
  for (let d = new Date(from); d < to; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

/**
 * What, if anything, happens to an open signal at this price.
 *
 * Order matters and is deliberate: the stop is checked before any target, so a gap through both in
 * one poll reads as the loss it more likely was rather than as a win.
 */
export function evaluateExit(
  open: OpenSignal,
  tick: Tick,
  today: string,
  ctx: DailyContext | null,
  whales: WhaleHit[],
  cfg: SignalConfig = DEFAULT_CONFIG,
): ExitDecision | null {
  const price = tick.price;
  if (!(price > 0)) return null;

  if (price <= open.stop) return { kind: open.target1Hit ? "breakeven" : "stop", closes: true, price };
  if (price >= open.target2) return { kind: "target2", closes: true, price };
  if (!open.target1Hit && price >= open.target1) return { kind: "target1", closes: false, price };

  // The morning analysis turning bearish is a reason to leave, on the first price of the day.
  if (ctx && ctx.lean === "bearish" && today !== open.openedDay) return { kind: "flip", closes: true, price };

  // Large money arriving while the price falls is selling pressure, not accumulation.
  const change = changePctOf(tick, ctx?.prevClose ?? null);
  const bigMoney = whales.some((w) => w.kind === "value-surge" || w.kind === "awakening");
  if (bigMoney && change !== null && change <= -2 && price < open.entry) return { kind: "distribution", closes: true, price };

  if (weekdaysBetween(open.openedDay, today) >= cfg.maxHoldDays) return { kind: "time", closes: true, price };
  return null;
}
