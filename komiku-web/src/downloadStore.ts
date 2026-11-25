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

import { cacheChapters, downloadChapters, saveGeneratedPdf } from './downloadBatch'
import { markDownloadDone } from './downloadHistory'

export interface DlJob {
  number: string
  state: 'wait' | 'run' | 'ok' | 'fail'
  error?: string
}

export interface DlRun {
  /** 'sumber:native_id' (unified) atau 'komiku:<id>' (legacy). */
  handle: string
  seriesTitle: string
  /**
   * Jenis unduhan: 'pdf' = generate PDF server + auto-unduh ke perangkat;
   * 'cache' = simpan byte gambar ke Cache Storage (offline reader).
   * Dipakai UI supaya pesan akhir tidak menyebut "tersimpan offline" untuk
   * batch PDF yang gagal, dan sebaliknya.
   */
  mode: 'pdf' | 'cache'
  jobs: DlJob[]
  startedAt: number
  /**
   * epoch ms progres TERAKHIR (job mulai/terminal, saved/saveFailed berubah,
   * atau progress/bytes job). Diinisialisasi = startedAt; di-update di dalam
   * fungsi update store (patchJob / auto-unduh PDF / finalisasi abort), bukan
   * di pemanggil. Basis `isRunStale` — run yang masih membuat progres tidak
   * dianggap macet walau umurnya > 15 menit.
   *
   * Record lama tanpa field ini (belum ada persist layer saat ini — store
   * murni module singleton) diperlakukan sebagai startedAt oleh isRunStale.
   */
  lastProgressAt: number
  /**
   * Q22.A — jumlah PDF yang sudah otomatis dikirim ke perangkat user
   * (auto-trigger simpan setelah generate). Dipakai UI untuk melaporkan
   * jujur berapa file benar-benar tersimpan, terpisah dari berapa chapter
   * berhasil di-generate di server.
   */
  saved: number
  /**
   * Q22.A — jumlah PDF yang generate-nya OK di server tapi GAGAL di-auto-unduh
   * ke perangkat user (mis. no DOM / ditolak browser). Terpisah dari `saved`
   * supaya UI bisa lapor jujur: file ada di server, belum tentu ada di perangkat.
   */
  saveFailed: number
}

interface RunRec extends DlRun {
  ctrl: AbortController
}

/** Run hidup (urutan = urutan mulai; satu entri per handle). */
const recs: RunRec[] = []
/**
 * Subscriber disimpan KUAT: React membersihkan lewat `unsubscribe` dari cleanup
 * useEffect. (Jangan WeakRef di sini — referensi lemah bisa dibuang saat run
 * masih jalan, subscriber diam-diam hilang, dan kartu progres berhenti update
 * padahal run masih berjalan.)
 * Pemanggil yang lupa unsubscribe tetap mempertahankan closure — itu bug
 * pemanggil yang harus dilaporkan, bukan ditutupi auto-GC.
 */
const subscribers = new Set<(runs: DlRun[]) => void>()

/** Run masih punya chapter yang belum selesai (progress card / Batal). */
export function runBusy(run: DlRun): boolean {
  return run.jobs.some((j) => j.state === 'wait' || j.state === 'run')
}

/**
 * Hitung jumlah job per state — dipakai kartu progres supaya keempat state
 * (wait/run/ok/fail) terlihat beda, bukan satu bar tanpa makna.
 */
export interface JobTally {
  wait: number
  run: number
  ok: number
  fail: number
}

export function jobTally(run: DlRun): JobTally {
  const t: JobTally = { wait: 0, run: 0, ok: 0, fail: 0 }
  for (const j of run.jobs) t[j.state] += 1
  return t
}

/**
 * SATU definisi progres terminal — dipakai progressPct di sini dan harus
 * dipakai konsumen lain (Rak, ringkasan series) supaya angka "selesai" tidak
 * berbeda-beda:
 *   selesai = jobs ok+fail, ok = jobs ok, fail = jobs fail.
 * Pembatalan ('Dibatalkan') TETAP dihitung fail di sini — itu penanda abort,
 * bukan kegagalan, tapi tetap terminal untuk keperluan progres.
 */
export interface RunProgress {
  selesai: number
  ok: number
  fail: number
}

export function runProgress(
  run: { readonly jobs: readonly { readonly state: 'wait' | 'run' | 'ok' | 'fail' }[] },
): RunProgress {
  let ok = 0
  let fail = 0
  for (const j of run.jobs) {
    if (j.state === 'ok') ok += 1
    else if (j.state === 'fail') fail += 1
  }
  return { selesai: ok + fail, ok, fail }
}

/** Persentase job terminal (ok+fail) — pembagi 0 dihindari. */
export function progressPct(run: DlRun): number {
  if (run.jobs.length === 0) return 0
  return Math.round((runProgress(run).selesai / run.jobs.length) * 100)
}

/** Batas umur run tanpa hasil sebelum dianggap "lambat" / "macet". */
export const SLOW_RUN_MS = 30 * 1000
/** Umur maksimal wajar run sibuk — lebih dari ini, fetch kemungkinan menggantung. */
export const STALE_RUN_MS = 15 * 60 * 1000

/** Bentuk minimal run yang perlu tahu progres — kompatibel dengan `DlRun`. */
export type RunAgeSource = {
  readonly startedAt: number
  /** Absen (record lama) → diperlakukan sebagai startedAt. */
  readonly lastProgressAt?: number
  readonly jobs: readonly { readonly state: 'wait' | 'run' | 'ok' | 'fail' }[]
}

/** Run sibuk yang belum ada satu pun job selesai selama ≥ SLOW_RUN_MS. */
export function isRunSlow(run: RunAgeSource, now: number = Date.now()): boolean {
  return (
    now - run.startedAt >= SLOW_RUN_MS &&
    run.jobs.length > 0 &&
    run.jobs.every((j) => j.state === 'wait' || j.state === 'run')
  )
}

/**
 * Run sibuk tanpa progres (job/saved/saveFailed) selama ≥ STALE_RUN_MS sejak
 * `lastProgressAt` — kemungkinan macet (fetch menggantung). Run terminal → false.
 * Record tanpa lastProgressAt → fallback ke startedAt.
 */
export function isRunStale(run: RunAgeSource, now: number = Date.now()): boolean {
  const last = run.lastProgressAt ?? run.startedAt
  return (
    now - last >= STALE_RUN_MS &&
    run.jobs.some((j) => j.state === 'wait' || j.state === 'run')
  )
}

/** Salinan dangkal (array + objek baru) supaya subscriber React re-render. */
function snapshot(runs: readonly RunRec[]): DlRun[] {
  return runs.map((r) => ({
    handle: r.handle,
    seriesTitle: r.seriesTitle,
    mode: r.mode,
    startedAt: r.startedAt,
    lastProgressAt: r.lastProgressAt,
    saved: r.saved,
    saveFailed: r.saveFailed,
    jobs: r.jobs.map((j) => ({ ...j })),
  }))
}

function emit(): void {
  const snap = snapshot(recs)
  for (const cb of [...subscribers]) {
    try {
      cb(snap)
    } catch {
      // Satu subscriber yang melempar jangan memutus subscriber lain.
    }
  }
}

function patchJob(rec: RunRec, index: number, patch: Partial<DlJob>): void {
  const prev = rec.jobs[index]
  if (!prev) return
  const jobs = rec.jobs.slice()
  jobs[index] = { ...prev, ...patch }
  rec.jobs = jobs
  rec.lastProgressAt = Date.now()
  // Ledger chapter selesai — tahan tab ditutup (kehilangan progres sebelumnya
  // terjadi diam-diam saat batch berhenti di tengah jalan).
  if (patch.state === 'ok' && prev.state !== 'ok') {
    markDownloadDone(rec.handle, [rec.jobs[index].number])
  }
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
    mode: 'pdf',
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    saved: 0,
    saveFailed: 0,
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
    // Kegagalan auto-unduh dicatat di `saveFailed` supaya UI bisa lapor jujur.
    async (id, filename) => {
      if (await saveGeneratedPdf(id, filename, { signal: rec.ctrl.signal })) {
        rec.saved += 1
      } else {
        rec.saveFailed += 1
      }
      rec.lastProgressAt = Date.now()
      // Selalu emit — sukses maupun gagal auto-unduh harus re-render UI,
      // kalau tidak user tidak pernah tahu PDF-nya parkir di server saja.
      emit()
    },
  ).then(() => {
    // Setelah abort, chapter yang belum mulai / sedang berjalan tidak dipatch
    // oleh downloadChapters (AbortError ditelan). Beri state terminal supaya
    // run berhenti, status akhir tetap jujur: yang sudah 'ok' tetap 'ok'.
    if (!rec.ctrl.signal.aborted) return
    if (!rec.jobs.some((j) => j.state !== 'ok')) return
    rec.jobs = rec.jobs.map((j) =>
      // Hanya job yang masih menunggu/berjalan yang ditandai dibatalkan;
      // job yang sudah 'fail' (mis. HTTP 503) mempertahankan error aslinya
      // supaya retryRun tetap bisa mengulangnya.
      j.state === 'ok' || j.state === 'fail'
        ? j
        : { ...j, state: 'fail' as const, error: 'Dibatalkan' },
    )
    rec.lastProgressAt = Date.now()
    emit()
  })
}

/**
 * Uji ulang chapter gagal milik run handle ini: yang berstatus fail tapi
 * bukan "Dibatalkan" di-start ulang dengan mode run itu (pdf/cache).
 *
 * No-op kalau run masih busy atau tidak ada yang bisa diulang — dipakai
 * tombol "Coba lagi" di kartu ringkasan.
 */
export function retryRun(handle: string): void {
  const prev = recs.find((r) => r.handle === handle)
  if (!prev || runBusy(prev)) return
  const failed = prev.jobs
    .filter((j) => j.state === 'fail' && j.error !== 'Dibatalkan')
    .map((j) => j.number)
  if (failed.length === 0) return
  if (prev.mode === 'cache') startRunCache(handle, prev.seriesTitle, failed)
  else startRun(handle, prev.seriesTitle, failed)
}

/** Batalkan sisa chapter milik run handle ini (yang sudah ok tetap ok). */
export function cancelRun(handle: string): void {
  const rec = recs.find((r) => r.handle === handle && runBusy(r))
  if (!rec) return
  rec.ctrl.abort()
}

/**
 * Mulai run unduhan KE CACHE OFFLINE (mode baru). Sama `startRun` dalam hal
 * run/progres/batal, tapi tiap chapter di-cache ke browser (service worker)
 * alih-alih di-generate jadi PDF di server.
 */
export function startRunCache(handle: string, seriesTitle: string, numbers: string[]): void {
  if (numbers.length === 0) return
  if (recs.some((r) => r.handle === handle && runBusy(r))) return

  const rec: RunRec = {
    handle,
    seriesTitle,
    mode: 'cache',
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    saved: 0,
    saveFailed: 0,
    ctrl: new AbortController(),
    jobs: numbers.map((number) => ({ number, state: 'wait' as const })),
  }
  const at = recs.findIndex((r) => r.handle === handle)
  if (at >= 0) recs.splice(at, 1, rec)
  else recs.push(rec)
  emit()

  void cacheChapters(
    numbers.map((number) => ({ handle, number })),
    (index, patch) => patchJob(rec, index, patch),
    rec.ctrl.signal,
  ).then(() => {
    if (!rec.ctrl.signal.aborted) return
    if (!rec.jobs.some((j) => j.state !== 'ok')) return
    rec.jobs = rec.jobs.map((j) =>
      // Hanya job yang masih menunggu/berjalan yang ditandai dibatalkan;
      // job yang sudah 'fail' (mis. HTTP 503) mempertahankan error aslinya
      // supaya retryRun tetap bisa mengulangnya.
      j.state === 'ok' || j.state === 'fail'
        ? j
        : { ...j, state: 'fail' as const, error: 'Dibatalkan' },
    )
    rec.lastProgressAt = Date.now()
    emit()
  })

  // Hangatkan chunk rute baca yang lazy (Reader & ReaderMarathon) lewat service
  // worker. Kalau user mengunduh dari halaman Series lalu langsung offline
  // SEBELUM pernah membuka reader/maraton, chunk-nya belum ada di cache SW →
  // navigasi offline gagal dgn "Failed to fetch dynamically imported module".
  void import('./pages/Reader')
  void import('./pages/ReaderMarathon')
}
