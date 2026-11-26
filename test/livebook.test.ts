/**
 * Deltas from the order book, not from top-stock.
 *
 * On 2026-11-26, during an open session, top-stock's `value` fell between reads and 27 of its rows
 * carried a negative `frequency`. Differencing it produced false "new session" resets and wall-change
 * alerts judged against traded volumes that never happened. These tests pin the replacement: the
 * watcher ranks on top-stock and differences each symbol's own book, whose figures are cumulative.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-livebook-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { deltaBetween, sampleFromBook, type SymbolSample } from "../src/live/tape.ts";
import { parseOrderBook } from "../src/live/orderbook.ts";
import {
  SignalWatcher,
  MAX_BOOK_GAP_SECONDS,
  HOT_SLOTS,
  ROTATION_SLOTS,
  QUEUE_SIZE,
  RANK_EVERY_MS,
  pickThisPass,
} from "../src/live/watcher.ts";
import { AlertEngine, FATIGUE_DEFAULTS } from "../src/live/alertengine.ts";
import { wallChange, DEFAULTS, type Signal } from "../src/live/signals.ts";
import { compilePrompt } from "../src/live/promptspec.ts";
import type { ResolvedScope } from "../src/live/scope.ts";

/* ------------------------------- fixtures ------------------------------- */

const lvl = (price: number, volume: number) => ({ price: String(price), volume: String(volume), que_num: "10" });

/** A book whose cumulative figures can be set per read. */
function book(symbol: string, value: number, frequency: number, volume: number) {
  return {
    symbol,
    lastprice: 750,
    previous: 765,
    open: 760,
    high: 770,
    low: 745,
    average: 755,
    frequency,
    value,
    volume,
    uma: false,
    notation: [],
    ara: { value: "935", visible: true },
    arb: { value: "640", visible: true },
    bid: [lvl(750, 1_000_000), lvl(745, 1_000_000), lvl(740, 1_000_000), lvl(735, 1_000_000), lvl(730, 1_000_000)],
    offer: [lvl(755, 1_000_000), lvl(760, 1_000_000), lvl(765, 1_000_000), lvl(770, 1_000_000), lvl(775, 1_000_000)],
  };
}

const raw = (n: number) => ({ raw: String(n), formatted: "x" });
/** A top-stock row whose figures, like the live ones, are NOT cumulative. */
const topRow = (code: string, value: number, frequency: number) => ({ code, value: raw(value), lot: raw(1000), frequency: raw(frequency) });

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

const realFetch = globalThis.fetch;
let topStock: unknown[] = [];
let books: Record<string, unknown> = {};
let bookRequests: string[] = [];
let topStockRequests = 0;

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/login/refresh")) return json({ data: { access_token: farFutureJwt() } });
    if (u.includes("/order-trade/top-stock")) {
      topStockRequests++;
      return json({ data: topStock });
    }
    const m = /\/orderbook\/companies\/([A-Z0-9]+)/.exec(u);
    if (m) {
      bookRequests.push(m[1]);
      return json({ message: "ok", data: books[m[1]] });
    }
    return json({ data: [] });
  }) as typeof fetch;
});

beforeEach(() => {
  topStock = [];
  books = {};
  bookRequests = [];
  topStockRequests = 0;
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(STORE, { recursive: true, force: true });
});

const ALL: ResolvedScope = { scope: { kind: "all" }, symbols: null } as unknown as ResolvedScope;

function watcher() {
  return new SignalWatcher({ scope: ALL, spec: compilePrompt(""), elapsedSeconds: () => 3 * 3600 });
}

/* ------------------------------ the samples ------------------------------ */

test("a book sample carries the book's cumulative figures, with volume turned into lots", () => {
  const b = parseOrderBook({ message: "ok", data: book("BMRI", 257_149_585_000, 14_839, 64_173_800) })!;
  const s = sampleFromBook(b);
  assert.equal(s.source, "book");
  assert.equal(s.value, 257_149_585_000);
  assert.equal(s.frequency, 14_839);
  assert.equal(s.lot, 641_738, "SHARES on the book, LOTS on the sample");
});

test("a delta between two book samples is what traded in between", () => {
  const a: SymbolSample = { symbol: "X", source: "book", value: 1_000, lot: 10, frequency: 5, average: null };
  const b: SymbolSample = { ...a, value: 4_000, lot: 40, frequency: 8 };
  const d = deltaBetween(a, b, 60)!;
  assert.equal(d.value, 3_000);
  assert.equal(d.lots, 30);
  assert.equal(d.trades, 3);
  assert.equal(d.sessionValue, 4_000);
  assert.equal(d.confidence, "few");
});

test("a counter that went backwards gives no delta, and neither does a change of source", () => {
  const a: SymbolSample = { symbol: "X", source: "book", value: 1_000, lot: 10, frequency: 5, average: null };
  assert.equal(deltaBetween(a, { ...a, value: 900 }, 60), null);
  assert.equal(deltaBetween(a, { ...a, source: "top-stock", value: 2_000 }, 60), null);
});

/* ------------------------------ the watcher ------------------------------ */

test("the watcher differences books, so a falling top-stock no longer reads as a new session", async () => {
  const w = watcher();
  const t0 = new Date("2026-11-26T03:00:00Z");

  topStock = [topRow("TLKM", 22_086_483_000, -510)];
  books = { TLKM: book("TLKM", 120_000_000_000, 6_000, 59_000_000) };
  const first = await w.pass(t0);
  assert.equal(first.deltas, null);
  assert.equal(first.reason, "first-poll");
  assert.deepEqual(first.booksRead, ["TLKM"]);

  // top-stock FALLS, as it did live. The book keeps climbing.
  topStock = [topRow("TLKM", 19_913_436_000, -591)];
  books = { TLKM: book("TLKM", 120_500_000_000, 6_040, 59_250_000) };
  const second = await w.pass(new Date(t0.getTime() + 60_000));
  assert.equal(second.reason, undefined, "no session-reset from a falling top-stock");
  assert.equal(second.deltas?.length, 1);
  const d = second.deltas![0];
  assert.equal(d.value, 500_000_000);
  assert.equal(d.trades, 40);
  assert.equal(d.lots, 2_500);
  assert.equal(d.seconds, 60);
});

test("a symbol with negative top-stock frequency is still chosen for a book read", async () => {
  const w = watcher();
  topStock = [topRow("AAAA", 5_000_000_000, -100), topRow("BBBB", 1_000_000_000, 50)];
  books = { AAAA: book("AAAA", 1e10, 1_000, 1e7), BBBB: book("BBBB", 1e9, 100, 1e6) };
  const r = await w.pass(new Date("2026-11-26T03:00:00Z"));
  assert.deepEqual(r.booksRead, ["AAAA", "BBBB"]);
});

test("a book reading older than the gap limit becomes a new baseline instead of a giant window", async () => {
  const w = watcher();
  const t0 = new Date("2026-11-26T03:00:00Z");
  topStock = [topRow("BMRI", 1e10, 10)];
  books = { BMRI: book("BMRI", 1e11, 10_000, 5e7) };
  await w.pass(t0);
  books = { BMRI: book("BMRI", 2e11, 20_000, 9e7) };
  const late = await w.pass(new Date(t0.getTime() + (MAX_BOOK_GAP_SECONDS + 60) * 1000));
  assert.equal(late.deltas, null, "half an hour of trading is not one window");
  books = { BMRI: book("BMRI", 2.01e11, 20_010, 9.01e7) };
  const next = await w.pass(new Date(t0.getTime() + (MAX_BOOK_GAP_SECONDS + 120) * 1000));
  assert.equal(next.deltas?.[0].value, 1e9);
});

test("a wall that grew while the book shows little trading is still reported, judged on the book's own volume", async () => {
  const w = watcher();
  const t0 = new Date("2026-11-26T03:00:00Z");
  topStock = [topRow("ASII", 5e9, 10)];
  books = { ASII: book("ASII", 1e11, 10_000, 5e7) };
  await w.pass(t0);
  const grown = book("ASII", 1.0001e11, 10_005, 5.0001e7);
  grown.bid[0] = lvl(750, 20_000_000);
  books = { ASII: grown };
  const r = await w.pass(new Date(t0.getTime() + 60_000));
  assert.equal(r.deltas?.[0].lots, 10);
  assert.ok(r.signals.some((s) => s.kind === "wall-change" && s.symbol === "ASII"), JSON.stringify(r.signals.map((s) => s.kind)));
});

/* ------------------------------ the rotation ------------------------------ */

const q = (n: number) => Array.from({ length: n }, (_, i) => ({ symbol: `S${String(i).padStart(2, "0")}` }));

test("the queue is 48: three hot slots plus nine rotating for five passes", () => {
  assert.equal(QUEUE_SIZE, 48);
  assert.equal(HOT_SLOTS + ROTATION_SLOTS, 12, "the per-pass request budget is unchanged");
});

test("five passes read every one of the 48, twelve books a pass, the top three every time", () => {
  const queue = q(48);
  let cursor = 0;
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const r = pickThisPass(queue, [], cursor);
    cursor = r.cursor;
    assert.equal(r.picked.length, 12);
    assert.deepEqual(r.picked.slice(0, 3).map((x) => x.symbol), ["S00", "S01", "S02"]);
    for (const x of r.picked) seen.add(x.symbol);
  }
  assert.equal(seen.size, 48);
});

test("a symbol that just alerted takes a hot slot ahead of the ranking", () => {
  const r = pickThisPass(q(48), ["S30"], 0);
  assert.deepEqual(r.picked.slice(0, 3).map((x) => x.symbol), ["S30", "S00", "S01"]);
  assert.equal(r.picked.filter((x) => x.symbol === "S30").length, 1, "never read twice in one pass");
  assert.equal(r.picked.length, 12);
});

test("a short queue is read in full without repeats", () => {
  const r = pickThisPass(q(5), [], 0);
  assert.deepEqual(r.picked.map((x) => x.symbol), ["S00", "S01", "S02", "S03", "S04"]);
});

test("top-stock is read once per re-rank, not every pass", async () => {
  const w = watcher();
  const t0 = new Date("2026-11-26T03:00:00Z").getTime();
  topStock = q(60).map((x, i) => topRow(x.symbol, 1e10 - i, 10));
  books = Object.fromEntries(q(60).map((x) => [x.symbol, book(x.symbol, 1e10, 1_000, 1e7)]));
  for (let i = 0; i < 5; i++) await w.pass(new Date(t0 + i * 60_000));
  assert.equal(topStockRequests, 1);
  assert.equal(bookRequests.length, 60, "twelve books a pass");
  assert.equal(new Set(bookRequests).size, 48);
  const r = await w.pass(new Date(t0 + RANK_EVERY_MS));
  assert.equal(topStockRequests, 2);
  assert.equal(r.ranked, true);
});

test("a rotating symbol read five minutes later still gets its delta", async () => {
  const w = watcher();
  const t0 = new Date("2026-11-26T03:00:00Z").getTime();
  topStock = q(48).map((x, i) => topRow(x.symbol, 1e10 - i, 10));
  books = Object.fromEntries(q(48).map((x) => [x.symbol, book(x.symbol, 1e10, 1_000, 1e7)]));
  for (let i = 0; i < 5; i++) await w.pass(new Date(t0 + i * 60_000));
  books = Object.fromEntries(q(48).map((x) => [x.symbol, book(x.symbol, 1.1e10, 1_100, 1.1e7)]));
  // Re-rank at +5 min restarts the rotation at the same order, so S03..S11 are read again.
  const r = await w.pass(new Date(t0 + 5 * 60_000));
  const s03 = r.deltas?.find((d) => d.symbol === "S03");
  assert.ok(s03, JSON.stringify(r.deltas?.map((d) => d.symbol)));
  assert.equal(s03.seconds, 300);
  assert.equal(s03.value, 1e9);
});

/* ------------------------------ the filters ------------------------------ */

const sig = (symbol: string): Signal => ({
  kind: "value-surge",
  symbol,
  severity: "alert",
  surprise: 2,
  headline: symbol,
  detail: [],
  priceBucket: 0,
  at: 0,
});

test("an uncapped engine lets every distinct alert through; the default still caps", () => {
  const now = new Date("2026-11-26T04:00:00Z"); // 11:00 WIB, outside the quiet periods
  const many = Array.from({ length: 40 }, (_, i) => sig(`X${i}`));
  const capped = new AlertEngine(FATIGUE_DEFAULTS).process(many, now, 1_000);
  assert.equal(capped.emitted.length, FATIGUE_DEFAULTS.maxPerInterval);
  const open = new AlertEngine({ ...FATIGUE_DEFAULTS, maxPerInterval: Infinity, maxPerSession: Infinity }).process(many, now, 1_000);
  assert.equal(open.emitted.length, 40);
});

test("a wall worth less than the rupiah floor is not reported", () => {
  const before = parseOrderBook(book("CUAN", 1e10, 1_000, 1e7))!;
  const small = book("CUAN", 1e10, 1_000, 1e7);
  small.bid[0] = lvl(750, 2_000_000); // +1,000,000 shares at 750 = Rp750 jt
  assert.equal(wallChange({ book: parseOrderBook(small)!, previous: before, tradedShares: 0 }, DEFAULTS), null);
  const big = book("CUAN", 1e10, 1_000, 1e7);
  big.bid[0] = lvl(750, 3_000_000); // +2,000,000 shares at 750 = Rp1,5 M
  assert.ok(wallChange({ book: parseOrderBook(big)!, previous: before, tradedShares: 0 }, DEFAULTS));
});

test("floor-locked is sent once per symbol per session, however long the lock lasts", () => {
  const engine = new AlertEngine({ ...FATIGUE_DEFAULTS, maxPerInterval: Infinity, maxPerSession: Infinity });
  const locked = (symbol: string): Signal => ({ ...sig(symbol), kind: "floor-locked", severity: "critical", surprise: 10 });
  const t0 = new Date("2026-11-26T04:00:00Z").getTime();
  assert.equal(engine.process([locked("MPXL")], new Date(t0), 1_000).emitted.length, 1);
  for (const minutes of [16, 60, 180]) {
    const r = engine.process([locked("MPXL")], new Date(t0 + minutes * 60_000), 1_000);
    assert.equal(r.emitted.length, 0, `still silent after ${minutes} minutes`);
  }
  assert.equal(engine.process([locked("CSMI")], new Date(t0 + 200 * 60_000), 1_000).emitted.length, 1, "another symbol still gets its one");
  engine.resetSession();
  assert.equal(engine.process([locked("MPXL")], new Date(t0 + 24 * 3600_000), 1_000).emitted.length, 1, "a new day starts fresh");
});
