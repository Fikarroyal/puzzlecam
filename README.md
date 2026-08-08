# Puzzle·Cam — Hand Gesture Capture

Web app kamera bergaya cinema: jepret foto dengan **membentuk kotak pakai dua
tangan terbuka**, foto otomatis dipecah jadi puzzle 3×3 dengan color grade
teal‑orange ala film, susun ulang dengan tanganmu, lalu kumpulkan jadi strip
foto yang bisa diunduh.

## Cara menjalankan (WAJIB lewat server lokal, bukan dobel-klik file)

Browser memblokir akses kamera (`getUserMedia`) di halaman yang dibuka langsung
lewat `file://`. Jalankan folder ini lewat server lokal — pilih salah satu:

**Opsi A — VS Code Live Server (paling gampang, sama seperti di video referensi)**
1. Buka folder `puzzlecam` ini di VS Code.
2. Install extension "Live Server" (jika belum ada).
3. Klik kanan `index.html` → **Open with Live Server**.
4. Browser terbuka di `http://127.0.0.1:5500/` (atau port lain), izinkan akses kamera.

**Opsi B — Python (kalau sudah ada Python terinstal)**
```bash
cd puzzlecam
python3 -m http.server 5500
```
Buka `http://localhost:5500` di browser — bukan `http://[::]:5500`, harus
persis `localhost` atau `127.0.0.1`.

**Opsi C — Node (npx serve)**
```bash
cd puzzlecam
npx serve .
```

**Opsi D — Hosting online**
Unggah semua file ke Netlify / Vercel / GitHub Pages — semuanya otomatis
menyediakan HTTPS sehingga kamera bisa diakses dari HP juga.

## Cara pakai

1. **Izinkan kamera** saat diminta browser.
2. **Rentangkan dua tangan terbuka** membentuk kotak — bebas arah: kiri‑kanan
   (landscape), atas‑bawah (potrait), atau sama sisi (persegi) — sampai
   muncul kotak kuning mengikuti bentuk tanganmu, lalu **tahan** posisi itu
   sebentar → hitungan mundur 3‑2‑1 → foto diambil otomatis sesuai bentuk
   kotak itu, dengan color grade cinema (bukan hitam‑putih). **Kalau tangan
   belum membentuk kotak yang valid, proses foto tidak akan mulai.**
3. Foto langsung pecah jadi **9 keping puzzle** (mengikuti rasio foto asli —
   potrait/landscape/persegi) yang teracak di tengah layar.
4. **Cubit sebuah keping, geser, lalu lepas** di kotak lain untuk menukar
   posisi (bisa juga pakai jari/mouse langsung di layar).
5. Setelah 9/9 keping benar, **kepalkan tangan** dan tahan sebentar untuk
   menyimpannya ke **strip foto** di panel kanan. Setelah tersimpan, aplikasi
   **otomatis kembali** ke mode "bentuk kotak" supaya kamu bisa langsung
   mengambil foto berikutnya tanpa perlu reset apa pun.
6. Ulangi sampai strip terisi 3 foto, lalu tekan **Unduh Strip** untuk menyimpan
   hasilnya sebagai satu gambar PNG (tiap foto tetap dengan rasio aslinya),
   atau **Reset Semua** untuk mulai ulang dari 0/3.

Ada tombol **Ambil Foto** dan **Simpan Puzzle** di bagian bawah layar sebagai
cadangan manual — jadi aplikasi tetap bisa dipakai penuh walau deteksi gestur
tangan gagal dimuat atau kurang akurat di kondisi cahaya tertentu.

## Struktur file
```
puzzlecam/
├── index.html      # struktur halaman
├── styles.css       # tema HUD gelap + panel strip ala photobooth, full responsive
├── app.js           # deteksi tangan (MediaPipe), state machine, logika puzzle
├── manifest.json     # supaya bisa "Add to Home Screen" di HP
└── icon.svg
```

## Kustomisasi cepat (di bagian atas `app.js`)
- `STRIP_TARGET` — jumlah foto per strip (default 3)
- `BOX_MIN_GAP_RATIO` — seberapa jauh dua tangan harus direntangkan (perbesar = lebih ketat)
- `BOX_MIN_ASPECT` / `BOX_MAX_ASPECT` — batas rasio lebar/tinggi kotak yang diizinkan (potrait..landscape)
- `BOX_MIN_SIZE_PX` — ukuran minimum kotak dalam piksel, supaya tidak kepicu noise kecil
- `BOX_OPEN_MIN_FINGERS` — berapa jari yang harus terentang supaya dianggap "tangan terbuka"
- `CAPTURE_DWELL_MS` / `FIST_DWELL_MS` — lama tahan gestur sebelum aksi terpicu
- `CINEMA_GRAIN_STD` — intensitas grain/butiran film pada foto
- `PINCH_ON` — sensitivitas cubit untuk menggeser keping puzzle

## Catatan teknis
- Deteksi tangan pakai `@mediapipe/tasks-vision` (HandLandmarker) via CDN jsdelivr,
  jadi perlu koneksi internet saat pertama kali memuat model.
- **Kamera tampil & bisa dipakai duluan** (tombol Ambil Foto langsung aktif) —
  model gestur tangan dimuat diam-diam di belakang layar (maks. 15 detik),
  jadi kamu tidak perlu menunggu di layar hitam. Begitu model siap, gestur
  otomatis aktif tanpa perlu reload halaman.
- Kamera depan (`facingMode: "user"`) dipakai otomatis untuk pengalaman selfie.
- Filter foto: kontras filmic + color grade teal‑orange (bayangan condong
  teal, highlight condong hangat) + grain halus + vignette lembut — diterapkan
  ke foto hasil jepretan; preview kamera live juga diberi sentuhan warna cinema
  yang lebih ringan lewat CSS filter.
- Kalau model gagal/lambat dimuat (offline, CDN diblokir, dsb), aplikasi
  otomatis masuk "mode manual" — tombol Ambil Foto & Simpan Puzzle tetap
  berfungsi, drag puzzle tetap bisa lewat jari/mouse.
- Izin kamera diminta browser secara otomatis di awal (lewat `getUserMedia`) —
  ini bawaan browser, bukan sesuatu yang perlu ditambahkan manual. Setelah
  di-deploy dengan HTTPS (Netlify/Vercel/dst), pengunjung akan otomatis
  diminta izin kamera saat pertama kali membuka halamannya.