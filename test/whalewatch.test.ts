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
  telegramHtml,
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
  id: {
    headline: "TEST: transaksi besar masuk",
    detail: ["Rp 2,10 M berpindah tangan dalam 60 detik lewat 4 transaksi."],
  },
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
  // Unconfirmed on the tape, a value surge is an anomaly and says so; 🐋 is kept for confirmed whales.
  assert.match(h.sent[0], /^📈 Anomali · TEST: transaksi besar masuk/);
  assert.match(h.sent[0], /Rp 2,10 M berpindah tangan/);
  assert.match(h.sent[0], /Tingkat: 🟧 <b>Penting<\/b> · 10:01:00 WIB/);
  assert.match(h.sent[0], /Bukan rekomendasi beli atau jual/);
  assert.doesNotMatch(h.sent[0], /bn in 60s/, "the Indonesian text replaces the English, it is not appended");
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
  assert.match(h.sent[0], /serentak di 60 dari 100 saham/);
});

test("an expired session sends one message and ends the loop as auth", async () => {
  const h = harness([pass(), new Error("auth"), pass({ engine: { emitted: [surge], suppressed: [], marketWide: null } })]);
  const summary = await runWhaleWatch(h.deps, { intervalMs: 60_000 });
  assert.equal(summary.ended, "auth");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /mode maintenance/);
  assert.match(h.sent[0], /aktif lagi setelah ada pemberitahuan berikutnya/);
  assert.doesNotMatch(h.sent[0], /stockbit|login|admin/i, "the group gets a neutral notice, not the chore");
});

test("after a maintenance stop, the first good pass of the next run tells the group it is back, once", async () => {
  let flagged = false;
  const maintenance = { pending: () => flagged, set: () => { flagged = true; }, clear: () => { flagged = false; } };
  const down = harness([new Error("auth")]);
  down.deps.maintenance = maintenance;
  await runWhaleWatch(down.deps, { intervalMs: 60_000 });
  assert.equal(flagged, true);

  const up = harness([pass(), pass()]);
  up.deps.maintenance = maintenance;
  await runWhaleWatch(up.deps, { intervalMs: 60_000 });
  assert.equal(up.sent.filter((t) => /aktif kembali/.test(t)).length, 1);
  assert.equal(flagged, false);
});

test("repeated failures announce an outage once, then announce recovery", async () => {
  const boom = () => new Error("HTTP 502");
  const h = harness([boom(), boom(), boom(), boom(), boom(), pass()]);
  await runWhaleWatch(h.deps, { intervalMs: 60_000, failureNotice: 3 });
  assert.equal(h.sent.length, 2, h.sent.join("\n---\n"));
  assert.match(h.sent[0], /gagal membaca data pasar 3 kali berturut-turut/);
  assert.match(h.sent[0], /BUKAN berarti pasar sepi/);
  assert.match(h.sent[1], /bisa membaca data pasar lagi/);
  assert.equal(h.events.filter((e) => e.type === "pass-failed").length, 5);
});

test("an empty market before the open is logged but never announced as an outage", async () => {
  // 2026-11-26: top-stock was empty through the 08:45 pre-opening, and the group was told the
  // watcher could not see the market fifteen minutes before it opened.
  const empty = () => new Error("top-stock returned no readable rows");
  const h = harness([empty(), empty(), empty(), empty(), pass()]);
  let n = 0;
  h.deps.failureCounts = () => n++ >= 4;
  await runWhaleWatch(h.deps, { intervalMs: 60_000, failureNotice: 3 });
  assert.deepEqual(h.sent, [], h.sent.join("\n---\n"));
  const failed = h.events.filter((e) => e.type === "pass-failed");
  assert.equal(failed.length, 4);
  assert.ok(failed.every((e) => e.counted === false));
});

test("once trading is on, the same failures do count", async () => {
  const boom = () => new Error("HTTP 502");
  const h = harness([boom(), boom(), boom(), pass()]);
  h.deps.failureCounts = () => true;
  await runWhaleWatch(h.deps, { intervalMs: 60_000, failureNotice: 3 });
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[0], /gagal membaca data pasar 3 kali/);
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
  assert.doesNotMatch(h.sent[0], /Data broker/);
  assert.ok(h.events.some((x) => x.type === "context-failed"));
});

/* ------------------------------- the words ------------------------------- */

const ctx = (over: Partial<BandarContext> = {}): BandarContext => ({
  symbol: "TEST",
  from: "2026-11-24",
  to: "2026-11-24",
  endOfDay: true,
  buyers: [
    { code: "AA", investor: "foreign", netLots: 1000, netValueIdr: 1e9, avgPrice: 1000, freq: 4, lotsPerTrade: 250, profile: "institution-like" },
  ],
  sellers: [
    { code: "BB", investor: "local", netLots: -900, netValueIdr: -9e8, avgPrice: 1000, freq: 300, lotsPerTrade: 3, profile: "retail-like" },
  ],
  labels: [{ scope: "top3", label: "Acc", amountIdr: 1e9, percent: 12 }],
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
  assert.match(lines[0], /^Data broker 24 Nov 2026 \(data akhir hari, BUKAN live\):$/);
  assert.match(lines[1], /Pembeli terbesar: AA \(asing\), 1\.000 lot, Rp 1,00 M, pola institusi/);
  assert.match(lines[2], /Penjual terbesar: BB \(lokal\), 900 lot, Rp 900 jt, pola ritel/, "sell magnitudes, not the wire's negative sign");
  assert.match(lines[3], /3 broker teratas: Acc/);
  const text = whaleText(surge, OPEN, lines);
  assert.ok(text.indexOf("BUKAN live") > text.indexOf(surge.id!.headline), "context comes after the live measurement");
});

test("the Telegram text names no data provider, so the alert reads as a market observation", () => {
  const text = whaleText(surge, OPEN, brokerContextLines(ctx()));
  assert.doesNotMatch(text, /stockbit/i);
});

test("a signal without Indonesian text still sends, in English", () => {
  const { id: _drop, ...english } = surge;
  assert.match(whaleText(english, OPEN, null), /Rp 2\.10 bn in 60s/);
});

test("a degraded or empty summary adds no block at all", () => {
  assert.equal(brokerContextLines(null), null);
  assert.equal(brokerContextLines(ctx({ degraded: true, degradedReason: "No broker rows came back." })), null);
  assert.equal(brokerContextLines(ctx({ buyers: [], sellers: [], labels: [] })), null);
});

test("the clock helpers speak WIB", () => {
  assert.equal(wibClock(OPEN), "10:00:00");
  assert.equal(elapsedTradingSeconds(OPEN), 3600);
  assert.equal(elapsedTradingSeconds(new Date("2026-11-25T01:00:00Z")), 60, "before the open floors at a minute");
});

test("the Telegram text escapes everything, then marks the level and HAKA/HAKI in colour and bold", () => {
  const html = telegramHtml("X <b>&: order beli besar (HAKA)\n• jual (HAKI)\n\nTingkat: Sangat penting · 10:01:00 WIB");
  assert.match(html, /X &lt;b&gt;&amp;:/, "nothing in the text can open a tag");
  assert.match(html, /\(🟢 <b>HAKA<\/b>\)/);
  assert.match(html, /\(🔴 <b>HAKI<\/b>\)/);
  assert.match(html, /Tingkat: 🟥 <b>Sangat penting<\/b> ·/);
  assert.match(telegramHtml("Tingkat: Pantau · 1"), /🟨 <b>Pantau<\/b>/);
});
