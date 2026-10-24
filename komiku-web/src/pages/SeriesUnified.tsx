import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { imgUrl } from '../imgUrl'
import { unifiedApi } from '../api'
import type { MangaOut, UnifiedChapterOut } from '../types'
import { Empty, Spinner } from '../App'
import SourceBadge from '../components/SourceBadge'
import HeartButton from '../components/HeartButton'
import { useProgress } from '../hooks/useProgress'
import { useReadMarks } from '../hooks/useReadMarks'
import { rememberSeriesLite, readerHref } from '../readerSource'
import {
  cancelRun,
  getRuns,
  runBusy,
  startRunCache,
  subscribeRuns,
  type DlRun,
} from '../downloadStore'
import { RangeSelectBar, useRangeSelection } from '../components/DownloadRangePicker'

/**
 * Detail manga unified (route /manga/:handle, handle 'sumber:native_id').
 * UI sengaja mengikuti Series.tsx lama supaya user tidak merasa "pindah
 * aplikasi"; sumber hanya tampil sebagai badge halus.
 */
export default function SeriesUnified() {
  const { handle = '' } = useParams<{ handle: string }>()
  const [data, setData] = useState<{
    manga: MangaOut
    chapters: UnifiedChapterOut[]
    representative_source: string | null
  } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const { recent } = useProgress()
  // --- unduh PDF mode range (2-tap Awal/Akhir) ------------------------------
  const [pickMode, setPickMode] = useState(false)
  const [dlMsg, setDlMsg] = useState<string | null>(null)
  /**
   * Run unduhan milik halaman ini (dari store module-level — hidup lintas
   * halaman). `dlBusy` masih dipakai UI (mode seleksi, tombol Batal) walau
   * state jobs tidak lagi tinggal di komponen.
   */
  const [dlRun, setDlRun] = useState<DlRun | null>(null)
  const dlBusy = dlRun != null && runBusy(dlRun)
  /**
   * true selama komponen ter-pasang. Unduhan SENGAJA tidak di-abort saat
   * unmount (navigasi ke reader): batch jalan di store-nya sendiri dan
   * hasilnya tetap masuk store server + muncul di Rak. State setelah
   * unmount adalah no-op di React 18, jadi aman.
   */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const range = useRangeSelection()
  const navigate = useNavigate()
  /** true selama instance ini melihat run busy → boleh umumkan hasilnya. */
  const watchingRef = useRef(false)

  // Subscribe run unduhan handle ini (store module-level → progres tetap
  // hidup & terlihat walau user pindah halaman; Rak subscribe lewat lane
  // D2). Sinkron awal penting: user kembali ke series saat run masih jalan
  // langsung melihat kartu progresnya.
  useEffect(() => {
    const sync = (runs: DlRun[]) => {
      const run = runs.find((r) => r.handle === handle) ?? null
      setDlRun(run)
      if (run && runBusy(run)) {
        watchingRef.current = true
        return
      }
      // transisi busy → selesai (atau batal) hanya diumumkan oleh instance
      // yang benar-benar menyaksikan run berjalan — bukan oleh kunjungan
      // baru ke halaman yang menemukan run sudah selesai.
      if (!run || !watchingRef.current) return
      watchingRef.current = false
      announceFinish(run, { mountedRef, setDlMsg })
    }
    const unsub = subscribeRuns(sync)
    sync(getRuns())
    return unsub
  }, [handle, navigate])

  // Sticky B+C — server coba sumber terakhir-dibaca untuk judul ini dulu
  // (kalau ada di riwayat), baru fallback primary. Ref supaya effect tidak
  // re-fetch setiap kali riwayat bertambah.
  const lastSourceRef = useRef<string | undefined>(undefined)
  lastSourceRef.current = recent.find((r) => String(r.seriesId) === handle)?.source ?? undefined

  useEffect(() => {
    if (!handle) return
    const ctrl = new AbortController()
    setData(null)
    setError(null)
    setShowAll(false)
    setPickMode(false)
    unifiedApi
      .series(handle, ctrl.signal, lastSourceRef.current)
      .then((r) =>
        setData({
          manga: r.manga,
          chapters: r.chapters ?? [],
          representative_source: r.representative_source ?? null,
        }),
      )
      .catch((e: Error) => e.name !== 'AbortError' && setError(e.message))
    return () => ctrl.abort()
  }, [handle])

  // urut nomor DESC (terbaru dulu). Nomor bisa "1195", "1.5", "extra-9" —
  // bandingkan numerik kalau bisa, jatuh ke string supaya tidak pernah NaN.
  const chapters = useMemo(
    () =>
      [...(data?.chapters ?? [])].sort((a, b) => {
        const na = Number(a.number)
        const nb = Number(b.number)
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na
        return b.number.localeCompare(b.number)
      }),
    [data],
  )
  const oldest = chapters.length > 0 ? chapters[chapters.length - 1] : null
  // Mark "sudah dibaca" per akun: chapter yang pernah dibuka user jadi abu.
  // Kunci = title_key series + nomor chapter (lihat readMarks.ts).
  const titleKey = data?.manga.title_key ?? null
  const { isRead, count: readTotal } = useReadMarks(titleKey)
  // entry riwayat memakai seriesId = handle (ditetapkan Reader unified)
  const resume = recent.find((r) => String(r.seriesId) === handle)
  // Kunci chapter terakhir dibaca: `<handle>:<nomor>` (bentuk yang ditulis
  // Reader unified). Hanya dipakai kalau entri benar-benar milik series ini —
  // id numerik komiku lama tidak cocok route `/baca/<handle>/<number>`.
  const resumeKey =
    resume && String(resume.chapterId).startsWith(`${handle}:`)
      ? String(resume.chapterId)
      : null

  // Range mengikuti URUTAN TAMPIL, dan `visible` selalu potongan awal `chapters`
  // → index baris aman dipakai walau daftar dipotong 40.
  const selectedRefs = useMemo(
    () =>
      range.indices
        .map((i) => chapters[i])
        .filter((c): c is UnifiedChapterOut => c !== undefined)
        .map((c) => ({ handle, number: c.number })),
    [range.indices, handle, chapters],
  )
  const resetRange = range.reset

  /** Tap di luar daftar chapter (dan bukan tombol "Unduh") → tutup mode seleksi. */
  useEffect(() => {
    // Saat mengunduh, mode dibiarkan terbuka supaya progres per chapter terlihat.
    if (!pickMode || dlBusy) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('[data-range-toggle], section[data-series-list]')) return
      setPickMode(false)
      resetRange()
    }
    document.addEventListener('pointerdown', onDown as EventListener)
    return () => document.removeEventListener('pointerdown', onDown as EventListener)
  }, [pickMode, dlBusy, resetRange])

  const downloadSelected = () => {
    if (dlBusy || selectedRefs.length === 0) return
    // LANGSUNG keluar dari mode pilih: baris chapter kembali jadi Link ke
    // reader dan tombol Unduh tak lagi tertekan. Unduhan jalan di store
    // (lintas halaman) — hanya tombol Batal yang membatalkan, jadi user
    // bebas navigasi.
    setPickMode(false)
    setDlMsg(null)
    range.reset()
    startRunCache(handle, data?.manga.title ?? '', selectedRefs.map((r) => r.number))
  }

  // Catatan: TIDAK ada abort saat unmount — store yang memegang run
  // (lihat downloadStore), navigasi ke chapter lain / halaman lain bukan
  // pembatalan. Yang membatalkan hanya tombol "Batal" (cancelRun).

  if (error) return <Empty title="Gagal memuat manga" body={error} />
  if (!data) return <Spinner label="Memuat manga…" />

  const { manga: m } = data
  // reader nanti butuh judul + title_key ini untuk toolbar dan rak (sejarah/
  // favorit) — isi cache sekarang supaya halaman baca tidak perlu fetch series
  // lagi (hemat satu request/chapter).
  rememberSeriesLite(handle, {
    title: m.title,
    title_key: m.title_key,
    cover_url: m.cover_url ?? null,
  })
  const visible = showAll ? chapters : chapters.slice(0, 40)
  // progres dari run store: yang sudah berstatus terminal (ok/fail)
  const dlDone = dlRun
    ? dlRun.jobs.filter((j) => j.state === 'ok' || j.state === 'fail').length
    : 0
  const dlFail = dlRun ? dlRun.jobs.filter((j) => j.state === 'fail').length : 0

  const chapterLabel = (c: UnifiedChapterOut) => c.title || `Chapter ${c.number}`

  return (
    <div className="mx-auto max-w-3xl">
      {/* Hero sampul */}
      <div className="relative">
        {m.cover_url && (
          <div className="absolute inset-0 h-56 overflow-hidden">
            <img src={imgUrl(m.cover_url)} alt="" className="size-full object-cover opacity-25 blur-md" />
            <div className="absolute inset-0 bg-gradient-to-b from-ink-950/60 to-ink-950" />
          </div>
        )}

        <div className="relative px-4 pb-4 pt-5">
          <Link to="/" className="text-[12px] font-medium text-ink-400 hover:text-ink-200">
            ← Beranda
          </Link>

          <div className="mt-3 flex gap-4">
            <div className="w-28 shrink-0 sm:w-32">
              <div className="aspect-[3/4] overflow-hidden rounded-xl border border-ink-700 bg-ink-850 shadow-lg">
                {m.cover_url ? (
                  <img src={imgUrl(m.cover_url)} alt={m.title} className="size-full object-cover" />
                ) : (
                  <span className="grid size-full place-items-center p-2 text-center text-[11px] text-ink-500">
                    {m.title}
                  </span>
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-1.5">
                <h1 className="text-lg font-bold leading-tight text-ink-100">{m.title}</h1>
                {/* badge sumber — selalu tampil di detail (bukan cuma di kartu) */}
                <SourceBadge source={m.source} className="mt-1 shrink-0" />
              </div>

              <dl className="mt-2.5 space-y-1 text-[12px]">
                {m.author && (
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-500">Penulis</dt>
                    <dd className="min-w-0 flex-1 truncate text-ink-200">{m.author}</dd>
                  </div>
                )}
                {m.status && (
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-500">Status</dt>
                    <dd className="min-w-0 flex-1 truncate text-ink-200">{m.status}</dd>
                  </div>
                )}
                {m.manga_type && (
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-500">Tipe</dt>
                    <dd className="min-w-0 flex-1 truncate text-ink-200">{m.manga_type}</dd>
                  </div>
                )}
                {hasScore(m.rating) && (
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-ink-500">Skor</dt>
                    <dd className="min-w-0 flex-1 truncate text-ink-200">★ {m.rating}</dd>
                  </div>
                )}
              </dl>

              {data.representative_source && (
                <p className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-400">
                  Terbaru dari {data.representative_source}
                </p>
              )}

              {m.updated_at != null && (
                <p className="mt-1.5 text-[11px] text-ink-500">
                  Update {new Date(m.updated_at).toLocaleDateString('id-ID')}
                </p>
              )}

              {m.url && (
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2.5 inline-block text-[11.5px] font-semibold text-brand-amber"
                >
                  Buka halaman asli ↗
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tombol baca / maraton */}
      <div className="sticky top-14 z-30 border-y border-ink-800 bg-ink-950/95 px-4 py-2.5 backdrop-blur">
        <div className="flex gap-2">
          {oldest && (
            <>
              <Link
                to={resumeKey ? readerHref(resumeKey) : `/baca/${handle}/${oldest.number}`}
                className="flex-1 rounded-xl bg-brand-amber py-2.5 text-center text-[13px] font-bold text-ink-950 transition-colors hover:bg-brand-amber-soft"
              >
                {resumeKey ? `Lanjut · ${resume?.chapterName}` : `Baca ${chapterLabel(oldest)}`}
              </Link>
              <Link
                to={`/maraton/${handle}/${oldest.number}`}
                title={`Mulai maraton dari ${chapterLabel(oldest)}`}
                className="rounded-xl border border-brand-amber-dim px-3.5 py-2.5 text-center text-[13px] font-semibold text-brand-amber transition-colors hover:bg-brand-amber-dim/20"
              >
                Maraton
              </Link>
              {/* unduh PDF: aktifkan mode range 2-tap (Awal/Akhir) pada daftar chapter */}
              {chapters.length > 0 && (
                <button
                  type="button"
                  data-range-toggle
                  aria-pressed={pickMode}
                  aria-label={pickMode ? 'Tutup mode pilih chapter' : 'Unduh chapter'}
                  onClick={() => {
                    if (pickMode) range.reset()
                    setPickMode(!pickMode)
                  }}
                  className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2.5 text-center text-[13px] font-semibold transition-colors ${
                    pickMode
                      ? 'border-brand-amber bg-brand-amber/15 text-brand-amber'
                      : 'border-brand-amber-dim text-brand-amber hover:bg-brand-amber-dim/20'
                  }`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                    className="size-4"
                  >
                    <path d="M12 4v11m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M5 20h14" strokeLinecap="round" />
                  </svg>
                  Unduh
                </button>
              )}
              {/* favorit: tombol berlabel di sebelah CTA baca (discoverability HP) */}
              {m.title_key && (
                <HeartButton
                  labeled
                  manga={{
                    title_key: m.title_key,
                    title: m.title,
                    cover_url: m.cover_url ?? null,
                    handle,
                    source: m.source,
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Daftar chapter */}
      <section className="px-4 pb-6" data-series-list>
        <h2 className="mb-2 text-[13px] font-semibold text-ink-100">
          Chapter <span className="text-ink-500">({chapters.length})</span>
          {readTotal > 0 && (
            <span className="ml-1.5 font-normal text-ink-500">
              · {readTotal} sudah dibaca
            </span>
          )}
        </h2>

        {/* Mode seleksi range (2-tap Awal/Akhir) → POST /unified/download-pdf.
            Info seleksi + baris progres mengisi ulang tempat UI centang lama. */}
        {!pickMode && dlMsg && <p className="mb-3 text-[11px] text-ink-400">{dlMsg}</p>}
        {/* Ringkasan compact: judul, rentang chapter, n/M, bar progres,
            tombol Batal. SENGAJA di LUAR blok pickMode — setelah "Unduh"
            diklik mode pilih keluar (baris kembali Link), tapi kartu progres
            + tombol Batal harus tetap terlihat sampai batch selesai.
            Tanpa daftar per chapter (server generate PDF bisa 30+ baris →
            user tak bisa lihat apa-apa). */}
        {dlBusy && dlRun && (
          <div className="mb-3 rounded-xl border border-ink-800 bg-ink-900 p-3">
            <div className="rounded-xl border border-ink-800/60 bg-ink-950/60 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] font-semibold text-ink-100">Mengunduh</p>
                <p className="text-[11px] text-ink-400">
                  {dlDone}/{dlRun.jobs.length} chapter
                </p>
              </div>
              <p className="mt-0.5 truncate text-[11.5px] text-ink-300">
                Chapter {rangeLabel(dlRun.jobs)}
              </p>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
                <div
                  className="h-full rounded-full bg-brand-amber transition-[width]"
                  style={{
                    width: `${dlRun.jobs.length === 0 ? 0 : Math.round((dlDone / dlRun.jobs.length) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-ink-500">
                Berjalan di latar belakang — boleh buka chapter lain.
              </p>
              {dlFail > 0 && <p className="mt-1 text-[11px] text-brand-red">{dlFail} gagal</p>}
              <button
                type="button"
                onClick={() => cancelRun(handle)}
                className="mt-2 w-full rounded-lg border border-ink-700 py-1.5 text-[11.5px] font-semibold text-ink-300 transition-colors hover:border-brand-red/60 hover:text-brand-red"
              >
                Batal
              </button>
            </div>
          </div>
        )}
        {pickMode && chapters.length > 0 && (
          <div className="mb-3">
            <RangeSelectBar
              count={selectedRefs.length}
              clamped={range.clamped}
              needEnd={range.needEnd}
              busy={dlBusy}
              onDownload={downloadSelected}
            />
          </div>
        )}

        {chapters.length === 0 ? (
          <p className="text-[12.5px] text-ink-500">Belum ada chapter.</p>
        ) : (
          <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
            {visible.map((c, i) => {
              // Mode seleksi: tap baris bikin anchor Awal lalu Akhir — tanpa centang 1-1.
              const anchor = pickMode ? range.isAnchor(i) : null
              // Chapter yang sudah pernah dibuka user → judul jadi abu (redup),
              // penanda tak hilang lewat aria-label "sudah dibaca".
              const read = isRead(c.number)
              const titleCls = read
                ? 'min-w-0 flex-1 truncate text-[13px] font-medium text-ink-500'
                : 'min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-100'
              return (
                <li
                  key={c.native_id}
                  className={`flex items-center ${
                    anchor
                      ? 'border border-brand-amber bg-brand-amber/10'
                      : pickMode && range.inRange(i)
                        ? 'bg-brand-amber/5'
                        : ''
                  }`}
                >
                  {pickMode ? (
                    <button
                      type="button"
                      aria-pressed={anchor !== null}
                      aria-label={
                        anchor
                          ? `Anchor ${anchor} chapter ${c.number}`
                          : `Pilih chapter ${c.number}`
                      }
                      onClick={() => range.select(i)}
                      className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors hover:bg-ink-850 active:bg-ink-850"
                    >
                      <span className={titleCls}>{chapterLabel(c)}</span>
                      {anchor && (
                        <span className="shrink-0 rounded-md bg-brand-amber px-1.5 py-0.5 text-[10px] font-bold text-ink-950">
                          {anchor}
                        </span>
                      )}
                      <span className="shrink-0 text-[10.5px] font-medium text-ink-500">
                        {chapterDate(c)}
                      </span>
                    </button>
                  ) : (
                    <Link
                      to={readerHref(`${handle}:${c.number}`)}
                      aria-label={
                        read
                          ? `${chapterLabel(c)} — sudah dibaca`
                          : `${chapterLabel(c)} — belum dibaca`
                      }
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 py-3 pr-3.5 transition-colors hover:bg-ink-850 active:bg-ink-850"
                    >
                      <span className={titleCls}>{chapterLabel(c)}</span>
                      <span className="shrink-0 text-[10.5px] font-medium text-ink-500">
                        {chapterDate(c)}
                      </span>
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {chapters.length > 40 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 w-full rounded-xl border border-ink-700 py-2.5 text-[13px] font-medium text-ink-300"
          >
            {showAll ? 'Tampilkan lebih sedikit' : `Tampilkan semua ${chapters.length} chapter`}
          </button>
        )}
      </section>
    </div>
  )
}

/**
 * Umumkan hasil run yang baru selesai: pesan di halaman + navigate ke tab
 * Unduhan (kontrak `location.state.flash` yang dibaca Rak). Hanya dipanggil
 * saat instance ini MENYAKSIKAN transisi busy → selesai; kalau user sudah
 * pindah halaman (unmounted), Rak yang menampilkan progresnya.
 */
function announceFinish(
  run: DlRun,
  {
    mountedRef,
    setDlMsg,
  }: {
    mountedRef: { current: boolean }
    setDlMsg: (msg: string | null) => void
  },
): void {
  const ok = run.jobs.filter((j) => j.state === 'ok').length
  const fail = run.jobs.filter((j) => j.state === 'fail').length
  const cancelled = run.jobs.some((j) => j.error === 'Dibatalkan')
  if (!mountedRef.current) return
  if (cancelled) {
    // sisa chapter dilewati store — bukan kegagalan unduhan
    setDlMsg('Unduhan dibatalkan')
    return
  }
  const msg =
    fail > 0
      ? `${ok} tersimpan, ${fail} gagal`
      : `${ok} chapter tersimpan offline`
  setDlMsg(msg)
}

/**
 * Label rentang untuk kartu ringkasan: "3–12" (1 chapter: "3").
 * Urutan tampil DESC (terbaru dulu), jadi angka diurutkan naik secara
 * numerik kalau bisa; nomor non-numerik jatuh ke urutan list apa adanya.
 */
function rangeLabel(list: readonly { number: string }[]): string {
  const first = list[0]?.number ?? ''
  const last = list[list.length - 1]?.number ?? ''
  if (list.length <= 1) return first
  const na = Number(first)
  const nb = Number(last)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
    return na < nb ? `${first}–${last}` : `${last}–${first}`
  }
  return `${first}–${last}`
}

/** Placeholder tanggal kalau sumber tidak mengirim tanggal chapter. */
export const DATE_PLACEHOLDER = '—'

/**
 * Skor layak tampil? Server memakai "-" untuk "tanpa skor" (lihat api.ts),
 * dan sebagian sumber mengirim "0"/kosong — semuanya disembunyikan supaya
 * baris "Skor ★ 0" tidak muncul.
 */
export function hasScore(rating: string | null | undefined): boolean {
  if (rating == null) return false
  const s = String(rating).trim()
  if (!/\d/.test(s)) return false // '', '-', 'N/A' → tanpa skor
  const n = Number(s.replace(',', '.'))
  return !(Number.isFinite(n) && n === 0)
}

/**
 * Tanggal chapter untuk daftar: "12 Okt 2026" — atau placeholder "—" kalau
 * `updated_at` null/kosong/tidak valid, supaya baris tidak tampak pincang.
 */
export function chapterDate(c: { updated_at: number | null }): string {
  const t = c.updated_at
  if (t == null || !Number.isFinite(t)) return DATE_PLACEHOLDER
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return DATE_PLACEHOLDER
  return d.toLocaleDateString('id-ID')
}
