/**
 * What `stockbit-signals` accepts. Same gate as `stockbit-live`: an unknown flag is refused, never
 * ignored.
 */
import type { CommandTable } from "../cliargs.js";

export const SIGNALS_BIN = "stockbit-signals";

/** Liquid IDX names used when no scope is given. Edit freely; it is a starting list, not advice. */
export const DEFAULT_UNIVERSE = [
  "BBCA", "BBRI", "BMRI", "BBNI", "BRIS", "TLKM", "ASII", "UNTR", "ICBP", "INDF",
  "KLBF", "AMRT", "CPIN", "ANTM", "MDKA", "INCO", "ADRO", "PTBA", "ITMG", "MEDC",
  "PGAS", "SMGR", "GOTO", "TPIA", "AKRA",
] as const;

export const SIGNALS_COMMANDS: CommandTable = {
  run: {
    summary: "watch prices all session and send BUY/SELL signals to Telegram (no orders, ever)",
    usage: "[BBCA,ANTM|watchlist[:Name]] [1m|2m|5m]",
    flags: {
      "--dry-run": "decide and print, but send nothing to Telegram",
      "--no-ai": "skip the Claude review even when ANTHROPIC_API_KEY is set",
      "--always": "run even outside IDX hours (testing only: a shut market reads as flat)",
    },
    valueFlags: {
      "--max-buys": { placeholder: "N", help: "BUY messages per day (default 3)" },
      "--max-open": { placeholder: "N", help: "signals open at once (default 5)" },
    },
    positionals: [
      { name: "scope", required: false },
      { name: "time-frame", required: false },
    ],
    details: [
      "With no scope, a built-in list of 25 liquid IDX stocks is watched. `all` is not accepted:",
      "each symbol is analysed every morning, and the whole market is too many requests.",
      "Telegram: STOCKBIT_TELEGRAM_BOT_TOKEN and STOCKBIT_TELEGRAM_CHAT_ID (the whale watch's group).",
      "AI note and veto: ANTHROPIC_API_KEY; model from STOCKBIT_SIGNALS_MODEL (default claude-opus-5-5).",
    ],
  },
  status: {
    summary: "print the open signals and the last closed ones from the journal",
  },
  recap: {
    summary: "print (or with --send, post) this week's recap",
    flags: { "--send": "post the recap to Telegram instead of only printing it" },
  },
};

export const SIGNALS_EPILOGUE: readonly string[] = [
  "Signals only. This bin cannot place, amend or cancel an order, and its messages say so.",
];
