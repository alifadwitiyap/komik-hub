import { useCallback, useEffect, useRef, useState } from 'react'
import { imgUrl } from '../imgUrl'
import { IconBolt, IconXmark } from '../icons'
import { loadChapter } from '../readerSource'
import { addChapterUrls, getManifest, markSaved } from '../offlineStore'

interface DownloadSheetProps {
  open: boolean
  chapterId: string
  chapterName: string
  onClose: () => void
}

type Status = 'idle' | 'saving' | 'done' | 'partial'

interface SwMsg {
  type?: string
  done?: number
  total?: number
  ok?: boolean
}

interface CacheResult {
  ok: boolean
  /** berapa URL yang benar-benar sudah di cache saat run berakhir */
  saved: number
}

/** "3 chapter berikutnya" = chapter ini + 3 sesudahnya (total 4 chapter). */
const NEXT_COUNT = 3
const IMG_CACHE = 'komiku-img-v1'

/**
 * Sheet "Simpan untuk offline" — gaya sheet putih Komiku+ (rounded-t-2xl,
 * baris + tombol). Status JUJUR: angka yang tampil hanya menghitung gambar
 * yang benar-benar sudah ada di cache 'komiku-img-v1' (dilaporkan service
 * worker via CACHE_PROGRESS/CACHE_DONE; kalau SW belum aktif, diverifikasi
 * langsung dari halaman dengan cache.match sebelum fetch).
 *
 * Semua URL gambar lewat imgUrl() (proxy /img?u=...) supaya manifest,
 * cache SW, dan reader memakai URL yang sama persis.
 */
export default function DownloadSheet({ open, chapterId, chapterName, onClose }: DownloadSheetProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [label, setLabel] = useState('')
  const [step, setStep] = useState(0)
  const [steps, setSteps] = useState(1)
  const [note, setNote] = useState<string | null>(null)
  /** naik tiap kali run baru: progres dari run lama diabaikan */
  const runRef = useRef(0)
  /** resolver cache yang masih menggantung — diputus kalau sheet ditutup */
  const pendingRef = useRef<((r: CacheResult) => void) | null>(null)

  const busy = status === 'saving'

  // status tersimpan (dari manifest lokal) setiap kali sheet dibuka
  useEffect(() => {
    if (!open) return
    setStatus('idle')
    setDone(0)
    setTotal(0)
    setStep(0)
    setSteps(1)
    setNote(null)
    setLabel(chapterName)
    let alive = true
    getManifest(chapterId)
      .then((m) => {
        if (!alive || !m) return
        setDone(m.saved)
        setTotal(m.total)
        if (m.total > 0 && m.saved >= m.total) setStatus('done')
      })
      .catch(() => {
        /* IndexedDB diblokir (mode privat?) — tetap boleh coba simpan */
      })
    return () => {
      alive = false
    }
  }, [open, chapterId, chapterName])

  // tutup = run berjalan dibatalkan
  useEffect(() => {
    if (open) return
    runRef.current++
    pendingRef.current?.({ ok: false, saved: 0 })
    pendingRef.current = null
  }, [open])

  /** Cache semua URL — lewat SW kalau ada controller, kalau tidak dari page. */
  const cacheUrls = useCallback(
    async (urls: string[], run: number): Promise<CacheResult> => {
      const isStale = () => runRef.current !== run
      if (navigator.serviceWorker?.controller) {
        const sw = navigator.serviceWorker
        return new Promise<CacheResult>((resolve) => {
          let saved = 0
          // Jaring aman: SW versi lama (belum punya CACHE_CHAPTER) tak akan
          // pernah menjawab — setelah 30s diam, anggap gagal biar status
          // jujur ("Terputus, lanjutkan") dan tombol bisa dicoba lagi.
          const watchdog = setTimeout(() => finish({ ok: false, saved }), 30000)
          const finish = (x: CacheResult) => {
            clearTimeout(watchdog)
            sw.removeEventListener('message', onMsg)
            pendingRef.current = null
            resolve(x)
          }
          // listener dipasang SEBELUM postMessage: event message selalu
          // dikirim sebagai task, jadi CACHE_PROGRESS/CACHE_DONE tak terlewat.
          // Kalau sheet ditutup sebelum SW menjawab, finish dipanggil dari
          // effect close → promise selesai dengan {ok:false}.
          const onMsg = (e: MessageEvent) => {
            if (isStale()) return
            const d = e.data as SwMsg | null
            if (!d) return
            if (d.type === 'CACHE_PROGRESS') {
              saved = d.done ?? 0
              setDone(saved)
              setTotal(d.total ?? urls.length)
            } else if (d.type === 'CACHE_DONE') {
              finish({ ok: d.ok === true, saved })
            }
          }
          sw.addEventListener('message', onMsg)
          pendingRef.current = finish
          sw.controller?.postMessage({ type: 'CACHE_CHAPTER', urls })
        })
      }
      if (typeof caches !== 'undefined') {
        return cacheInPage(urls, setDone, isStale)
      }
      setNote('Browser ini tidak mendukung penyimpanan offline.')
      return { ok: false, saved: 0 }
    },
    [],
  )

  const save = useCallback(
    async (mode: 'one' | 'next3') => {
      if (busy || !chapterId) return
      const run = ++runRef.current
      const want = mode === 'one' ? 1 : 1 + NEXT_COUNT
      setStatus('saving')
      setNote(null)
      setStep(0)
      setSteps(want)
      setDone(0)
      setTotal(0)
      const chain: string[] = []
      let cursor: string | null = chapterId
      let allOk = true
      try {
        while (cursor && chain.length < want) {
          // daftar URL chapter ini + "next" untuk lanjut rantai
          const d = await loadChapter(cursor)
          if (runRef.current !== run) return // sheet ditutup / run dibatalkan
          chain.push(cursor)
          setStep(chain.length - 1)
          const urls = (d.images ?? []).map((u: string) =>
            new URL(imgUrl(u), window.location.origin).toString(),
          )
          const m = await addChapterUrls(cursor, d.chapter.name, d.series?.id ?? null, urls)
          if (runRef.current !== run) return
          setLabel(d.chapter.name)
          setTotal(m.total)
          setDone(m.saved)
          const r = await cacheUrls(urls, run)
          if (runRef.current !== run) return
          await markSaved(cursor, r.saved).catch(() => {
            /* manifest gagal ditulis: penyimpanan cache tetap berlaku */
          })
          if (!r.ok) {
            allOk = false
            break
          }
          // chapter berikutnya: resolve lewat respons loadChapter (next.id)
          // — kunci komiku lama ATAUN unified, dua-duanya jalan.
          cursor = d.chapter.next ? String(d.chapter.next.id) : null
        }
        setStatus(allOk ? 'done' : 'partial')
      } catch {
        setStatus('partial')
      }
    },
    [busy, chapterId, cacheUrls],
  )

  if (!open) return null

  const complete = total > 0 && done >= total
  const statusText =
    status === 'saving'
      ? `${done}/${total} gambar tersimpan · ${label} (${step + 1}/${steps})`
      : status === 'done' || complete
        ? 'Lengkap — siap offline'
        : status === 'partial'
          ? 'Terputus, lanjutkan'
          : total > 0
            ? `${done}/${total} gambar tersimpan`
            : 'Belum disimpan — belum ada gambar di cache.'

  const statusTone =
    status === 'partial' ? 'text-brand-red' : complete || status === 'done' ? 'text-brand-amber' : 'text-ink-500'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-2xl bg-white pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="font-display text-[15px] font-bold text-ink-100">Simpan untuk offline</h2>
          <button onClick={onClose} aria-label="Tutup" className="p-1.5 text-ink-500">
            <IconXmark className="size-4" />
          </button>
        </div>
        <div className="h-px bg-ink-800" />

        <div className="px-4 pt-3">
          <p className="truncate text-[12.5px] font-semibold text-ink-100">{chapterName}</p>
          <p className={`mt-0.5 text-[11.5px] font-medium ${statusTone}`}>{statusText}</p>
          {note && <p className="mt-0.5 text-[11px] text-brand-red">{note}</p>}

          {status === 'saving' && total > 0 && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
              <div
                className="h-full rounded-full bg-brand-amber transition-[width] duration-200"
                style={{ width: `${Math.min((done / total) * 100, 100)}%` }}
              />
            </div>
          )}

          <div className="mt-3 space-y-2">
            <button
              onClick={() => save('one')}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-amber py-3 text-[13px] font-bold text-white disabled:opacity-60"
            >
              <IconBolt className="size-4" />
              Simpan chapter ini
            </button>
            <button
              onClick={() => save('next3')}
              disabled={busy}
              className="w-full rounded-xl border border-ink-300 py-3 text-[12.5px] font-semibold text-ink-300 disabled:opacity-60"
            >
              Simpan 3 chapter berikutnya
            </button>
          </div>

          <p className="mt-3 text-[10.5px] leading-relaxed text-ink-500">
            Gambar disimpan di cache aplikasi dan bisa dibaca lagi tanpa internet dari mode
            maraton. Membersihkan cache browser akan membuang simpanan ini.
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * Fallback tanpa controller SW: isi cache langsung dari halaman
 * (cache.match dulu supaya yang sudah ada tidak diunduh ulang — angka
 * progres tetap berarti "sudah tersimpan").
 */
async function cacheInPage(
  urls: string[],
  onProgress: (done: number, total: number) => void,
  isStale: () => boolean,
): Promise<CacheResult> {
  const cache = await caches.open(IMG_CACHE)
  let done = 0
  for (const u of urls) {
    if (isStale()) break
    try {
      const req = new Request(u)
      if (!(await cache.match(req, { ignoreSearch: false }))) {
        const res = await fetch(req)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await cache.put(req, res)
      }
      done++
    } catch {
      break // putus: berhenti, status jujur "Terputus, lanjutkan"
    }
    onProgress(done, urls.length)
  }
  return { ok: done === urls.length, saved: done }
}
