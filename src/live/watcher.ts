/**
 * One pass of the watcher: fetch, detect, filter, report.
 *
 * This is the only file that knows about all the pieces at once. The detectors are pure and the
 * alert engine is pure; this is where they meet the network, and keeping that boundary sharp is what
 * makes everything else testable without a market.
 *
 * ## Cost, and why the order of operations matters
 *
 * `top-stock` covers a hundred symbols in ONE request and drives the value-surge detector. The
 * order-book detectors need a request PER SYMBOL, so they are run only on symbols that are in scope
 * AND actually traded in the window. Watching a hundred symbols would otherwise mean a hundred
 * requests every interval against an unofficial API on the user's own account, which is the thing
 * the research was explicit about not doing.
 */
import { getJson } from "../http/client.js";
import { MarketWatcher, type PollResult } from "./poller.js";
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

/** How many symbols may be book-checked in one pass. Each is a separate request. */
const MAX_BOOK_FETCHES = 12;

/** With `wide`: how many of those slots go to symbols only the movers lists carry, by default. */
export const DEFAULT_WIDE_BOOK_SLOTS = 4;

/**
 * Which symbols get an order-book read this pass.
 *
 * Without movers symbols this is the old rule: the busiest by rupiah, up to `max`. With them, up to
 * `wideSlots` go to movers-only symbols ranked by LOTS traded in the window, because those are the
 * cheap names whose rupiah would never win a slot. Slots one side cannot fill go to the other, so
 * the total stays `max` and the request budget does not grow.
 */
export function chooseBookCandidates(deltas: TradeDelta[], max: number, wideSlots: number): TradeDelta[] {
  const traded = deltas.filter((d) => d.trades > 0);
  const main = traded.filter((d) => d.source !== "movers").sort((a, b) => b.value - a.value);
  const wide = traded.filter((d) => d.source === "movers").sort((a, b) => b.lots - a.lots);
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
      ? { id: { headline: signal.id.headline, detail: [...signal.id.detail, `Saham ini masuk lewat daftar top ${id} Stockbit, di luar 100 saham utama.`] } }
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
    const errors: string[] = [];
    const poll = await this.market.poll(now.getTime());

    if (!poll.deltas) {
      return {
        at: poll.at,
        symbolsSeen: poll.symbolsSeen,
        deltas: null,
        reason: poll.reason,
        signals: [],
        engine: null,
        booksRead: [],
        errors: [...errors, ...(poll.warnings ?? [])],
        ...(poll.moversOnly !== undefined ? { moversOnly: poll.moversOnly } : {}),
      };
    }

    errors.push(...(poll.warnings ?? []));
    const mine = poll.deltas.filter((d) => inScope(this.opts.scope, d.symbol));
    const signals: Signal[] = [];
    // Every detector reports through this, so a movers-only symbol is labelled whichever one fired.
    const add = (s: Signal | null, d: TradeDelta) => {
      if (s) signals.push(d.source === "movers" ? tagWide(s, d.lists) : s);
    };

    // ---- value surge (#1): free, one request already spent ----
    if (this.enabled("value-surge")) {
      for (const d of mine) {
        if (this.opts.spec.minValue !== null && d.value < this.opts.spec.minValue) continue;
        // A symbol that has been firing all session gets a harder gate, per the adaptive rule.
        const widen = this.engine.widenFactor(d.symbol);
        const base: Thresholds =
          d.source === "movers" ? { ...t, minWindowValue: t.minWindowValueWide ?? t.minWindowValue } : t;
        const scaled: Thresholds =
          widen === 1 ? base : { ...base, concentration: base.concentration * widen, rate: base.rate * widen };
        const s = valueSurge(
          {
            delta: d,
            sessionValue: d.sessionValue,
            sessionFrequency: d.sessionFrequency,
            elapsedSeconds: this.opts.elapsedSeconds(),
          },
          scaled,
        );
        add(s, d);
      }
    }

    // ---- awakening (#7): also free ----
    if (this.enabled("awakening")) {
      for (const d of mine) {
        const prev = this.mem(d.symbol).previousSessionValue;
        if (prev === undefined) continue;
        const s = awakening({ symbol: d.symbol, todayValue: d.sessionValue, previousSessionValue: prev }, t);
        add(s, d);
      }
    }

    // ---- the book detectors: one request each, so choose carefully ----
    const needsBook =
      this.enabled("band-approach") ||
      this.enabled("book-imbalance") ||
      this.enabled("wall-change") ||
      this.enabled("uma-flag") ||
      this.enabled("floor-locked");

    const booksRead: string[] = [];
    if (needsBook) {
      // Busiest first: a symbol that did not trade cannot have moved its book meaningfully, and the
      // budget is better spent where something happened.
      const candidates = chooseBookCandidates(
        mine,
        MAX_BOOK_FETCHES,
        this.opts.wide ? (this.opts.wideBookSlots ?? DEFAULT_WIDE_BOOK_SLOTS) : 0,
      );
      for (const d of candidates) {
        let book: OrderBook | null = null;
        try {
          book = parseOrderBook(await getJson("orderbook", { segments: { symbol: d.symbol } }));
        } catch (err) {
          errors.push(`${d.symbol}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!book) {
          errors.push(`${d.symbol}: order book did not parse`);
          continue;
        }
        booksRead.push(d.symbol);
        const m = this.mem(d.symbol);

        if (this.enabled("band-approach")) {
          const s = bandApproach({ book, recentVolumeShares: d.lots * 100, windowSeconds: d.seconds }, t);
          add(s, d);
        }
        if (this.enabled("book-imbalance")) {
          const s = bookImbalance({ book, previousPercent: m.lastImbalance ?? null }, t);
          add(s, d);
        }
        if (this.enabled("wall-change") && m.lastBook) {
          const s = wallChange({ book, previous: m.lastBook, tradedShares: d.lots * 100 }, t);
          add(s, d);
        }
        if (this.enabled("uma-flag")) {
          const s = umaFlag(book);
          add(s, d);
        }
        if (this.enabled("floor-locked")) {
          const s = floorLocked(book);
          add(s, d);
        }

        m.lastBook = book;
        m.lastImbalance = topFiveBidPercent(book) ?? undefined;
      }
    }

    // The severity floor lives on the engine (set from the spec in the constructor). Only the money
    // floor and the symbol filter have been applied above.
    const engine = this.engine.process(signals, now, mine.length || poll.symbolsSeen);

    return {
      at: poll.at,
      symbolsSeen: poll.symbolsSeen,
      deltas: mine,
      signals,
      engine,
      booksRead,
      errors,
      ...(poll.moversOnly !== undefined ? { moversOnly: poll.moversOnly } : {}),
    };
  }

  get alertsSpent(): number {
    return this.engine.spent;
  }

  get overFiring(): SignalKind[] {
    return this.engine.overFiringKinds();
  }
}
