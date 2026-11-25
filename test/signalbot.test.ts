/**
 * The signal bot, replayed offline: the entry and exit rules, the journal, the AI guard, and a
 * scripted trading day through the loop.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-signalbot-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { evaluateEntry, evaluateExit, weekdaysBetween, type DailyContext, type OpenSignal } from "../src/signals/engine.ts";
import { closeSignal, emptyJournal, loadJournal, recap, saveJournal, type Journal } from "../src/signals/ledger.ts";
import { buyText, exitText, DISCLAIMER_ID } from "../src/signals/messages.ts";
import { noteIsGrounded, numbersIn } from "../src/signals/ai.ts";
import { tickFromQuote, whalesFromLog } from "../src/signals/context.ts";
import { mondayOf, runSignalBot, type SignalBotDeps } from "../src/signals/loop.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

const ctx = (over: Partial<DailyContext> = {}): DailyContext => ({
  symbol: "TEST",
  asOf: "2026-11-24",
  lean: "bullish",
  score: 50,
  confidence: 60,
  prevClose: 1000,
  prevHigh: 1010,
  prevLow: 980,
  atr: 20,
  ara: 1250,
  pillars: [
    { name: "brokerFlow", score: 40, reason: "" },
    { name: "trend", score: 60, reason: "" },
    { name: "valuation", score: 5, reason: "" },
  ],
  ...over,
});

/* ----------------------------------- entry ----------------------------------- */

test("a breakout above yesterday's high on a bullish day is a BUY with a tick-grid plan", () => {
  const d = evaluateEntry(ctx(), { price: 1020, changePct: 2 }, []);
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.equal(d.plan.entry, 1020);
  // max(prevLow 980, 1020 − 1.5×20 = 990) = 990, within 2–8%.
  assert.equal(d.plan.stop, 990);
  assert.equal(d.plan.target1, 1065);
  assert.equal(d.plan.target2, 1110);
  assert.match(d.plan.trigger, /menembus/);
  // Pillars under |10| say nothing and are left out.
  assert.equal(d.plan.reasons.length, 2);
});

test("no BUY without both gates", () => {
  assert.deepEqual(evaluateEntry(ctx({ lean: "neutral" }), { price: 1020, changePct: 2 }, []), { ok: false, reason: "daily-lean-neutral" });
  assert.deepEqual(evaluateEntry(ctx(), { price: 1005, changePct: 0.5 }, []), { ok: false, reason: "no-intraday-trigger" });
  assert.deepEqual(
    evaluateEntry(ctx({ pillars: [{ name: "brokerFlow", score: -20, reason: "" }] }), { price: 1020, changePct: 2 }, []),
    { ok: false, reason: "broker-flow-negative" },
  );
});

test("whale money with a rising price opens the gate without a breakout", () => {
  const d = evaluateEntry(ctx(), { price: 1005, changePct: 0.5 }, [{ kind: "value-surge", at: "", text: "" }]);
  assert.ok(d.ok);
  if (d.ok) assert.match(d.plan.trigger, /Whale/);
});

test("it refuses to chase, to buy near ARA, or to plan without an ATR", () => {
  assert.equal((evaluateEntry(ctx(), { price: 1090, changePct: 9 }, []) as { reason: string }).reason, "chasing");
  assert.equal((evaluateEntry(ctx({ ara: 1030 }), { price: 1020, changePct: 2 }, []) as { reason: string }).reason, "near-ara");
  assert.equal((evaluateEntry(ctx({ atr: null }), { price: 1020, changePct: 2 }, []) as { reason: string }).reason, "no-daily-bars");
});

/* ----------------------------------- exits ----------------------------------- */

const open = (over: Partial<OpenSignal> = {}): OpenSignal => ({
  id: "x",
  symbol: "TEST",
  openedAt: "",
  openedDay: "2026-11-23",
  entry: 1000,
  stop: 960,
  target1: 1060,
  target2: 1120,
  target1Hit: false,
  ...over,
});

test("exits: stop before targets, target 1 keeps it open, breakeven after target 1", () => {
  assert.deepEqual(evaluateExit(open(), { price: 955, changePct: -3 }, "2026-11-24", null, []), { kind: "stop", closes: true, price: 955 });
  assert.deepEqual(evaluateExit(open(), { price: 1065, changePct: 3 }, "2026-11-24", null, []), { kind: "target1", closes: false, price: 1065 });
  assert.deepEqual(evaluateExit(open(), { price: 1125, changePct: 3 }, "2026-11-24", null, []), { kind: "target2", closes: true, price: 1125 });
  assert.equal(evaluateExit(open({ target1Hit: true, stop: 1000 }), { price: 1000, changePct: 0 }, "2026-11-24", null, [])?.kind, "breakeven");
  assert.equal(evaluateExit(open(), { price: 1010, changePct: 0 }, "2026-11-24", null, []), null);
});

test("exits: a bearish morning, selling pressure, and time", () => {
  assert.equal(evaluateExit(open(), { price: 1010, changePct: 0 }, "2026-11-24", ctx({ lean: "bearish" }), [])?.kind, "flip");
  assert.equal(
    evaluateExit(open(), { price: 980, changePct: -2.5 }, "2026-11-24", ctx(), [{ kind: "value-surge", at: "", text: "" }])?.kind,
    "distribution",
  );
  assert.equal(evaluateExit(open(), { price: 1010, changePct: 0 }, "2026-12-07", null, [])?.kind, "time");
  assert.equal(weekdaysBetween("2026-11-20", "2026-11-23"), 1); // Fri → Mon
});

/* ---------------------------------- journal ---------------------------------- */

test("the journal round-trips, closes with a return, and recaps", () => {
  const j = emptyJournal();
  j.open.push(open({ id: "a" }), open({ id: "b", symbol: "OTHER" }));
  closeSignal(j, "a", { price: 1100, kind: "target2", at: "", day: "2026-11-25" });
  closeSignal(j, "b", { price: 950, kind: "stop", at: "", day: "2026-11-25" });
  saveJournal(j);
  const back = loadJournal();
  assert.equal(back.closed.length, 2);
  assert.equal(back.lastClosed.TEST, "2026-11-25");
  const r = recap(back, "2026-11-23");
  assert.equal(r.wins, 1);
  assert.equal(r.winRatePct, 50);
  assert.equal(r.avgReturnPct, 2.5);
  assert.equal(r.best?.symbol, "TEST");
  assert.equal(mondayOf("2026-11-27"), "2026-11-23");
});

/* --------------------------------- messages ---------------------------------- */

test("every message carries the disclaimer and none says an order was placed", () => {
  const d = evaluateEntry(ctx(), { price: 1020, changePct: 2 }, []);
  assert.ok(d.ok);
  if (!d.ok) return;
  const texts = [buyText(d.plan, new Date("2026-11-25T03:00:00Z"), { text: "Bukti searah." }), exitText(open(), { kind: "stop", closes: true, price: 955 }, new Date())];
  for (const t of texts) {
    assert.ok(t.includes(DISCLAIMER_ID));
    assert.doesNotMatch(t, /order (dikirim|ditempatkan)|sudah dibeli/i);
  }
  assert.match(texts[0], /SINYAL BELI: TEST/);
  assert.match(texts[0], /10:00 WIB/);
});

/* -------------------------------- AI guard ----------------------------------- */

test("an AI note that quotes a number not in the evidence is dropped", () => {
  assert.deepEqual(numbersIn("harga 1.250 naik 2,5%"), [1250, 2.5]);
  const evidence = { entry: 1250, change: 2.5 };
  assert.ok(noteIsGrounded("Harga 1.250 naik 2,5% dengan 3 pilar searah.", evidence));
  assert.equal(noteIsGrounded("Target realistis 1.400.", evidence), false);
});

/* ------------------------------ context readers ------------------------------ */

test("a quote with no price throws instead of reading as zero; the whale log is filtered to today", () => {
  assert.throws(() => tickFromQuote({ symbol: "X" }));
  assert.deepEqual(tickFromQuote({ symbol: "X", price: "1,020", percentage: "2.0" }), { price: 1020, changePct: 2 });
  const log = join(STORE, "whale.log");
  writeFileSync(
    log,
    [
      JSON.stringify({ type: "alert", symbol: "TEST", kind: "value-surge", at: "2026-11-25T03:00:00Z", headline: "h" }),
      JSON.stringify({ type: "alert", symbol: "TEST", kind: "value-surge", at: "2026-11-24T03:00:00Z", headline: "old" }),
      JSON.stringify({ type: "alert", symbol: "TEST", kind: "value-surge", at: "2026-11-25T04:00:00Z", dryRun: true }),
      '{"type":"alert","symbol":"TEST"', // torn line
    ].join("\n"),
  );
  const hits = whalesFromLog(log, "TEST", "2026-11-25");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "h");
});

/* ----------------------------------- loop ------------------------------------ */

function harness(prices: number[], opts: { veto?: boolean } = {}) {
  let journal: Journal = emptyJournal();
  const sent: string[] = [];
  let i = 0;
  const deps: SignalBotDeps = {
    now: () => new Date(Date.UTC(2026, 10, 25, 3, i)),
    sleep: async () => {},
    inWindow: () => true,
    stopped: () => false,
    dailyContext: async () => ctx(),
    tick: async () => ({ price: prices[Math.min(i, prices.length - 1)], changePct: null }),
    whales: () => [],
    send: async (t) => {
      sent.push(t);
      return null;
    },
    record: (e) => {
      if (e.type === "pass") i++;
    },
    loadJournal: () => journal,
    saveJournal: (j) => (journal = j),
    review: opts.veto === undefined ? undefined : async () => ({ approve: !opts.veto, note: null }),
    isAuthError: () => false,
  };
  return { deps, sent, journal: () => journal };
}

test("a day: breakout BUY once, target 1, then stop at breakeven SELL", async () => {
  const h = harness([1005, 1020, 1025, 1070, 1020, 1015]);
  const s = await runSignalBot(h.deps, { symbols: ["TEST"], intervalMs: 1, maxPasses: 6 });
  assert.equal(s.buys, 1, "one BUY per symbol per day, even though later ticks also break out");
  assert.equal(h.sent.filter((t) => t.startsWith("🟢")).length, 1);
  assert.equal(h.sent.filter((t) => t.startsWith("🎯")).length, 1);
  assert.ok(h.sent.some((t) => t.includes("balik ke harga beli")));
  assert.equal(h.journal().open.length, 0);
  assert.equal(h.journal().closed[0].exitKind, "breakeven");
});

test("an AI veto stops the BUY and the symbol is not retried today", async () => {
  const h = harness([1020, 1030, 1040], { veto: true });
  const s = await runSignalBot(h.deps, { symbols: ["TEST"], intervalMs: 1, maxPasses: 3 });
  assert.equal(s.buys, 0);
  assert.equal(s.vetoes, 1);
  assert.equal(h.sent.length, 0);
});

test("the daily BUY cap holds across symbols", async () => {
  const h = harness([1020]);
  const s = await runSignalBot(h.deps, { symbols: ["A", "B", "C", "D"], intervalMs: 1, maxPasses: 2, maxBuysPerDay: 2 });
  assert.equal(s.buys, 2);
});

test("an expired session sends one message and stops", async () => {
  const h = harness([1020]);
  h.deps.dailyContext = async () => {
    throw new Error("auth");
  };
  h.deps.isAuthError = () => true;
  const s = await runSignalBot(h.deps, { symbols: ["TEST"], intervalMs: 1, maxPasses: 3 });
  assert.equal(s.ended, "auth");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /login/);
});
