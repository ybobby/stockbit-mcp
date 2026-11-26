/**
 * The whale watch: the live detectors, run continuously, delivered to Telegram.
 *
 * `stockbit-live signals` runs ONE detection pass and exits. That shape is right for a caller that
 * asks a question and waits for the answer, and wrong for the thing people actually want from it —
 * a phone that buzzes when large money lands in a stock, without anyone sitting at a terminal. This
 * module is that loop. It adds no detector and changes no threshold: everything that decides truth
 * is still `signals.ts`, and everything that decides whether truth is worth an interruption is still
 * `alertengine.ts`. What lives here is the clock, the day boundary, the failure handling, and the
 * words that reach the chat.
 *
 * ## What a message may claim
 *
 * The same rules as the detectors. A value-surge alert says money arrived in large pieces; it never
 * names a buyer, because IDX closed broker codes in live running trade on 6 December 2021 and nobody
 * outside the exchange can see who is on either side today. The broker block appended to an alert is
 * the PREVIOUS session's end-of-day summary, and it says so in its own heading, with the date the API
 * reported. A reader who skims must not come away thinking a broker was seen buying this minute.
 *
 * ## Failure is loud, once
 *
 * A watcher that silently stopped reading is worse than none — the chat goes quiet and reads as a
 * calm market. So an expired session sends ONE Telegram message and ends the loop with a non-zero
 * exit, and a run of other failures sends one message when it starts and one when it clears, rather
 * than one per pass.
 *
 * ## Nothing here trades
 *
 * It reads `top-stock`, order books and the broker summary through the closed route table, and it
 * sends text. It cannot place, amend or cancel an order, and its messages must not read as if it
 * might.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stockbitDir } from "../paths.js";
import { wibTodayIso } from "../core/sessionclock.js";
import type { BandarContext } from "./bandar.js";
import type { PassResult } from "./watcher.js";
import type { EngineResult } from "./alertengine.js";
import { ANOMALY_KINDS, numId, rupiahId, type Severity, type Signal, type SignalKind } from "./signals.js";

/* ------------------------------------ the clock ------------------------------------ */

/** WIB is UTC+7 with no daylight saving. */
const WIB_MS = 7 * 3600_000;

/**
 * Seconds of continuous trading elapsed today, for the value-surge "what should this window have
 * carried" baseline. Floored at one minute so the very first minutes of the session cannot divide by
 * almost nothing and call every print a surge.
 *
 * The same arithmetic `stockbit-live signals` has always used, lifted here so the one-shot command
 * and the loop cannot drift apart.
 */
export function elapsedTradingSeconds(now: Date): number {
  const wib = new Date(now.getTime() + WIB_MS);
  const mins = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  return Math.max(60, (Math.min(mins, 16 * 60) - 9 * 60) * 60);
}

/** `HH:MM:SS` in WIB, for the foot of a message. */
export function wibClock(now: Date): string {
  return new Date(now.getTime() + WIB_MS).toISOString().slice(11, 19);
}

/* ------------------------------------ the words ------------------------------------ */

const MARK: Record<SignalKind, string> = {
  whale: "🐋",
  "value-surge": "📈",
  awakening: "🌅",
  "book-imbalance": "📚",
  "wall-change": "🧱",
  "band-approach": "📏",
  "uma-flag": "⚠️",
  "floor-locked": "⛔",
};

const SEVERITY_ID: Record<Severity, string> = {
  info: "Info",
  watch: "Pantau",
  alert: "Penting",
  critical: "Sangat penting",
};

const INVESTOR_ID: Record<string, string> = {
  foreign: "asing",
  local: "lokal",
  government: "pemerintah",
  unknown: "tidak diketahui",
};

const PROFILE_ID: Record<string, string> = {
  "retail-like": "pola ritel, banyak transaksi kecil",
  "institution-like": "pola institusi, sedikit transaksi besar",
  mixed: "pola campuran",
  unknown: "pola tidak terbaca",
};

/** "2026-11-24" → "24 Nov 2026". */
function tanggal(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const bulan = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"][Number(m[2]) - 1];
  return `${Number(m[3])} ${bulan ?? m[2]} ${m[1]}`;
}

/**
 * The previous session's broker summary, in a few plain Indonesian lines.
 *
 * Built from `readBandar`'s structured rows, with the retail/institution boundary taken from its
 * `profile` field so that boundary stays defined in exactly one place. A degraded read (no rows, or
 * a floor-locked book) yields null: "no broker data" is not context, and printing it under every
 * alert would teach the reader to skip the block.
 */
export function brokerContextLines(ctx: BandarContext | null): string[] | null {
  if (!ctx || ctx.degraded) return null;
  const lines: string[] = [];
  const row = (label: string, b: BandarContext["buyers"][number]) =>
    `• ${label} terbesar: ${b.code} (${INVESTOR_ID[b.investor] ?? b.investor}), ${numId(Math.abs(b.netLots))} lot, ${rupiahId(Math.abs(b.netValueIdr))}, ${PROFILE_ID[b.profile] ?? b.profile}.`;
  if (ctx.buyers[0]) lines.push(row("Pembeli", ctx.buyers[0]));
  if (ctx.sellers[0]) lines.push(row("Penjual", ctx.sellers[0]));
  const t3 = ctx.labels.find((l) => l.scope === "top3");
  if (t3?.label) lines.push(`• Pembacaan akumulasi/distribusi 3 broker teratas: ${t3.label}.`);
  if (!lines.length) return null;
  const when =
    ctx.from && ctx.to ? (ctx.from === ctx.to ? tanggal(ctx.from) : `${tanggal(ctx.from)} sampai ${tanggal(ctx.to)}`) : "sesi sebelumnya";
  return [`Data broker ${when} (data akhir hari, BUKAN live):`, ...lines];
}

/**
 * One alert as a Telegram message, in plain Indonesian. Plain text — `postTelegram` sends no
 * `parse_mode`, so nothing in a headline can make Telegram reject the message. Falls back to the
 * English text for a signal that carries no Indonesian.
 */
export function whaleText(signal: Signal, now: Date, context: string[] | null): string {
  const words = signal.id ?? { headline: signal.headline, detail: signal.detail };
  // Until a whale is confirmed on the tape, what the screener sees is an anomaly, and the message
  // says so. The states (locked at ARB, UMA) are facts rather than anomalies and keep their own words.
  const label = ANOMALY_KINDS.has(signal.kind) ? "Anomali · " : "";
  const lines = [`${MARK[signal.kind] ?? "•"} ${label}${words.headline}`, ...words.detail.map((d) => `• ${d}`)];
  if (context?.length) lines.push("", ...context);
  lines.push("", `Tingkat: ${SEVERITY_ID[signal.severity]} · ${wibClock(now)} WIB`, "Bukan rekomendasi beli atau jual.");
  return lines.join("\n");
}

export function marketWideText(mw: NonNullable<EngineResult["marketWide"]>, now: Date): string {
  return `📈 Sinyal yang sama muncul serentak di ${mw.count} dari ${mw.universe} saham.\nIni pergerakan pasar secara umum, bukan satu saham tertentu, jadi tidak dikirim per saham.\n\n${wibClock(now)} WIB`;
}

/* ------------------------------------ the log ------------------------------------ */

export function whaleLogPath(): string {
  return join(stockbitDir(), "whale-alerts.log");
}

/**
 * Append one line of JSONL. Written BEFORE Telegram is tried, for the reason `notify.ts` gives: an
 * alert that fired and was never seen must still have left a record.
 */
export function logWhaleEvent(event: Record<string, unknown>): void {
  mkdirSync(stockbitDir(), { recursive: true });
  appendFileSync(whaleLogPath(), `${JSON.stringify(event)}\n`, "utf8");
}

/* ------------------------------------ the loop ------------------------------------ */

export interface WhaleWatchDeps {
  /** A fresh detector for a new trading day. Its alert budget and baselines start empty. */
  newWatcher(): { pass(now: Date): Promise<PassResult> };
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Whether IDX is inside the polling window. */
  inWindow(now: Date): boolean;
  /**
   * Whether a failed pass at this moment counts toward the outage notice. Absent means always.
   *
   * The polling window opens at 08:45 for the pre-opening auction, when top-stock is legitimately
   * empty. On 2026-11-26 that emptiness was counted as three failures in a row, and the group was
   * told the watcher could not see the market a quarter of an hour before the market opened.
   */
  failureCounts?(now: Date): boolean;
  /** Send one message. Resolves to an error string, or null when delivered. */
  send(text: string): Promise<string | null>;
  /** Yesterday's broker context for a symbol, or null. May throw; a failure costs only the block. */
  brokerContext?(symbol: string): Promise<string[] | null>;
  /** One structured event per thing that happened, for stdout and the log. */
  record(event: Record<string, unknown>): void;
  /** Checked between passes, so Ctrl-C ends the loop at a clean boundary. */
  stopped(): boolean;
  /** True when the error means the Stockbit session is gone and polling cannot recover. */
  isAuthError(err: unknown): boolean;
}

export interface WhaleWatchOptions {
  intervalMs: number;
  /** How long to sleep while the market is shut. */
  idleMs?: number;
  /** Consecutive failed passes before the chat is told the watcher cannot see. */
  failureNotice?: number;
  /** Stop after this many passes. For tests; a real run leaves it unset. */
  maxPasses?: number;
}

export interface WhaleWatchSummary {
  passes: number;
  alertsSent: number;
  sendFailures: number;
  ended: "stopped" | "auth" | "max-passes";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run until stopped. Every side effect goes through `deps`, so a whole trading day — open, alerts,
 * an outage, the close, the next morning — replays in a unit test with no network and no waiting.
 */
export async function runWhaleWatch(deps: WhaleWatchDeps, opts: WhaleWatchOptions): Promise<WhaleWatchSummary> {
  const idleMs = opts.idleMs ?? 60_000;
  const failureNotice = opts.failureNotice ?? 3;
  const summary: WhaleWatchSummary = { passes: 0, alertsSent: 0, sendFailures: 0, ended: "stopped" };

  let watcher: ReturnType<WhaleWatchDeps["newWatcher"]> | null = null;
  let day: string | null = null;
  let failures = 0;
  let announcedOutage = false;
  const contextCache = new Map<string, string[] | null>();

  const send = async (text: string, event: Record<string, unknown>): Promise<void> => {
    const error = await deps.send(text);
    if (error) summary.sendFailures++;
    deps.record({ ...event, delivered: error ? "failed" : "sent", ...(error ? { deliveryError: error } : {}) });
  };

  const contextFor = async (symbol: string): Promise<string[] | null> => {
    if (!deps.brokerContext) return null;
    if (contextCache.has(symbol)) return contextCache.get(symbol) ?? null;
    let lines: string[] | null = null;
    try {
      lines = await deps.brokerContext(symbol);
    } catch (err) {
      deps.record({ type: "context-failed", symbol, error: message(err) });
    }
    contextCache.set(symbol, lines);
    return lines;
  };

  while (!deps.stopped()) {
    if (opts.maxPasses !== undefined && summary.passes >= opts.maxPasses) {
      summary.ended = "max-passes";
      break;
    }
    const now = deps.now();

    if (!deps.inWindow(now)) {
      if (watcher) {
        deps.record({ type: "session-closed", day, at: now.toISOString() });
        watcher = null;
      }
      await deps.sleep(idleMs);
      continue;
    }

    // A new trading day gets a new detector: a fresh baseline, a fresh alert budget, and a fresh
    // broker-context cache, since "yesterday" has moved.
    const today = wibTodayIso(now);
    if (!watcher || day !== today) {
      watcher = deps.newWatcher();
      day = today;
      contextCache.clear();
      deps.record({ type: "session-started", day, at: now.toISOString() });
    }

    summary.passes++;
    let result: PassResult;
    try {
      result = await watcher.pass(now);
    } catch (err) {
      if (deps.isAuthError(err)) {
        // Polling cannot fix this, and a loop that kept trying would sit silently forever.
        await send(
          `⛔ Whale watch berhenti: sesi login ke sumber data sudah tidak berlaku.\nAdmin perlu login ulang, lalu menjalankan whale watch lagi.\n${wibClock(now)} WIB`,
          // The group text names no provider; the operator's log line carries the actual fix.
          { type: "stopped-auth", at: now.toISOString(), fix: "stockbit-auth login" },
        );
        summary.ended = "auth";
        return summary;
      }
      if (deps.failureCounts && !deps.failureCounts(now)) {
        // Outside continuous trading an empty market is expected. Logged, not counted.
        deps.record({ type: "pass-failed", at: now.toISOString(), counted: false, error: message(err) });
        await deps.sleep(opts.intervalMs);
        continue;
      }
      failures++;
      deps.record({ type: "pass-failed", at: now.toISOString(), consecutive: failures, error: message(err) });
      if (failures === failureNotice && !announcedOutage) {
        announcedOutage = true;
        await send(
          `⚠️ Whale watch gagal membaca data pasar ${failures} kali berturut-turut. Kalau setelah ini sepi, itu BUKAN berarti pasar sepi.\n${wibClock(now)} WIB`,
          { type: "outage", at: now.toISOString(), consecutive: failures },
        );
      }
      await deps.sleep(opts.intervalMs);
      continue;
    }

    if (announcedOutage) {
      await send(`✅ Whale watch sudah bisa membaca data pasar lagi.\n${wibClock(now)} WIB`, {
        type: "recovered",
        at: now.toISOString(),
      });
    }
    failures = 0;
    announcedOutage = false;

    deps.record({
      type: "pass",
      at: now.toISOString(),
      symbolsSeen: result.symbolsSeen,
      ...(result.moversOnly !== undefined ? { moversOnly: result.moversOnly } : {}),
      ...(result.ranked ? { ranked: true } : {}),
      booksRead: result.booksRead.length,
      ...(result.whale ? { whale: result.whale } : {}),
      baseline: result.deltas === null,
      ...(result.reason ? { reason: result.reason } : {}),
      detected: result.signals.length,
      emitted: result.engine?.emitted.length ?? 0,
      errors: result.errors,
    });

    if (result.engine?.marketWide) {
      await send(marketWideText(result.engine.marketWide, now), {
        type: "market-wide",
        at: now.toISOString(),
        ...result.engine.marketWide,
      });
    }

    for (const signal of result.engine?.emitted ?? []) {
      const context = await contextFor(signal.symbol);
      await send(whaleText(signal, now, context), {
        type: "alert",
        at: now.toISOString(),
        symbol: signal.symbol,
        kind: signal.kind,
        severity: signal.severity,
        surprise: Number(signal.surprise.toFixed(3)),
        headline: signal.headline,
        detail: signal.detail,
        brokerContext: context !== null,
      });
      summary.alertsSent++;
    }

    for (const text of result.followUps ?? []) {
      await send(`${text}\n${wibClock(now)} WIB`, { type: "whale-follow", at: now.toISOString(), text });
      summary.alertsSent++;
    }

    await deps.sleep(opts.intervalMs);
  }

  return summary;
}
