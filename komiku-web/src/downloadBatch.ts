import { unifiedApi } from './api'
import { accountHeaders } from './api'
import { downloadChapterImages } from './chapterOffline'

/**
 * Deteksi error 5xx dari server (dipakai friendlyError & circuit breaker).
 * Regex tunggal — jangan diduplikasi.
 */
export function isServerError5xx(e: unknown): boolean {
  // 1) status HTTP asli yang dibuang oleh send()/get() — dikomiku-server pesan
  //    error berisi teks anyhow, bukan "HTTP 502…", jadi regex saja tidak cukup.
  const s = (e as { status?: number } | null | undefined)?.status
  if (typeof s === 'number' && s >= 500 && s < 600) return true
  const raw = (e as Error)?.message ?? String(e)
  // Hanya cocokkan status code dalam konteks respons HTTP ("HTTP 503",
  // frasa "status 5xx", atau frasa error server yang dikenal) — bukan sekadar
  // digit 500–599 di mana pun, karena pesan partial-failure bisa mengandung
  // angka seperti "550 dari 1200 halaman gagal".
  return /HTTP\s*5\d\d|status[^0-9]{0,10}5\d\d|internal server error|bad gateway|service unavailable|gateway timeout/i.test(raw)
}

/**
 * Pesan error yang user-friendly.
 */
export function friendlyError(e: unknown): string {
  const raw = (e as Error)?.message ?? String(e)
  if (/failed to fetch|networkerror|network error|err_|load failed/i.test(raw)) {
    return 'Tidak ada koneksi internet'
  }
  if (isServerError5xx(e)) {
    return 'Server bermasalah'
  }
  return raw || 'Gagal mengunduh'
}

/**
 * Batch unduh PDF (kontrak POST /api/unified/download-pdf).
 *
 * Dipakai dua tempat: daftar chapter di halaman series dan tab Unduhan.
 * Logika (pool + batas batch) hidup DI SINI supaya bisa diuji tanpa React.
 */

/** Maksimal chapter terpilih per batch (spek user: maks 30 chapter). */
export const BATCH_MAX = 30

/**
 * Ukuran chunk pemrosesan: chapter diproses 10 sekaligus, chunk berikutnya
 * baru jalan setelah chunk sebelumnya selesai (server generate PDF berat).
 */
export const CHUNK_SIZE = 10

/** Konkuren unduhan di dalam satu chunk: server generate PDF berat, jangan rebut. */
export const CONCURRENCY = 3

/** Ukuran file manusiawi: "1.2 MB" / "340 KB" / "812 B"; nilai tak wajar → "—". */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export interface ChapterRef {
  handle: string
  number: string
}

export interface JobProgress {
  number: string
  state: 'wait' | 'run' | 'ok' | 'fail'
  error?: string
}

/** Dipanggil tiap PDF selesai di-generate (lihat `saveGeneratedPdf`). */
export type GeneratedHandler = (id: string, filename: string) => void | Promise<void>

/**
 * Simpan PDF yang baru di-generate ke perangkat user (keputusan Q22.A:
 * "user tekan Unduh → server kirim file → HP simpan").
 *
 * Server membalas `Content-Disposition: attachment` di
 * `GET /api/unified/downloads/{id}` → cukup mengarahkan browser ke URL itu;
 * file di-STREAM server, tidak ditahan di memori JS (tanpa fetch/blob). Atribut
 * `download` dipakai supaya nama file yang tersimpan = `filename`.
 *
 * URL-nya same-origin (`/api/...`) sehingga tidak butuh CORS. Anchor
 * DILEPAS SETELAH JEDA, bukan sinkron: `a.remove()` tepat setelah `click()`
 * bisa membatalkan unduhan yang belum sempat mulai di sebagian browser —
 * penjadwalan ulang (bukan `URL.revokeObjectURL`, yang memang tak dipakai
 * karena kita mengarahkan langsung ke URL server, tanpa blob).
 *
 * AMAN di Node/SSR: tanpa `document` fungsi ini no-op dan mengembalikan
 * `false`, jadi `downloadChapters` tetap bisa diuji tanpa DOM (hostile-check /
 * unified-selfcheck). JANGAN menyentuh `document`/`window` saat inisialisasi
 * modul (aturan wiring-check).
 *
 * Catatan jujur: batch > 1 chapter memicu beberapa unduhan beruntun; browser
 * boleh menampilkan prompt "izinkan unduh banyak file" — itu perilaku browser,
 * bukan bug (server tetap menyimpan tiap entri, bisa diambil ulang dari Rak).
 */
export async function saveGeneratedPdf(
  id: string,
  filename: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<boolean> {
  if (typeof window === 'undefined' || !document?.body) return false
  const { signal, timeoutMs = 30_000 } = opts ?? {}
  if (signal?.aborted) return false
  // Satu AbortController untuk timeout internal + signal pemanggil, supaya
  // fetch yang menggantung tidak menahan run selamanya.
  const ac = new AbortController()
  const onOuterAbort = () => ac.abort()
  signal?.addEventListener('abort', onOuterAbort)
  const timer = window.setTimeout(() => ac.abort(), timeoutMs)
  try {
    // Auto-unduh lewat fetch + blob (bukan anchor <a download>) supaya header
    // `X-Komik-User` ikut terkirim. Server `GET /api/unified/downloads/{id}`
    // mewajibkan header itu (401 tanpa) — anchor top-level tidak bisa membawa
    // header, jadi sebelumnya auto-unduh PUT gagal padahal PDF sudah jadi.
    const res = await fetch(unifiedApi.downloadFileUrl(id, filename), {
      headers: accountHeaders(),
      signal: ac.signal,
    })
    if (!res.ok) return false
    const blob = await res.blob()
    if (ac.signal.aborted) return false
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename || 'chapter.pdf'
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    // Jangan hapus sinkron: beri unduhan waktu memulai sebelum anchor dilepas.
    window.setTimeout(() => {
      a.remove()
      URL.revokeObjectURL(objectUrl)
    }, 1000)
    return true
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** Pesan saat circuit breaker menghentikan batch (server 5xx beruntun). */
export const BREAKER_MESSAGE = 'Dihentikan: server bermasalah'
/** Jumlah kegagalan 5xx beruntun yang men-trip circuit breaker. */
export const BREAKER_THRESHOLD = 3

/**
 * Circuit breaker per batch run (dibuat baru di tiap downloadChapters/
 * cacheChapters). Menghitung kegagalan 5xx BERUNTUN; reset ke 0 pada sukses
 * maupun kegagalan non-5xx. Bukan state global.
 */
export function create5xxBreaker() {
  let consecutive = 0
  return {
    tripped: () => consecutive >= BREAKER_THRESHOLD,
    recordSuccess: () => {
      consecutive = 0
    },
    recordFailure: (e: unknown) => {
      consecutive = isServerError5xx(e) ? consecutive + 1 : 0
    },
  }
}

/** Pool sederhana: jalankan promise maksimal `limit` sekaligus. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length && !shouldStop?.()) {
      const i = cursor++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Unduh beberapa chapter. `list` diproses PER CHUNK_SIZE chapter: chunk
 * berikutnya baru jalan setelah chunk sebelumnya selesai (di dalam chunk,
 * pool CONCURRENCY). `onUpdate(index, patch)` dipanggil tiap perubahan status
 * item — index tetap posisi di `list` (bukan di dalam chunk) supaya UI bisa
 * memetakan progres ke baris chapter yang sama.
 *
 * `signal` opsional: saat di-abort, chapter yang BELUM MULAI dilewati tanpa
 * error palsu dan fungsi langsung kembali (signal diteruskan ke
 * `unifiedApi.downloadPdf` supaya fetch yang sedang jalan juga berhenti).
 * Chapter yang sedang jalan saat abort tidak ditandai gagal — statusnya
 * dibiarkan dan pemanggil yang merapikan state.
 *
 * `onGenerated` opsional (Q22.A): dipanggil tiap PDF berhasil di-generate,
 * dengan `{id, filename}` server, supaya pemanggil bisa langsung menyimpan
 * file ke perangkat user (lihat `saveGeneratedPdf`). Dipanggil SEBELUM
 * status chapter menjadi 'ok'.
 */
export async function downloadChapters(
  list: readonly ChapterRef[],
  onUpdate: (index: number, patch: Partial<JobProgress>) => void,
  signal?: AbortSignal,
  onGenerated?: GeneratedHandler,
): Promise<void> {
  const breaker = create5xxBreaker()
  const settled = new Array<boolean>(list.length).fill(false)
  const finish = (index: number, patch: Partial<JobProgress>) => {
    settled[index] = true
    onUpdate(index, patch)
  }
  for (let offset = 0; offset < list.length; offset += CHUNK_SIZE) {
    if (signal?.aborted) return
    if (breaker.tripped()) break
    const jobs = list
      .slice(offset, offset + CHUNK_SIZE)
      .map((ref, k) => ({ ref, index: offset + k }))
    await pool(
      jobs,
      CONCURRENCY,
      async ({ ref, index }) => {
      // belum mulai → dilewati senyap (bukan kegagalan unduhan)
      if (signal?.aborted) return
      if (breaker.tripped()) {
        finish(index, { state: 'fail', error: BREAKER_MESSAGE })
        return
      }
      onUpdate(index, { state: 'run' })
      try {
        const res = await unifiedApi.downloadPdf(ref.handle, ref.number, signal)
        // Respons tidak valid (id/filename hilang atau kosong) → GAGAL,
        // bukan sukses palsu yang menandai job 'ok'.
        if (
          typeof res?.id !== 'string' || res.id.length === 0
          || typeof res?.filename !== 'string' || res.filename.length === 0
        ) {
          throw new Error('Server tidak mengirim file PDF (respons tidak valid).')
        }
        // Q22.A: PDF sudah di server → langsung kirim ke perangkat user.
        // Dijalankan SEBELUM menandai 'ok' supaya kegagalan penyimpanan
        // tidak menyamar sebagai sukses; `onGenerated` sendiri tidak
        // melempar (saveGeneratedPdf no-op tanpa DOM).
        // onGenerated bisa async (saveGeneratedPdf fetch+blob). Tunggu selesai
        // sebelum menandai 'ok', supaya kegagalan penyimpanan tidak menyamar
        // sebagai sukses. Jika user abort SETELAH PDF terkirim, chapter ini
        // TETAP ditandai 'ok' — mengikuti realita (file sudah sampai di
        // perangkat) dan mencegah abort-finalize salah menandai 'Dibatalkan'.
        await onGenerated?.(res.id, res.filename)
        breaker.recordSuccess()
        finish(index, { state: 'ok' })
      } catch (e) {
        // abort bawaan user: fetch gagal dengan AbortError — jangan beri
        // label gagal, pemanggil yang menutup UI-nya.
        if (signal?.aborted) return
        breaker.recordFailure(e)
        finish(index, { state: 'fail', error: friendlyError(e) })
      }
      },
      () => breaker.tripped(),
    )
  }
  // Breaker trip → sisa item yang belum mulai ditandai gagal, tanpa network.
  if (!signal?.aborted && breaker.tripped()) {
    for (let i = 0; i < list.length; i++) {
      if (!settled[i]) onUpdate(i, { state: 'fail', error: BREAKER_MESSAGE })
    }
  }
}

/**
 * Unduh beberapa chapter KE CACHE OFFLINE (bukan generate PDF).
 * chapter: fetch metadata (daftar gambar) → cache semua halaman via service
 * worker (`downloadChapterImages`). Sama `downloadChapters` dalam hal chunk/
 * concurrency/abort — bedanya hasilnya bukan file PDF di server, melainkan
 * byte gambar di Cache Storage browser, jadi kebaca saat internet/server mati.
 */
export async function cacheChapters(
  list: readonly ChapterRef[],
  onUpdate: (index: number, patch: Partial<JobProgress>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const breaker = create5xxBreaker()
  const settled = new Array<boolean>(list.length).fill(false)
  const finish = (index: number, patch: Partial<JobProgress>) => {
    settled[index] = true
    onUpdate(index, patch)
  }
  for (let offset = 0; offset < list.length; offset += CHUNK_SIZE) {
    if (signal?.aborted) return
    if (breaker.tripped()) break
    const jobs = list
      .slice(offset, offset + CHUNK_SIZE)
      .map((ref, k) => ({ ref, index: offset + k }))
    await pool(
      jobs,
      CONCURRENCY,
      async ({ ref, index }) => {
      if (signal?.aborted) return
      if (breaker.tripped()) {
        finish(index, { state: 'fail', error: BREAKER_MESSAGE })
        return
      }
      onUpdate(index, { state: 'run' })
      try {
        const ch = await unifiedApi.chapter(ref.handle, ref.number, signal)
        const images = ch?.images ?? []
        if (images.length === 0) throw new Error('chapter tanpa halaman')
        const { ok, fail } = await downloadChapterImages(images, undefined, signal)
        // Sukses hanya kalau SEMUA halaman (semua lebar) tersimpan. Sebelumnya
        // `ok !== 0` dianggap sukses → 1 dari 40 halaman gagal tetap dilaporkan
        // "tersimpan" dan user baru sadar saat offline. Kegagalan sebagian
        // harus jadi kegagalan chapter, dengan jumlah yang jujur.
        if (fail > 0) {
          throw new Error(
            `${fail} dari ${images.length} halaman gagal disimpan (${ok} tersimpan)`,
          )
        }
        breaker.recordSuccess()
        finish(index, { state: 'ok' })
      } catch (e) {
        if (signal?.aborted) return
        breaker.recordFailure(e)
        finish(index, { state: 'fail', error: friendlyError(e) })
      }
      },
      () => breaker.tripped(),
    )
  }
  // Breaker trip → sisa item yang belum mulai ditandai gagal, tanpa network.
  if (!signal?.aborted && breaker.tripped()) {
    for (let i = 0; i < list.length; i++) {
      if (!settled[i]) onUpdate(i, { state: 'fail', error: BREAKER_MESSAGE })
    }
  }
}
