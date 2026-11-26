/**
 * One pass of the watcher: fetch, detect, filter, report.
 *
 * This is the only file that knows about all the pieces at once. The detectors are pure and the
 * alert engine is pure; this is where they meet the network, and keeping that boundary sharp is what
 * makes everything else testable without a market.
 *
 * ## Cost, and where the numbers come from
 *
 * `top-stock` covers a hundred symbols in ONE request, and is used only to RANK them. The busiest
 * twelve (some reserved for movers-only symbols with `--wide`) get an order-book request each, and
 * every detector, value-surge included, works from those books: the book carries the symbol's
 * cumulative value, transaction count and volume, so two consecutive readings give an honest delta.
 * Until 2026-11-26 value-surge differenced top-stock itself; that morning top-stock's figures were
 * seen falling between reads and going negative, which no cumulative counter does. Watching a
 * hundred symbols would mean a hundred requests every interval against an unofficial API on the
 * user's own account, which is the thing the research was explicit about not doing, so the twelve
 * stay twelve.
 */
import { getJson } from "../http/client.js";
import { MarketWatcher, type PollResult } from "./poller.js";
import { deltaBetween, sampleFromBook, type SymbolSample } from "./tape.js";
import { parseOrderBook, type OrderBook } from "./orderbook.js";
import { inScope, type ResolvedScope } from "./scope.js";
import {
  awakening,
  bandApproach,
  bookImbalance,
  floorLocked,
  umaFlag,
  valueSurge,
  wallChange,
  topFiveBidPercent,
  DEFAULTS,
  type Signal,
  type SignalKind,
  type Thresholds,
} from "./signals.js";
import { AlertEngine, FATIGUE_DEFAULTS, type EngineResult } from "./alertengine.js";
import type { WatchSpec } from "./promptspec.js";
import type { TradeDelta } from "./tape.js";

/**
 * The longest gap, in seconds, across which two order-book readings of one symbol are differenced.
 *
 * A symbol drops out of the busiest twelve and comes back later; differencing its new reading against
 * one from half an hour ago would report thirty minutes of trading as one window. Past this gap the
 * old reading is discarded and the new one becomes the baseline.
 */
export const MAX_BOOK_GAP_SECONDS = 300;

/** How many symbols may be book-checked in one pass. Each is a separate request. */
const MAX_BOOK_FETCHES = 12;

/** With `wide`: how many of those slots go to symbols only the movers lists carry, by default. */
export const DEFAULT_WIDE_BOOK_SLOTS = 4;

/** What the book-slot chooser needs to know about a symbol. */
export interface BookCandidate {
  symbol: string;
  /** Rupiah, as the ranking source reports it. Ranks the main slots. */
  value: number;
  /** Lots, as the ranking source reports it. Ranks the movers-only slots. */
  lots: number;
  source?: TradeDelta["source"] | SymbolSample["source"];
  lists?: string[];
}

/**
 * Which symbols get an order-book read this pass.
 *
 * Without movers symbols: the busiest by rupiah, up to `max`. With them, up to `wideSlots` go to
 * movers-only symbols ranked by LOTS, because those are the cheap names whose rupiah would never win
 * a slot. Slots one side cannot fill go to the other, so the total stays `max` and the request budget
 * does not grow. A symbol showing neither value nor lots is never read.
 *
 * Ranks on the CURRENT top-stock/movers reading rather than on a delta of it: since 2026-11-26 those
 * figures are not cumulative counters, so a delta of them means nothing. Ranking on the reading
 * keeps the chosen twelve fairly stable from one pass to the next, which is what lets each symbol's
 * order book be differenced against its previous reading.
 */
export function chooseBookCandidates<T extends BookCandidate>(items: T[], max: number, wideSlots: number): T[] {
  const active = items.filter((d) => d.value > 0 || d.lots > 0);
  const main = active.filter((d) => d.source !== "movers").sort((a, b) => b.value - a.value);
  const wide = active.filter((d) => d.source === "movers").sort((a, b) => b.lots - a.lots);
  const wideTake = Math.min(wide.length, Math.max(0, wideSlots), max);
  const mainTake = Math.min(main.length, max - wideTake);
  const extraWide = Math.min(wide.length - wideTake, max - wideTake - mainTake);
  return [...main.slice(0, mainTake), ...wide.slice(0, wideTake + extraWide)];
}

const LIST_ID: Record<string, string> = { value: "nilai", volume: "volume", frequency: "frekuensi" };

/**
 * Say, in both languages, that a signal came from a symbol only the movers lists carry.
 *
 * These are a different population from the top-stock hundred (cheaper, noisier, judged against a
 * lower rupiah floor), so a reader should be able to tell them apart without looking anything up.
 */
export function tagWide(signal: Signal, lists: string[] | undefined): Signal {
  const en = lists?.length ? lists.join("/") : "movers";
  const id = lists?.length ? lists.map((l) => LIST_ID[l] ?? l).join("/") : "movers";
  return {
    ...signal,
    detail: [...signal.detail, `From Stockbit's top ${en} movers list, outside the top-stock hundred.`],
    ...(signal.id
      ? { id: { headline: signal.id.headline, detail: [...signal.id.detail, `Saham ini masuk lewat daftar top ${id} bursa hari ini, di luar 100 saham utama.`] } }
      : {}),
  };
}

export interface PassResult {
  at: number;
  symbolsSeen: number;
  /** Null on the very first pass — a delta needs two snapshots. */
  deltas: TradeDelta[] | null;
  reason?: PollResult["reason"];
  signals: Signal[];
  engine: EngineResult | null;
  booksRead: string[];
  errors: string[];
  /** With `wide`: symbols this pass that only the movers lists carried. */
  moversOnly?: number;
}

/** Per-symbol memory the detectors need between passes. */
interface SymbolMemory {
  lastBook?: OrderBook;
  /** The cumulative figures from `lastBook`, and when they were read (epoch ms). */
  lastSample?: SymbolSample;
  lastAt?: number;
  lastImbalance?: number;
  /** Previous session's total value, for the awakening detector. */
  previousSessionValue?: number;
}

export interface WatcherOptions {
  scope: ResolvedScope;
  spec: WatchSpec;
  thresholds?: Thresholds;
  /** Seconds of trading elapsed when the pass runs. Injected so this stays testable. */
  elapsedSeconds: () => number;
  /** Also watch the symbols on Stockbit's value, volume and frequency movers lists. */
  wide?: boolean;
  /** With `wide`: order-book slots reserved for movers-only symbols. Default {@link DEFAULT_WIDE_BOOK_SLOTS}. */
  wideBookSlots?: number;
}

export class SignalWatcher {
  private readonly market: MarketWatcher;
  private readonly engine: AlertEngine;
  private readonly memory = new Map<string, SymbolMemory>();
  private passes = 0;

  constructor(private readonly opts: WatcherOptions) {
    // The prompt's severity floor has to reach the engine, which is the only thing that enforces it.
    // Compiling it and then not wiring it up is exactly the silent half-obedience the prompt
    // compiler exists to prevent.
    this.engine = new AlertEngine({ ...FATIGUE_DEFAULTS, floor: opts.spec.severityFloor });
    this.market = new MarketWatcher({ wide: opts.wide === true });
  }

  private enabled(kind: SignalKind): boolean {
    return this.opts.spec.kinds.includes(kind);
  }

  private mem(symbol: string): SymbolMemory {
    let m = this.memory.get(symbol);
    if (!m) {
      m = {};
      this.memory.set(symbol, m);
    }
    return m;
  }

  /** Record what each symbol traded on a previous day, so the awakening detector has a baseline. */
  seedPreviousSession(values: Record<string, number>): void {
    for (const [symbol, value] of Object.entries(values)) {
      this.mem(symbol.toUpperCase()).previousSessionValue = value;
    }
  }

  async pass(now = new Date()): Promise<PassResult> {
    const t = this.opts.thresholds ?? DEFAULTS;
    const at = now.getTime();
    const read = await this.market.read(at);
    const errors: string[] = [...(read.warnings ?? [])];
    const wideCount = read.moversOnly !== undefined ? { moversOnly: read.moversOnly } : {};

    // top-stock (and the movers lists) only RANK here. Deltas come from each symbol's own order book,
    // whose figures are cumulative; see `sampleFromBook`.
    const ranked: (BookCandidate & { sample: SymbolSample })[] = [];
    for (const sample of read.snapshot.symbols.values()) {
      if (!inScope(this.opts.scope, sample.symbol)) continue;
      ranked.push({
        symbol: sample.symbol,
        value: sample.value,
        lots: sample.lot,
        source: sample.source,
        ...(sample.lists ? { lists: sample.lists } : {}),
        sample,
      });
    }

    const candidates = chooseBookCandidates(
      ranked,
      MAX_BOOK_FETCHES,
      this.opts.wide ? (this.opts.wideBookSlots ?? DEFAULT_WIDE_BOOK_SLOTS) : 0,
    );

    const signals: Signal[] = [];
    const deltas: TradeDelta[] = [];
    const booksRead: string[] = [];
    // Every detector reports through this, so a movers-only symbol is labelled whichever one fired.
    const add = (s: Signal | null, c: BookCandidate) => {
      if (s) signals.push(c.source === "movers" ? tagWide(s, c.lists) : s);
    };

    for (const c of candidates) {
      let book: OrderBook | null = null;
      try {
        book = parseOrderBook(await getJson("orderbook", { segments: { symbol: c.symbol } }));
      } catch (err) {
        errors.push(`${c.symbol}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!book) {
        errors.push(`${c.symbol}: order book did not parse`);
        continue;
      }
      booksRead.push(c.symbol);
      const m = this.mem(c.symbol);

      // The delta against this symbol's previous book, when there is an honest one to take.
      const sample = sampleFromBook(book);
      const seconds = m.lastAt !== undefined ? (at - m.lastAt) / 1000 : 0;
      const fresh = m.lastSample !== undefined && seconds > 0 && seconds <= MAX_BOOK_GAP_SECONDS;
      const raw = fresh && m.lastSample ? deltaBetween(m.lastSample, sample, seconds) : null;
      const d: TradeDelta | null = raw
        ? { ...raw, ...(c.source === "movers" ? { source: "movers" as const, lists: c.lists ?? [] } : {}) }
        : null;
      if (d) deltas.push(d);
      // A stale previous book is no baseline for the book detectors either.
      const previousBook = fresh ? m.lastBook : undefined;

      if (d && this.enabled("value-surge") && !(this.opts.spec.minValue !== null && d.value < this.opts.spec.minValue)) {
        // A symbol that has been firing all session gets a harder gate, per the adaptive rule.
        const widen = this.engine.widenFactor(d.symbol);
        const base: Thresholds =
          c.source === "movers" ? { ...t, minWindowValue: t.minWindowValueWide ?? t.minWindowValue } : t;
        const scaled: Thresholds =
          widen === 1 ? base : { ...base, concentration: base.concentration * widen, rate: base.rate * widen };
        add(
          valueSurge(
            { delta: d, sessionValue: d.sessionValue, sessionFrequency: d.sessionFrequency, elapsedSeconds: this.opts.elapsedSeconds() },
            scaled,
          ),
          c,
        );
      }

      if (this.enabled("awakening")) {
        const prev = m.previousSessionValue;
        if (prev !== undefined) add(awakening({ symbol: c.symbol, todayValue: book.value, previousSessionValue: prev }, t), c);
      }

      if (d && this.enabled("band-approach")) {
        add(bandApproach({ book, recentVolumeShares: d.lots * 100, windowSeconds: d.seconds }, t), c);
      }
      if (this.enabled("book-imbalance")) {
        add(bookImbalance({ book, previousPercent: fresh ? (m.lastImbalance ?? null) : null }, t), c);
      }
      if (d && previousBook && this.enabled("wall-change")) {
        add(wallChange({ book, previous: previousBook, tradedShares: d.lots * 100 }, t), c);
      }
      if (this.enabled("uma-flag")) add(umaFlag(book), c);
      if (this.enabled("floor-locked")) add(floorLocked(book), c);

      m.lastBook = book;
      m.lastSample = sample;
      m.lastAt = at;
      m.lastImbalance = topFiveBidPercent(book) ?? undefined;
    }

    // On the first pass every book read is a fresh baseline, so nothing can be differenced yet.
    const firstPass = this.passes === 0;
    this.passes++;
    const noDelta = deltas.length === 0;

    // The severity floor lives on the engine (set from the spec in the constructor). Only the money
    // floor and the symbol filter have been applied above.
    const engine = this.engine.process(signals, now, ranked.length || read.snapshot.symbols.size);

    return {
      at: read.snapshot.at,
      symbolsSeen: read.snapshot.symbols.size,
      deltas: noDelta ? null : deltas,
      ...(noDelta && firstPass ? { reason: "first-poll" as const } : {}),
      signals,
      engine,
      booksRead,
      errors,
      ...wideCount,
    };
  }

  get alertsSpent(): number {
    return this.engine.spent;
  }

  get overFiring(): SignalKind[] {
    return this.engine.overFiringKinds();
  }
}
