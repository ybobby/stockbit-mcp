/**
 * `--wide`: the movers lists that bring cheap, high-lot stocks into the whale watch.
 *
 * Offline like the rest of the live tests. What is guarded here is the one thing that would make
 * the wider universe worse than the narrow one: a delta taken between two DIFFERENT services'
 * figures for the same symbol, which would report the gap between them as a trade.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-livewide-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  diffSnapshots,
  looksLikeSessionReset,
  samplesFromMovers,
  snapshotFromTopStock,
  widenSnapshot,
  type TradeDelta,
} from "../src/live/tape.ts";
import { chooseBookCandidates, tagWide } from "../src/live/watcher.ts";
import { valueSurge, DEFAULTS, type Signal } from "../src/live/signals.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

const raw = (n: number) => ({ raw: String(n), formatted: "x" });
const topRow = (code: string, value: number, lot: number, frequency: number) => ({
  code,
  value: raw(value),
  lot: raw(lot),
  frequency: raw(frequency),
});
const moverRow = (code: string, value: number, volume: number, frequency: number) => ({
  stock_detail: { code, name: code },
  price: raw(100),
  value: raw(value),
  volume: raw(volume),
  frequency: raw(frequency),
});

test("movers rows become samples, with volume read as lots and every list recorded", () => {
  const samples = samplesFromMovers([
    { list: "volume", rows: [moverRow("goto", 1_000, 50, 10), moverRow("KOTA", 2_000, 70, 20)] },
    { list: "frequency", rows: [moverRow("GOTO", 1_000, 50, 10)] },
  ]);
  assert.equal(samples.size, 2);
  const goto = samples.get("GOTO");
  assert.equal(goto?.lot, 50);
  assert.equal(goto?.source, "movers");
  assert.deepEqual(goto?.lists, ["volume", "frequency"]);
});

test("a movers row missing value, volume or frequency is skipped, never zero-filled", () => {
  const samples = samplesFromMovers([
    {
      list: "volume",
      rows: [
        { stock_detail: { code: "AAAA" }, value: raw(1), frequency: raw(1) },
        { stock_detail: { code: "BBBB" }, volume: raw(1), frequency: raw(1) },
        { value: raw(1), volume: raw(1), frequency: raw(1) },
        moverRow("CCCC", 1, 1, 1),
      ],
    },
  ]);
  assert.deepEqual([...samples.keys()], ["CCCC"]);
});

test("top-stock wins where both sources carry a symbol", () => {
  const base = snapshotFromTopStock([topRow("BMRI", 27e9, 67_000, 1_700)], 0);
  const wide = widenSnapshot(base, samplesFromMovers([{ list: "value", rows: [moverRow("BMRI", 524e9, 1.3e6, 21_000), moverRow("BBCA", 955e9, 1.6e6, 30_000)] }]));
  assert.equal(wide.symbols.get("BMRI")?.source, "top-stock");
  assert.equal(wide.symbols.get("BMRI")?.value, 27e9);
  assert.equal(wide.symbols.get("BBCA")?.source, "movers");
});

test("no delta is taken across sources, however the numbers line up", () => {
  const before = widenSnapshot(snapshotFromTopStock([topRow("BMRI", 27e9, 67_000, 1_700)], 0), new Map());
  // BMRI fell out of top-stock and appears only on a movers list a minute later.
  const after = widenSnapshot(
    snapshotFromTopStock([], 60_000),
    samplesFromMovers([{ list: "value", rows: [moverRow("BMRI", 524e9, 1.3e6, 21_000)] }]),
  );
  assert.deepEqual(diffSnapshots(before, after), []);
  // ...and a cross-source drop is not counted towards a session reset either.
  assert.equal(looksLikeSessionReset(after, before), false);
});

test("a movers-to-movers delta carries its source and lists", () => {
  const at = (t: number, value: number, lots: number, freq: number) =>
    widenSnapshot(snapshotFromTopStock([], t), samplesFromMovers([{ list: "volume", rows: [moverRow("GOTO", value, lots, freq)] }]));
  const [d] = diffSnapshots(at(0, 100e9, 40e6, 9_000), at(60_000, 100.2e9, 40.08e6, 9_040));
  assert.equal(d.symbol, "GOTO");
  assert.equal(d.source, "movers");
  assert.deepEqual(d.lists, ["volume"]);
  assert.equal(d.lots, 80_000);
  assert.equal(d.trades, 40);
});

test("a top-stock delta looks exactly as it did before --wide existed", () => {
  const [d] = diffSnapshots(
    snapshotFromTopStock([topRow("BBCA", 100, 10, 5)], 0),
    snapshotFromTopStock([topRow("BBCA", 200, 20, 9)], 60_000),
  );
  assert.equal(d.source, undefined);
  assert.equal(d.lists, undefined);
});

const delta = (symbol: string, value: number, lots: number, source?: "movers"): TradeDelta => ({
  symbol,
  value,
  lots,
  trades: 10,
  averageTradeValue: value / 10,
  seconds: 60,
  sessionValue: value * 50,
  sessionFrequency: 1_000,
  confidence: "averaged",
  ...(source ? { source, lists: ["volume"] } : {}),
});

test("book slots: without movers symbols the old busiest-by-rupiah rule is unchanged", () => {
  const ds = Array.from({ length: 20 }, (_, i) => delta(`S${i}`, 1_000 - i, 1));
  assert.deepEqual(chooseBookCandidates(ds, 12, 0).map((d) => d.symbol), ds.slice(0, 12).map((d) => d.symbol));
  assert.deepEqual(chooseBookCandidates(ds, 12, 4).map((d) => d.symbol), ds.slice(0, 12).map((d) => d.symbol));
});

test("book slots: movers-only symbols get their reserved slots, ranked by lots", () => {
  const main = Array.from({ length: 20 }, (_, i) => delta(`M${i}`, 1e9 - i, 10));
  const wide = [delta("W1", 1e6, 500, "movers"), delta("W2", 2e6, 9_000, "movers"), delta("W3", 3e6, 100, "movers"), delta("W4", 1e5, 50, "movers"), delta("W5", 1e5, 5_000, "movers")];
  const picked = chooseBookCandidates([...main, ...wide], 12, 4).map((d) => d.symbol);
  assert.equal(picked.length, 12);
  assert.deepEqual(picked.slice(0, 8), main.slice(0, 8).map((d) => d.symbol));
  assert.deepEqual(picked.slice(8), ["W2", "W5", "W1", "W3"]);
});

test("book slots: a side that cannot fill its share gives the rest to the other", () => {
  const main = [delta("M1", 1e9, 10), delta("M2", 9e8, 10)];
  const wide = Array.from({ length: 15 }, (_, i) => delta(`W${i}`, 1e6, 1_000 - i, "movers"));
  const picked = chooseBookCandidates([...main, ...wide], 12, 4);
  assert.equal(picked.length, 12);
  assert.deepEqual(picked.slice(0, 2).map((d) => d.symbol), ["M1", "M2"]);
  const fewWide = chooseBookCandidates([...Array.from({ length: 20 }, (_, i) => delta(`M${i}`, 1e9 - i, 1)), delta("W", 1, 1, "movers")], 12, 4);
  assert.equal(fewWide.length, 12);
  assert.equal(fewWide.filter((d) => d.source === "movers").length, 1);
});

test("book slots: symbols that did not trade are never read", () => {
  const quiet = { ...delta("Q", 0, 0, "movers"), trades: 0 };
  assert.deepEqual(chooseBookCandidates([quiet], 12, 4), []);
});

test("a movers-only alert says where it came from, in both languages", () => {
  const s: Signal = {
    kind: "value-surge",
    symbol: "GOTO",
    severity: "watch",
    surprise: 1.2,
    headline: "GOTO: x",
    detail: ["a"],
    priceBucket: 0,
    at: 0,
    id: { headline: "GOTO: y", detail: ["b"] },
  };
  const t = tagWide(s, ["volume", "frequency"]);
  assert.equal(t.detail.at(-1), "From Stockbit's top volume/frequency movers list, outside the top-stock hundred.");
  assert.equal(t.id?.detail.at(-1), "Saham ini masuk lewat daftar top volume/frekuensi bursa hari ini, di luar 100 saham utama.");
  assert.deepEqual(s.detail, ["a"], "the original signal is not mutated");
});

test("the wide value floor lets a cheap stock's surge through that the top-stock floor would stop", () => {
  const d: TradeDelta = {
    symbol: "KOTA",
    value: 150_000_000,
    lots: 25_000,
    trades: 4,
    averageTradeValue: 37_500_000,
    seconds: 60,
    sessionValue: 2_000_000_000,
    sessionFrequency: 1_000,
    confidence: "few",
    source: "movers",
    lists: ["volume"],
  };
  const input = { delta: d, sessionValue: d.sessionValue, sessionFrequency: d.sessionFrequency, elapsedSeconds: 3 * 3600 };
  assert.equal(valueSurge(input, DEFAULTS), null);
  assert.ok(valueSurge(input, { ...DEFAULTS, minWindowValue: DEFAULTS.minWindowValueWide ?? 0 }));
});
