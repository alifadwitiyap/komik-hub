import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toMangaCard, usableCoverUrl } from './api'
import { IMG_HOSTS, imgSrc, isProxyable } from './imgUrl'

describe('komikindo cover & allowlist sync', () => {
  const sampleCover =
    'https://komikindo.ch/wp-content/uploads/2024/07/Komik-Solo-Leveling-Ragnarok-223x319.jpg'

  it('usableCoverUrl dan toMangaCard mempertahankan cover komikindo untuk hero & kartu', () => {
    expect(usableCoverUrl(sampleCover)).toBe(sampleCover)
    const card = toMangaCard({
      source: 'komikindo',
      native_id: 'solo-leveling-ragnarok',
      handle: 'komikindo:solo-leveling-ragnarok',
      title: 'Solo Leveling: Ragnarok',
      title_key: 'solo-leveling-ragnarok',
      cover_url: sampleCover,
      author: null,
      status: 'Ongoing',
      manga_type: 'Manhwa',
      rating: '8',
      last_chapter: '74',
      updated_at: null,
      url: null,
    })
    expect(card.cover).toBe(sampleCover)
    expect(card.thumbnail).toBe(sampleCover)
  })

  it('komikindo.ch dan www.komikindo.ch diarahkan lewat proxy same-origin /img', () => {
    expect(isProxyable(sampleCover)).toBe(true)
    expect(isProxyable('https://www.komikindo.ch/wp-content/uploads/a.jpg')).toBe(true)
    expect(imgSrc(sampleCover, 640)).toBe(
      `/img?u=${encodeURIComponent(sampleCover)}&w=640`,
    )
  })

  it('IMG_HOSTS di web identik dengan ALLOWED_HOSTS di komiku-server/src/hosts.rs', () => {
    const hostsRs = readFileSync(
      fileURLToPath(new URL('../../komiku-server/src/hosts.rs', import.meta.url)),
      'utf8',
    )
    const block = hostsRs.match(/const ALLOWED_HOSTS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/)?.[1] ?? ''
    const rustHosts = Array.from(block.matchAll(/"([^"]+)"/g), (m) => m[1])
    expect(rustHosts.length).toBeGreaterThan(0)
    expect([...IMG_HOSTS]).toEqual(rustHosts)
  })
})
