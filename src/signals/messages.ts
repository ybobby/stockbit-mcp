/**
 * The words that reach the Telegram group, in plain Indonesian.
 *
 * Every message ends with the same disclaimer, and none of them may read as if an order was placed:
 * this bot sends text and nothing else.
 */
import type { BuyPlan, ExitDecision, OpenSignal } from "./engine.js";
import type { ClosedSignal, Recap } from "./ledger.js";

export const DISCLAIMER_ID =
  "⚠️ Bukan ajakan beli/jual dan bukan nasihat investasi. Sinyal otomatis bisa salah. Keputusan dan risiko ada di tangan masing-masing.";

const WIB_MS = 7 * 3600_000;

export function wibTime(now: Date): string {
  return new Date(now.getTime() + WIB_MS).toISOString().slice(11, 16);
}

export function rp(n: number): string {
  return n.toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

function pct(from: number, to: number): string {
  const v = ((to - from) / from) * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1).replace(".", ",")}%`;
}

export interface AiNote {
  /** One to three short sentences, Indonesian. */
  text: string;
}

export function buyText(plan: BuyPlan, now: Date, ai: AiNote | null): string {
  const lines = [
    `🟢 SINYAL BELI: ${plan.symbol}`,
    "",
    `Harga sekarang: ${rp(plan.entry)}`,
    `Stop loss: ${rp(plan.stop)} (${pct(plan.entry, plan.stop)})`,
    `Target 1: ${rp(plan.target1)} (${pct(plan.entry, plan.target1)})`,
    `Target 2: ${rp(plan.target2)} (${pct(plan.entry, plan.target2)})`,
    "",
    `Pemicu: ${plan.trigger}`,
  ];
  if (plan.reasons.length) {
    lines.push("Analisis harian:");
    for (const r of plan.reasons) lines.push(`• ${r}`);
  }
  if (ai) lines.push("", `🤖 Catatan AI: ${ai.text}`);
  lines.push(
    "",
    `Saran: risiko per transaksi sebaiknya kecil (misalnya 1% modal). Kalau harga sudah jauh di atas ${rp(plan.entry)}, jangan dikejar.`,
    `${wibTime(now)} WIB`,
    "",
    DISCLAIMER_ID,
  );
  return lines.join("\n");
}

const EXIT_HEAD: Record<ExitDecision["kind"], string> = {
  target1: "🎯 TARGET 1 TERCAPAI",
  target2: "🔴 SINYAL JUAL (target 2 tercapai)",
  stop: "🔴 SINYAL JUAL (kena stop loss)",
  breakeven: "🔴 SINYAL JUAL (balik ke harga beli)",
  flip: "🔴 SINYAL JUAL (analisis harian berbalik negatif)",
  distribution: "🔴 SINYAL JUAL (tekanan jual besar)",
  time: "🔴 SINYAL JUAL (terlalu lama tidak bergerak)",
};

const EXIT_EXPLAIN: Record<ExitDecision["kind"], string> = {
  target1: "Sebagian bisa diamankan. Stop loss dinaikkan ke harga beli, jadi sisa posisi tidak rugi kalau harga balik.",
  target2: "Target akhir tercapai. Sinyal ini ditutup.",
  stop: "Harga menyentuh stop loss. Disiplin keluar supaya rugi tetap kecil.",
  breakeven: "Setelah target 1, harga turun lagi ke harga beli. Sinyal ditutup tanpa rugi.",
  flip: "Skor analisis harian (broker, tren, pola, valuasi) sekarang condong negatif.",
  distribution: "Ada transaksi besar sementara harga turun di bawah harga beli. Ini tanda tekanan jual.",
  time: "Sudah lama tidak mencapai target. Modal lebih baik dipakai di tempat lain.",
};

export function exitText(open: OpenSignal, exit: ExitDecision, now: Date): string {
  return [
    `${EXIT_HEAD[exit.kind]}: ${open.symbol}`,
    "",
    `Harga beli sinyal: ${rp(open.entry)}`,
    `Harga sekarang: ${rp(exit.price)} (${pct(open.entry, exit.price)})`,
    exit.kind === "target1" ? `Stop loss baru: ${rp(open.entry)}` : `Sinyal dibuka: ${open.openedDay}`,
    "",
    EXIT_EXPLAIN[exit.kind],
    `${wibTime(now)} WIB`,
    "",
    DISCLAIMER_ID,
  ].join("\n");
}

function line(c: ClosedSignal | null): string {
  if (!c) return "-";
  return `${c.symbol} ${c.returnPct >= 0 ? "+" : ""}${String(c.returnPct).replace(".", ",")}%`;
}

export function recapText(r: Recap, sinceDay: string, now: Date): string {
  const lines = [`📊 REKAP SINYAL MINGGU INI (sejak ${sinceDay})`, ""];
  if (r.closed === 0) {
    lines.push("Belum ada sinyal yang selesai minggu ini.");
  } else {
    lines.push(
      `Sinyal selesai: ${r.closed}`,
      `Untung: ${r.wins} · Rugi: ${r.losses} · Win rate: ${r.winRatePct}%`,
      `Rata-rata hasil: ${String(r.avgReturnPct).replace(".", ",")}% per sinyal`,
      `Terbaik: ${line(r.best)} · Terburuk: ${line(r.worst)}`,
    );
  }
  lines.push(
    `Masih terbuka: ${r.stillOpen}`,
    "",
    "Hasil dihitung dari harga saat sinyal dikirim, belum termasuk fee broker dan selisih harga.",
    `${wibTime(now)} WIB`,
    "",
    DISCLAIMER_ID,
  );
  return lines.join("\n");
}

export interface ReplayTradeBrief {
  symbol: string;
  buyAt: string;
  buy: number;
  sellAt: string | null;
  sell: number | null;
  exitKind: string | null;
  returnPct: number;
  stillOpen: boolean;
}

const EXIT_SHORT: Record<string, string> = {
  target2: "target 2",
  stop: "stop loss",
  breakeven: "balik ke harga beli",
  flip: "analisis berbalik",
  distribution: "tekanan jual",
  time: "terlalu lama",
};

/** One message for the group: what the bot would have sent on `day`. Labelled SIMULASI throughout. */
export function replayText(day: string, trades: ReplayTradeBrief[], analysed: number, bullish: string[]): string {
  const t = (iso: string) => wibTime(new Date(iso));
  const lines = [`🧪 SIMULASI BOT SINYAL, ${day}`, "(data hari ini diputar ulang, BUKAN sinyal live)", ""];
  lines.push(`${analysed} saham dianalisis. Condong positif pagi ini: ${bullish.length ? bullish.join(", ") : "tidak ada"}.`, "");
  if (!trades.length) {
    lines.push("Tidak ada sinyal BELI yang keluar hari ini: syarat analisis harian dan pemicu intraday tidak terpenuhi bersamaan.");
  }
  for (const tr of trades) {
    const r = `${tr.returnPct >= 0 ? "+" : ""}${String(tr.returnPct).replace(".", ",")}%`;
    lines.push(`🟢 ${tr.symbol} BELI ${t(tr.buyAt)} di ${rp(tr.buy)}`);
    if (tr.stillOpen) lines.push(`   Masih terbuka di penutupan, posisi ${r}`);
    else lines.push(`   🔴 JUAL ${tr.sellAt ? t(tr.sellAt) : "?"} di ${rp(tr.sell as number)} (${EXIT_SHORT[tr.exitKind ?? ""] ?? tr.exitKind}), hasil ${r}`);
  }
  if (trades.length) {
    const avg = trades.reduce((s, x) => s + x.returnPct, 0) / trades.length;
    lines.push("", `Rata-rata hasil: ${avg >= 0 ? "+" : ""}${avg.toFixed(2).replace(".", ",")}% per sinyal (belum termasuk fee).`);
  }
  lines.push("", "Satu hari simulasi tidak membuktikan strategi ini bekerja.", "", DISCLAIMER_ID);
  return lines.join("\n");
}

const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

/** `Sen 23/11 10:05`, in WIB. */
export function wibDayTime(iso: string): string {
  const w = new Date(Date.parse(iso) + WIB_MS);
  return `${HARI[w.getUTCDay()]} ${String(w.getUTCDate()).padStart(2, "0")}/${String(w.getUTCMonth() + 1).padStart(2, "0")} ${w.toISOString().slice(11, 16)}`;
}

/** The summary of a multi-day replay. Labelled SIMULASI throughout. */
export function replayRangeText(
  days: { day: string; analysed: number; bullish: string[] }[],
  trades: ReplayTradeBrief[],
): string {
  const span = days.length === 1 ? days[0].day : `${days[0].day} s.d. ${days[days.length - 1].day}`;
  const lines = [`🧪 SIMULASI BOT SINYAL, ${span}`, "(data diputar ulang, BUKAN sinyal live)", ""];
  for (const d of days) lines.push(`${wibDayTime(`${d.day}T02:00:00Z`).slice(0, 9)}: condong positif ${d.bullish.length ? d.bullish.join(", ") : "-"}`);
  lines.push("");
  if (!trades.length) lines.push("Tidak ada sinyal BELI yang keluar: syarat analisis harian dan pemicu intraday tidak terpenuhi bersamaan.");
  for (const tr of trades) {
    const r = `${tr.returnPct >= 0 ? "+" : ""}${String(tr.returnPct).replace(".", ",")}%`;
    lines.push(`🟢 ${tr.symbol} BELI ${wibDayTime(tr.buyAt)} di ${rp(tr.buy)}`);
    if (tr.stillOpen) lines.push(`   Masih terbuka di akhir simulasi, posisi ${r}`);
    else lines.push(`   🔴 JUAL ${tr.sellAt ? wibDayTime(tr.sellAt) : "?"} di ${rp(tr.sell as number)} (${EXIT_SHORT[tr.exitKind ?? ""] ?? tr.exitKind}), hasil ${r}`);
  }
  if (trades.length) {
    const avg = trades.reduce((s, x) => s + x.returnPct, 0) / trades.length;
    lines.push("", `Rata-rata hasil: ${avg >= 0 ? "+" : ""}${avg.toFixed(2).replace(".", ",")}% per sinyal (belum termasuk fee).`);
  }
  lines.push("", "Simulasi beberapa hari tidak membuktikan strategi ini bekerja.", "", DISCLAIMER_ID);
  return lines.join("\n");
}
