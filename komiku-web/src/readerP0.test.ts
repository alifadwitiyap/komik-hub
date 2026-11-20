/**
 * Test kontrak Bagian 2 (P0 — Reader dan Preferensi).
 *
 * Vitest env = 'node' (tanpa jsdom/@testing-library), jadi assertion memakai
 * dua lapisan seperti `downloadA11y.test.ts`: fungsi murni diuji langsung,
 * sedangkan kontrak markup .tsx di-pin lewat import `?raw` (bukan render).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isChromeToggleKey } from './readerChromeKeys'
import footerSrc from './components/ReaderFooter.tsx?raw'
import toolbarSrc from './components/ReaderToolbar.tsx?raw'
import sheetSrc from './components/ReaderSettingsSheet.tsx?raw'
import comicSrc from './components/ComicImage.tsx?raw'
import readerSrc from './pages/Reader.tsx?raw'
import marathonSrc from './pages/ReaderMarathon.tsx?raw'

describe('kontrol chrome: pemicu keyboard H', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key: k, altKey: false, ctrlKey: false, metaKey: false, ...mods }) as Pick<
      KeyboardEvent,
      'key' | 'altKey' | 'ctrlKey' | 'metaKey'
    >

  it('H/h aktif tanpa modifier', () => {
    expect(isChromeToggleKey(key('H'))).toBe(true)
    expect(isChromeToggleKey(key('h'))).toBe(true)
  })

  it('modifier dan tombol lain dilewati (shortcut browser/AT tidak dikalahkan)', () => {
    expect(isChromeToggleKey(key('h', { ctrlKey: true }))).toBe(false)
    expect(isChromeToggleKey(key('h', { altKey: true }))).toBe(false)
    expect(isChromeToggleKey(key('h', { metaKey: true }))).toBe(false)
    expect(isChromeToggleKey(key('Escape'))).toBe(false)
  })
})

describe('(1) footer satu baris + navigasi', () => {
  it('grid 3 kolom, tombol selalu ada, label akhir chapter benar', () => {
    expect(footerSrc).toContain('grid-cols-3')
    expect(footerSrc).toContain('disabled={!prevHref}')
    expect(footerSrc).toContain('disabled={!nextHref}')
    expect(footerSrc).toContain("nextHref ? 'Berikutnya' : 'Chapter berikutnya'")
  })

  it('kontrol tersembunyi keluar dari urutan Tab', () => {
    expect(footerSrc).toContain('aria-hidden={!visible}')
    expect(footerSrc).toContain('inert={!visible}')
    expect(toolbarSrc).toContain('aria-hidden={!visible}')
    expect(toolbarSrc).toContain('inert={!visible}')
  })
})

describe('(2) pemicu keyboard dipasang di hook chrome', () => {
  it('useChromeOnScroll memakai helper H dan mengabaikan form/dialog', () => {
    // dibaca langsung supaya helper tidak menganggur
    const hookSrc = readFileSync(
      fileURLToPath(new URL('./hooks/useChromeOnScroll.ts', import.meta.url)),
      'utf8',
    ) as string
    expect(hookSrc).toContain('isChromeToggleKey')
    expect(hookSrc).toContain('[role="dialog"]')
  })
})

describe('(3) sheet Preferensi: viewport, scroll, sticky, Escape + focus return', () => {
  it('max-h viewport + header shrink-0 + area opsi overflow-y-auto', () => {
    expect(sheetSrc).toContain('max-h-[92dvh]')
    expect(sheetSrc).toContain('flex shrink-0 items-center justify-between')
    expect(sheetSrc).toContain('min-h-0 flex-1 overflow-y-auto')
  })
  it('Escape memanggil onCloseRef, cleanup mengembalikan fokus', () => {
    expect(sheetSrc).toContain("e.key === 'Escape'")
    expect(sheetSrc).toContain('onCloseRef.current()')
    // Fokus kembali ke elemen pembuka (tombol Tutup terlihat/sticky) tanpa menggulir.
    expect(sheetSrc).toMatch(/(prev|openerRef\.current)\?\.focus\(/)
  })
})

describe('(4) progres halaman terpisah dari loading gambar; retry tanpa geser', () => {
  it('toolbar punya label posisi dan node status loading terpisah', () => {
    expect(toolbarSrc).toContain('loadingLabel')
    expect(toolbarSrc).toContain('role="status" aria-live="polite"')
  })
  it('reader & maraton memakai format "Hal. X dari N"', () => {
    expect(readerSrc).toContain('`Hal. ${activePage} dari ${images.length}`')
    expect(marathonSrc).toContain('dari ${curLen}')
  })
  it('ComicImage reserve ruang via aspectRatio + tombol Coba lagi per gambar', () => {
    expect(comicSrc).toContain('aspectRatio: String(ratio)')
    expect(comicSrc).toContain('data-reader-control="page-retry"')
    expect(comicSrc).toContain('Coba lagi')
    // P1: pesan inline memakai nomor halaman (1-based) dan menyertakan aksi
    // dalam satu status yang sama, tepat di tempat halaman gagal.
    expect(comicSrc).toContain('`Halaman ${pageNumber} gagal dimuat`')
    expect(comicSrc).toContain('`${label} · Coba lagi`')
    expect(comicSrc).toContain('pageNumber={pageIndex === undefined ? undefined : pageIndex + 1}')
    // retry hanya gambar ini: cache-buster unik, tanpa reload chapter.
    expect(comicSrc).toContain('setBuster(Date.now())')
  })
})

describe('(5) pesan sumber cadangan bisa diumumkan', () => {
  it('catatan switched_from memakai role=status', () => {
    expect(readerSrc).toContain('data.switched_from && data.note')
    const block = readerSrc.slice(
      readerSrc.indexOf('data.switched_from && data.note'),
      readerSrc.indexOf('data.switched_from && data.note') + 700,
    )
    expect(block).toContain('role="status"')
    expect(block).toContain('aria-live="polite"')
  })
})

describe('(6) chapter selesai tidak bergantung pada gambar selesai dimuat', () => {
  it('didOpenChapter dipanggil saat fetch resolve, bukan di efek imagesReady', () => {
    const then = readerSrc.indexOf('.then((d) =>')
    const didOpen = readerSrc.indexOf('didOpenChapter(', then)
    expect(didOpen).toBeGreaterThan(then)
    const imagesReadyEfek = readerSrc.indexOf('if (imagesReady &&')
    expect(imagesReadyEfek).toBeGreaterThan(0)
    expect(imagesReadyEfek).toBeGreaterThan(didOpen)
    // efek imagesReady hanya menulis riwayat (writeRef), bukan menandai selesai
    const readyBlock = readerSrc.slice(imagesReadyEfek, imagesReadyEfek + 160)
    expect(readyBlock).toContain('writeRef.current(true)')
    expect(readyBlock).not.toContain('didOpenChapter')
  })
  it('maraton menandai blok aktif saat dibuka (markOnly), bukan saat gambar beres', () => {
    const mark = marathonSrc.indexOf('{ markOnly: true }')
    expect(mark).toBeGreaterThan(0)
    // onSettled (gambar beres) hanya dipakai label loading, bukan penanda selesai
    const settledUsage = marathonSrc.indexOf('onSettled={() =>')
    const markBlock = marathonSrc.slice(mark - 200, mark + 200)
    expect(markBlock).not.toContain('onSettled')
    expect(settledUsage).toBeGreaterThan(mark)
  })
})
