# Versi web

Bang Story juga bisa jalan sebagai web app di server (misalnya Linux tanpa layar) dan dibuka dari browser.
Kodenya sama dengan versi desktop: server Node menjalankan `src/main` apa adanya, dan browser memuat
tampilan React yang sama.

```
browser ── src/web/api.ts (window.api lewat HTTP) ──► src/server/index.ts ──► src/main (tanpa diubah)
                                                       electron-shim.ts menggantikan modul `electron`
```

## Cara kerja

| Desktop (Electron) | Web |
|---|---|
| `ipcRenderer.invoke('kanal', …)` | `POST /api/invoke/kanal` dengan body `{ args }` |
| `webContents.send('event:…')` | satu `EventSource` ke `GET /api/events` |
| protokol `studio://asset/…`, `studio://fonts/…` | `GET /studio/asset/…`, `/studio/fonts/…` (dengan Range) |
| dialog pilih file (musik, logo) | browser upload dulu ke `POST /api/upload`, lalu kanal `assets:pick*` dipanggil dengan `upload` |
| "Buka folder" hasil ekspor | file MP4 diunduh lewat `GET /api/download` |
| `safeStorage` (DPAPI) | AES-256-GCM, kunci di `<folder data>/secrets.key` |
| clipboard, buka link | dikerjakan browser |

- `vite.server.config.ts` mem-bundle `src/server/index.ts` + `src/main` dan mengganti `electron` dengan
  `src/server/electron-shim.ts`. Shim hanya berisi API Electron yang dipakai `src/main` di luar `index.ts` dan
  `devharness.ts`. Kalau `src/main` mulai memakai API Electron baru, tambahkan ke shim.
- `vite.web.config.ts` membangun renderer dengan entry `src/web/main.ts`, yang memasang `window.api` versi HTTP
  sebelum aplikasi jalan, dan mengganti URL font `studio://fonts/` di `styles.css`.
- `src/web/api.ts` mengubah semua string `studio://…` di hasil IPC dan event menjadi `/studio/…`, jadi
  `src/main` tetap menghasilkan URL `studio://`.
- **IPC baru tidak perlu didaftarkan di versi web.** Semua kanal diteruskan otomatis berdasarkan nama
  (`window.api.grup.metode` → `grup:metode`, kecuali `exporter` → `export`). Yang perlu ditangani browser
  (file, clipboard, link, unduhan) ada di `overrides` di `src/web/api.ts`.

## Keamanan

- Semua halaman butuh login. Kata sandi dari env `BANG_STORY_PASSWORD` (minimal 8 karakter). Cookie sesi
  `HttpOnly`, `SameSite=Lax`, dan berlaku 30 hari. Mengganti kata sandi membuat semua sesi keluar.
- Login gagal berulang dari alamat yang sama diperlambat (jeda bertambah setelah 5 kali gagal).
- Request `POST /api/*` wajib membawa header `X-Bang-Story: 1`, yang tidak bisa dikirim form dari situs lain
  (perlindungan CSRF).
- Path di `/studio/` dan `/api/download` dibatasi ke folder data.
- Server hanya mendengar `127.0.0.1` kecuali `HOST` diatur. Kunci API pengguna tersimpan di server, jadi jangan
  buka ke internet tanpa HTTPS (misalnya lewat Cloudflare Tunnel atau Tailscale).

## Setup di Linux

```bash
npm run web:install   # dependensi untuk Node (bukan Electron): better-sqlite3 dibangun untuk Node
npm run web:build     # out/server/index.js + out/web/
BANG_STORY_PASSWORD='…' BANG_STORY_DATA=/path/data npm run web:start
```

Jangan pakai `npm install` biasa di server: `postinstall` membangun ulang better-sqlite3 untuk Electron, dan
server Node tidak bisa memuatnya lagi.

### Env

| Variabel | Bawaan | Fungsi |
|---|---|---|
| `BANG_STORY_PASSWORD` | (wajib) | kata sandi login |
| `BANG_STORY_DATA` | `./web-data` | folder data: `studio.db`, `projects/`, `exports/`, `models/`, kunci enkripsi |
| `PORT` / `HOST` | `3200` / `127.0.0.1` | alamat server |
| `STUDIO_WHISPER_CLI` | `resources/whisper/whisper-cli.exe` | `whisper-cli` untuk Linux (lihat di bawah) |

### Whisper di Linux

`resources/whisper/` hanya berisi build Windows. Untuk sinkron caption di Linux, build whisper.cpp sendiri
(versi yang diuji: v1.9.5) lalu arahkan `STUDIO_WHISPER_CLI` ke `build/bin/whisper-cli`:

```bash
git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp.git
cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=ON
cmake --build build -j4 --target whisper-cli
```

Model Whisper diunduh dari Pengaturan seperti di desktop, ke `<folder data>/models/whisper/`.

## Yang berbeda dari desktop

- Folder ekspor selalu `<folder data>/exports`; tombol "Pilih folder" tidak melakukan apa-apa dan hasil
  ekspor diunduh ke komputer pengguna.
- "Buka folder" model Whisper tidak melakukan apa-apa.
- Satu server = satu pengguna. Semua tab yang login melihat proyek dan kunci API yang sama.

## Menguji

- `npm run typecheck` sekarang juga memeriksa `src/server` dan `src/web`.
- Build desktop (`npm run build`) tidak terpengaruh; jalankan keduanya.
- Uji manual: login, buat proyek, unggah musik dan logo, putar pratinjau (audio/video bisa di-seek), ekspor
  lalu unduh hasilnya, dan sinkron caption kalau Whisper terpasang.
