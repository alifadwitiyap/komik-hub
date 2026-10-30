import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { preloadReloadSudahDicoba, tandaiPreloadReload } from './preloadGuard'
import { bootstrapTheme } from './theme'

// Pasang tema SEBELUM render (class `dark` di <html> + token ikut) supaya
// halaman tidak kedip terang dulu saat user sebelumnya memilih gelap.
bootstrapTheme()

// Chunk lazy yang gagal diambil (deploy baru / jaringan putus) TIDAK ditangkap
// Suspense — promise-nya reject saat render dan meng-unmount seluruh pohon.
// Reload sekali adalah pemulihan yang benar: chunk ber-hash lama sudah tidak ada
// di server, jadi hanya build terbaru yang bisa menyelamatkan.
//
// PENTING: preventDefault() membuat helper Vite me-resolve `undefined` alih-alih
// melempar, sehingga ErrorBoundary di bawah menerima error sekunder
// ("Cannot read properties of undefined (reading 'default')"). Itu disengaja:
// fallback tetap tampil dengan tombol "Muat ulang", dan pesan mentahnya hanya
// ditampilkan kecil di bawah. Tanpa ErrorBoundary, preventDefault justru
// memperburuk (halaman tetap blank) — keduanya WAJIB berpasangan.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault()
  // Sudah pernah reload untuk error ini? Biarkan ErrorBoundary yang tampil.
  if (preloadReloadSudahDicoba()) return
  tandaiPreloadReload()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      {/* Boundary membungkus App, BUKAN di dalamnya: App menjalankan tiga
          initializer di body render (captureFromUrl / startFavoritesSync /
          startReadMarksSync), dan throw di sana membuat App sendiri gagal —
          boundary internal tidak akan pernah melihatnya. Terbukti: boundary di
          dalam App -> caught: false; membungkus App -> caught: true. */}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
)

// Service worker: baca komik tetap jalan walau internet jelek (cache-first
// gambar + SWR metadata + shell precache).localhost dianggap secure context.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW gagal (mis. browser lama): aplikasi tetap jalan tanpa cache offline */
    })
  })
}
