/**
 * downloadStore — progres unduhan tingkat MODUL (singleton, hidup seumur
 * hidup tab).
 *
 * Sebelumnya tiap halaman series menjalankan batch-nya sendiri di state
 * lokal: begitu user pindah halaman (Rak, reader, Home) kartu progres hilang
 * walau unduhan tetap jalan di server. Store ini memegang run DI LUAR React:
 *   - batch tetap berjalan apa pun halaman yang dibuka;
 *   - progres bisa dibaca dari mana saja (mis. tab Unduhan di Rak) lewat
 *     subscribe, dikelompokkan per series (handle + seriesTitle).
 *
 * Sengaja TIDAK bergantung pada React / DOM / localStorage supaya logikanya
 * bisa diuji di node. Yang boleh berubah hanya state in-modul ini.
 *
 * Kontrak run:
 *   - SATU run aktif per handle; run baru untuk handle yang sama MENGGANTI
 *     run lama yang sudah selesai/dibatalkan.
 *   - Job: 'wait' → 'run' → 'ok' | 'fail'. Pembatalan menyisakan job yang
 *     sudah 'ok' tetap 'ok'; sisanya diberi state 'fail' dengan error
 *     'Dibatalkan' (penanda pembatalan, bukan kegagalan unduhan) supaya run
 *     tidak menggantung selamanya di "wait/run".
 *   - Run yang sudah selesai TETAP ada sampai diganti run baru handle yang
 *     sama — pemanggil yang memutuskan mau menampilkannya atau tidak
 *     (lihat helper `runBusy` di halaman series).
 */

import { downloadChapters, saveGeneratedPdf } from './downloadBatch'

export interface DlJob {
  number: string
  state: 'wait' | 'run' | 'ok' | 'fail'
  error?: string
}

export interface DlRun {
  /** 'sumber:native_id' (unified) atau 'komiku:<id>' (legacy). */
  handle: string
  seriesTitle: string
  jobs: DlJob[]
  startedAt: number
  /**
   * Q22.A — jumlah PDF yang sudah otomatis dikirim ke perangkat user
   * (auto-trigger simpan setelah generate). Dipakai UI untuk melaporkan
   * jujur berapa file benar-benar tersimpan, terpisah dari berapa chapter
   * berhasil di-generate di server.
   */
  saved: number
}

interface RunRec extends DlRun {
  ctrl: AbortController
}

/** Run hidup (urutan = urutan mulai; satu entri per handle). */
const recs: RunRec[] = []
const subscribers = new Set<(runs: DlRun[]) => void>()

/** Run masih punya chapter yang belum selesai (progress card / Batal). */
export function runBusy(run: DlRun): boolean {
  return run.jobs.some((j) => j.state === 'wait' || j.state === 'run')
}

/** Salinan dangkal (array + objek baru) supaya subscriber React re-render. */
function snapshot(runs: readonly RunRec[]): DlRun[] {
  return runs.map((r) => ({
    handle: r.handle,
    seriesTitle: r.seriesTitle,
    startedAt: r.startedAt,
    saved: r.saved,
    jobs: r.jobs.map((j) => ({ ...j })),
  }))
}

function emit(): void {
  const snap = snapshot(recs)
  for (const cb of [...subscribers]) cb(snap)
}

function patchJob(rec: RunRec, index: number, patch: Partial<DlJob>): void {
  const prev = rec.jobs[index]
  if (!prev) return
  const jobs = rec.jobs.slice()
  jobs[index] = { ...prev, ...patch }
  rec.jobs = jobs
  emit()
}

export function getRuns(): DlRun[] {
  return snapshot(recs)
}

/** Daftar pas perubahan; kembalikan fungsi unsubscribe. */
export function subscribeRuns(cb: (runs: DlRun[]) => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function startRun(handle: string, seriesTitle: string, numbers: string[]): void {
  if (numbers.length === 0) return
  // Dedupe: handle yang sudah punya run aktif TIDAK dijalankan dua kali —
  // batch kedua rebut server generate-PDF dan kartu progres jadi membingungkan.
  // Permintaan baru diabaikan; UI mematikan tombol Unduh selama run aktif.
  if (recs.some((r) => r.handle === handle && runBusy(r))) return

  const rec: RunRec = {
    handle,
    seriesTitle,
    startedAt: Date.now(),
    saved: 0,
    ctrl: new AbortController(),
    jobs: numbers.map((number) => ({ number, state: 'wait' as const })),
  }
  // run lama handle yang sama (selesai/dibatalkan) diganti supaya daftar
  // run tidak tumbuh tanpa batas per handle.
  const at = recs.findIndex((r) => r.handle === handle)
  if (at >= 0) recs.splice(at, 1, rec)
  else recs.push(rec)
  emit()

  void downloadChapters(
    numbers.map((number) => ({ handle, number })),
    (index, patch) => patchJob(rec, index, patch),
    rec.ctrl.signal,
    // Q22.A — tiap PDF selesai di-generate langsung di-auto-unduh ke
    // perangkat user (anchor `download` → Content-Disposition attachment).
    // `saveGeneratedPdf` mengembalikan false tanpa DOM (uji node) → `saved`
    // tetap 0 di lingkungan tanpa browser, jadi tidak ada klaim palsu.
    (id, filename) => {
      if (saveGeneratedPdf(id, filename)) {
        rec.saved += 1
        emit()
      }
    },
  ).then(() => {
    // Setelah abort, chapter yang belum mulai / sedang berjalan tidak dipatch
    // oleh downloadChapters (AbortError ditelan). Beri state terminal supaya
    // run berhenti, status akhir tetap jujur: yang sudah 'ok' tetap 'ok'.
    if (!rec.ctrl.signal.aborted) return
    if (!rec.jobs.some((j) => j.state !== 'ok')) return
    rec.jobs = rec.jobs.map((j) =>
      j.state === 'ok' ? j : { ...j, state: 'fail' as const, error: 'Dibatalkan' },
    )
    emit()
  })
}

/** Batalkan sisa chapter milik run handle ini (yang sudah ok tetap ok). */
export function cancelRun(handle: string): void {
  const rec = recs.find((r) => r.handle === handle && runBusy(r))
  if (!rec) return
  rec.ctrl.abort()
}
