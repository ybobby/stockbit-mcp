/**
 * The detectors. One function per signal, all pure, all testable with no market open.
 *
 * Each returns a {@link Signal} or null. Nothing here decides whether the user is told — that is the
 * alert engine's job (`alertengine.ts`), and keeping the two apart is what makes it possible to tune
 * noise without touching the arithmetic that decides truth.
 *
 * ## Thresholds are arguments, not constants
 *
 * Every number lives in {@link DEFAULTS}, sourced from the research findings, and every detector
 * takes them as a parameter. That is not ceremony: the report's own conclusion is that IDX mean print
 * size varies roughly tenfold across the price range, so any constant baked into a function body
 * would be wrong for most of the market and impossible to revise per symbol later.
 *
 * ## What each detector may and may not claim
 *
 * A detector reports what it measured and how surprising it was. It never claims to have seen an
 * individual trade unless `trades === 1`, and it never describes withdrawn depth as intent — you can
 * observe an order leaving, you cannot observe why, and IDX books carry no per-order participant id.
 */
import type { TradeDelta } from "./tape.js";
import { depth, toLots, type BookLevel, type OrderBook } from "./orderbook.js";

export type SignalKind =
  | "value-surge"
  | "band-approach"
  | "book-imbalance"
  | "wall-change"
  | "awakening"
  | "uma-flag"
  | "floor-locked"
  /** A large aggressive print confirmed on the running-trade tape. See `prints.ts`. */
  | "whale";

/** Kinds the screener reports before (or without) a tape confirmation: anomalies, not whales. */
export const ANOMALY_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  "value-surge",
  "awakening",
  "book-imbalance",
  "wall-change",
  "band-approach",
]);

export type Severity = "info" | "watch" | "alert" | "critical";

export interface Signal {
  kind: SignalKind;
  symbol: string;
  severity: Severity;
  /**
   * How far past its own threshold this fired, as a multiple. 1.0 means "exactly at the line".
   *
   * This is the ranking key when more signals fire than may be shown, so it must be comparable
   * ACROSS kinds — which is why it is a ratio to threshold rather than a raw magnitude.
   */
  surprise: number;
  headline: string;
  detail: string[];
  /** Dedup key component: the price rounded into a 1%-wide bucket. */
  priceBucket: number;
  at: number;
  /**
   * The same finding in plain Indonesian, for a chat message a non-specialist reads on a phone.
   *
   * Written from the same numbers as `headline`/`detail`, in the same function, so the two cannot
   * disagree. It must make no stronger claim than the English: no buyer names, no "manipulation",
   * no direction the measurement cannot see. Optional so a caller that only reads the English is
   * unaffected.
   */
  id?: { headline: string; detail: string[] };
}

export interface Thresholds {
  /** #1 — window mean print size vs session mean print size. */
  concentration: number;
  /** #1 — window value vs the value that window would normally carry. */
  rate: number;
  /** #1 — absolute rupiah floor, so a thin stock cannot fire on noise. */
  minWindowValue: number;
  /**
   * #1 — the same floor for a symbol that only the movers lists carry (`--wide`). Those are mostly
   * cheap, high-lot names that rarely move Rp300 juta in a minute, so the top-stock floor would
   * keep them silent. Absent means `minWindowValue`.
   */
  minWindowValueWide?: number;
  /** #1 — a window needs at least this many prints to have a meaningful mean. */
  minWindowTrades: number;
  /** #1, and the warm-up gate generally — a symbol needs this much session history. */
  minSessionTrades: number;
  /** #2 — fire when remaining depth to the band is under this multiple of recent consumption. */
  bandDepthMultiple: number;
  /**
   * #2 — and only once price has covered at least this share of the way from the previous close to
   * the band. Without it a stock 2% up with a thin ladder above read as "approaching ARA" while
   * 31.9% short of it (IRSX, 2026-11-26). Absent means no price gate.
   */
  bandProgressMin?: number;
  /** #3 — top-5 bid share, as a percentage, at or above which the book is one-sided. */
  imbalanceHigh: number;
  /** #3 — and at or below which it is one-sided the other way. */
  imbalanceLow: number;
  /** #6 — a level must lose at least this fraction of its size to count as withdrawn. */
  wallShrink: number;
  /** #6 — ...and the trading that happened must explain less than this fraction of the loss. */
  wallUnexplained: number;
  /**
   * #6 — the size that left or arrived, in RUPIAH (shares × price), must reach this. Absent means no
   * floor. Added 2026-11-26 after the first full morning sent 20 wall-change alerts out of 25,
   * several for levels worth a few hundred million rupiah on cheap stocks.
   */
  wallMinValue?: number;
  /** #7 — today's value versus the previous session's total. */
  awakeningMultiple: number;
}

/**
 * Defaults taken from the research findings, with the reasoning that justified each.
 *
 * `concentration: 5` — trade sizes are power-law with a tail exponent near 1.5, so a window's mean is
 * dominated by its largest print; 3 fires on ordinary draws from that tail, 10 only ever fires on
 * thin names. `rate: 3` matches the RVOL convention (1.5 elevated, 2-3 above average, >5 catalyst),
 * applied to VALUE rather than shares because lot sizes vary by more than tenfold across the price
 * range. `minSessionTrades: 200` is the warm-up gate. `imbalance 75/25` is measured on the top five
 * levels rather than the API's own `bid_percent`, which compared twenty bid levels against forty-one
 * offer levels on the book this was written against and called the result balanced.
 */
export const DEFAULTS: Thresholds = {
  concentration: 5,
  rate: 3,
  minWindowValue: 300_000_000,
  minWindowValueWide: 100_000_000,
  minWindowTrades: 3,
  minSessionTrades: 200,
  bandDepthMultiple: 3,
  bandProgressMin: 2 / 3,
  imbalanceHigh: 75,
  imbalanceLow: 25,
  wallShrink: 0.5,
  wallUnexplained: 0.5,
  wallMinValue: 1_000_000_000,
  awakeningMultiple: 3,
};

const bucket = (price: number): number => Math.round(price / Math.max(1, price * 0.01));

const rupiah = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `Rp ${(n / 1e12).toFixed(2)} T`;
  if (abs >= 1e9) return `Rp ${(n / 1e9).toFixed(2)} bn`;
  if (abs >= 1e6) return `Rp ${(n / 1e6).toFixed(1)} jt`;
  return `Rp ${Math.round(n).toLocaleString("en-US")}`;
};

/** Indonesian money: "Rp 2,10 M", "Rp 525 jt". Miliar is M, the convention on Indonesian trading screens. */
export const rupiahId = (n: number): string => {
  const abs = Math.abs(n);
  const f = (v: number, d: number) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (abs >= 1e12) return `Rp ${f(n / 1e12, 2)} T`;
  if (abs >= 1e9) return `Rp ${f(n / 1e9, 2)} M`;
  if (abs >= 1e6) return `Rp ${f(n / 1e6, 0)} jt`;
  return `Rp ${f(n, 0)}`;
};

/** Indonesian number with thousands dots: 28.804. */
export const numId = (n: number, digits = 0): string =>
  n.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const lotsId = (shares: number): string => numId(Math.round(toLots(shares)));
const sideId = (side: "bid" | "offer"): string => (side === "bid" ? "beli (bid)" : "jual (offer)");

const severityFor = (surprise: number): Severity =>
  surprise >= 10 ? "critical" : surprise >= 3 ? "alert" : surprise >= 1 ? "watch" : "info";

/* ------------------------------------------------------------------ *
 * #1 — value surge with print concentration
 * ------------------------------------------------------------------ */

export interface SurgeInput {
  delta: TradeDelta;
  /** Cumulative session value for this symbol, rupiah. */
  sessionValue: number;
  /** Cumulative session transaction count. */
  sessionFrequency: number;
  /**
   * Seconds of trading elapsed in the session so far.
   *
   * Used to pro-rate what the window "should" have carried. The report is explicit that no intraday
   * baseline exists in this API and one has to be accumulated over ~20 sessions; until then the
   * session's own average rate is the honest stand-in, and it is deliberately a weaker claim than a
   * time-of-day median would be.
   */
  elapsedSeconds: number;
}

/**
 * The headline signal: money arriving in unusually large pieces.
 *
 * Two conditions, both required. CONCENTRATION says the prints in this window were larger than this
 * symbol's own prints usually are. RATE says more money moved than this window would normally carry.
 * Either alone is ordinary — a busy minute of small trades has high RATE and low CONC; a sleepy
 * minute containing one chunky print has the reverse.
 */
export function valueSurge(input: SurgeInput, t: Thresholds = DEFAULTS): Signal | null {
  const { delta, sessionValue, sessionFrequency, elapsedSeconds } = input;

  if (delta.trades < t.minWindowTrades) return null;
  if (sessionFrequency < t.minSessionTrades) return null;
  if (delta.value < t.minWindowValue) return null;
  if (sessionValue <= 0 || sessionFrequency <= 0 || elapsedSeconds <= 0 || delta.seconds <= 0) return null;

  const sessionMeanPrint = sessionValue / sessionFrequency;
  const windowMeanPrint = delta.value / delta.trades;
  if (sessionMeanPrint <= 0) return null;

  const concentration = windowMeanPrint / sessionMeanPrint;
  const expectedWindowValue = sessionValue * (delta.seconds / elapsedSeconds);
  const rate = expectedWindowValue > 0 ? delta.value / expectedWindowValue : 0;

  if (concentration < t.concentration || rate < t.rate) return null;

  // Ranked by whichever gate it cleared by less — the binding constraint is the honest measure of
  // how unusual this is, and taking the larger would flatter a signal that barely passed the other.
  const surprise = Math.min(concentration / t.concentration, rate / t.rate);

  return {
    kind: "value-surge",
    symbol: delta.symbol,
    severity: severityFor(surprise),
    surprise,
    headline: `${delta.symbol}: ${rupiah(delta.value)} in ${Math.round(delta.seconds)}s across ${delta.trades} print${delta.trades === 1 ? "" : "s"}`,
    detail: [
      `Average print ${rupiah(windowMeanPrint)} vs ${rupiah(sessionMeanPrint)} for the session — ${concentration.toFixed(1)}x.`,
      `Money in the window ran ${rate.toFixed(1)}x the session's own pace.`,
      delta.confidence === "single"
        ? "Exactly one print, so that average IS the trade."
        : delta.confidence === "few"
          ? `${delta.trades} prints, so at least one was large.`
          : `${delta.trades} prints, so this is large ON AVERAGE and says nothing about any single trade.`,
    ],
    priceBucket: 0,
    at: Date.now(),
    id: {
      headline: `${delta.symbol}: transaksi besar masuk`,
      detail: [
        `${rupiahId(delta.value)} berpindah tangan dalam ${Math.round(delta.seconds)} detik lewat ${numId(delta.trades)} transaksi.`,
        `Rata-rata per transaksi ${rupiahId(windowMeanPrint)}, ${numId(concentration, 1)}x lebih besar dari rata-rata saham ini hari ini (${rupiahId(sessionMeanPrint)}).`,
        `Uang mengalir ${numId(rate, 1)}x lebih cepat dari biasanya hari ini.`,
        delta.confidence === "single"
          ? "Hanya 1 transaksi, jadi ini memang satu order besar."
          : delta.confidence === "few"
            ? `Hanya ${delta.trades} transaksi, jadi setidaknya ada satu order besar di dalamnya.`
            : `Ada ${numId(delta.trades)} transaksi, jadi ini besar secara rata-rata. Belum tentu ada satu order raksasa.`,
        "Arahnya (beli atau jual) tidak terlihat dari data ini.",
      ],
    },
  };
}

/* ------------------------------------------------------------------ *
 * #2 — approach to the auto-reject band, with reachable depth
 * ------------------------------------------------------------------ */

/** Shares resting between the last price and a band edge, and whether the ladder actually got there. */
export function depthToBand(book: OrderBook, side: "ara" | "arb"): { shares: number; complete: boolean } | null {
  const edge = side === "ara" ? book.ara : book.arb;
  if (edge === null) return null;
  const levels = side === "ara" ? book.offer : book.bid;
  const within = (l: BookLevel) => (side === "ara" ? l.price <= edge : l.price >= edge);
  let shares = 0;
  for (const l of levels) if (within(l)) shares += l.shares;
  return { shares, complete: side === "ara" ? book.reachesBand.ara : book.reachesBand.arb };
}

export interface BandInput {
  book: OrderBook;
  /** Shares traded in the recent window, used as the consumption rate. */
  recentVolumeShares: number;
  /** How long that window was, seconds. */
  windowSeconds: number;
}

/**
 * How much supply stands between here and the ceiling, measured against how fast it is being eaten.
 *
 * IDX-specific and exact rather than estimated: the exchange publishes the band price outright, so
 * "how much is left before ARA" is a sum over real levels, not a model.
 *
 * When the ladder stops short of the band the answer is reported as a LOWER BOUND. Treating a
 * truncated ladder as a complete one would understate remaining supply and fire early, which is the
 * one direction this signal must not be wrong in.
 */
export function bandApproach(input: BandInput, t: Thresholds = DEFAULTS): Signal | null {
  const { book, recentVolumeShares, windowSeconds } = input;
  if (recentVolumeShares <= 0 || windowSeconds <= 0) return null;

  const rising = book.lastPrice >= book.previousClose;
  const side = rising ? "ara" : "arb";
  const remaining = depthToBand(book, side);
  const edge = side === "ara" ? book.ara : book.arb;
  if (!remaining || edge === null || remaining.shares <= 0) return null;

  // How far along the road from yesterday's close to the band the price already is, 0..1.
  const road = edge - book.previousClose;
  const progress = road !== 0 ? (book.lastPrice - book.previousClose) / road : 0;
  if (t.bandProgressMin !== undefined && progress < t.bandProgressMin) return null;

  const ratio = remaining.shares / recentVolumeShares;
  if (ratio > t.bandDepthMultiple) return null;

  const surprise = t.bandDepthMultiple / Math.max(0.01, ratio);
  const pct = ((edge - book.lastPrice) / book.lastPrice) * 100;
  const minutes = (remaining.shares / recentVolumeShares) * (windowSeconds / 60);

  return {
    kind: "band-approach",
    symbol: book.symbol,
    severity: severityFor(surprise),
    surprise,
    headline: `${book.symbol}: ${toLots(remaining.shares).toLocaleString("en-US", { maximumFractionDigits: 0 })} lots left before ${side.toUpperCase()} at ${edge}`,
    detail: [
      `Price ${book.lastPrice}, ${Math.round(progress * 100)}% of the way from the previous close, ${Math.abs(pct).toFixed(1)}% from the band.`,
      `At the last ${Math.round(windowSeconds)}s of pace that is about ${minutes.toFixed(1)} minute(s) of supply.`,
      remaining.complete
        ? "The ladder reaches the band, so this is the full remaining depth."
        : "The ladder stops short of the band, so this is a LOWER BOUND — there may be more resting beyond what the book shows.",
    ],
    priceBucket: bucket(book.lastPrice),
    at: Date.now(),
    id: {
      headline: `${book.symbol}: mendekati ${side.toUpperCase()} ${numId(edge)}`,
      detail: [
        `Harga ${numId(book.lastPrice)}, sudah ${side === "ara" ? "naik" : "turun"} ${numId(Math.abs(((book.lastPrice - book.previousClose) / book.previousClose) * 100), 1)}% dari penutupan kemarin, tinggal ${numId(Math.abs(pct), 1)}% lagi ke batas ${side.toUpperCase()}.`,
        `Antrean ${side === "ara" ? "jual" : "beli"} yang tersisa sebelum ${side.toUpperCase()}: ${lotsId(remaining.shares)} lot.`,
        `Dengan kecepatan transaksi ${Math.round(windowSeconds)} detik terakhir, antrean itu habis dalam sekitar ${numId(minutes, 1)} menit.`,
        ...(remaining.complete
          ? []
          : ["Order book tidak menampilkan semua level sampai batas, jadi antrean sebenarnya bisa lebih banyak."]),
      ],
    },
  };
}

/* ------------------------------------------------------------------ *
 * #3 — top-5 order-book imbalance, computed here
 * ------------------------------------------------------------------ */

/** Top-5 bid share of top-5 total, as a percentage. Null when neither side has depth. */
export function topFiveBidPercent(book: OrderBook): number | null {
  const b = depth(book.bid, 5);
  const o = depth(book.offer, 5);
  if (b + o <= 0) return null;
  return (b / (b + o)) * 100;
}

export interface ImbalanceInput {
  book: OrderBook;
  /** The same measurement from the previous poll. Null on the first poll. */
  previousPercent: number | null;
}

/**
 * One-sided depth at the top of the book, held across two polls.
 *
 * Deliberately NOT the API's `bid_percent`. On the book this was written against that field read 50.1
 * — "balanced" — while the top five levels were 9.9% bid. It is summing whatever the ladder happens
 * to show, and the two sides are not shown to equal depth.
 *
 * The two-poll requirement is the whole noise filter. A single crossing is queue churn; depth that is
 * still one-sided a poll later is a standing condition.
 */
export function bookImbalance(input: ImbalanceInput, t: Thresholds = DEFAULTS): Signal | null {
  const { book, previousPercent } = input;
  const pct = topFiveBidPercent(book);
  if (pct === null || previousPercent === null) return null;

  const bidHeavy = pct >= t.imbalanceHigh && previousPercent >= t.imbalanceHigh;
  const offerHeavy = pct <= t.imbalanceLow && previousPercent <= t.imbalanceLow;
  if (!bidHeavy && !offerHeavy) return null;

  const distance = bidHeavy ? pct - t.imbalanceHigh : t.imbalanceLow - pct;
  const room = bidHeavy ? 100 - t.imbalanceHigh : t.imbalanceLow;
  const surprise = 1 + (room > 0 ? distance / room : 0) * 2;

  return {
    kind: "book-imbalance",
    symbol: book.symbol,
    severity: severityFor(surprise),
    surprise,
    headline: `${book.symbol}: top-5 book ${pct.toFixed(0)}% ${bidHeavy ? "bid" : "offer"}-heavy, two polls running`,
    detail: [
      `Top-5 bid share ${previousPercent.toFixed(0)}% then ${pct.toFixed(0)}%.`,
      `The API's own bid_percent reads ${book.bid.length} bid levels against ${book.offer.length} offer levels, so it is not comparable — this is the top five of each.`,
      "Queue size is an intention, not a transaction, and can be withdrawn at any moment.",
    ],
    priceBucket: bucket(book.lastPrice),
    at: Date.now(),
    id: {
      headline: bidHeavy
        ? `${book.symbol}: antrean beli jauh lebih tebal dari antrean jual`
        : `${book.symbol}: antrean jual jauh lebih tebal dari antrean beli`,
      detail: [
        bidHeavy
          ? `Di 5 level teratas order book, ${numId(pct)}% antrean adalah beli (bid). Pengecekan sebelumnya ${numId(previousPercent)}%.`
          : `Di 5 level teratas order book, antrean beli (bid) hanya ${numId(pct)}%, sisanya antrean jual. Pengecekan sebelumnya ${numId(previousPercent)}%.`,
        "Kondisi ini bertahan di dua pengecekan berturut-turut.",
        "Antrean belum tentu jadi transaksi dan bisa ditarik kapan saja.",
      ],
    },
  };
}

/* ------------------------------------------------------------------ *
 * #6 — depth withdrawn versus depth consumed
 * ------------------------------------------------------------------ */

export interface WallInput {
  book: OrderBook;
  previous: OrderBook;
  /** Shares that actually traded between the two snapshots. */
  tradedShares: number;
}

/**
 * A level that lost most of its size without the trading to explain it.
 *
 * The word for that is "withdrawn", and this deliberately never says "spoofing". You can observe
 * depth leaving; you cannot observe intent, IDX books carry no per-order participant id, and the
 * accusation is a criminal one under UU Pasar Modal Pasal 91-93.
 *
 * The mirror case matters as much: a level GROWING while little trades is a wall appearing.
 */
export function wallChange(input: WallInput, t: Thresholds = DEFAULTS): Signal | null {
  const { book, previous, tradedShares } = input;

  const index = (side: BookLevel[]) => new Map(side.map((l) => [l.price, l]));
  const candidates: { price: number; before: number; after: number; side: "bid" | "offer" }[] = [];

  for (const [side, now, then] of [
    ["bid", index(book.bid), index(previous.bid)],
    ["offer", index(book.offer), index(previous.offer)],
  ] as const) {
    for (const [price, was] of then) {
      const isNow = now.get(price)?.shares ?? 0;
      candidates.push({ price, before: was.shares, after: isNow, side });
    }
  }

  let best: { signal: Omit<Signal, "at">; score: number } | null = null;

  for (const c of candidates) {
    if (c.before <= 0) continue;
    const lost = c.before - c.after;
    const grown = c.after - c.before;

    const tooSmall = (shares: number) => t.wallMinValue !== undefined && shares * c.price < t.wallMinValue;

    if (lost > 0 && lost / c.before >= t.wallShrink && !tooSmall(lost)) {
      // Only interesting when trading cannot account for it.
      const explained = Math.min(1, tradedShares / lost);
      if (explained >= t.wallUnexplained) continue;
      const surprise = 1 + (1 - explained) * 2;
      const score = lost * (1 - explained);
      if (!best || score > best.score) {
        best = {
          score,
          signal: {
            kind: "wall-change",
            symbol: book.symbol,
            severity: severityFor(surprise),
            surprise,
            headline: `${book.symbol}: ${toLots(lost).toLocaleString("en-US", { maximumFractionDigits: 0 })} lots withdrawn from the ${c.side} at ${c.price}`,
            detail: [
              `Level went ${toLots(c.before).toLocaleString("en-US", { maximumFractionDigits: 0 })} → ${toLots(c.after).toLocaleString("en-US", { maximumFractionDigits: 0 })} lots.`,
              `Only ${toLots(tradedShares).toLocaleString("en-US", { maximumFractionDigits: 0 })} lots of this stock traded in that time, so trading explains ${(explained * 100).toFixed(0)}% of it.`,
              "Depth withdrawn. That is an observation about the book, not a claim about anyone's intent.",
            ],
            priceBucket: bucket(c.price),
            id: {
              headline: `${book.symbol}: antrean besar ${sideId(c.side)} ditarik di harga ${numId(c.price)}`,
              detail: [
                `Antrean di harga itu turun dari ${lotsId(c.before)} lot menjadi ${lotsId(c.after)} lot.`,
                `Padahal saham ini dalam waktu itu cuma tertransaksi ${lotsId(tradedShares)} lot, jadi sebagian besar ditarik, bukan dimakan.`,
                "Ini pengamatan atas order book, bukan tuduhan soal niat siapa pun.",
              ],
            },
          },
        };
      }
    }

    if (grown > 0 && c.before > 0 && grown / c.before >= 1 && grown > tradedShares && !tooSmall(grown)) {
      const surprise = 1 + Math.min(2, grown / Math.max(1, tradedShares));
      const score = grown;
      if (!best || score > best.score) {
        best = {
          score,
          signal: {
            kind: "wall-change",
            symbol: book.symbol,
            severity: severityFor(surprise),
            surprise,
            headline: `${book.symbol}: a wall appeared on the ${c.side} at ${c.price}`,
            detail: [
              `Level grew ${toLots(c.before).toLocaleString("en-US", { maximumFractionDigits: 0 })} → ${toLots(c.after).toLocaleString("en-US", { maximumFractionDigits: 0 })} lots.`,
              `Only ${toLots(tradedShares).toLocaleString("en-US", { maximumFractionDigits: 0 })} lots traded in that time, so this is new resting size rather than a shuffle.`,
            ],
            priceBucket: bucket(c.price),
            id: {
              headline: `${book.symbol}: tembok antrean ${sideId(c.side)} muncul di harga ${numId(c.price)}`,
              detail: [
                `Antrean di harga itu naik dari ${lotsId(c.before)} lot menjadi ${lotsId(c.after)} lot.`,
                `Yang tertransaksi dalam waktu itu cuma ${lotsId(tradedShares)} lot, jadi ini antrean baru, bukan sekadar geser.`,
                "Antrean bisa ditarik kapan saja.",
              ],
            },
          },
        };
      }
    }
  }

  return best ? { ...best.signal, at: Date.now() } : null;
}

/* ------------------------------------------------------------------ *
 * #7 — a quiet stock waking up
 * ------------------------------------------------------------------ */

export interface AwakeningInput {
  symbol: string;
  /** Value traded so far today, rupiah. */
  todayValue: number;
  /** The whole of the previous session, rupiah. */
  previousSessionValue: number;
}

/** The only signal worth running on the thin tier: turnover far past what this name usually does. */
export function awakening(input: AwakeningInput, t: Thresholds = DEFAULTS): Signal | null {
  const { symbol, todayValue, previousSessionValue } = input;
  if (previousSessionValue <= 0 || todayValue <= 0) return null;

  const multiple = todayValue / previousSessionValue;
  if (multiple < t.awakeningMultiple) return null;

  const surprise = multiple / t.awakeningMultiple;
  return {
    kind: "awakening",
    symbol,
    severity: severityFor(surprise),
    surprise,
    headline: `${symbol}: ${rupiah(todayValue)} today versus ${rupiah(previousSessionValue)} all of the previous session — ${multiple.toFixed(1)}x`,
    detail: [
      "A name that is normally quiet is trading heavily.",
      "Compared against the previous session's full total, so it is already ahead of a whole day.",
    ],
    priceBucket: 0,
    at: Date.now(),
    id: {
      headline: `${symbol}: saham yang biasanya sepi mendadak ramai`,
      detail: [
        `Nilai transaksi hari ini ${rupiahId(todayValue)}, sudah ${numId(multiple, 1)}x seluruh sesi sebelumnya (${rupiahId(previousSessionValue)}).`,
      ],
    },
  };
}

/* ------------------------------------------------------------------ *
 * #11 — IDX's own flags
 * ------------------------------------------------------------------ */

/**
 * The exchange's Unusual Market Activity flag and any notation codes.
 *
 * UMA is an early-warning announcement, explicitly NOT a sanction and not an accusation of
 * manipulation — roughly two stocks a trading day carry one. The wording here must never imply
 * wrongdoing, which is why it says "IDX has flagged" and stops there.
 */
export function umaFlag(book: OrderBook): Signal | null {
  if (!book.uma && book.notation.length === 0) return null;
  const surprise = book.uma ? 1.5 : 1;
  return {
    kind: "uma-flag",
    symbol: book.symbol,
    severity: "watch",
    surprise,
    headline: book.uma
      ? `${book.symbol}: IDX has flagged Unusual Market Activity`
      : `${book.symbol}: carries IDX notation ${book.notation.join(", ")}`,
    detail: [
      book.uma ? "UMA is an early-warning announcement. It is not a sanction and not a finding of manipulation." : "",
      book.notation.length ? `Notation codes: ${book.notation.join(", ")}.` : "",
    ].filter(Boolean),
    priceBucket: bucket(book.lastPrice),
    at: Date.now(),
    id: {
      headline: book.uma
        ? `${book.symbol}: IDX mengumumkan UMA (aktivitas pasar tidak biasa)`
        : `${book.symbol}: punya notasi khusus IDX ${book.notation.join(", ")}`,
      detail: [
        book.uma ? "UMA adalah peringatan dini dari bursa, bukan sanksi dan bukan bukti manipulasi." : "",
        book.notation.length ? `Kode notasi: ${book.notation.join(", ")}.` : "",
      ].filter(Boolean),
    },
  };
}

/* ------------------------------------------------------------------ *
 * #12 — locked at the floor
 * ------------------------------------------------------------------ */

/**
 * Price sitting on ARB with sell size parked on it and little or nothing bidding.
 *
 * The point is not that the stock fell. It is that there is no exit: everyone filling does so at one
 * price, which also makes any accumulation/distribution read from broker data degenerate that day.
 */
export function floorLocked(book: OrderBook): Signal | null {
  if (book.arb === null || book.lastPrice > book.arb) return null;

  const bidShares = depth(book.bid, 5);
  const offerAtFloor = book.offer.find((l) => l.price <= book.arb!)?.shares ?? depth(book.offer, 1);
  if (offerAtFloor <= 0) return null;

  // A thin bid against a heavy floor offer is the condition; an equally heavy bid means it is being
  // absorbed, which is a different situation and not this signal.
  const ratio = bidShares > 0 ? offerAtFloor / bidShares : Infinity;
  if (ratio < 5) return null;

  const surprise = Number.isFinite(ratio) ? Math.min(10, ratio / 5) : 10;
  return {
    kind: "floor-locked",
    symbol: book.symbol,
    severity: bidShares === 0 ? "critical" : severityFor(surprise),
    surprise,
    headline: `${book.symbol}: locked at ARB ${book.arb} with ${toLots(offerAtFloor).toLocaleString("en-US", { maximumFractionDigits: 0 })} lots queued to sell`,
    detail: [
      bidShares === 0
        ? "There is nothing on the bid. A position opened here cannot be exited at any price today."
        : `Top-5 bid holds ${toLots(bidShares).toLocaleString("en-US", { maximumFractionDigits: 0 })} lots — the sell queue is ${ratio.toFixed(0)}x that.`,
      "With one fill price, broker accumulation/distribution labels carry no information today.",
    ],
    priceBucket: bucket(book.lastPrice),
    at: Date.now(),
    id: {
      headline: `${book.symbol}: terkunci di ARB ${numId(book.arb)}`,
      detail: [
        `Antrean jual di ARB: ${lotsId(offerAtFloor)} lot.`,
        bidShares === 0
          ? "Tidak ada antrean beli sama sekali. Posisi yang dibuka di sini tidak bisa dijual hari ini."
          : `Antrean beli di 5 level teratas cuma ${lotsId(bidShares)} lot, antrean jualnya ${numId(ratio)}x lebih besar.`,
      ],
    },
  };
}
