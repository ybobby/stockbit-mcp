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
  /** Signals still open from earlier days of a multi-day replay. Not mutated. */
  journal?: Journal;
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
  /** The journal at the end of the day, to carry into the next one. */
  journal: Journal;
}

/**
 * The IDX continuous-trading minutes of `day`, as ISO times: 09:00–11:59, then 13:30 (Friday 14:00)
 * to 15:49. The pre-closing auction is left out: nobody fills a normal order there.
 */
export function minuteSlots(day: string): string[] {
  const friday = new Date(`${day}T00:00:00Z`).getUTCDay() === 5;
  const ranges: [number, number][] = [
    [9 * 60, (friday ? 11 * 60 + 30 : 12 * 60) - 1],
    [friday ? 14 * 60 : 13 * 60 + 30, 15 * 60 + 49],
  ];
  const out: string[] = [];
  for (const [a, b] of ranges) {
    for (let m = a; m <= b; m++) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      out.push(new Date(`${day}T${hh}:${mm}:00+07:00`).toISOString());
    }
  }
  return out;
}

/**
 * Give an UNTIMED close series approximate times, spread evenly across the session's trading
 * minutes. The minute route carries no clock (see `getIntradayPrices`), so this is a labelled
 * approximation: right in order, roughly right in time, and never presented as exact.
 */
export function spreadOverSession(day: string, closes: number[]): PricePoint[] {
  const slots = minuteSlots(day);
  return closes.map((price, i) => ({
    at: slots[Math.min(slots.length - 1, Math.floor((i * slots.length) / closes.length))],
    price,
  }));
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
  let journal: Journal = input.journal ? structuredClone(input.journal) : emptyJournal();
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

  const notes = new Map(events.filter((e) => e.type === "buy").map((e) => [String(e.id), (e.aiNote as string | null) ?? null]));
  const trades = tradesFrom(journal, (sym) => {
    const pts = series.get(sym) ?? [];
    return pts[pts.length - 1]?.price ?? null;
  }, notes);

  const done = events.find((e) => e.type === "analysis-done");
  return {
    day: input.day,
    analysed: input.contexts.size,
    bullish: (done?.bullish as string[]) ?? [],
    events,
    messages,
    trades,
    vetoes: events.filter((e) => e.type === "vetoed").length,
    journal,
    limits: [
      "Harga dari titik grafik intraday, bukan setiap kutipan yang akan dibaca bot live.",
      "Analisis pagi memakai data sampai kemarin. Hasil satu hari tidak membuktikan strategi bekerja.",
      "Pemicu whale hanya ada kalau whale watch berjalan hari itu.",
      "Belum termasuk fee broker dan selisih harga.",
    ],
  };
}

/** Every signal in a journal as a trade row, open ones marked to `lastPrice`. */
export function tradesFrom(
  journal: Journal,
  lastPrice: (symbol: string) => number | null,
  notes: Map<string, string | null> = new Map(),
): ReplayTrade[] {
  const pct = (from: number, to: number) => Math.round(((to - from) / from) * 10000) / 100;
  const closed: ReplayTrade[] = journal.closed.map((c) => ({
    symbol: c.symbol,
    buyAt: c.openedAt,
    buy: c.entry,
    stop: c.stop,
    target1: c.target1,
    target2: c.target2,
    sellAt: c.closedAt,
    sell: c.exitPrice,
    exitKind: c.exitKind,
    returnPct: c.returnPct,
    stillOpen: false,
    aiNote: notes.get(c.id) ?? null,
  }));
  const open: ReplayTrade[] = journal.open.map((o) => {
    const last = lastPrice(o.symbol) ?? o.entry;
    return {
      symbol: o.symbol,
      buyAt: o.openedAt,
      buy: o.entry,
      stop: o.stop,
      target1: o.target1,
      target2: o.target2,
      sellAt: null,
      sell: null,
      exitKind: null,
      returnPct: pct(o.entry, last),
      stillOpen: true,
      aiNote: notes.get(o.id) ?? null,
    };
  });
  return [...closed, ...open].sort((a, b) => Date.parse(a.buyAt) - Date.parse(b.buyAt));
}

export interface ReplayRangeResult {
  days: { day: string; analysed: number; bullish: string[]; buys: number; exits: number }[];
  trades: ReplayTrade[];
  vetoes: number;
  events: ReplayEvent[];
  limits: string[];
}

/**
 * Several days in a row, with signals carried overnight, so a BUY on Monday can meet its SELL on
 * Wednesday. Each day gets its own morning context (the caller cuts each at the day before).
 */
export async function replayDays(
  days: Omit<ReplayInput, "journal">[],
): Promise<ReplayRangeResult> {
  let journal: Journal | undefined;
  const out: ReplayRangeResult = { days: [], trades: [], vetoes: 0, events: [], limits: [] };
  const notes = new Map<string, string | null>();
  const last = new Map<string, number>();
  for (const input of days) {
    const r = await replayDay({ ...input, journal });
    journal = r.journal;
    out.events.push(...r.events);
    out.vetoes += r.vetoes;
    out.limits = r.limits;
    for (const e of r.events) if (e.type === "buy") notes.set(String(e.id), (e.aiNote as string | null) ?? null);
    for (const [sym, pts] of input.series) if (pts.length) last.set(sym, [...pts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[pts.length - 1].price);
    out.days.push({
      day: r.day,
      analysed: r.analysed,
      bullish: r.bullish,
      buys: r.events.filter((e) => e.type === "buy").length,
      exits: r.events.filter((e) => e.type === "exit" && e.kind !== "target1").length,
    });
  }
  out.trades = journal ? tradesFrom(journal, (s) => last.get(s) ?? null, notes) : [];
  return out;
}
