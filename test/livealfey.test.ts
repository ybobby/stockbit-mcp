// Isolate before importing anything that reads the store.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-alfey-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { AlfeyList, alfeyLabel, parseAlfeyList } from "../src/live/alfeylist.ts";
import { telegramHtml, whaleText } from "../src/live/whalewatch.ts";
import type { Signal } from "../src/live/signals.ts";

test("the list keeps ticker, status and date, an active row wins, junk is skipped", () => {
  const m = parseAlfeyList({
    items: [
      { ticker: "aims", status: "setup", date: "2026-11-26" },
      { ticker: "AIMS", status: "active", date: "2026-11-20" },
      { ticker: "CTRA", status: "setup", date: "2026-11-25" },
      { ticker: "CTRA", status: "setup", date: "2026-11-26" },
      { ticker: "BAD TICKER", status: "active", date: "2026-11-26" },
      { ticker: "BBCA", status: "closed", date: "2026-11-26" },
      { ticker: "BBRI", status: "active", date: "26/11/2026" },
    ],
  });
  assert.deepEqual([...m.entries()], [
    ["AIMS", { status: "active", date: "2026-11-20" }],
    ["CTRA", { status: "setup", date: "2026-11-26" }],
  ]);
  assert.throws(() => parseAlfeyList({ error: "unauthorized" }));
});

test("the owner's wording: Posisi Aktif AlfeySaham, Kandidat per <date>", () => {
  assert.equal(alfeyLabel({ status: "active", date: "2026-11-20" }), "📌 Posisi Aktif AlfeySaham");
  assert.equal(alfeyLabel({ status: "setup", date: "2026-11-26" }), "📋 Kandidat per 26 Nov 2026");
  assert.equal(alfeyLabel(undefined), null);
});

test("refresh sends the key header, keeps the last list on failure, and drops it when too old", async () => {
  let status = 200;
  let auth = "";
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    auth = String((init?.headers as Record<string, string>)["x-whale-watchlist-key"]);
    return new Response(JSON.stringify({ items: [{ ticker: "AIMS", status: "active", date: "2026-11-20" }] }), { status });
  }) as unknown as typeof fetch;
  const list = new AlfeyList({ url: "https://example.test/api/whale-watchlist", token: "tok", fetchImpl, refreshMs: 60_000, maxAgeMs: 3600_000 });

  assert.equal(await list.refresh(0), null);
  assert.equal(auth, "tok");
  assert.equal(list.label("aims"), "📌 Posisi Aktif AlfeySaham");
  assert.deepEqual(list.symbols(), ["AIMS"]);

  status = 500;
  assert.equal(await list.refresh(30_000), null, "not due yet: no request");
  const err = await list.refresh(60_000);
  assert.equal(err, "alfey list: HTTP 500");
  assert.doesNotMatch(err!, /tok|example/, "never the token or the URL");
  assert.equal(list.label("AIMS"), "📌 Posisi Aktif AlfeySaham", "a failed refresh keeps the last good list");

  await list.refresh(4_000_000);
  assert.equal(list.label("AIMS"), null, "a list past maxAge is dropped");
});

test("the label sits under the headline, in bold", () => {
  const signal: Signal = {
    kind: "whale", symbol: "AIMS", severity: "watch", surprise: 1.5, headline: "x", detail: [], priceBucket: 1, at: 0,
    id: { headline: "AIMS: order beli besar (HAKA)", detail: ["💰 Rp 371 jt sekali transaksi"] },
  };
  const html = telegramHtml(whaleText(signal, new Date(), null, "📌 Posisi Aktif AlfeySaham"));
  const lines = html.split("\n");
  assert.equal(lines[0], "<b>🐋 AIMS: order beli besar (🟢 HAKA)</b>");
  assert.equal(lines[1], "<b>📌 Posisi Aktif AlfeySaham</b>");
  assert.equal(lines[2], "");
});
