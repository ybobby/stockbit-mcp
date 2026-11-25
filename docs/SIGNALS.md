# Bot sinyal: BELI/JUAL ke Telegram

`stockbit-signals run` memantau harga sepanjang jam bursa dan mengirim **sinyal BELI dan JUAL** ke
grup Telegram yang sama dengan whale watch. Ia **hanya mengirim pesan**. Bot ini tidak bisa membuat,
mengubah, atau membatalkan order, dan tidak menerima PIN (ADR-0012).

Setiap pesan ditutup dengan: *bukan ajakan beli/jual dan bukan nasihat investasi*.

## Cara sinyal dibuat

**Setiap pagi** (saat sesi pertama dibuka), setiap saham di daftar pantauan dianalisis dengan
`analyze` yang sudah ada di repo: aliran broker (bandarmology), tren harga, pola candle, dan valuasi.
Hasilnya skor −100 sampai +100 dan tingkat keyakinan bukti.

**Sinyal BELI** dikirim kalau **dua syarat** terpenuhi sekaligus:

1. Harian: skor condong positif (≥35), keyakinan bukti ≥45, dan aliran broker tidak negatif.
2. Intraday: harga menembus tertinggi kemarin, **atau** whale watch mencatat transaksi besar masuk
   hari ini sementara harga naik.

Lalu ada penyaring:

- Tidak mengejar: saham yang sudah naik >7% hari ini, atau dekat ARA, dilewati.
- Stop loss = 1,5× ATR di bawah harga (minimal 2%, maksimal 8%), tidak di bawah terendah kemarin.
- Target 1 = 1,5R, target 2 = 3R (R = jarak ke stop loss). Semua harga dibulatkan ke fraksi IDX.
- Sinyal BELI baru hanya antara 09:05 dan 15:30 WIB (sinyal JUAL tetap dicek sampai tutup).
- Maksimal 3 sinyal BELI per hari, 5 sinyal terbuka sekaligus, satu sinyal per saham per hari, dan
  jeda 3 hari bursa setelah sinyal suatu saham ditutup.

**Sinyal JUAL** untuk setiap sinyal yang masih terbuka (tidak pernah dibatasi jumlahnya):

| Pesan | Kapan |
| --- | --- |
| 🎯 Target 1 tercapai | Harga ≥ target 1. Sinyal tetap terbuka, stop loss naik ke harga beli. |
| 🔴 Target 2 | Harga ≥ target 2. Ditutup. |
| 🔴 Stop loss | Harga ≤ stop loss. Ditutup. |
| 🔴 Balik ke harga beli | Setelah target 1, harga turun lagi ke harga beli. Ditutup tanpa rugi. |
| 🔴 Analisis berbalik | Analisis pagi berikutnya condong negatif. |
| 🔴 Tekanan jual besar | Ada transaksi besar sementara harga turun ≥2% dan di bawah harga beli. |
| 🔴 Terlalu lama | 10 hari bursa tanpa mencapai target. |

## Peran AI (opsional)

Ada dua cara memakai AI, dipilih dengan `--ai`:

- `--ai claude-code`: memakai **Claude Code di Mac ini** (`claude -p`), jadi memakai langganan Claude
  (Pro/Max) yang sudah login. **Tidak ada biaya tambahan**, hanya memakai kuota langganan. Syaratnya
  Claude Code terpasang dan sudah login. Kalau kuota habis atau Claude Code gagal, sinyal tetap
  terkirim tanpa catatan AI.
- `--ai api`: memakai API key Anthropic (`ANTHROPIC_API_KEY`), ditagih terpisah per pemakaian.
  Ini bawaan kalau key di-set.

Tanpa keduanya (`--ai off`), bot berjalan dengan aturan saja.

Setiap calon sinyal BELI dikirim ke Claude bersama datanya. Claude:

- boleh **membatalkan** sinyal yang buktinya lemah atau bertentangan;
- menulis **catatan singkat** dalam bahasa Indonesia yang ikut di pesan;
- **tidak boleh** membuat sinyal sendiri atau mengubah harga, stop loss, dan target.

Catatan AI yang menyebut angka yang tidak ada di data otomatis dibuang. Kalau AI gagal dihubungi,
sinyal tetap jalan tanpa catatan. Untuk `--ai api`, model bawaan `claude-opus-5-5`; ganti dengan
`STOCKBIT_SIGNALS_MODEL` (misalnya `claude-haiku-5-5` yang jauh lebih murah). Dengan batas 3 sinyal
per hari, jumlah panggilan kecil.

## Menjalankan di Mac

Di folder yang sama dengan whale watch (login Stockbit sudah ada):

```bash
git pull
npm ci
npm run build
```

Uji dulu tanpa mengirim apa pun (pesan dicetak di terminal, jurnal tidak ditulis):

```bash
node dist/bin/stockbit-signals.js run --dry-run
```

Kalau sudah yakin, jalankan dengan env yang sama dengan whale watch:

```bash
export STOCKBIT_TELEGRAM_BOT_TOKEN="..."
export STOCKBIT_TELEGRAM_CHAT_ID="..."
export ANTHROPIC_API_KEY="..."        # opsional
node dist/bin/stockbit-signals.js run
```

Jalankan **berdampingan** dengan whale watch (dua terminal). Whale watch memberi pemicu "transaksi
besar"; tanpa whale watch, bot sinyal tetap jalan dengan pemicu breakout saja.

### Pilihan

| Contoh | Artinya |
| --- | --- |
| `run` | 25 saham likuid bawaan, cek harga kandidat sekitar tiap 3 menit. |
| `run watchlist 3m` | Watchlist default Stockbit Anda. |
| `run BBCA,BMRI,ANTM 1m` | Saham tertentu, tiap 1 menit. |
| `--max-buys 2 --max-open 4` | Ubah batas harian dan batas sinyal terbuka. |
| `--ai claude-code` | Review AI memakai langganan Claude (tanpa biaya tambahan). |
| `--no-ai` / `--ai off` | Matikan review AI walau API key ada. |
| `--dry-run` | Cetak saja, tidak mengirim dan tidak menulis jurnal. |
| `--watch-all` | Pantau semua saham seharian, bukan hanya kandidat. Request jauh lebih banyak. |

`all` tidak diterima, karena setiap saham dianalisis tiap pagi dan seluruh pasar terlalu banyak
request.

### Jumlah request ke Stockbit

Supaya pemakaian tetap wajar:

- Pagi: setiap saham dianalisis sekali (sekitar 60-80 request untuk 25 saham).
- Setelah itu hanya saham yang **lolos analisis pagi** (satu-satunya yang bisa memberi sinyal BELI hari
  itu) dan sinyal yang masih terbuka yang dicek harganya. Hari tanpa kandidat hampir tanpa request.
- Ada jeda acak 0,4-2,5 detik antar request, dan jarak antar putaran bervariasi ±25%.
- Kalau Stockbit menjawab "terlalu banyak request" (429), bot berhenti membaca harga 15 menit, mengirim
  satu pemberitahuan ke grup, lalu lanjut sendiri.

Perkiraan total: sekitar 100-500 request per hari. Tetap ingat bahwa API ini tidak resmi.

### Simulasi satu hari (replay)

Putar ulang data hari ini (atau hari lain minggu ini) melalui bot yang sama, untuk melihat kapan
sinyal BELI dan JUAL akan keluar dan berapa hasilnya:

```bash
node dist/bin/stockbit-signals.js replay --pretty              # hari ini, 25 saham bawaan
node dist/bin/stockbit-signals.js replay BBCA,ANTM 2026-11-24  # saham dan tanggal tertentu
node dist/bin/stockbit-signals.js replay 2026-11-23 2026-11-25  # Senin s.d. Rabu, sinyal dibawa ke hari berikutnya
node dist/bin/stockbit-signals.js replay --send                # kirim satu ringkasan SIMULASI ke grup
```

Analisis pagi pada simulasi hanya memakai data sampai kemarin, supaya tidak "menyontek" data sore.
Untuk hari ini, harga diambil dari data per menit; jam-nya **perkiraan** karena data itu tidak
membawa jam (titik dibagi rata ke menit perdagangan). Untuk hari lain, dipakai titik grafik intraday
yang lebih jarang. `--all-series` menyertakan grafik semua saham di output. Satu hari simulasi tidak membuktikan strategi bekerja.

### Perintah lain

- `node dist/bin/stockbit-signals.js status`: sinyal terbuka dan 10 terakhir yang ditutup.
- `node dist/bin/stockbit-signals.js recap`: rekap minggu ini. Tambah `--send` untuk mengirimnya.
  Rekap otomatis dikirim setiap Jumat pukul 16:15 WIB kalau bot sedang berjalan.

### File

- `~/.stockbit/signals/journal.json`: semua sinyal, terbuka dan selesai. Dipakai untuk rekap.
- `~/.stockbit/signals/signals.log`: satu baris JSON per kejadian (analisis, sinyal, veto AI, error).

## Catatan risiko

- Sinyal otomatis bisa salah, dan AI juga bisa salah. Jalankan beberapa minggu dan lihat rekapnya
  sebelum mempercayainya.
- Hasil di rekap dihitung dari harga saat pesan dikirim, belum termasuk fee broker dan selisih harga.
- Data berasal dari API Stockbit yang tidak resmi dan bisa berubah sewaktu-waktu.
- Jam bursa di bot tidak tahu hari libur IDX.
- Kalau grup dibuka untuk umum atau berbayar, cek aturan OJK tentang penyebaran rekomendasi saham.

## Di VPS (nanti)

Sama seperti whale watch di [WHALE-WATCH.md](WHALE-WATCH.md), dengan service kedua:

```ini
[Unit]
Description=Stockbit signal bot
After=network-online.target

[Service]
User=stockbit
WorkingDirectory=/home/stockbit/stockbit-mcp
Environment=STOCKBIT_FORCE_FILE_STORE=1
EnvironmentFile=/home/stockbit/whale-watch.env
ExecStart=/usr/bin/node dist/bin/stockbit-signals.js run
Restart=on-failure
RestartSec=60
RestartPreventExitStatus=3

[Install]
WantedBy=multi-user.target
```

Tambahkan `ANTHROPIC_API_KEY=...` ke file env kalau ingin review AI.
