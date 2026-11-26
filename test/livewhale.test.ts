/**
 * The whale confirmation stage: tape prints judged against each stock's own liquidity.
 *
 * Offline. Rows are shaped like the live `/order-trade/running-trade` rows measured on 2026-11-26
 * (string prices with thousands separators, `value: {raw}`, `action` buy/sell), with invented
 * numbers and no account data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-livewhale-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import {
  parsePrints,
  whaleThreshold,
  minimumLotFor,
  judgePrints,
  whaleSignal,
  followUpText,
  WHALE_DEFAULTS,
  type Print,
} from "../src/live/prints.ts";
import { AdvCache, WhaleConfirmer, readTape, CONFIRM_LIMITS } from "../src/live/confirm.ts";
import { SignalWatcher } from "../src/live/watcher.ts";
import { compilePrompt } from "../src/live/promptspec.ts";
import type { ResolvedScope } from "../src/live/scope.ts";

/* ------------------------------- fixtures ------------------------------- */

let seq = 1_000;
function row(code: string, time: string, price: number, lots: number, action: "buy" | "sell" | "", board = "RG") {
  return {
    id: String(5_000_000 + seq),
    time,
    action,
    code,
    price: price.toLocaleString("en-US"),
    lot: lots.toLocaleString("en-US"),
    trade_number: String(seq++),
    market_board: board,
    value: { raw: lots * 100 * price, formatted: "x" },
  };
}

const print = (over: Partial<Print>): Print => ({
  tradeNumber: seq++,
  time: "10:00:00",
  seconds: 36_000,
  symbol: "KECL",
  price: 100,
  lots: 1,
  value: 10_000,
  side: "buy",
  ...over,
});

/** An ADV cache with fixed values and no disk or network. */
class FixedAdv extends AdvCache {
  loads: string[] = [];
  constructor(private readonly fixed: Record<string, number | null>) {
    super(join(STORE, `adv-${Math.random()}.json`));
  }
  override has(symbol: string): boolean {
    return symbol in this.fixed && this.loads.includes(symbol);
  }
  override get(symbol: string): number | null {
    return this.fixed[symbol] ?? null;
  }
  override async load(symbol: string): Promise<number | null> {
    this.loads.push(symbol);
    return this.fixed[symbol] ?? null;
  }
}

/* ------------------------------- the network ------------------------------- */

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

const realFetch = globalThis.fetch;
/** Running-trade rows the fake tape serves, newest first, keyed by symbol ("" = market-wide). */
let tape: Record<string, unknown[]> = {};
let tapeUrls: string[] = [];
let topStock: unknown[] = [];
let books: Record<string, unknown> = {};

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = new URL(String(url));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname.includes("/login/refresh")) return json({ data: { access_token: farFutureJwt() } });
    if (u.pathname.endsWith("/order-trade/running-trade")) {
      tapeUrls.push(u.search);
      const sym = u.searchParams.get("symbols") ?? "";
      const minLot = Number(u.searchParams.get("minimum_lot") ?? 0);
      const before = u.searchParams.get("trade_number");
      let rows = (tape[sym] ?? []).filter((r) => Number(String((r as { lot: string }).lot).replace(/,/g, "")) >= minLot);
      if (before) rows = rows.filter((r) => Number((r as { trade_number: string }).trade_number) <= Number(before));
      return json({ message: "ok", data: rows.slice(0, 100) });
    }
    if (u.pathname.endsWith("/order-trade/top-stock")) return json({ data: topStock });
    const m = /\/orderbook\/companies\/([A-Z0-9]+)/.exec(u.pathname);
    if (m) return json({ message: "ok", data: books[m[1]] });
    return json({ data: [] });
  }) as typeof fetch;
});

beforeEach(() => {
  tape = {};
  tapeUrls = [];
  topStock = [];
  books = {};
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(STORE, { recursive: true, force: true });
});

/* ------------------------------- parsing ------------------------------- */

test("prints keep the regular board and a known aggressor, and read separators and value.raw", () => {
  const ps = parsePrints([
    row("ZATA", "13:41:25", 40, 2_600, "buy"),
    row("BBCA", "13:41:26", 5_825, 1_000, "sell"),
    row("BBCA", "08:58:00", 5_825, 50, ""), // auction: no aggressor
    row("BBCA", "13:41:27", 5_825, 9_000, "buy", "NG"), // negotiated
  ]);
  assert.deepEqual(ps.map((p) => p.symbol), ["ZATA", "BBCA"]);
  assert.equal(ps[0].lots, 2_600);
  assert.equal(ps[0].value, 10_400_000);
  assert.equal(ps[1].price, 5_825);
  assert.equal(ps[1].side, "sell");
  assert.equal(ps[1].seconds, 13 * 3600 + 41 * 60 + 26);
});

/* ------------------------------- thresholds ------------------------------- */

test("the threshold scales with each stock's own liquidity, by tier", () => {
  // Rp1 M in BBCA is not a whale; Rp100 jt in a thin small-cap can be.
  const cases: [number, number][] = [
    [1_000_000_000_000, 2_500_000_000], // > Rp250 M: 0.25%
    [300_000_000_000, 1_250_000_000], // > Rp250 M, under the tier floor
    [200_000_000_000, 1_000_000_000], // Rp100-250 M: 0.5%
    [120_000_000_000, 1_000_000_000], // Rp100-250 M, floored at Rp1 M
    [60_000_000_000, 600_000_000], // Rp5-100 M: 1%
    [10_000_000_000, 200_000_000], // Rp5-100 M, floored at Rp200 jt
    [4_000_000_000, 200_000_000], // < Rp5 M: 5%
    [1_000_000_000, 100_000_000], // < Rp5 M, floored at Rp100 jt
  ];
  for (const [adv20, want] of cases) {
    const th = whaleThreshold({ adv20, sessionMeanPrint: null });
    assert.equal(th.value, want, `ADV ${adv20}`);
    assert.equal(th.basis, "adv");
  }
  const giant = whaleThreshold({ adv20: 50_000_000_000_000, sessionMeanPrint: null });
  assert.equal(giant.value, WHALE_DEFAULTS.maxValue, "capped");
});

test("a slightly more liquid stock never gets a lower threshold at the Rp100 M and Rp250 M edges", () => {
  // The Rp5 M edge is the owner's choice and does step down, from 5% of just under Rp5 M (~Rp250 jt)
  // to the Rp200 jt floor of the tier above.
  for (const edge of [100_000_000_000, 250_000_000_000]) {
    const below = whaleThreshold({ adv20: edge - 1, sessionMeanPrint: null }).value;
    const at = whaleThreshold({ adv20: edge, sessionMeanPrint: null }).value;
    assert.ok(at >= below - 1, `edge ${edge}: ${below} then ${at}`);
  }
});

test("an unusually busy day raises the bar through today's own average print", () => {
  const th = whaleThreshold({ adv20: 10_000_000_000, sessionMeanPrint: 30_000_000 });
  assert.equal(th.value, 300_000_000);
  assert.equal(th.basis, "session");
});

test("without an ADV the fallback floor stands in, and says so", () => {
  const th = whaleThreshold({ adv20: null, sessionMeanPrint: null });
  assert.equal(th.value, WHALE_DEFAULTS.fallbackValue);
  assert.equal(th.basis, "fallback");
});

test("the tape is asked only for prints worth a tenth of the threshold", () => {
  assert.equal(minimumLotFor(5_000_000_000, 5_825), 858);
  assert.equal(minimumLotFor(50_000_000, 100), 500);
});

/* ------------------------------- judging ------------------------------- */

const th50 = whaleThreshold({ adv20: 1_000_000_000, sessionMeanPrint: null }); // Rp100 jt (small-cap tier floor)

test("one print over the stock's threshold is a whale, with the aggressor named", () => {
  const f = judgePrints("KECL", [print({ value: 250_000_000, lots: 25_000, side: "buy" }), print({ value: 6_000_000, side: "sell" })], th50);
  assert.ok(f);
  assert.equal(f.largest?.value, 250_000_000);
  assert.equal(f.direction, "buy");
  assert.ok(f.surprise >= 2);
});

test("a burst of same-side prints across price levels is a sweep even with no single big print", () => {
  const ps = [0, 5, 10, 20].map((dt, i) => print({ seconds: 36_000 + dt, time: `10:00:${String(dt).padStart(2, "0")}`, value: 60_000_000, price: 100 + i, side: "buy" }));
  const f = judgePrints("KECL", ps, th50);
  assert.ok(f);
  assert.equal(f.largest, null);
  assert.equal(f.sweep?.value, 240_000_000);
  assert.equal(f.sweep?.levels, 4);
});

test("the same burst spread over minutes is not a sweep", () => {
  const ps = [0, 60, 120, 180].map((dt, i) => print({ seconds: 36_000 + dt, value: 60_000_000, price: 100 + i, side: "buy" }));
  assert.equal(judgePrints("KECL", ps, th50), null);
});

test("balanced large buying and selling is two-way, not HAKA or HAKI", () => {
  const f = judgePrints("KECL", [print({ value: 100_000_000, side: "buy" }), print({ value: 90_000_000, side: "sell" })], th50)!;
  assert.equal(f.direction, "two-way");
  assert.match(whaleSignal(f, [], "sweep").id!.headline, /transaksi besar dua arah/);
});

test("several prints over the threshold are told as the others in the same stretch, not as earlier alerts", () => {
  const ps = [
    print({ seconds: 36_000, time: "10:00:00", value: 300_000_000, side: "buy" }),
    print({ seconds: 36_020, time: "10:00:20", value: 150_000_000, side: "buy" }),
    print({ seconds: 36_040, time: "10:00:40", value: 120_000_000, side: "buy" }),
  ];
  const text = whaleSignal(judgePrints("KECL", ps, th50)!, [], "sweep").id!.detail.join("\n");
  assert.match(text, /🔁 Total 3 transaksi di atas ambang, Rp 570 jt \(10:00:00 sampai 10:00:40\)/);
  assert.doesNotMatch(text, /transaksi tunggal|jendela ini/);
});

test("a print under the stock's threshold is nothing", () => {
  assert.equal(judgePrints("KECL", [print({ value: 40_000_000 })], th50), null);
});

test("the whale message gives size relative to the stock, the trigger, and no claim about who", () => {
  const th = whaleThreshold({ adv20: 1_000_000_000, sessionMeanPrint: 2_000_000 });
  const f = judgePrints("KECL", [print({ time: "13:41:25", value: 150_000_000, lots: 15_000, price: 100, side: "buy" })], th)!;
  const s = whaleSignal(f, ["KECL: tembok antrean beli (bid) muncul di harga 99"], "confirm");
  assert.equal(s.kind, "whale");
  assert.equal(s.id!.headline, "KECL: order beli besar (HAKA)");
  const text = s.id!.detail.join("\n");
  assert.match(text, /💰 Rp 150 jt sekali transaksi, 15\.000 lot di 100 \(13:41:25\)/);
  assert.match(text, /📊 Setara 15,0% nilai harian rata-rata, 75x transaksi rata-rata hari ini/);
  assert.match(text, /⚖️ 100% beli: beli Rp 150 jt, jual Rp 0 \(transaksi minimal Rp 10 jt\)/);
  assert.match(text, /🔎 Pemicu: tembok antrean beli/, "the trigger drops the symbol the headline already names");
  assert.doesNotMatch(text, /broker|bandar|pelaku/i);
  assert.equal(followUpText(f, 3), "🐋 KECL lanjutan: beli (HAKA)\n💰 Rp 150 jt lagi dalam 3 menit terakhir, harga 100");
});

/* ------------------------------- the tape ------------------------------- */

test("the tape is read newest-first with sort=desc and the lot filter", async () => {
  tape = { BBCA: [row("BBCA", "13:41:26", 5_825, 2_000, "buy")] };
  const r = await readTape({ symbol: "BBCA", minimumLot: 500, sinceSeconds: 0, maxPages: 2 });
  assert.equal(r.prints.length, 1);
  const q = new URLSearchParams(tapeUrls[0]);
  assert.equal(q.get("sort"), "desc");
  assert.equal(q.get("order_by"), "1");
  assert.equal(q.get("minimum_lot"), "500");
  assert.equal(q.get("symbols"), "BBCA");
});

test("a busy tape is paged backwards by trade number until the last print already seen", async () => {
  seq = 10_000;
  const rows = Array.from({ length: 250 }, () => row("ZATA", "13:41:00", 100, 2_000, "buy")).reverse(); // newest first
  tape = { "": rows };
  const r = await readTape({ symbol: null, minimumLot: 1_000, sinceTradeNumber: 10_020, maxPages: 3 });
  assert.equal(r.pages, 3);
  assert.equal(r.prints.length, 229, "every print after 10_020, none twice");
  assert.equal(new Set(r.prints.map((p) => p.tradeNumber)).size, r.prints.length);
});

/* ------------------------------- the stage ------------------------------- */

test("a flagged stock with a big print is confirmed and gets a watch slot; later prints become a follow-up", async () => {
  const c = new WhaleConfirmer(new FixedAdv({ KECL: 1_000_000_000 }), WHALE_DEFAULTS, CONFIRM_LIMITS, false);
  const t0 = new Date("2026-11-26T06:41:30Z"); // 13:41:30 WIB
  tape = { KECL: [row("KECL", "13:41:25", 100, 12_000, "buy")] };
  const r1 = await c.run([{ symbol: "KECL", price: 100, sessionMeanPrint: null, windowSeconds: 60, strength: 2 }], t0);
  assert.equal(r1.confirmed.get("KECL")?.direction, "buy");
  assert.deepEqual(r1.slots, ["KECL"]);

  tape = { KECL: [row("KECL", "13:43:10", 101, 11_000, "buy"), ...tape.KECL] };
  const r2 = await c.run([], new Date(t0.getTime() + 2 * 60_000));
  assert.equal(r2.followUps.length, 1);
  assert.equal(r2.followUps[0].finding.largest?.lots, 11_000);

  const r3 = await c.run([], new Date(t0.getTime() + 3 * 60_000));
  assert.equal(r3.followUps.length, 0, "nothing new, nothing sent");
  const r4 = await c.run([], new Date(t0.getTime() + 20 * 60_000));
  assert.deepEqual(r4.slots, [], "idle slots close");
});

test("the market-wide sweep finds a whale in a stock nobody flagged, judged by that stock's ADV", async () => {
  const adv = new FixedAdv({ BESR: 2_000_000_000_000, KECL: 1_000_000_000 });
  const c = new WhaleConfirmer(adv, WHALE_DEFAULTS, CONFIRM_LIMITS, true);
  tape = {
    "": [
      row("KECL", "13:41:20", 100, 15_000, "sell"), // Rp150 jt in a Rp1 M/day stock: a whale
      row("BESR", "13:41:21", 5_000, 3_000, "buy"), // Rp1,5 M in a Rp2 T/day stock (threshold Rp5 M): not
    ],
  };
  const r = await c.run([], new Date("2026-11-26T06:41:30Z"));
  assert.deepEqual(r.swept.map((f) => [f.symbol, f.direction]), [["KECL", "sell"]]);
  assert.equal(new URLSearchParams(tapeUrls[0]).get("symbols"), null, "market-wide");
  assert.equal(new URLSearchParams(tapeUrls[0]).get("minimum_lot"), "1000");
});

test("more flagged stocks than the limit: the strongest are confirmed", async () => {
  const fixed = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`S${i}`, 1_000_000_000]));
  const c = new WhaleConfirmer(new FixedAdv(fixed), WHALE_DEFAULTS, CONFIRM_LIMITS, false);
  const flagged = Array.from({ length: 8 }, (_, i) => ({ symbol: `S${i}`, price: 100, sessionMeanPrint: null, windowSeconds: 60, strength: i }));
  await c.run(flagged, new Date("2026-11-26T06:41:30Z"));
  const asked = tapeUrls.map((q) => new URLSearchParams(q).get("symbols")).sort();
  assert.deepEqual(asked, ["S3", "S4", "S5", "S6", "S7"]);
});

/* ------------------------------- in the watcher ------------------------------- */

const lvl = (price: number, volume: number) => ({ price: String(price), volume: String(volume), que_num: "10" });
const ALL = { scope: { kind: "all" }, symbols: null } as unknown as ResolvedScope;

test("a confirmed whale replaces the anomaly that flagged it, and names it as the trigger", async () => {
  const c = new WhaleConfirmer(new FixedAdv({ KECL: 1_000_000_000 }), WHALE_DEFAULTS, CONFIRM_LIMITS, false);
  const w = new SignalWatcher({ scope: ALL, spec: compilePrompt(""), elapsedSeconds: () => 3 * 3600, uncapped: true, whale: c });
  // Ten symbols, so one stock firing is not read as the whole market moving (the engine's
  // market-wide rule collapses a signal tripped by more than 40% of the universe).
  topStock = ["KECL", ...Array.from({ length: 9 }, (_, i) => `QQ${i}`)].map((code, i) => ({
    code, value: { raw: String(1e9 - i) }, lot: { raw: "100000" }, frequency: { raw: "10" },
  }));
  // Top five levels 90% bid: book-imbalance fires on the third consecutive read.
  const book = (value: number, freq: number) => ({
    symbol: "KECL", lastprice: 100, previous: 98, open: 98, high: 101, low: 97, average: 99,
    frequency: freq, value, volume: value / 100, uma: false, notation: [],
    ara: { value: "132", visible: true }, arb: { value: "66", visible: true },
    bid: [lvl(100, 9_000_000), lvl(99, 9_000_000), lvl(98, 9_000_000), lvl(97, 9_000_000), lvl(96, 9_000_000)],
    offer: [lvl(101, 1_000_000), lvl(102, 1_000_000), lvl(103, 1_000_000), lvl(104, 1_000_000), lvl(105, 1_000_000)],
  });
  books = { KECL: book(1_000_000_000, 500) };
  const t0 = new Date("2026-11-26T03:30:00Z"); // 10:30 WIB, outside the quiet periods
  await w.pass(t0);
  books = { KECL: book(1_100_000_000, 510) };
  await w.pass(new Date(t0.getTime() + 60_000));
  books = { KECL: book(1_200_000_000, 520) };
  tape = { KECL: [row("KECL", "10:31:50", 100, 20_000, "buy")] };
  const r = await w.pass(new Date(t0.getTime() + 120_000));
  const kinds = r.signals.filter((s) => s.symbol === "KECL").map((s) => s.kind);
  assert.deepEqual(kinds, ["whale"], JSON.stringify(kinds));
  assert.match(r.signals[0].id!.detail.join(" "), /Pemicu: .*berat|Pemicu: /);
  assert.equal(r.whale?.confirmed, 1);
  assert.equal(r.engine?.emitted[0]?.kind, "whale");
});
