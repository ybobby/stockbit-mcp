/**
 * The signal journal: every BUY the bot sent, and how it ended.
 *
 * A local JSON file, not the paper-trading ledger. Paper orders go through preview tickets and an
 * explicit confirmation because a person is deciding to act; a signal is a message the bot decided
 * to send, and its journal exists only so the weekly recap can say honestly how those messages did.
 * Mixing the two would let a bot write into a ledger the person treats as their own decisions.
 *
 * Results are measured at the price the bot SAW when it sent the signal and when it closed it —
 * no fees, no slippage, no partial fills. The recap says so.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stockbitDir } from "../paths.js";
import type { ExitKind, OpenSignal } from "./engine.js";

export interface ClosedSignal extends OpenSignal {
  closedAt: string;
  closedDay: string;
  exitPrice: number;
  exitKind: ExitKind;
  /** Percent from entry to exit. */
  returnPct: number;
}

export interface Journal {
  version: 1;
  open: OpenSignal[];
  closed: ClosedSignal[];
  /** Symbol → last WIB day a signal on it closed, for the cooldown. */
  lastClosed: Record<string, string>;
  /** WIB days a weekly recap was already sent. */
  recapsSent: string[];
}

export function journalPath(): string {
  return join(stockbitDir(), "signals", "journal.json");
}

export function emptyJournal(): Journal {
  return { version: 1, open: [], closed: [], lastClosed: {}, recapsSent: [] };
}

export function loadJournal(path = journalPath()): Journal {
  if (!existsSync(path)) return emptyJournal();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Journal>;
  return {
    version: 1,
    open: parsed.open ?? [],
    closed: parsed.closed ?? [],
    lastClosed: parsed.lastClosed ?? {},
    recapsSent: parsed.recapsSent ?? [],
  };
}

/** Written to a temp file and renamed, so a crash mid-write cannot leave half a journal. */
export function saveJournal(journal: Journal, path = journalPath()): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2), "utf8");
  renameSync(tmp, path);
}

export function closeSignal(
  journal: Journal,
  id: string,
  exit: { price: number; kind: ExitKind; at: string; day: string },
): ClosedSignal | null {
  const i = journal.open.findIndex((s) => s.id === id);
  if (i === -1) return null;
  const [open] = journal.open.splice(i, 1);
  const closed: ClosedSignal = {
    ...open,
    closedAt: exit.at,
    closedDay: exit.day,
    exitPrice: exit.price,
    exitKind: exit.kind,
    returnPct: Math.round(((exit.price - open.entry) / open.entry) * 10000) / 100,
  };
  journal.closed.push(closed);
  journal.lastClosed[open.symbol] = exit.day;
  return closed;
}

export interface Recap {
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgReturnPct: number | null;
  best: ClosedSignal | null;
  worst: ClosedSignal | null;
  stillOpen: number;
}

/** Signals closed on or after `sinceDay` (WIB `YYYY-MM-DD`). */
export function recap(journal: Journal, sinceDay: string): Recap {
  const rows = journal.closed.filter((c) => c.closedDay >= sinceDay);
  const wins = rows.filter((r) => r.returnPct > 0).length;
  const sorted = [...rows].sort((a, b) => b.returnPct - a.returnPct);
  const avg = rows.length ? rows.reduce((s, r) => s + r.returnPct, 0) / rows.length : null;
  return {
    closed: rows.length,
    wins,
    losses: rows.length - wins,
    winRatePct: rows.length ? Math.round((wins / rows.length) * 100) : null,
    avgReturnPct: avg === null ? null : Math.round(avg * 100) / 100,
    best: sorted[0] ?? null,
    worst: sorted[sorted.length - 1] ?? null,
    stillOpen: journal.open.length,
  };
}
