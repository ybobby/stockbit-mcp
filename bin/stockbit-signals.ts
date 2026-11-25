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
import { claudeReviewer, DEFAULT_MODEL } from "../src/signals/ai.js";
import { journalPath, loadJournal, recap, saveJournal } from "../src/signals/ledger.js";
import { mondayOf, runSignalBot } from "../src/signals/loop.js";
import { recapText } from "../src/signals/messages.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stockbitDir } from "../src/paths.js";

const VALUE_FLAGS = new Set(["--max-buys", "--max-open"]);

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
  process.stdout.write(JSON.stringify(body) + "\n");
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

function signalLogPath(): string {
  return join(stockbitDir(), "signals", "signals.log");
}

async function run(): Promise<void> {
  const [, scopeToken, intervalToken] = positionals();

  let symbols: string[];
  let intervalMs: number;
  try {
    intervalMs = intervalToken ? parseInterval(intervalToken).ms : 120_000;
    if (!scopeToken) {
      symbols = [...DEFAULT_UNIVERSE];
    } else {
      const scope = parseScope(scopeToken);
      if (scope.kind === "all") {
        fail("bad-arguments", "`all` is not accepted: every symbol is analysed each morning.", "Name the stocks (BBCA,ANTM), use `watchlist`, or omit the scope for the built-in list.");
      }
      const resolved = await resolveScope(scope);
      symbols = resolved.symbols ?? [];
    }
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

  const aiOn = !flag("no-ai") && Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const model = process.env.STOCKBIT_SIGNALS_MODEL?.trim() || DEFAULT_MODEL;

  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  const nap = async (ms: number) => {
    const until = Date.now() + ms;
    while (!stopping && Date.now() < until) await sleep(Math.min(1000, until - Date.now()));
  };

  const analyzeDeps: AnalyzeDeps = {
    bars: (symbol, count) => core.getBars({ symbol, bars: count }),
    brokerSummary: (symbol, period) => core.getBrokerSummary({ symbol, period }),
    priceBands: (symbol) => core.getPriceBands(symbol),
    keystats: (symbol) => core.getKeystats(symbol),
    ratios: (symbol) => core.getRatios(symbol),
    sentiment: (symbol, limit) => getSentimentStream(symbol, limit),
  };

  process.stderr.write(
    `signal bot: ${symbols.length} symbols, every ${Math.round(intervalMs / 1000)}s` +
      `${dryRun ? ", DRY RUN (nothing sent)" : ", to Telegram"}; AI review ${aiOn ? `on (${model})` : "off"}; ` +
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
      review: aiOn ? claudeReviewer({ model }) : undefined,
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
  if (gate === "unknown-command") fail("unknown-command", `"${command}" is not a command.`, "Commands: run · status · recap");

  if (command === "run") return run();
  if (command === "status") return status();
  if (command === "recap") return recapCommand();
  fail("unknown-command", `"${command}" is not a command.`);
}

main().catch((err) => {
  fail("crashed", err instanceof Error ? err.message : String(err));
});
