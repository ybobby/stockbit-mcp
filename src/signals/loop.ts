/**
 * The signal bot's day: analyse the watchlist each morning, watch prices all session, send BUY and
 * SELL messages to Telegram, and a recap on Friday afternoon.
 *
 * Every side effect goes through `deps`, so a whole trading week replays in a unit test.
 *
 * ## Limits that keep a full-intraday feed readable
 *
 *   - at most `maxBuysPerDay` BUY messages per day, and `maxOpen` signals open at once;
 *   - one BUY per symbol per day, and a `cooldownDays` pause after a signal on it closes;
 *   - a symbol the AI vetoed is not reconsidered until tomorrow.
 *
 * SELL messages are never rate-limited: a person holding on the strength of a BUY must hear about
 * the stop.
 *
 * ## Nothing here trades
 *
 * It reads quotes, the daily analysis and the whale watch's own log, and it sends text.
 */
import { wibTodayIso } from "../core/sessionclock.js";
import type { AiReviewer } from "./ai.js";
import {
  DEFAULT_CONFIG,
  evaluateEntry,
  evaluateExit,
  weekdaysBetween,
  type DailyContext,
  type SignalConfig,
  type Tick,
  type WhaleHit,
} from "./engine.js";
import { closeSignal, recap, type Journal } from "./ledger.js";
import { buyText, exitText, recapText } from "./messages.js";

export interface SignalBotDeps {
  now(): Date;
  sleep(ms: number): Promise<void>;
  inWindow(now: Date): boolean;
  stopped(): boolean;
  dailyContext(symbol: string): Promise<DailyContext>;
  tick(symbol: string): Promise<Tick>;
  /** Today's whale-watch alerts on a symbol. Never throws; an unreadable log is an empty list. */
  whales(symbol: string, day: string): WhaleHit[];
  send(text: string): Promise<string | null>;
  record(event: Record<string, unknown>): void;
  loadJournal(): Journal;
  saveJournal(journal: Journal): void;
  review?: AiReviewer;
  isAuthError(err: unknown): boolean;
}

export interface SignalBotOptions {
  symbols: string[];
  intervalMs: number;
  idleMs?: number;
  maxBuysPerDay?: number;
  maxOpen?: number;
  cooldownDays?: number;
  /**
   * New BUYs only between these WIB times (`HH:MM`). The open is noisy and the last minutes run into
   * the closing auction, where a normal order does not fill at the price the message would quote.
   * Exits are checked all session regardless.
   */
  entryFrom?: string;
  entryUntil?: string;
  /** Send the weekly recap on Friday at or after this WIB time (`HH:MM`). */
  recapAt?: string;
  failureNotice?: number;
  config?: SignalConfig;
  maxPasses?: number;
}

export interface SignalBotSummary {
  passes: number;
  buys: number;
  exits: number;
  vetoes: number;
  sendFailures: number;
  ended: "stopped" | "auth" | "max-passes";
}

const WIB_MS = 7 * 3600_000;
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

function wibParts(now: Date): { weekday: number; hhmm: string } {
  const w = new Date(now.getTime() + WIB_MS);
  return { weekday: w.getUTCDay(), hhmm: w.toISOString().slice(11, 16) };
}

/** Monday of the WIB week containing `day`. */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export async function runSignalBot(deps: SignalBotDeps, opts: SignalBotOptions): Promise<SignalBotSummary> {
  const cfg = opts.config ?? DEFAULT_CONFIG;
  const idleMs = opts.idleMs ?? 60_000;
  const maxBuysPerDay = opts.maxBuysPerDay ?? 3;
  const maxOpen = opts.maxOpen ?? 5;
  const cooldownDays = opts.cooldownDays ?? 3;
  const recapAt = opts.recapAt ?? "16:15";
  const entryFrom = opts.entryFrom ?? "09:05";
  const entryUntil = opts.entryUntil ?? "15:30";
  const failureNotice = opts.failureNotice ?? 3;
  const summary: SignalBotSummary = { passes: 0, buys: 0, exits: 0, vetoes: 0, sendFailures: 0, ended: "stopped" };

  let day: string | null = null;
  let contexts = new Map<string, DailyContext>();
  let buysToday = 0;
  let touchedToday = new Set<string>();
  let failures = 0;
  let announcedOutage = false;

  const send = async (text: string, event: Record<string, unknown>) => {
    const error = await deps.send(text);
    if (error) summary.sendFailures++;
    deps.record({ ...event, delivered: error ? "failed" : "sent", ...(error ? { deliveryError: error } : {}) });
  };

  const authStop = async (now: Date) => {
    await send(
      "⛔ Bot sinyal berhenti: sesi login Stockbit sudah tidak berlaku.\nLogin ulang (stockbit-auth login), lalu jalankan bot sinyal lagi.",
      { type: "stopped-auth", at: now.toISOString() },
    );
    summary.ended = "auth";
  };

  const maybeRecap = async (now: Date) => {
    const { weekday, hhmm } = wibParts(now);
    const today = wibTodayIso(now);
    if (weekday !== 5 || hhmm < recapAt) return;
    const journal = deps.loadJournal();
    if (journal.recapsSent.includes(today)) return;
    const since = mondayOf(today);
    const r = recap(journal, since);
    journal.recapsSent.push(today);
    deps.saveJournal(journal);
    await send(recapText(r, since, now), { type: "recap", at: now.toISOString(), ...r, best: r.best?.symbol, worst: r.worst?.symbol });
  };

  while (!deps.stopped()) {
    if (opts.maxPasses !== undefined && summary.passes >= opts.maxPasses) {
      summary.ended = "max-passes";
      break;
    }
    const now = deps.now();

    if (!deps.inWindow(now)) {
      await maybeRecap(now);
      await deps.sleep(idleMs);
      continue;
    }

    const today = wibTodayIso(now);
    if (day !== today) {
      // A new day: fresh analysis for everything watched or held, fresh daily limits.
      day = today;
      buysToday = 0;
      touchedToday = new Set();
      contexts = new Map();
      const held = deps.loadJournal().open.map((s) => s.symbol);
      const universe = [...new Set([...opts.symbols, ...held])];
      deps.record({ type: "day-started", day, symbols: universe.length, at: now.toISOString() });
      for (const symbol of universe) {
        if (deps.stopped()) break;
        try {
          contexts.set(symbol, await deps.dailyContext(symbol));
        } catch (err) {
          if (deps.isAuthError(err)) {
            await authStop(now);
            return summary;
          }
          deps.record({ type: "analysis-failed", symbol, error: msg(err) });
        }
      }
      const bullish = [...contexts.values()].filter((c) => c.lean === "bullish").map((c) => c.symbol);
      deps.record({ type: "analysis-done", day, analysed: contexts.size, bullish });
    }

    summary.passes++;
    const journal = deps.loadJournal();
    let changed = false;
    const symbols = [...new Set([...journal.open.map((s) => s.symbol), ...opts.symbols])];
    const ticks = new Map<string, Tick>();
    let tickErrors = 0;
    for (const symbol of symbols) {
      try {
        ticks.set(symbol, await deps.tick(symbol));
      } catch (err) {
        if (deps.isAuthError(err)) {
          await authStop(now);
          return summary;
        }
        tickErrors++;
        deps.record({ type: "tick-failed", symbol, error: msg(err) });
      }
    }

    if (symbols.length > 0 && ticks.size === 0) {
      failures++;
      if (failures === failureNotice && !announcedOutage) {
        announcedOutage = true;
        await send(
          `⚠️ Bot sinyal gagal membaca harga ${failures} kali berturut-turut. Kalau setelah ini tidak ada sinyal, itu BUKAN berarti tidak ada peluang.`,
          { type: "outage", at: now.toISOString() },
        );
      }
      await deps.sleep(opts.intervalMs);
      continue;
    }
    if (announcedOutage) {
      await send("✅ Bot sinyal sudah bisa membaca harga lagi.", { type: "recovered", at: now.toISOString() });
    }
    failures = 0;
    announcedOutage = false;

    // Exits first: a SELL is never held back by anything.
    for (const open of [...journal.open]) {
      const tick = ticks.get(open.symbol);
      if (!tick) continue;
      const exit = evaluateExit(open, tick, today, contexts.get(open.symbol) ?? null, deps.whales(open.symbol, today), cfg);
      if (!exit) continue;
      const snapshot = { ...open };
      if (exit.closes) {
        closeSignal(journal, open.id, { price: exit.price, kind: exit.kind, at: now.toISOString(), day: today });
        summary.exits++;
      } else {
        open.target1Hit = true;
        open.stop = open.entry;
      }
      changed = true;
      touchedToday.add(open.symbol);
      deps.saveJournal(journal);
      await send(exitText(snapshot, exit, now), { type: "exit", at: now.toISOString(), id: open.id, symbol: open.symbol, kind: exit.kind, price: exit.price });
    }

    // Entries, within the limits and the entry window.
    const hhmm = wibParts(now).hhmm;
    const entriesOpen = hhmm >= entryFrom && hhmm < entryUntil;
    for (const symbol of entriesOpen ? opts.symbols : []) {
      if (buysToday >= maxBuysPerDay || journal.open.length >= maxOpen) break;
      if (touchedToday.has(symbol) || journal.open.some((s) => s.symbol === symbol)) continue;
      const last = journal.lastClosed[symbol];
      if (last && weekdaysBetween(last, today) < cooldownDays) continue;
      const ctx = contexts.get(symbol);
      const tick = ticks.get(symbol);
      if (!ctx || !tick) continue;

      const whales = deps.whales(symbol, today);
      const decision = evaluateEntry(ctx, tick, whales, cfg);
      if (!decision.ok) continue;
      const plan = decision.plan;

      let note: { text: string } | null = null;
      if (deps.review) {
        const review = await deps.review({ plan, ctx, whales });
        if (review === null) {
          deps.record({ type: "review-unavailable", symbol });
        } else if (!review.approve) {
          summary.vetoes++;
          touchedToday.add(symbol);
          deps.record({ type: "vetoed", symbol, at: now.toISOString(), note: review.note, plan });
          continue;
        } else if (review.note) {
          note = { text: review.note };
        }
      }

      const id = `${today}-${symbol}`;
      journal.open.push({
        id,
        symbol,
        openedAt: now.toISOString(),
        openedDay: today,
        entry: plan.entry,
        stop: plan.stop,
        target1: plan.target1,
        target2: plan.target2,
        target1Hit: false,
      });
      changed = true;
      buysToday++;
      summary.buys++;
      touchedToday.add(symbol);
      deps.saveJournal(journal);
      await send(buyText(plan, now, note), { type: "buy", at: now.toISOString(), id, ...plan, aiNote: note?.text ?? null });
    }

    deps.record({ type: "pass", at: now.toISOString(), symbols: symbols.length, tickErrors, open: journal.open.length, buysToday, changed });
    await deps.sleep(opts.intervalMs);
  }

  return summary;
}
