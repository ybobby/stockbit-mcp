/**
 * The whale watch loop, replayed with no network and no waiting.
 *
 * Every side effect of `runWhaleWatch` goes through its deps, so these tests drive a scripted clock
 * and a scripted watcher and read back exactly what would have reached Telegram. The failures worth
 * guarding are the silent ones: a watcher that stops reading and goes quiet, a broker block that
 * reads as live, a new day that inherits yesterday's alert budget.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-whalewatch-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  runWhaleWatch,
  whaleText,
  brokerContextLines,
  elapsedTradingSeconds,
  wibClock,
  type WhaleWatchDeps,
} from "../src/live/whalewatch.ts";
import type { PassResult } from "../src/live/watcher.ts";
import type { Signal } from "../src/live/signals.ts";
import type { BandarContext } from "../src/live/bandar.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

/* ------------------------------- fixtures ------------------------------- */

/** 10:00 WIB on a Wednesday. */
const OPEN = new Date("2026-11-25T03:00:00Z");

const surge: Signal = {
  kind: "value-surge",
  symbol: "TEST",
  severity: "alert",
  surprise: 2.4,
  headline: "TEST: Rp 2.10 bn in 60s across 4 prints",
  detail: ["Average print Rp 525.0 jt vs Rp 40.0 jt for the session — 13.1x."],
  priceBucket: 100,
  at: OPEN.getTime(),
};

function pass(over: Partial<PassResult> = {}): PassResult {
  return {
    at: OPEN.getTime(),
    symbolsSeen: 100,
    deltas: [],
    signals: [],
    engine: { emitted: [], suppressed: [], marketWide: null },
    booksRead: [],
    errors: [],
    ...over,
  };
}

interface Harness {
  deps: WhaleWatchDeps;
  sent: string[];
  events: Record<string, unknown>[];
  watchersMade: () => number;
}

/**
 * A harness whose clock advances by `stepMs` on every sleep, and whose watcher answers from a script.
 * A script entry that is an Error is thrown from `pass`.
 */
function harness(
  script: (PassResult | Error)[],
  opts: { start?: Date; stepMs?: number; inWindow?: (d: Date) => boolean; context?: WhaleWatchDeps["brokerContext"]; sendError?: string } = {},
): Harness {
  let clock = (opts.start ?? OPEN).getTime();
  let i = 0;
  let made = 0;
  const sent: string[] = [];
  const events: Record<string, unknown>[] = [];
  const deps: WhaleWatchDeps = {
    newWatcher: () => {
      made++;
      return {
        pass: async () => {
          const next = script[i++];
          if (next instanceof Error) throw next;
          return next;
        },
      };
    },
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += opts.stepMs ?? ms;
    },
    inWindow: opts.inWindow ?? (() => true),
    send: async (text) => {
      sent.push(text);
      return opts.sendError ?? null;
    },
    brokerContext: opts.context,
    record: (e) => events.push(e),
    stopped: () => i >= script.length,
    isAuthError: (err) => err instanceof Error && err.message === "auth",
  };
  return { deps, sent, events, watchersMade: () => made };
}

/* ------------------------------- the loop ------------------------------- */

test("an emitted signal reaches Telegram once, with its headline and the WIB time", async () => {
  const h = harness([pass({ deltas: null, reason: "first-poll" }), pass({ signals: [surge], engine: { emitted: [surge], suppressed: [], marketWide: null } })]);
  const summary = await runWhaleWatch(h.deps, { intervalMs: 60_000 });

  assert.equal(summary.alertsSent, 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^🐋 TEST · value-surge · ALERT/);
  assert.match(h.sent[0], /Rp 2\.10 bn in 60s/);
  assert.match(h.sent[0], /10:01:00 WIB/);
  assert.match(h.sent[0], /not a trade signal/);
  const alert = h.events.find((e) => e.type === "alert");
  assert.equal(alert?.delivered, "sent");
});

test("detected but suppressed signals are logged, never sent", async () => {
  const h = harness([pass({ signals: [surge], engine: { emitted: [], suppressed: [{ signal: surge, emitted: false, reason: "cooldown" }], marketWide: null } })]);
  await runWhaleWatch(h.deps, { intervalMs: 60_000 });
  assert.equal(h.sent.length, 0);
  const p = h.events.find((e) => e.type === "pass");
  assert.equal(p?.detected, 1);
  assert.equal(p?.emitted, 0);
});

test("a market-wide trip is one message, not one per symbol", async () => {
  const mw = { kind: "value-surge" as const, count: 60, universe: 100, note: "60 of 100 symbols tripped value-surge at once — that is the market, not a stock." };
  const h = harness([pass({ engine: { emitted: [], suppressed: [], marketWide: mw } })]);
  await runWhaleWatch(h.deps, { intervalMs: 60_000 });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /Market-wide value-surge/);
});

test("an expired session sends one message and ends the loop as auth", async () => {
  const h = harness([pass(), new Error("auth"), pass({ engine: { emitted: [surge], suppressed: [], marketWide: null } })]);
  const summary = await runWhaleWatch(h.deps, { intervalMs: 60_000 });
  assert.equal(summary.ended, "auth");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /session is no longer valid/);
  assert.match(h.sent[0], /stockbit-auth login/);
});

test("repeated failures announce an outage once, then announce recovery", async () => {
  const boom = () => new Error("HTTP 502");
  const h = harness([boom(), boom(), boom(), boom(), boom(), pass()]);
  await runWhaleWatch(h.deps, { intervalMs: 60_000, failureNotice: 3 });
  assert.equal(h.sent.length, 2, h.sent.join("\n---\n"));
  assert.match(h.sent[0], /cannot read the market \(3 failed passes/);
  assert.match(h.sent[0], /does NOT mean a quiet market/);
  assert.match(h.sent[1], /reading the market again/);
  assert.equal(h.events.filter((e) => e.type === "pass-failed").length, 5);
});

test("a failed Telegram send is recorded, and does not stop the next alert", async () => {
  const e = { emitted: [surge, { ...surge, symbol: "OTHER" }], suppressed: [], marketWide: null };
  const h = harness([pass({ engine: e })], { sendError: "HTTP 429" });
  const summary = await runWhaleWatch(h.deps, { intervalMs: 60_000 });
  assert.equal(h.sent.length, 2);
  assert.equal(summary.sendFailures, 2);
  const alerts = h.events.filter((x) => x.type === "alert");
  assert.deepEqual(alerts.map((a) => a.delivered), ["failed", "failed"]);
  assert.equal(alerts[0].deliveryError, "HTTP 429");
});

test("outside the polling window nothing is polled, and closing is recorded once", async () => {
  // Window open for the first two minutes, then shut.
  const closeAt = OPEN.getTime() + 2 * 60_000;
  const h = harness([pass(), pass(), pass()], { inWindow: (d) => d.getTime() < closeAt || d.getTime() >= closeAt + 10 * 60_000 });
  await runWhaleWatch(h.deps, { intervalMs: 60_000, idleMs: 5 * 60_000 });
  const types = h.events.map((e) => e.type);
  assert.deepEqual(types, ["session-started", "pass", "pass", "session-closed", "session-started", "pass"]);
});

test("a new trading day gets a fresh watcher, so yesterday's alert budget does not carry over", async () => {
  // Each sleep jumps a whole day.
  const h = harness([pass(), pass(), pass()], { stepMs: 24 * 3600_000 });
  await runWhaleWatch(h.deps, { intervalMs: 60_000 });
  assert.equal(h.watchersMade(), 3);
});

test("broker context is fetched once per symbol per day and a failure costs only the block", async () => {
  let calls = 0;
  const e = { emitted: [surge], suppressed: [], marketWide: null };
  const h = harness([pass({ engine: e }), pass({ engine: e })], {
    context: async () => {
      calls++;
      throw new Error("HTTP 500");
    },
  });
  await runWhaleWatch(h.deps, { intervalMs: 60_000 });
  assert.equal(calls, 1);
  assert.equal(h.sent.length, 2, "both alerts still went out");
  assert.doesNotMatch(h.sent[0], /Broker context/);
  assert.ok(h.events.some((x) => x.type === "context-failed"));
});

/* ------------------------------- the words ------------------------------- */

const ctx = (over: Partial<BandarContext> = {}): BandarContext => ({
  symbol: "TEST",
  from: "2026-11-24",
  to: "2026-11-24",
  endOfDay: true,
  buyers: [],
  sellers: [],
  labels: [],
  degraded: false,
  degradedReason: null,
  lines: [
    "Biggest buyer AA (foreign): 1,000 lots, Rp 1.00 bn, 4 trades — 250 lots each, institution-like.",
    "Biggest seller BB (local): -900 lots, Rp -0.90 bn, 300 trades — 3 lots each, retail-like.",
    "Retail/institution split uses |netLots|/freq with our own boundaries.",
    "End-of-day data. Broker codes are closed during live trading, so this is never a real-time signal.",
  ],
  ...over,
});

test("the broker block names its date and says it is not live", () => {
  const lines = brokerContextLines(ctx());
  assert.ok(lines);
  assert.match(lines[0], /2026-11-24 \(end-of-day, NOT live\)/);
  assert.equal(lines.length, 3, "only the buyer and seller lines, not the methodology footnotes");
  const text = whaleText(surge, OPEN, lines);
  assert.match(text, /Biggest buyer AA/);
  assert.ok(text.indexOf("NOT live") > text.indexOf(surge.headline), "context comes after the live measurement");
});

test("a degraded or empty summary adds no block at all", () => {
  assert.equal(brokerContextLines(null), null);
  assert.equal(brokerContextLines(ctx({ degraded: true, degradedReason: "No broker rows came back." })), null);
  assert.equal(brokerContextLines(ctx({ lines: ["End-of-day data."] })), null);
});

test("the clock helpers speak WIB", () => {
  assert.equal(wibClock(OPEN), "10:00:00");
  assert.equal(elapsedTradingSeconds(OPEN), 3600);
  assert.equal(elapsedTradingSeconds(new Date("2026-11-25T01:00:00Z")), 60, "before the open floors at a minute");
});
