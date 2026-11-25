/**
 * Replay one finished trading day through the real signal loop, to see what it WOULD have sent.
 *
 * Not a backtest of the strategy — one day says nothing about whether it works — but a way to see the
 * messages, their timing and their arithmetic on real prices before trusting the live feed.
 *
 * It drives `runSignalBot` itself, with a scripted clock and an in-memory journal, so the replay
 * cannot drift from what the live bot does. The differences from a live run are stated in `limits`:
 *
 *   - prices are the chart's intraday points, not every quote the live bot would have polled;
 *   - the morning context is built from data up to YESTERDAY (the caller's deps must enforce that);
 *   - whale triggers exist only if the whale watch was running that day and logged them.
 */
import type { AiReviewer } from "./ai.js";
import type { DailyContext, Tick, WhaleHit } from "./engine.js";
import { emptyJournal, type Journal } from "./ledger.js";
import { runSignalBot } from "./loop.js";

export interface PricePoint {
  /** ISO time. */
  at: string;
  price: number;
}

export interface ReplayInput {
  day: string;
  contexts: Map<string, DailyContext>;
  /** Intraday points per symbol, any order. */
  series: Map<string, PricePoint[]>;
  whales: (symbol: string) => WhaleHit[];
  review?: AiReviewer;
  maxBuysPerDay?: number;
  maxOpen?: number;
}

export interface ReplayEvent {
  at: string;
  type: string;
  symbol?: string;
  text?: string;
  [k: string]: unknown;
}

export interface ReplayTrade {
  symbol: string;
  buyAt: string;
  buy: number;
  stop: number;
  target1: number;
  target2: number;
  sellAt: string | null;
  sell: number | null;
  exitKind: string | null;
  /** Percent, to the exit, or to the last price when still open. */
  returnPct: number;
  stillOpen: boolean;
  aiNote: string | null;
}

export interface ReplayResult {
  day: string;
  analysed: number;
  bullish: string[];
  events: ReplayEvent[];
  messages: { at: string; text: string }[];
  trades: ReplayTrade[];
  vetoes: number;
  limits: string[];
}

function lastAtOrBefore(points: PricePoint[], t: number): PricePoint | null {
  let best: PricePoint | null = null;
  for (const p of points) {
    if (Date.parse(p.at) <= t) best = p;
    else break;
  }
  return best;
}

export async function replayDay(input: ReplayInput): Promise<ReplayResult> {
  const series = new Map<string, PricePoint[]>();
  for (const [s, pts] of input.series) series.set(s, [...pts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
  const timeline = [...new Set([...series.values()].flatMap((pts) => pts.map((p) => Date.parse(p.at))))].sort((a, b) => a - b);

  const symbols = [...input.contexts.keys()].filter((s) => series.has(s));
  const events: ReplayEvent[] = [];
  const messages: { at: string; text: string }[] = [];
  let journal: Journal = emptyJournal();
  let i = 0;
  const nowAt = () => new Date(timeline[Math.min(i, timeline.length - 1)] ?? Date.now());

  await runSignalBot(
    {
      now: nowAt,
      sleep: async () => {
        i++;
      },
      inWindow: () => true,
      stopped: () => i >= timeline.length,
      dailyContext: async (symbol) => {
        const c = input.contexts.get(symbol);
        if (!c) throw new Error(`no context for ${symbol}`);
        return c;
      },
      tick: async (symbol): Promise<Tick> => {
        const p = lastAtOrBefore(series.get(symbol) ?? [], timeline[i]);
        if (!p) throw new Error("no price yet");
        return { price: p.price, changePct: null };
      },
      whales: (symbol) => input.whales(symbol).filter((w) => Date.parse(w.at) <= timeline[i]),
      send: async (text) => {
        messages.push({ at: nowAt().toISOString(), text });
        return null;
      },
      record: (e) => {
        if (e.type === "pass" || e.type === "tick-failed") return;
        events.push({ at: nowAt().toISOString(), ...e } as ReplayEvent);
      },
      loadJournal: () => journal,
      saveJournal: (j) => (journal = j),
      review: input.review,
      isAuthError: () => false,
    },
    {
      symbols,
      intervalMs: 0,
      maxPasses: timeline.length,
      maxBuysPerDay: input.maxBuysPerDay,
      maxOpen: input.maxOpen,
      failureNotice: Number.MAX_SAFE_INTEGER,
    },
  );

  const buys = events.filter((e) => e.type === "buy");
  const trades: ReplayTrade[] = buys.map((b) => {
    const symbol = String(b.symbol);
    const closed = journal.closed.find((c) => c.symbol === symbol);
    const exitEvent = events.find((e) => e.type === "exit" && e.symbol === symbol && e.kind !== "target1");
    const pts = series.get(symbol) ?? [];
    const last = pts[pts.length - 1]?.price ?? Number(b.entry);
    const entry = Number(b.entry);
    const sell = closed ? closed.exitPrice : null;
    const ref = sell ?? last;
    return {
      symbol,
      buyAt: b.at,
      buy: entry,
      stop: Number(b.stop),
      target1: Number(b.target1),
      target2: Number(b.target2),
      sellAt: exitEvent?.at ?? null,
      sell,
      exitKind: closed?.exitKind ?? null,
      returnPct: Math.round(((ref - entry) / entry) * 10000) / 100,
      stillOpen: !closed,
      aiNote: (b.aiNote as string | null) ?? null,
    };
  });

  const done = events.find((e) => e.type === "analysis-done");
  return {
    day: input.day,
    analysed: input.contexts.size,
    bullish: (done?.bullish as string[]) ?? [],
    events,
    messages,
    trades,
    vetoes: events.filter((e) => e.type === "vetoed").length,
    limits: [
      "Harga dari titik grafik intraday, bukan setiap kutipan yang akan dibaca bot live.",
      "Analisis pagi memakai data sampai kemarin. Hasil satu hari tidak membuktikan strategi bekerja.",
      "Pemicu whale hanya ada kalau whale watch berjalan hari itu.",
      "Belum termasuk fee broker dan selisih harga.",
    ],
  };
}
