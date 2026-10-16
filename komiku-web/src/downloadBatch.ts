import { unifiedApi } from './api'

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

/** Pool sederhana: jalankan promise maksimal `limit` sekaligus. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
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
 */
export async function downloadChapters(
  list: readonly ChapterRef[],
  onUpdate: (index: number, patch: Partial<JobProgress>) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < list.length; offset += CHUNK_SIZE) {
    if (signal?.aborted) return
    const jobs = list
      .slice(offset, offset + CHUNK_SIZE)
      .map((ref, k) => ({ ref, index: offset + k }))
    await pool(jobs, CONCURRENCY, async ({ ref, index }) => {
      // belum mulai → dilewati senyap (bukan kegagalan unduhan)
      if (signal?.aborted) return
      onUpdate(index, { state: 'run' })
      try {
        await unifiedApi.downloadPdf(ref.handle, ref.number, signal)
        onUpdate(index, { state: 'ok' })
      } catch (e) {
        // abort bawaan user: fetch gagal dengan AbortError — jangan beri
        // label gagal, pemanggil yang menutup UI-nya.
        if (signal?.aborted) return
        onUpdate(index, { state: 'fail', error: (e as Error).message })
      }
    })
  }
}
