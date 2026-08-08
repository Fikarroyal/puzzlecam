# Puzzle · Cam

Browser memblokir akses kamera (`getUserMedia`) di halaman yang dibuka langsung
lewat `file://`. Jalankan folder ini lewat server lokal.

**Opsi A, VS Code Live Server**
1. Buka folder `puzzlecam` ini di VS Code.
2. Install extension "Live Server" (jika belum ada).
3. Klik kanan `index.html` → **Open with Live Server**.
4. Browser terbuka di `http://127.0.0.1:5500/` (atau port lain), izinkan akses kamera.

**Opsi B, Terminal Python**
```bash
cd puzzlecam
python3 -m http.server 5500
```
Silahkan buka `http://localhost:5500` di browser
