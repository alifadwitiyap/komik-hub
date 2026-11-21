/** Kontrak PWA Track 1: manifest, ikon, meta, hook, dan toast update. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import manifestRaw from '../public/manifest.webmanifest?raw'
import indexHtml from '../index.html?raw'
import swSrc from '../public/sw.js?raw'
import hookSrc from './hooks/usePwaInstall.ts?raw'
import bannerSrc from './components/PwaInstallBanner.tsx?raw'
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
      background_color: '#0d1117',
      theme_color: '#0b0b0d',
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
  it('hook mendeteksi standalone, menahan prompt, dan mengingat dismiss 14 hari', () => {
    expect(hookSrc).toContain("matchMedia('(display-mode: standalone)')")
    expect(hookSrc).toContain("navigator as Navigator & { standalone?: boolean }")
    expect(hookSrc).toContain("'beforeinstallprompt'")
    expect(hookSrc).toContain('event.preventDefault()')
    expect(hookSrc).toContain('komik-pwa-dismissed')
    expect(hookSrc).toContain('14 * 24 * 60 * 60 * 1000')
    expect(hookSrc).toContain('Safari\\//')
    expect(hookSrc).not.toContain('(navigator as any)')
  })

  it('banner + kartu Akun memakai hook yang sama, update toast dipasang global', () => {
    expect(bannerSrc).toContain("from '../hooks/usePwaInstall'")
    expect(bannerSrc).toContain('Ketuk ikon Bagikan → Pilih &quot;Tambah ke Layar Utama&quot;')
    expect(bannerSrc).toContain('kh-tap')
    expect(bannerSrc).toContain('size-11')
    expect(bannerSrc).toContain('Pasang')
    expect(homeSrc).toContain('<PwaInstallBanner />')
    expect(akunSrc).toContain("from '../hooks/usePwaInstall'")
    expect(akunSrc).toContain('{!isStandalone && (')
    expect(appSrc).toContain('<SwUpdateToast />')
    expect(appSrc.indexOf('<SwUpdateToast />')).toBeGreaterThan(appSrc.indexOf('</Routes>'))
  })

  it('toast ditahan di reader dan mengirim SKIP_WAITING sebelum reload', () => {
    expect(toastSrc).toContain("pathname.startsWith('/baca/')")
    expect(toastSrc).toContain("pathname.startsWith('/maraton/')")
    expect(toastSrc).toContain("Versi baru siap")
    expect(toastSrc).toContain('Muat ulang')
    expect(toastSrc).toContain('kh-toast-enter kh-tap')
    expect(toastSrc).toContain("{ type: 'SKIP_WAITING' }")
    expect(toastSrc).toContain('controllerchange')
    expect(toastSrc).toContain('window.location.reload()')
    expect(swSrc).toContain("event.data.type === 'SKIP_WAITING'")
  })
})
