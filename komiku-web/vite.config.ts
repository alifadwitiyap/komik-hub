import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: Vite (5173) mem-proxy /api ke server Rust (8788).
// Prod: build di sini, lalu server Rust menyajikan folder `dist/`.
// Di container dev (docker compose --profile dev), target di-override lewat
// VITE_API_TARGET=http://server:8788 (service name compose). Native dev
// tanpa env var tetap 127.0.0.1:8788.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8788'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  },
})
