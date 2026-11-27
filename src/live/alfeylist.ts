/**
 * Which stocks are AlfeySaham's open positions and candidates, for a label on the alert.
 *
 * The list comes from AlfeySaham's own `GET /api/whale-watchlist` (its decision D-093), which
 * returns ONLY ticker, status and a WIB date: no entry price, stop or target. That endpoint is not a
 * Stockbit host, so it sits outside the closed route table the same way Telegram does, and it is
 * read-only by construction (GET). The key travels in `x-whale-watchlist-key`, not as a bearer:
 * in this repo only the transport builds a bearer (test/transport.test.ts, ADR-0002), and that rule
 * keeps meaning "a bearer here is a Stockbit token".
 *
 * The label reveals running positions. It is for the internal admin group only, and is off unless
 * both the URL and the token are configured; `--no-alfey-labels` turns it off for a run.
 *
 * A failed refresh keeps the last good list: a label that is a few minutes stale is better than
 * labels that vanish whenever the site hiccups. A list older than `maxAgeMs` is dropped, so a
 * position closed hours ago is not still labelled open.
 */

export interface AlfeyEntry {
  status: "active" | "setup";
  /** YYYY-MM-DD, WIB. For a candidate, the day the setup was published. */
  date: string;
}

/** Parse the endpoint's body. Unknown rows are skipped; an active row wins over a setup row. */
export function parseAlfeyList(body: unknown): Map<string, AlfeyEntry> {
  const out = new Map<string, AlfeyEntry>();
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error("whale-watchlist: no items array");
  for (const raw of items) {
    const r = raw as { ticker?: unknown; status?: unknown; date?: unknown };
    if (typeof r.ticker !== "string" || !/^[A-Z0-9]{2,6}$/.test(r.ticker.trim().toUpperCase())) continue;
    if (r.status !== "active" && r.status !== "setup") continue;
    if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    const ticker = r.ticker.trim().toUpperCase();
    const prev = out.get(ticker);
    if (prev?.status === "active" && r.status === "setup") continue;
    // Two candidates for one stock: the newer date is the one the group last read about.
    if (prev && prev.status === r.status && prev.date >= r.date) continue;
    out.set(ticker, { status: r.status, date: r.date });
  }
  return out;
}

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** The owner's wording (2026-11-26): "Posisi Aktif AlfeySaham" and "Kandidat per <date>". */
export function alfeyLabel(entry: AlfeyEntry | undefined): string | null {
  if (!entry) return null;
  if (entry.status === "active") return "📌 Posisi Aktif AlfeySaham";
  const [y, m, d] = entry.date.split("-").map(Number);
  return `📋 Kandidat per ${d} ${BULAN[m - 1] ?? m} ${y}`;
}

export interface AlfeyListOptions {
  url: string;
  token: string;
  /** How often to fetch again. Default 15 minutes. */
  refreshMs?: number;
  /** Drop a list this old when refreshing keeps failing. Default 2 hours. */
  maxAgeMs?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class AlfeyList {
  private entries = new Map<string, AlfeyEntry>();
  private fetchedAt: number | null = null;
  private triedAt: number | null = null;

  constructor(private readonly opts: AlfeyListOptions) {}

  /**
   * Fetch when due. Returns an error string for the log on failure, never throws, and never puts
   * the URL or the token in that string.
   */
  async refresh(now: number): Promise<string | null> {
    const every = this.opts.refreshMs ?? 15 * 60_000;
    if (this.triedAt !== null && now - this.triedAt < every) return null;
    this.triedAt = now;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8000);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.opts.url, {
        headers: { "x-whale-watchlist-key": this.opts.token },
        redirect: "manual",
        signal: controller.signal,
      });
      if (!res.ok) return this.stale(now, `HTTP ${res.status}`);
      this.entries = parseAlfeyList(await res.json());
      this.fetchedAt = now;
      return null;
    } catch (err) {
      return this.stale(now, err instanceof Error ? `request failed (${err.name})` : "request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  private stale(now: number, reason: string): string {
    if (this.fetchedAt !== null && now - this.fetchedAt > (this.opts.maxAgeMs ?? 2 * 3600_000)) {
      this.entries = new Map();
      this.fetchedAt = null;
    }
    return `alfey list: ${reason}`;
  }

  label(symbol: string): string | null {
    return alfeyLabel(this.entries.get(symbol.toUpperCase()));
  }

  /** Every listed ticker, so the watcher can keep them in its order-book queue. */
  symbols(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }
}
