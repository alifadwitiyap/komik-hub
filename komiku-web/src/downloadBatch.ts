import { unifiedApi } from './api'
import { downloadChapterImages } from './chapterOffline'

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
export type GeneratedHandler = (id: string, filename: string) => void

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
export function saveGeneratedPdf(id: string, filename: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const a = document.createElement('a')
  // `filename` ikut di URL (`?fn=`) supaya SW bisa menulis header RFC 5987;
  // atribut `download` tetap jadi penentu nama di browser yang menghormatinya.
  a.href = unifiedApi.downloadFileUrl(id, filename)
  a.download = filename || 'chapter.pdf'
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  // Jangan hapus sinkron: beri unduhan waktu memulai sebelum anchor dilepas.
  // Tanpa jeda, beberapa browser membatalkan transfer yang baru di-trigger.
  // Tidak ada URL.revokeObjectURL di sini — tidak ada blob yang dibuat.
  window.setTimeout(() => a.remove(), 1000)
  return true
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
        const res = await unifiedApi.downloadPdf(ref.handle, ref.number, signal)
        // Q22.A: PDF sudah di server → langsung kirim ke perangkat user.
        // Dijalankan SEBELUM menandai 'ok' supaya kegagalan penyimpanan
        // tidak menyamar sebagai sukses; `onGenerated` sendiri tidak
        // melempar (saveGeneratedPdf no-op tanpa DOM).
        onGenerated?.(res.id, res.filename)
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

/**
 * Unduh beberapa chapter KE CACHE OFFLINE (bukan generate PDF). Untuk tiap
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
  for (let offset = 0; offset < list.length; offset += CHUNK_SIZE) {
    if (signal?.aborted) return
    const jobs = list
      .slice(offset, offset + CHUNK_SIZE)
      .map((ref, k) => ({ ref, index: offset + k }))
    await pool(jobs, CONCURRENCY, async ({ ref, index }) => {
      if (signal?.aborted) return
      onUpdate(index, { state: 'run' })
      try {
        const ch = await unifiedApi.chapter(ref.handle, ref.number, signal)
        const images = ch?.images ?? []
        if (images.length === 0) throw new Error('chapter tanpa halaman')
        const { ok, fail } = await downloadChapterImages(images)
        // Sukses hanya kalau SEMUA halaman (semua lebar) tersimpan. Sebelumnya
        // `ok !== 0` dianggap sukses → 1 dari 40 halaman gagal tetap dilaporkan
        // "tersimpan" dan user baru sadar saat offline. Kegagalan sebagian
        // harus jadi kegagalan chapter, dengan jumlah yang jujur.
        if (fail > 0) {
          throw new Error(
            `${fail} dari ${images.length} halaman gagal disimpan (${ok} tersimpan)`,
          )
        }
        onUpdate(index, { state: 'ok' })
      } catch (e) {
        if (signal?.aborted) return
        onUpdate(index, { state: 'fail', error: (e as Error).message })
      }
    })
  }
}
