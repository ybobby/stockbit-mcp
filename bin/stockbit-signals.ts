#!/usr/bin/env node
/**
 * The signal bot: BUY and SELL messages to Telegram, all session. Signals only.
 *
 *   stockbit-signals run                       25 liquid stocks, every 2 minutes, to Telegram
 *   stockbit-signals run watchlist 2m          ...over the user's default watchlist
 *   stockbit-signals run BBCA,ANTM 1m --dry-run   print instead of sending
 *   stockbit-signals status                    open and recently closed signals
 *   stockbit-signals recap [--send]            this week's results
 *
 * See `src/signals/` for what decides a signal and `docs/SIGNALS.md` for running it.
 *
 * ## What it deliberately does NOT do
 *
 * It never places, amends or cancels an order and accepts no PIN. It reads market data through the
 * closed route table, reads the whale watch's log, and sends text (ADR-0012).
 */
import * as core from "../src/core/index.js";
import { getSentimentStream } from "../src/core/stream.js";
import { getSeriesBars } from "../src/core/market.js";
import { getIntradayPrices } from "../src/core/pricefeed.js";
import { isWithinPollingWindow, wibTodayIso } from "../src/core/sessionclock.js";
import { CliParseError, formatUsage, gateCommandLine, isHelpToken, isVersionToken } from "../src/cliargs.js";
import { VERSION } from "../src/version.js";
import { StockbitError } from "../src/http/errors.js";
import { parseInterval, IntervalParseError } from "../src/live/interval.js";
import { parseScope, resolveScope, ScopeParseError } from "../src/live/scope.js";
import { whaleLogPath } from "../src/live/whalewatch.js";
import { telegramTargetFromEnv, postTelegram } from "../src/alerts/notify.js";
import { analyze, type AnalyzeDeps } from "../src/analysis/analyze.js";
import { DEFAULT_UNIVERSE, SIGNALS_BIN, SIGNALS_COMMANDS, SIGNALS_EPILOGUE } from "../src/signals/cli.js";
import { buildContext, tickFromQuote, whalesFromLog } from "../src/signals/context.js";
import { claudeCodeReviewer, claudeReviewer, DEFAULT_MODEL, type AiReviewer } from "../src/signals/ai.js";
import { replayDays, spreadOverSession, type PricePoint } from "../src/signals/replay.js";
import type { DailyContext } from "../src/signals/engine.js";
import { journalPath, loadJournal, recap, saveJournal } from "../src/signals/ledger.js";
import { mondayOf, runSignalBot } from "../src/signals/loop.js";
import { recapText, replayRangeText } from "../src/signals/messages.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stockbitDir } from "../src/paths.js";

const VALUE_FLAGS = new Set(["--max-buys", "--max-open", "--ai"]);

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function positionals(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function emit(body: unknown): void {
  process.stdout.write(JSON.stringify(body, null, flag("pretty") ? 2 : 0) + "\n");
}

function fail(reason: string, detail: string, hint?: string): never {
  emit({ ok: false, reason, detail, ...(hint ? { hint } : {}) });
  process.exit(1);
}

function positiveInt(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail("bad-arguments", `--${name} must be a whole number of at least 1, got ${JSON.stringify(raw)}.`);
  return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function liveAnalyzeDeps(): AnalyzeDeps {
  return {
    bars: (symbol, count) => core.getBars({ symbol, bars: count }),
    brokerSummary: (symbol, period) => core.getBrokerSummary({ symbol, period }),
    priceBands: (symbol) => core.getPriceBands(symbol),
    keystats: (symbol) => core.getKeystats(symbol),
    ratios: (symbol) => core.getRatios(symbol),
    sentiment: (symbol, limit) => getSentimentStream(symbol, limit),
  };
}

/**
 * The same readers, cut off before `day`: bars dated `day` or later are dropped, and the broker
 * summary is asked for the fourteen calendar days that END yesterday. Without this a replay would
 * decide its morning BUY list with the afternoon's data.
 */
function asOfDayDeps(day: string): AnalyzeDeps {
  const live = liveAnalyzeDeps();
  const shift = (n: number) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  return {
    ...live,
    bars: async (symbol, count) => {
      const s = await core.getBars({ symbol, bars: count + 5 });
      return { ...s, bars: s.bars.filter((b) => b.date < day).slice(-count) };
    },
    brokerSummary: (symbol) => core.getBrokerSummary({ symbol, from: shift(-14), to: shift(-1) }),
  };
}

/** `2026-11-25 09:05:00` (Jakarta wall clock) → ISO. Null when there is no clock part. */
function jakartaIso(wall: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/.exec(wall);
  return m ? new Date(`${m[1]}T${m[2]}${m[3] ?? ":00"}+07:00`).toISOString() : null;
}

function signalLogPath(): string {
  return join(stockbitDir(), "signals", "signals.log");
}

async function symbolsFor(scopeToken: string | undefined): Promise<string[]> {
  if (!scopeToken) return [...DEFAULT_UNIVERSE];
  const scope = parseScope(scopeToken);
  if (scope.kind === "all") {
    fail("bad-arguments", "`all` is not accepted: every symbol is analysed each morning.", "Name the stocks (BBCA,ANTM), use `watchlist`, or omit the scope for the built-in list.");
  }
  return (await resolveScope(scope)).symbols ?? [];
}

/** `--ai api|claude-code|off`. Without the flag: api when a key is set (unless --no-ai), else off. */
function reviewerFor(defaultMode: "auto" | "off"): { review: AiReviewer | undefined; label: string } {
  const model = process.env.STOCKBIT_SIGNALS_MODEL?.trim() || undefined;
  let mode = option("ai") ?? (flag("no-ai") || defaultMode === "off" ? "off" : process.env.ANTHROPIC_API_KEY?.trim() ? "api" : "off");
  mode = mode.toLowerCase();
  if (mode === "off") return { review: undefined, label: "off" };
  if (mode === "api") {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) fail("bad-arguments", "--ai api needs ANTHROPIC_API_KEY.", "Use --ai claude-code to review on your Claude plan instead.");
    return { review: claudeReviewer({ model }), label: `api (${model ?? DEFAULT_MODEL})` };
  }
  if (mode === "claude-code") return { review: claudeCodeReviewer({ model }), label: "claude-code (Claude plan)" };
  fail("bad-arguments", `--ai must be api, claude-code or off, got ${JSON.stringify(mode)}.`);
}

async function run(): Promise<void> {
  const [, scopeToken, intervalToken] = positionals();

  let symbols: string[];
  let intervalMs: number;
  try {
    intervalMs = intervalToken ? parseInterval(intervalToken).ms : 120_000;
    symbols = await symbolsFor(scopeToken);
  } catch (err) {
    if (err instanceof ScopeParseError || err instanceof IntervalParseError) {
      fail("bad-arguments", err.message, "Usage: stockbit-signals run [BBCA,ANTM|watchlist] [1m|2m|5m]");
    }
    if (err instanceof StockbitError && err.kind === "auth") fail("auth", err.message, "Run stockbit-auth login.");
    throw err;
  }
  if (!symbols.length) fail("empty-scope", "Nothing to watch: the scope resolved to no symbols.");
  if (intervalMs < 60_000) fail("bad-arguments", "The signal bot polls at most once a minute.", "Use 1m, 2m or 5m.");

  const dryRun = flag("dry-run");
  const telegram = telegramTargetFromEnv();
  if (!dryRun && !telegram) {
    fail(
      "telegram-not-configured",
      "STOCKBIT_TELEGRAM_BOT_TOKEN and STOCKBIT_TELEGRAM_CHAT_ID must both be set, and the chat id must be numeric.",
      "Set them in the environment (never as flags), or pass --dry-run.",
    );
  }

  const ai = reviewerFor("auto");

  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  const nap = async (ms: number) => {
    const until = Date.now() + ms;
    while (!stopping && Date.now() < until) await sleep(Math.min(1000, until - Date.now()));
  };

  const analyzeDeps = liveAnalyzeDeps();

  process.stderr.write(
    `signal bot: ${symbols.length} symbols, every ${Math.round(intervalMs / 1000)}s` +
      `${dryRun ? ", DRY RUN (nothing sent)" : ", to Telegram"}; AI review ${ai.label}; ` +
      `journal ${journalPath()}. Ctrl-C to stop.\n`,
  );

  const summary = await runSignalBot(
    {
      now: () => new Date(),
      sleep: nap,
      inWindow: (now) => flag("always") || isWithinPollingWindow(now),
      stopped: () => stopping,
      dailyContext: async (symbol) => {
        const report = await analyze({ symbol, includeSentiment: false }, analyzeDeps);
        const series = await core.getBars({ symbol, bars: 40 });
        return buildContext(report, series.bars, wibTodayIso());
      },
      tick: async (symbol) => tickFromQuote(await core.getQuote(symbol)),
      whales: (symbol, day) => whalesFromLog(whaleLogPath(), symbol, day),
      send: async (text) => {
        if (dryRun || !telegram) {
          process.stderr.write(`\n${text}\n\n`);
          return null;
        }
        return postTelegram(telegram, text);
      },
      record: (event) => {
        const line = { ...event, ...(dryRun ? { dryRun: true } : {}) };
        try {
          mkdirSync(join(stockbitDir(), "signals"), { recursive: true });
          appendFileSync(signalLogPath(), `${JSON.stringify(line)}\n`, "utf8");
        } catch (err) {
          process.stderr.write(`log write failed: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        emit(line);
      },
      // A dry run must not write signals into the journal the real run and the recap read.
      loadJournal: dryRun ? (() => {
        let mem = loadJournal();
        return () => mem;
      })() : () => loadJournal(),
      saveJournal: dryRun ? () => {} : (j) => saveJournal(j),
      review: ai.review,
      isAuthError: (err) => err instanceof StockbitError && err.kind === "auth",
    },
    {
      symbols,
      intervalMs,
      maxBuysPerDay: positiveInt("max-buys", 3),
      maxOpen: positiveInt("max-open", 5),
    },
  );

  emit({ ok: summary.ended !== "auth", type: "summary", ...summary });
  if (summary.ended === "auth") process.exit(3);
}

/** Weekdays from `from` to `to`, inclusive. */
function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function replay(): Promise<void> {
  // `replay [scope] [from] [to]`. The scope is optional, so date-shaped tokens are always dates.
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const rest = positionals().slice(1);
  const dates = rest.filter((t) => DATE.test(t));
  const others = rest.filter((t) => !DATE.test(t));
  if (others.length > 1 || dates.length > 2) fail("bad-arguments", "Usage: stockbit-signals replay [BBCA,ANTM|watchlist] [from YYYY-MM-DD] [to YYYY-MM-DD]");
  const today = wibTodayIso();
  const from = dates[0] ?? today;
  const to = dates[1] ?? from;
  if (to < from) fail("bad-arguments", `The end date ${to} is before the start date ${from}.`);
  if (to > today) fail("bad-arguments", `${to} has not traded yet.`);
  const days = weekdays(from, to);
  if (!days.length) fail("bad-arguments", "No weekday in that range.");
  if (days.length > 5) fail("bad-arguments", "At most five trading days: intraday points older than a week are not available.");

  let symbols: string[];
  try {
    symbols = await symbolsFor(others[0]);
  } catch (err) {
    if (err instanceof ScopeParseError) fail("bad-arguments", err.message);
    if (err instanceof StockbitError && err.kind === "auth") fail("auth", err.message, "Run stockbit-auth login.");
    throw err;
  }
  const ai = reviewerFor("off");
  const telegram = flag("send") ? telegramTargetFromEnv() : null;
  if (flag("send") && !telegram) fail("telegram-not-configured", "STOCKBIT_TELEGRAM_BOT_TOKEN and STOCKBIT_TELEGRAM_CHAT_ID must both be set.");

  // Count what this run asks of Stockbit, so the cost of a replay (and of a live morning) is a
  // measured number rather than a guess. Counting only; every request still goes through the
  // closed route table.
  let stockbitRequests = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/stockbit\.com/i.test(url)) stockbitRequests++;
    return realFetch(input, init);
  }) as typeof fetch;

  const skipped: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const charts = new Map<string, Awaited<ReturnType<typeof getSeriesBars>>>();
  const perDay: Parameters<typeof replayDays>[0] = [];
  const morningRequests: Record<string, number> = {};

  for (const day of days) {
    const deps = asOfDayDeps(day);
    const contexts = new Map<string, DailyContext>();
    const series = new Map<string, PricePoint[]>();
    const before = stockbitRequests;
    for (const symbol of symbols) {
      process.stderr.write(`replay ${day}: ${symbol}\n`);
      try {
        const report = await analyze({ symbol, includeSentiment: false }, deps);
        const bars = await deps.bars(symbol, 40);
        contexts.set(symbol, buildContext(report, bars.bars, day));
      } catch (err) {
        if (err instanceof StockbitError && err.kind === "auth") fail("auth", err.message, "Run stockbit-auth login.");
        skipped[`${symbol} ${day}`] = err instanceof Error ? err.message : String(err);
        continue;
      }
      try {
        let pts: PricePoint[] = [];
        // Today: the one-minute close series, the finest this server reads. It carries no clock, so
        // times are spread over the session's trading minutes (see minuteSlots) and are approximate.
        if (day === today) {
          const minute = await getIntradayPrices(symbol, 1);
          const closes = minute.prices.filter((p): p is number => p !== null && p > 0);
          if (closes.length >= 30) {
            pts = spreadOverSession(day, closes);
            sources[`${symbol} ${day}`] = `1m (${closes.length} titik, jam perkiraan)`;
          }
        }
        // Another day: the chart's timestamped intraday points (coarser).
        if (!pts.length) {
          if (!charts.has(symbol)) charts.set(symbol, await getSeriesBars(symbol, "1w"));
          for (const b of charts.get(symbol)!.bars) {
            if (!String(b.date).startsWith(day)) continue;
            const at = jakartaIso(String(b.date));
            if (at && b.close > 0) pts.push({ at, price: b.close });
          }
          if (pts.length) sources[`${symbol} ${day}`] = `chart 1w (${pts.length} titik)`;
        }
        if (pts.length) series.set(symbol, pts);
        else skipped[`${symbol} ${day}`] = "no intraday points for that day";
      } catch (err) {
        if (err instanceof StockbitError && err.kind === "auth") fail("auth", err.message, "Run stockbit-auth login.");
        skipped[`${symbol} ${day}`] = err instanceof Error ? err.message : String(err);
      }
    }
    morningRequests[day] = stockbitRequests - before;
    perDay.push({
      day,
      contexts,
      series,
      whales: (symbol) => whalesFromLog(whaleLogPath(), symbol, day),
      review: ai.review,
      maxBuysPerDay: positiveInt("max-buys", 3),
    });
  }

  const result = await replayDays(perDay);

  let delivered: string | null = null;
  const summaryText = replayRangeText(result.days, result.trades);
  if (telegram) delivered = (await postTelegram(telegram, summaryText)) ?? "sent";

  // Series only for the symbols that traded unless --all-series, thinned to one point per 5 minutes.
  const traded = new Set(result.trades.map((t) => t.symbol));
  const keep = (s: string) => flag("all-series") || traded.has(s);
  // A minute series longer than the session's minutes puts two closes on one approximate minute;
  // keep the later one so a chart gets one point per time.
  const thin = (pts: PricePoint[]) =>
    pts.filter((p, i) => (i === pts.length - 1 || new Date(p.at).getUTCMinutes() % 5 === 0) && pts[i + 1]?.at !== p.at);
  const series: Record<string, PricePoint[]> = {};
  for (const d of perDay) for (const [s, pts] of d.series) if (keep(s)) (series[s] ??= []).push(...thin(pts));
  emit({
    ok: true,
    from,
    to,
    days: result.days,
    trades: result.trades,
    vetoes: result.vetoes,
    events: result.events.filter((e) => ["buy", "exit", "vetoed", "review-unavailable"].includes(e.type)),
    limits: result.limits,
    ai: ai.label,
    skipped,
    contexts: perDay.map((d) => ({ day: d.day, rows: [...d.contexts.values()].map((c) => ({ symbol: c.symbol, lean: c.lean, score: c.score, prevHigh: c.prevHigh })) })),
    sources,
    series,
    stockbitRequests: { total: stockbitRequests, perDay: morningRequests, symbols: symbols.length },
    summaryText,
    telegram: telegram ? delivered : "not sent (pass --send)",
  });
}

function status(): void {
  const j = loadJournal();
  emit({ ok: true, journal: journalPath(), open: j.open, recentlyClosed: j.closed.slice(-10) });
}

async function recapCommand(): Promise<void> {
  const now = new Date();
  const since = mondayOf(wibTodayIso(now));
  const r = recap(loadJournal(), since);
  const text = recapText(r, since, now);
  if (flag("send")) {
    const telegram = telegramTargetFromEnv();
    if (!telegram) fail("telegram-not-configured", "STOCKBIT_TELEGRAM_BOT_TOKEN and STOCKBIT_TELEGRAM_CHAT_ID must both be set.");
    const error = await postTelegram(telegram, text);
    if (error) fail("send-failed", error);
  }
  emit({ ok: true, since, ...r, text });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const explicit = positionals()[0];
  if (explicit === undefined ? args.some(isHelpToken) : isHelpToken(explicit)) {
    process.stdout.write(formatUsage(SIGNALS_BIN, SIGNALS_COMMANDS, undefined, SIGNALS_EPILOGUE));
    return;
  }
  if (explicit === undefined ? args.some(isVersionToken) : isVersionToken(explicit)) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const command = explicit ?? "status";
  const rest = [...args];
  const at = rest.indexOf(command);
  if (at !== -1) rest.splice(at, 1);
  let gate: "help" | "ok" | "unknown-command";
  try {
    gate = gateCommandLine(SIGNALS_BIN, SIGNALS_COMMANDS, command, rest, (text) => process.stdout.write(text));
  } catch (err) {
    if (err instanceof CliParseError) fail("bad-arguments", err.message, `Run \`stockbit-signals ${command} --help\`.`);
    throw err;
  }
  if (gate === "help") return;
  if (gate === "unknown-command") fail("unknown-command", `"${command}" is not a command.`, "Commands: run · replay · status · recap");

  if (command === "run") return run();
  if (command === "replay") return replay();
  if (command === "status") return status();
  if (command === "recap") return recapCommand();
  fail("unknown-command", `"${command}" is not a command.`);
}

main().catch((err) => {
  fail("crashed", err instanceof Error ? err.message : String(err));
});
