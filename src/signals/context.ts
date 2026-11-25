/**
 * From the readers' output to the engine's `DailyContext`, plus the two small readers the bot needs
 * that nothing else in the repo shapes this way: a numeric tick from a quote, and today's whale
 * alerts from the whale watch's log.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Bar } from "../core/bars.js";
import type { Quote } from "../core/emitten.js";
import { atr, latest } from "../core/indicators.js";
import type { AnalysisReport } from "../analysis/analyze.js";
import type { DailyContext, Tick, WhaleHit } from "./engine.js";

/**
 * Build the day's context. Only bars dated BEFORE `today` count as "yesterday": during a session the
 * bar series can already carry today's partial bar, and treating that as the previous session would
 * move the breakout level with every tick.
 */
export function buildContext(report: AnalysisReport, bars: Bar[], today: string): DailyContext {
  const done = bars.filter((b) => b.date < today);
  const prev = done[done.length - 1] ?? null;
  const atrValue = done.length > 15 ? latest(atr(done, 14)) : null;
  return {
    symbol: report.symbol,
    asOf: report.asOf,
    lean: report.lean,
    score: report.score,
    confidence: report.confidence.value,
    prevClose: prev?.close ?? null,
    prevHigh: prev?.high ?? null,
    prevLow: prev?.low ?? null,
    atr: atrValue,
    ara: report.context.bands?.ara ?? null,
    pillars: report.pillars.map((p) => ({ name: p.name, score: p.score, reason: p.reason })),
  };
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(String(v).replace(/[%,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** A quote as a tick. Throws when the quote carries no price: a missing price is not zero. */
export function tickFromQuote(q: Quote): Tick {
  const price = num(q.price);
  if (price === null || price <= 0) throw new Error(`quote for ${q.symbol} carried no price`);
  return { price, changePct: num(q.percentage) };
}

/**
 * Today's alerts on `symbol` from the whale watch's JSONL log. The two processes share nothing but
 * this file, so the signal bot keeps working when the whale watch is not running — it just loses
 * the "large money" trigger and falls back to breakouts.
 */
export function whalesFromLog(path: string, symbol: string, day: string): WhaleHit[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: WhaleHit[] = [];
  const dayStart = Date.parse(`${day}T00:00:00+07:00`);
  for (const line of raw.split("\n")) {
    if (!line.includes(symbol)) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.type !== "alert" || e.symbol !== symbol || e.dryRun) continue;
      const at = typeof e.at === "string" ? e.at : "";
      const t = Date.parse(at);
      if (!(t >= dayStart && t < dayStart + 86_400_000)) continue;
      out.push({ kind: String(e.kind ?? ""), at, text: String(e.headline ?? "") });
    } catch {
      // A torn last line while the whale watch is writing. Skip it.
    }
  }
  return out;
}
