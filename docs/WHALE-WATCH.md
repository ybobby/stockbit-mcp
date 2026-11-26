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
| 🐋 `whale` | **Dikonfirmasi di running trade:** ada transaksi tunggal yang besar untuk ukuran saham itu, atau sapuan satu arah, lengkap dengan sisi agresor (HAKA/HAKI). Lihat bagian "Konfirmasi whale". |

Sinyal 📈 📚 🧱 📏 🌅 adalah **anomali** dan pesannya diawali "Anomali ·". Kalau anomali di satu saham
lolos konfirmasi, yang dikirim cukup satu pesan 🐋 yang menyebut anomali itu sebagai pemicunya.

Telegram tidak bisa mewarnai teks, jadi warna dipasang lewat tanda di depan kata yang ditebalkan:
tingkat ⬜ **Info**, 🟨 **Pantau**, 🟧 **Penting**, 🟥 **Sangat penting**, serta 🟢 **HAKA** dan
🔴 **HAKI**. Pesan dikirim sebagai HTML Telegram. Kalau Telegram menolak markup-nya, pesan yang sama
dikirim ulang sebagai teks polos.

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

Biarkan berjalan. Di luar jam pantau (08:45 sampai sebelum 16:00 WIB, Senin sampai Jumat) watcher hanya
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

### Konfirmasi whale

Aktif bawaan di `watch` (matikan dengan `--no-whale`). Setiap menit:

1. **Saham yang memicu anomali** (maksimal 5, yang paling kuat) dicek running trade-nya: transaksi
   terbaru dengan `sort=desc`, disaring server dengan `minimum_lot`, mundur sampai awal jendela
   anomali.
2. **Seluruh pasar disapu**: satu sampai tiga request running trade tanpa kode saham, minimal 1.000 lot,
   melanjutkan dari nomor transaksi terakhir yang sudah dibaca. Ini menangkap transaksi besar di
   saham yang tidak ada di antrean 48.
3. **Saham yang lolos mendapat slot pantau** (maksimal 5): dicek tiap menit, pesan lanjutan dikirim
   hanya kalau ada transaksi besar baru. Slot ditutup setelah 10 menit sepi atau 30 menit sejak dibuka.

Ambangnya **per saham**, karena Rp100 juta di saham kecil bisa sudah besar sementara Rp1 miliar di
BBCA belum. Satu transaksi disebut whale kalau melewati dua ukuran sekaligus:

- minimal **sekian persen dari rata-rata nilai transaksi harian 20 hari terakhir (ADV20)** saham itu,
  menurut tier di bawah, dengan batas atas Rp25 miliar (tanpa data harian: Rp200 juta);
- minimal **10x rata-rata nilai per transaksi saham itu hari ini**.

| ADV20 | Ambang | Paling kecil |
| --- | --- | --- |
| di atas Rp250 M | 0,25% × ADV20 | Rp1,25 M |
| Rp100 sampai 250 M | 0,5% × ADV20 | Rp1 M |
| Rp5 sampai 100 M | 1% × ADV20 | Rp200 juta |
| di bawah Rp5 M | 5% × ADV20 | Rp100 juta |

Batas paling kecil tiap tier sama dengan puncak tier di bawahnya. Dengan begitu saham yang sedikit
lebih ramai tidak pernah mendapat ambang yang lebih ringan di batas Rp100 M dan Rp250 M. Di batas
Rp5 M ambangnya memang turun sedikit (dari sekitar Rp250 juta ke Rp200 juta), sesuai pilihan owner.
Diputar ulang pada log uji live sore 26 Nov, tier ini mengubah 182 whale menjadi 48.

Pesan lanjutan tidak dibatasi jumlahnya. Ambang tier di atas sudah menjadi saringannya.

Sapuan dihitung kalau transaksi satu sisi dalam 30 detik totalnya minimal 2x ambang dan memakan minimal
2 level harga. Arah disebut HAKA/HAKI kalau satu sisi memegang minimal 70% nilai transaksi besar;
kalau tidak, pesannya "transaksi besar dua arah". Transaksi negosiasi dan lelang tidak dihitung.
Pelakunya tidak bisa diketahui: kode broker di running trade ditutup bursa sejak Desember 2021.

Rata-rata nilai harian dibaca sekali per saham per hari (2 request) dan disimpan di
`~/.stockbit/whale-adv.json`. Baris `pass` di log mencatat `whale` (request, jumlah konfirmasi, hasil
sapuan, slot aktif, dan `sweepGap` kalau sapuan pasar kehabisan halaman). Ambang ada di
`WHALE_DEFAULTS` (`src/live/prints.ts`) dan batas request di `CONFIRM_LIMITS` (`src/live/confirm.ts`).

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
