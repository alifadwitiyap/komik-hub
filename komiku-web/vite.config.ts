import { defineConfig } from 'vite'
import type { ResolvedConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// Dev: Vite (5173) mem-proxy /api ke server Rust (8788).
// Prod: build di sini, lalu server Rust menyajikan folder `dist/`.
// Di container dev (docker compose --profile dev), target di-override lewat
// VITE_API_TARGET=http://server:8788 (service name compose). Native dev
// tanpa env var tetap 127.0.0.1:8788.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8788'

/**
 * Inject daftar aset build ke `dist/sw.js` (salinan dari `public/sw.js`).
 *
 * `public/` disalin verbatim tanpa transformasi, jadi placeholder di sw.js
 * (`__SHELL_VERSION__`, `__PRECACHE_LIST__`) tidak akan terisi sendiri. Plugin
 * ini membaca manifest aset yang baru dihasilkan dan menimpanya di `dist/sw.js`.
 * Hasil: precache selalu sinkron dengan bundle kali ini, dan SHELL version
 * naik otomatis per build → cache lama dibuang (skill: stale chunk 404).
 */
function precacheInjectPlugin() {
  let outDir = 'dist'
  return {
    name: 'komiku-precache-inject',
    apply: 'build',
    configResolved(cfg: ResolvedConfig) {
      outDir = cfg.build.outDir
    },
    closeBundle() {
      const swPath = join(outDir, 'sw.js')
      let sw
      try {
        sw = readFileSync(swPath, 'utf8')
      } catch {
        // sw.js tidak ada di outDir (mungkin build non-web) — lewati.
        return
      }
      // Aset kritis: entry js/css + react-vendor + runtime.
      const files = []
      for (const f of readdirSync(join(outDir, 'assets'))) {
        if (/\.(js|css)$/.test(f) && !/_\.(mjs|js)$/.test(f)) files.push(f)
      }
      const precache = files
        .sort()
        .map((f) => `/assets/${f}`)
        .sort((a, b) => (a.includes('react-vendor') ? -1 : b.includes('react-vendor') ? 1 : 0))
      const version = 'v' + createHash('sha1').update(files.join('|')).digest('hex').slice(0, 8)
      writeFileSync(
        swPath,
        sw
          .replace('__SHELL_VERSION__', JSON.stringify(`komiku-shell-${version}`))
          .replace('__PRECACHE_LIST__', JSON.stringify(precache, null, 2)),
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precacheInjectPlugin()],
  server: {
    port: 5173,
    // HMR lintas bind-mount Windows (Docker Desktop) butuh polling.
    watch: { usePolling: !!process.env.CHOKIDAR_USEPOLLING },
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      // /img (proxy gambar komik) juga harus ke server Rust di dev —
      // tanpa ini Vite balas index.html -> semua <img> gagal decode (F-1 QA).
      '/img': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
    // Code-splitting (Vite 8 = rolldown). Sebelumnya SELURUH app + lib jadi SATU
    // chunk 385 KB (`index-*.js`), jadi tiap deploy men-invalidate semuanya.
    // Di sini runtime vendor dipisah dari kode app supaya chunk vendor
    // (hash stabil) tetap ter-cache di browser saat hanya app yang berubah.
    //
    // Catatan: entry tetap satu dan semua import statis, jadi semua chunk
    // dimuat saat load pertama — ini menang di CACHING, bukan mengurangi byte
    // awal. Lazy per-route butuh `React.lazy`/dynamic import di src/ (di luar
    // scope lane ini; lane lain memegang src/).
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // React runtime + router: satu grup, jarang berubah.
            {
              name: 'react-vendor',
              // `[\\/]` (bukan `/`) supaya separator Windows cocok.
              test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
              priority: 20,
            },
            // Sisa dependency pihak ketiga (kalau ada) → chunk vendor sendiri.
            {
              name: 'vendor',
              test: /[\\/]node_modules[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
})
