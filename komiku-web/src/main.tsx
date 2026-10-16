import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { bootstrapTheme } from './theme'

// Pasang tema SEBELUM render (class `dark` di <html> + token ikut) supaya
// halaman tidak kedip terang dulu saat user sebelumnya memilih gelap.
bootstrapTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
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
