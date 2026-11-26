# Whale watch: alert transaksi besar ke Telegram

`stockbit-live watch` menjalankan detektor live sepanjang jam bursa dan mengirim setiap alert ke
Telegram. Perintah ini tidak menambah detektor baru dan tidak mengubah ambang batas. Ia hanya
menjalankan `stockbit-live signals` terus-menerus, lalu mengirim hasil yang lolos filter alert ke
chat Anda.

Perintah ini **tidak bisa** membuat, mengubah, atau membatalkan order. Isinya hanya pengukuran,
bukan sinyal beli atau jual.

## Apa yang dideteksi

| Sinyal | Artinya |
| --- | --- |
| 🐋 `value-surge` | Uang masuk dalam potongan besar: rata-rata nilai per transaksi di window ini jauh di atas rata-rata sesi saham itu (default ≥5x), **dan** nilai di window ini jauh di atas laju normalnya (≥3x), minimal Rp300 juta. |
| 📚 `book-imbalance` | Top 5 level order book berat sebelah (≥75% bid atau ≤25%) selama dua poll berturut-turut. |
| 🧱 `wall-change` | Antrian besar di bid atau offer hilang lebih cepat daripada yang bisa dijelaskan oleh transaksi, atau wall baru muncul. |
| 📏 `band-approach` | Harga sudah menempuh minimal dua pertiga jalan dari penutupan kemarin ke batas ARA/ARB, **dan** sisa antrian menuju batas tinggal sedikit dibanding laju transaksi terakhir. |
| ⚠️ `uma-flag`, ⛔ `floor-locked` | Saham diberi UMA, atau terkunci di ARB dengan bid kosong. |

Yang **tidak bisa** dilakukan: menyebut siapa pembelinya. IDX menutup kode broker di running trade
sejak 6 Desember 2021. Blok "Broker context" di bawah alert adalah ringkasan broker **sesi
sebelumnya** (akhir hari), dan diberi label dengan tanggalnya. Itu konteks, bukan pengamatan live.

Jumlah alert ke Telegram **tidak dibatasi**. Yang menyaring adalah detektornya sendiri, ditambah
tiga pengaman: cooldown 15 menit untuk sinyal yang sama di saham yang sama (kecuali sinyal baru 2x
lebih kuat), 15 menit pertama dan menjelang penutupan hanya meloloskan sinyal `critical`, dan kalau
>40% saham memicu sinyal yang sama, yang dikirim cukup satu pesan "market-wide". Sinyal ⛔ `floor-locked` (terkunci
di ARB) hanya dikirim sekali per saham per hari, karena kondisi itu biasanya bertahan sampai tutup. Alert `wall-change`
hanya dikirim kalau antrean yang muncul atau ditarik bernilai minimal Rp1 miliar (`wallMinValue` di
`src/live/signals.ts`). (Perintah `stockbit-live signals` tetap memakai batas lama 5 per interval
dan 25 per sesi.)

## 1. Siapkan bot Telegram

1. Di Telegram, chat **@BotFather**, kirim `/newbot`, ikuti langkahnya, lalu simpan token yang
   diberikan.
2. Kirim pesan apa saja ke bot baru Anda (misalnya `halo`).
3. Buka `https://api.telegram.org/bot<TOKEN>/getUpdates` di browser. Cari `"chat":{"id":123456789`.
   Angka itu adalah chat id Anda. Untuk grup, id-nya negatif.

Token hanya boleh disimpan di environment variable, jangan pernah sebagai flag di command line.

## 2. Uji di laptop

Login sekali (membuka browser):

```bash
npm ci
npm run build
node dist/bin/stockbit-auth.js login
node dist/bin/stockbit-auth.js status
```

Coba dulu tanpa mengirim apa pun ke Telegram. Alert akan dicetak di terminal:

```bash
node dist/bin/stockbit-live.js watch all 1m --dry-run
```

Kalau sudah yakin, set token lalu jalankan.

macOS / Linux:

```bash
export STOCKBIT_TELEGRAM_BOT_TOKEN="123456:ABC..."
export STOCKBIT_TELEGRAM_CHAT_ID="123456789"
node dist/bin/stockbit-live.js watch all 1m
```

Windows PowerShell:

```powershell
$env:STOCKBIT_TELEGRAM_BOT_TOKEN = "123456:ABC..."
$env:STOCKBIT_TELEGRAM_CHAT_ID = "123456789"
node dist/bin/stockbit-live.js watch all 1m
```

Biarkan berjalan. Di luar jam bursa (08:45 sampai 16:15 WIB, Senin sampai Jumat) watcher hanya
menunggu, lalu otomatis mulai lagi besok pagi dengan baseline dan kuota alert yang baru. Tekan
Ctrl-C untuk berhenti. Catatan: jam bursa ini tidak tahu hari libur IDX.

### Pilihan cakupan dan interval

| Contoh | Artinya |
| --- | --- |
| `watch all 1m` | 100 saham paling aktif, dicek tiap 1 menit. Satu request mencakup semuanya. |
| `watch watchlist 1m` | Watchlist default Anda. |
| `watch watchlist:Bandar 30s` | Watchlist bernama "Bandar", tiap 30 detik. |
| `watch BBCA,BMRI,ANTM 1m` | Saham tertentu saja. |
| `watch all 1m transaksi besar minimal 1 miliar` | Kalimat bebas di akhir mempersempit sinyal (di sini: hanya value-surge, window di bawah Rp1 miliar diabaikan). Saat start, watcher mencetak bagaimana kalimat itu ditafsirkan. Lihat `src/live/promptspec.ts`. |

Interval tercepat 20 detik. Order book dibaca maksimal untuk 12 saham per pass, supaya akun Anda
tidak membanjiri API yang tidak resmi ini. Dua belas itu dibagi begini (dengan interval 1 menit):

- Tiap 5 menit, `top-stock` dibaca sekali dan 48 saham teraktif disusun menjadi antrean.
- **3 slot tetap** dibaca setiap menit: saham yang baru memicu alert (selama 15 menit), lalu saham
  teratas di antrean.
- **9 slot bergilir** berjalan menyusuri sisa antrean. Dalam 5 menit, 9 x 5 = 45 saham terbaca.
- Total 3 + 45 = 48 saham per 5 menit, tetap 12 request order book per menit.

Konsekuensinya, saham di slot bergilir dihitung dengan jendela sekitar 5 menit, jadi alertnya bisa
terlambat sampai 5 menit dan lonjakan nilainya dirata-rata selama 5 menit. Saham di slot tetap tetap
memakai jendela 1 menit. Baris `pass` di log mencatat `booksRead` dan `ranked: true` pada pass yang
menyusun ulang antrean.

### Dari mana angkanya

Sejak 26 Nov 2026, semua detektor menghitung dari **order book** masing-masing saham. Order book
memuat nilai, jumlah transaksi, dan volume kumulatif sejak bursa buka, jadi selisih dua bacaan
berturut-turut adalah transaksi yang terjadi di antaranya. `top-stock` hanya dipakai untuk menyusun
antrean 48 saham teraktif.

Alasannya: pada 26 Nov, saat bursa buka, angka `top-stock` terbukti bukan angka kumulatif. Nilainya
bisa turun antar bacaan dan 27 dari 100 baris punya frekuensi negatif. Menghitung selisih dari angka
itu menghasilkan 13 kali "sesi baru" palsu dalam satu pagi dan alert yang membandingkan dengan volume
transaksi yang keliru.

Akibatnya, saham hanya bisa memicu alert setelah order book-nya dibaca dua kali. Bacaan yang berjarak
lebih dari 7 menit tidak dibandingkan; bacaan baru menjadi titik awal lagi.

### Flag

- `--wide`: selain 100 saham top-stock, pantau juga daftar **top nilai, top volume, dan top
  frekuensi** dari Movers Stockbit (masing-masing maksimal 50 saham, jadi 3 request tambahan per
  penyusunan antrean). Ini untuk saham murah yang transaksinya banyak secara lot tapi kecil secara rupiah, yang
  hampir tidak pernah masuk top-stock. Saham yang hanya datang dari daftar Movers:
  - memakai batas transaksi besar Rp100 juta per window, lebih rendah dari batas biasa Rp300 juta,
  - mendapat 16 dari 48 tempat di antrean, dipilih berdasarkan lot terbanyak (tempat yang tidak
    terpakai kembali ke saham top-stock, jadi jumlah request order book tetap 12 per menit),
  - alert-nya diberi keterangan "Saham ini masuk lewat daftar top ... Stockbit, di luar 100 saham
    utama".
  **Catatan 26 Nov 2026:** selama jam bursa ketiga daftar Movers kembali KOSONG, dan baru terisi
  setelah bursa tutup. Jadi saat ini `--wide` belum menambah saham apa pun di jam bursa (`moversOnly`
  0). Flag tetap ada karena biayanya hanya 3 request murah, dan langsung berguna kalau Stockbit mulai
  mengisi daftar itu di jam bursa. Daftar kosong tidak lagi dicatat sebagai error.

- `--dry-run`: deteksi dan cetak, tanpa mengirim ke Telegram.
- `--no-context`: jangan tambahkan ringkasan broker kemarin di bawah alert.
- `--always`: tetap polling di luar jam bursa. Hanya untuk uji coba, karena pasar yang tutup akan
  terbaca datar.

### Log

Setiap pass, alert, dan perubahan status ditulis sebagai satu baris JSON di stdout dan di
`~/.stockbit/whale-alerts.log`. Log ditulis **sebelum** Telegram dicoba, jadi kalau Telegram gagal
catatannya tetap ada. Baris dengan `"type":"pass"` berisi berapa sinyal terdeteksi dan berapa yang
dikirim, yang berguna untuk mengkalibrasi ambang batas.

### Kalau ada masalah

- **Sesi Stockbit kedaluwarsa**: watcher mengirim satu pesan ⛔ ke Telegram lalu berhenti dengan exit
  code 3. Login ulang dengan `stockbit-auth login`, lalu jalankan lagi.
- **Gagal membaca pasar 3x berturut-turut** saat jam perdagangan: satu pesan ⚠️ dikirim ("diam bukan
  berarti pasar sepi"), lalu pesan ✅ saat pulih. Kegagalan di luar jam perdagangan (pra-pembukaan
  08:45 sampai 09:00, istirahat siang, sesudah 15:50) tetap dicatat di log dengan `"counted":false`
  tetapi tidak memicu pesan, karena pasar memang kosong di jam itu.

## 3. Pindah ke VPS (nanti)

Spek kecil cukup: 1 vCPU, 1 GB RAM, Ubuntu, lokasi Jakarta, dan **menyala terus** (bukan serverless).

1. Pasang Node.js 22+ dan git, clone repo ini, lalu `npm ci && npm run build`.
2. **Login.** VPS tidak punya layar untuk browser, dan file token dari laptop tidak bisa disalin
   begitu saja karena dienkripsi dengan kunci per mesin. Pakai salah satu:
   - `node dist/bin/stockbit-auth.js import-har login.har --shred`, dengan file `.har` yang Anda
     rekam di browser laptop (langkahnya ada di `stockbit-auth import-har --help`), lalu dikirim ke
     VPS dengan `scp`. `--shred` menghapus file itu setelah diimpor, karena isinya password dan
     cookie dalam bentuk teks biasa.
   - `node dist/bin/stockbit-auth.js bootstrap` untuk menempel refresh token secara manual.
3. Jalankan watcher **hanya di satu tempat**. Refresh token berotasi, jadi laptop dan VPS yang
   memakai login yang sama akan saling mengeluarkan.
4. Agar otomatis jalan lagi setelah reboot atau crash, buat `/etc/systemd/system/whale-watch.service`:

```ini
[Unit]
Description=Stockbit whale watch
After=network-online.target

[Service]
User=stockbit
WorkingDirectory=/home/stockbit/stockbit-mcp
Environment=STOCKBIT_FORCE_FILE_STORE=1
EnvironmentFile=/home/stockbit/whale-watch.env
ExecStart=/usr/bin/node dist/bin/stockbit-live.js watch all 1m
Restart=on-failure
RestartSec=60
# Exit 3 = sesi Stockbit kedaluwarsa. Restart tidak akan membantu, jadi jangan ulangi.
RestartPreventExitStatus=3

[Install]
WantedBy=multi-user.target
```

`/home/stockbit/whale-watch.env` berisi dua baris `STOCKBIT_TELEGRAM_BOT_TOKEN=...` dan
`STOCKBIT_TELEGRAM_CHAT_ID=...`, dengan `chmod 600`. Lalu jalankan:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now whale-watch
journalctl -u whale-watch -f
```

Kalau sesi kedaluwarsa, watcher mengirim satu pesan ⛔ lalu berhenti dengan exit 3, dan systemd tidak
mengulanginya (supaya Telegram tidak dibanjiri pesan yang sama). Setelah login ulang, jalankan
`sudo systemctl restart whale-watch`. Crash lain tetap di-restart otomatis.
