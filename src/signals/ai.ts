/**
 * The AI second opinion on a BUY: Claude reads the evidence and may VETO it, and writes a short
 * Indonesian note for the group.
 *
 * ## What the model may and may not do
 *
 * - It sees only numbers this server already read. It has no tools and no web access.
 * - It may cancel a signal the rules produced. It may NOT create one, change the entry, the stop or
 *   the targets — those stay the engine's, so every number in a message has one checkable source.
 * - Its note is checked: if it quotes a number that is not in the evidence it was given, the note is
 *   dropped (the veto/keep decision still stands). "Never invent a number" applies to the model too.
 * - Any failure — no key, a network error, a refusal, malformed output — means no note and NO veto.
 *   The rules already passed; an unavailable reviewer must not silently stop the feed.
 *
 * Off unless `ANTHROPIC_API_KEY` is set (or another credential the SDK resolves, see its docs).
 */
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import type { BuyPlan, DailyContext, WhaleHit } from "./engine.js";

export interface AiReview {
  approve: boolean;
  /** Indonesian, already checked for invented numbers. Null when it failed the check. */
  note: string | null;
}

export type AiReviewer = (input: { plan: BuyPlan; ctx: DailyContext; whales: WhaleHit[] }) => Promise<AiReview | null>;

export const DEFAULT_MODEL = "claude-opus-5-5";

const SYSTEM = [
  "Kamu adalah asisten analis saham Indonesia yang memeriksa sinyal BELI otomatis sebelum dikirim ke grup Telegram.",
  "Kamu hanya menerima data yang sudah dibaca dari Stockbit (analisis harian dan pemicu intraday).",
  "Tugasmu: (1) putuskan apakah sinyal layak dikirim atau dibatalkan karena buktinya lemah atau saling bertentangan;",
  "(2) tulis catatan singkat 1-3 kalimat dalam bahasa Indonesia sederhana untuk orang awam.",
  "Aturan: jangan menyebut angka apa pun yang tidak ada di data. Jangan mengubah harga beli, stop loss, atau target.",
  "Jangan menjanjikan keuntungan. Jangan menyebut nama broker atau pembeli tertentu yang tidak ada di data.",
].join(" ");

const SCHEMA = {
  type: "object",
  properties: {
    keputusan: { type: "string", enum: ["kirim", "batal"] },
    catatan: { type: "string" },
  },
  required: ["keputusan", "catatan"],
  additionalProperties: false,
} as const;

/** Every number written in `text`, normalised (Indonesian thousands dots and decimal commas). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d.,]*/g)) {
    let s = m[0].replace(/[.,]$/, "");
    // 1.250 or 12.500.000 → thousands separators; 2,5 → decimal comma.
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(",", ".");
    const v = Number(s);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * True when every number in `note` appears in the evidence (to within rounding). Small counting
 * words like "1-3 kalimat" are not the risk; prices and percentages are, so numbers below 10 that
 * are whole are allowed — "2 dari 4 pilar" cannot mislead anyone about a price.
 */
export function noteIsGrounded(note: string, evidence: unknown): boolean {
  const known = numbersIn(JSON.stringify(evidence));
  return numbersIn(note).every(
    (n) => (Number.isInteger(n) && n < 10) || known.some((k) => Math.abs(k - n) <= Math.max(0.051, Math.abs(k) * 0.005)),
  );
}

function evidenceOf({ plan, ctx, whales }: { plan: BuyPlan; ctx: DailyContext; whales: WhaleHit[] }) {
  return {
    sinyal: plan,
    analisisHarian: {
      tanggal: ctx.asOf,
      condong: ctx.lean,
      skor: ctx.score,
      keyakinanBukti: ctx.confidence,
      penutupanKemarin: ctx.prevClose,
      tertinggiKemarin: ctx.prevHigh,
      terendahKemarin: ctx.prevLow,
      atr14: ctx.atr,
      pilar: ctx.pillars,
    },
    whaleHariIni: whales.map((w) => ({ jenis: w.kind, jam: w.at, ringkasan: w.text })),
  };
}

/** Parse the model's JSON answer into a review, applying the grounding check. Null when unusable. */
export function reviewFromText(text: string, evidence: unknown): AiReview | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: { keputusan?: string; catatan?: string };
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed.keputusan !== "kirim" && parsed.keputusan !== "batal") return null;
  const raw = (parsed.catatan ?? "").trim().slice(0, 500);
  return { approve: parsed.keputusan === "kirim", note: raw && noteIsGrounded(raw, evidence) ? raw : null };
}

/** Through the Anthropic API. Needs ANTHROPIC_API_KEY (billed per use, separate from a Claude plan). */
export function claudeReviewer(opts: { model?: string; client?: Anthropic } = {}): AiReviewer {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? DEFAULT_MODEL;
  return async (input) => {
    const evidence = evidenceOf(input);
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 2000,
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: "user", content: `Data sinyal (JSON):\n${JSON.stringify(evidence)}` }],
      });
      if (response.stop_reason !== "end_turn") return null;
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") return null;
      return reviewFromText(text.text, evidence);
    } catch {
      // Deliberately swallowed: see the module note. The caller records that no review happened.
      return null;
    }
  };
}

/**
 * Through Claude Code on this machine (`claude -p`), so the review runs on the Claude plan the user
 * is already signed in with (Pro/Max) instead of a separately billed API key.
 *
 * `ANTHROPIC_API_KEY` is removed from the child's environment: with it set, Claude Code would bill
 * the API instead of the plan, which is the opposite of why this option exists. No tools are
 * granted: in print mode nothing that needs approval can run, and the prompt asks for JSON only.
 */
export function claudeCodeReviewer(opts: { command?: string; model?: string; timeoutMs?: number } = {}): AiReviewer {
  const command = opts.command ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return (input) =>
    new Promise((resolve) => {
      const evidence = evidenceOf(input);
      const prompt =
        `${SYSTEM}\n\nJawab HANYA dengan satu objek JSON: {"keputusan": "kirim" atau "batal", "catatan": "..."}.` +
        ` Tanpa teks lain.\n\nData sinyal (JSON):\n${JSON.stringify(evidence)}`;
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      const args = ["-p", "--output-format", "text"];
      if (opts.model) args.push("--model", opts.model);
      let out = "";
      let done = false;
      const finish = (v: AiReview | null) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      let child;
      try {
        child = spawn(command, args, { env, stdio: ["pipe", "pipe", "ignore"] });
      } catch {
        return finish(null);
      }
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(null);
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code === 0 ? reviewFromText(out, evidence) : null);
      });
      child.stdin.end(prompt);
    });
}
