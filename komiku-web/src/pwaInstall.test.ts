/** Kontrak PWA Track 1: manifest, ikon, meta, hook, dan toast update. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import manifestRaw from '../public/manifest.webmanifest?raw'
import indexHtml from '../index.html?raw'
import swSrc from '../public/sw.js?raw'
import toastSrc from './components/SwUpdateToast.tsx?raw'
import appSrc from './App.tsx?raw'
import homeSrc from './pages/Home.tsx?raw'
import akunSrc from './pages/Akun.tsx?raw'

const root = join(process.cwd())
const pngSize = (name: string) => {
  const b = readFileSync(join(root, 'public', 'icons', name))
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}

describe('PWA manifest + ikon', () => {
  it('manifest standalone sesuai kontrak', () => {
    const m = JSON.parse(manifestRaw)
    expect(m).toMatchObject({
      name: 'Komik Hub',
      short_name: 'Komik Hub',
      id: '/',
      start_url: '/?source=pwa',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait-primary',
      background_color: '#0a0c0f',
      theme_color: '#0a0c0f',
      lang: 'id',
    })
    expect(m.icons.map((i: { purpose: string }) => i.purpose)).toEqual(['any', 'any', 'maskable'])
    expect(m.shortcuts).toEqual([
      { name: 'Rak & Update', short_name: 'Rak', url: '/rak?tab=favorit' },
      { name: 'Cari Komik', short_name: 'Cari', url: '/cari' },
    ])
    // Caddy standard menyajikan .webmanifest sebagai application/manifest+json;
    // Content-Type dicek saat QA deploy, bukan di sini.
  })

  it('ukuran ikon benar dan apple-touch-icon tidak transparan', () => {
    expect(pngSize('icon-192.png')).toEqual([192, 192])
    expect(pngSize('icon-512.png')).toEqual([512, 512])
    expect(pngSize('icon-maskable-512.png')).toEqual([512, 512])
    expect(pngSize('apple-touch-icon.png')).toEqual([180, 180])
    const b = readFileSync(join(root, 'public', 'icons', 'apple-touch-icon.png'))
    expect(b[25]).toBe(2) // PNG color type 2 = RGB (tanpa alpha channel)
  })

  it('meta head lengkap tanpa mengubah skeleton', () => {
    for (const tag of [
      '<link rel="manifest" href="/manifest.webmanifest" />',
      '<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />',
      '<meta name="apple-mobile-web-app-capable" content="yes" />',
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
      '<meta name="apple-mobile-web-app-title" content="Komik Hub" />',
      '<meta name="mobile-web-app-capable" content="yes" />',
    ]) expect(indexHtml).toContain(tag)
    expect(indexHtml).toContain('id="boot-skeleton"')
    expect(indexHtml).toContain('/fonts/NunitoSans-Regular.woff2')
  })
})

describe('UX install + update', () => {
  it('beranda/Akun bebas ajakan pasang & panel health; update toast global', () => {
    expect(homeSrc).not.toContain('<PwaInstallBanner />')
    expect(homeSrc).not.toContain('Pasang Komik Hub')
    expect(akunSrc).not.toContain('usePwaInstall')
    expect(akunSrc).not.toContain('Pasang Komik Hub')
    expect(akunSrc).not.toContain('Status Sumber')
    expect(akunSrc).not.toContain('SourceHealthPanel')
    expect(appSrc).toContain('<SourceHealthBadge />')
    expect(appSrc).toContain('<SwUpdateToast />')
    expect(appSrc.indexOf('<SwUpdateToast />')).toBeGreaterThan(appSrc.indexOf('</Routes>'))
  })

  it('toast ditahan di reader dan mengirim SKIP_WAITING sebelum reload', () => {
    expect(toastSrc).toContain("pathname.startsWith('/baca/')")
    expect(toastSrc).toContain("pathname.startsWith('/maraton/')")
    expect(toastSrc).toContain("Versi baru siap")
    expect(toastSrc).toContain('Muat ulang')
    expect(toastSrc).toContain('kh-toast-enter')
    expect(toastSrc).toContain('kh-tap')
    expect(toastSrc).toContain("{ type: 'SKIP_WAITING' }")
    expect(toastSrc).toContain('controllerchange')
    expect(toastSrc).toContain('window.location.reload()')
    expect(swSrc).toContain("event.data.type === 'SKIP_WAITING'")
  })
})
