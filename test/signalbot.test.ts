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

test("after the morning, only the BUY candidates and open signals are polled", async () => {
  const h = harness([1005]);
  const polled: string[] = [];
  h.deps.dailyContext = async (symbol) => ctx({ symbol, lean: symbol === "UP" ? "bullish" : "bearish" });
  h.deps.tick = async (symbol) => {
    polled.push(symbol);
    return { price: 1005, changePct: null };
  };
  await runSignalBot(h.deps, { symbols: ["UP", "DOWN", "FLAT"], intervalMs: 1, maxPasses: 3 });
  assert.deepEqual(polled, ["UP", "UP", "UP"]);

  polled.length = 0;
  await runSignalBot(h.deps, { symbols: ["UP", "DOWN", "FLAT"], intervalMs: 1, maxPasses: 1, watchAll: true });
  assert.deepEqual(polled, ["UP", "DOWN", "FLAT"]);
});

test("a rate-limit answer pauses polling and says so once a day; reads are randomly spaced", async () => {
  const h = harness([1005]);
  const slept: number[] = [];
  h.deps.sleep = async (ms) => {
    slept.push(ms);
  };
  h.deps.random = () => 0.5;
  h.deps.isRateLimited = (err) => err instanceof Error && err.message === "429";
  h.deps.tick = async () => {
    throw new Error("429");
  };
  const s = await runSignalBot(h.deps, {
    symbols: ["A", "B"],
    intervalMs: 1000,
    maxPasses: 2,
    rateLimitPauseMs: 900_000,
    pacingMs: [400, 2400],
    intervalJitter: 0.25,
  });
  assert.equal(s.rateLimited, 2);
  assert.equal(h.sent.length, 1, "one notice, not one per pause");
  assert.match(h.sent[0], /memperlambat/);
  assert.equal(slept.filter((ms) => ms === 900_000).length, 2);
  assert.ok(slept.includes(1400), "the pause between two morning reads is drawn from pacingMs");
  assert.ok(!h.sent.some((t) => t.includes("gagal membaca harga")), "a slow-down is not reported as an outage");
});

/* ---------------------------------- replay ----------------------------------- */

import { replayDay } from "../src/signals/replay.ts";
import { claudeCodeReviewer, reviewFromText } from "../src/signals/ai.ts";
import { replayText } from "../src/signals/messages.ts";
import { chmodSync } from "node:fs";

test("a replayed day produces timed BUY and SELL, and a SIMULASI summary", async () => {
  const at = (hhmm: string) => new Date(`2026-11-25T${hhmm}:00+07:00`).toISOString();
  const r = await replayDay({
    day: "2026-11-25",
    contexts: new Map([["TEST", ctx()], ["FLAT", { ...ctx(), symbol: "FLAT", lean: "neutral" as const }]]),
    series: new Map([
      ["TEST", [{ at: at("09:00"), price: 1005 }, { at: at("09:30"), price: 1020 }, { at: at("10:00"), price: 1070 }, { at: at("11:00"), price: 1015 }]],
      ["FLAT", [{ at: at("09:00"), price: 500 }]],
    ]),
    whales: () => [],
  });
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.buyAt, at("09:30"));
  assert.equal(t.buy, 1020);
  assert.equal(t.exitKind, "breakeven");
  assert.equal(t.sellAt, at("11:00"));
  // Sold at the price seen when the stop was found breached, not at the stop: -0.49%, not 0.
  assert.equal(t.returnPct, -0.49);
  assert.deepEqual(r.bullish, ["TEST"]);
  const text = replayText(r.day, r.trades, r.analysed, r.bullish);
  assert.match(text, /SIMULASI/);
  assert.match(text, /BELI 09:30/);
  assert.match(text, /JUAL 11:00/);
  assert.ok(text.includes(DISCLAIMER_ID));
});

test("reviewFromText tolerates prose around the JSON and rejects anything else", () => {
  assert.deepEqual(reviewFromText('ok: {"keputusan":"batal","catatan":"Lemah."}', {}), { approve: false, note: "Lemah." });
  assert.equal(reviewFromText("tidak tahu", {}), null);
  assert.equal(reviewFromText('{"keputusan":"mungkin"}', {}), null);
});

test("the Claude Code reviewer reads claude -p output and never passes the API key", async () => {
  const fake = join(STORE, "fake-claude");
  writeFileSync(
    fake,
    `#!/bin/sh\ncat >/dev/null\nif [ -n "$ANTHROPIC_API_KEY" ]; then echo leaked; exit 1; fi\necho '{"keputusan":"kirim","catatan":"Bukti searah."}'\n`,
  );
  chmodSync(fake, 0o755);
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  try {
    const d = evaluateEntry(ctx(), { price: 1020, changePct: 2 }, []);
    assert.ok(d.ok);
    if (!d.ok) return;
    const review = await claudeCodeReviewer({ command: fake })({ plan: d.plan, ctx: ctx(), whales: [] });
    assert.deepEqual(review, { approve: true, note: "Bukti searah." });
    const missing = await claudeCodeReviewer({ command: join(STORE, "nope") })({ plan: d.plan, ctx: ctx(), whales: [] });
    assert.equal(missing, null);
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

import { minuteSlots, spreadOverSession } from "../src/signals/replay.ts";

test("session minutes skip the break (Friday's is longer) and the closing auction", () => {
  const wed = minuteSlots("2026-11-25");
  assert.equal(wed.length, 180 + 140);
  assert.equal(wed[0], "2026-11-25T02:00:00.000Z"); // 09:00 WIB
  assert.equal(wed[180], "2026-11-25T06:30:00.000Z"); // 13:30 WIB
  assert.equal(wed[wed.length - 1], "2026-11-25T08:49:00.000Z"); // 15:49 WIB
  assert.equal(minuteSlots("2026-11-27").length, 150 + 110);
  const pts = spreadOverSession("2026-11-25", [1, 2, 3, 4]);
  assert.deepEqual(pts.map((p) => p.at), [wed[0], wed[80], wed[160], wed[240]]);
});

test("no new BUY outside the entry window, but exits still run", async () => {
  const at = (hhmm: string) => new Date(`2026-11-25T${hhmm}:00+07:00`).toISOString();
  const late = await replayDay({
    day: "2026-11-25",
    contexts: new Map([["TEST", ctx()]]),
    series: new Map([["TEST", [{ at: at("15:35"), price: 1020 }, { at: at("15:45"), price: 1030 }]]]),
    whales: () => [],
  });
  assert.equal(late.trades.length, 0);
  const early = await replayDay({
    day: "2026-11-25",
    contexts: new Map([["TEST", ctx()]]),
    series: new Map([["TEST", [{ at: at("15:00"), price: 1020 }, { at: at("15:45"), price: 950 }]]]),
    whales: () => [],
  });
  assert.equal(early.trades[0].exitKind, "stop");
  assert.equal(early.trades[0].sellAt, at("15:45"));
});

import { replayDays } from "../src/signals/replay.ts";
import { replayRangeText } from "../src/signals/messages.ts";

test("a multi-day replay carries the signal overnight and sells it on a later day", async () => {
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`).toISOString();
  const r = await replayDays([
    {
      day: "2026-11-23",
      contexts: new Map([["TEST", ctx()]]),
      series: new Map([["TEST", [{ at: at("2026-11-23", "10:00"), price: 1020 }, { at: at("2026-11-23", "15:00"), price: 1030 }]]]),
      whales: () => [],
    },
    {
      day: "2026-11-24",
      contexts: new Map([["TEST", ctx({ prevHigh: 1040 })]]),
      series: new Map([["TEST", [{ at: at("2026-11-24", "10:00"), price: 1035 }, { at: at("2026-11-24", "11:00"), price: 1115 }]]]),
      whales: () => [],
    },
  ]);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.buyAt, at("2026-11-23", "10:00"));
  assert.equal(t.sellAt, at("2026-11-24", "11:00"));
  assert.equal(t.exitKind, "target2");
  assert.equal(r.days[0].buys, 1);
  assert.equal(r.days[1].exits, 1);
  const text = replayRangeText(r.days, r.trades);
  assert.match(text, /2026-11-23 s\.d\. 2026-11-24/);
  assert.match(text, /BELI Sen 23\/11 10:00/);
  assert.match(text, /JUAL Sel 24\/11 11:00/);
});
