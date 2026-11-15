import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconBolt, IconXmark } from '../icons'
import { Row } from './ReaderSettingsSheet'
import { saveGeneratedPdf } from '../downloadBatch'

interface ReaderDownloadActionsProps {
  /** true = aksi PDF sedang berjalan (disable tombol). */
  exportingPdf?: boolean
  /** true = aksi unduh offline sedang berjalan (disable tombol). */
  downloading?: boolean
  /** Ekspor chapter saat ini sebagai PDF (server-side → tab Unduhan). */
  onExportPdf?: () => void
  /** Simpan chapter saat ini ke cache offline (service worker). */
  onOfflineDownload?: () => void
  /** PDF sudah dibuat di server tapi serah-file ke perangkat gagal — tampilkan blok persisten. */
  pdfResult?: { id: string; filename: string } | null
  /** Bersihkan blok pdfResult (sukses Ambil PDF atau tombol tutup). */
  onPdfResultDismiss?: () => void
}

export default function ReaderDownloadActions({
  exportingPdf,
  downloading,
  onExportPdf,
  onOfflineDownload,
  pdfResult,
  onPdfResultDismiss,
}: ReaderDownloadActionsProps) {
  // Kegagalan retry "Ambil PDF" — teks kecil di blok hasil. Direset saat
  // pdfResult berganti (ekspor baru) supaya pesan basi tidak menempel.
  const [retryFailed, setRetryFailed] = useState(false)
  const [retrying, setRetrying] = useState(false)
  useEffect(() => {
    setRetryFailed(false)
    setRetrying(false)
  }, [pdfResult?.id])

  if (!onExportPdf && !onOfflineDownload && !pdfResult) return null

  const busy = Boolean(downloading || exportingPdf)
  const busyLabel = downloading ? 'Menyimpan chapter untuk baca offline' : exportingPdf ? 'Menyiapkan PDF chapter' : ''

  const handleFetchPdf = async () => {
    if (!pdfResult || retrying) return
    setRetrying(true)
    setRetryFailed(false)
    const ok = await saveGeneratedPdf(pdfResult.id, pdfResult.filename)
    setRetrying(false)
    if (ok) {
      onPdfResultDismiss?.()
    } else {
      setRetryFailed(true)
    }
  }

  return (
    <>
      {/* State sibuk diumumkan via live region — tombol Row hanya mengganti teks,
          tanpa ini screen reader diam saja saat proses berjalan. */}
      {busy && (
        <span role="status" aria-live="polite" className="sr-only">
          {busyLabel}, mohon tunggu
        </span>
      )}
      {/* Section header */}
      <div className="mt-3 flex items-center gap-2 px-4">
        <span className="h-px flex-1 bg-ink-800" />
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-500">Unduhan</span>
        <span className="h-px flex-1 bg-ink-800" />
      </div>

      {/* Offline — PRIMARY (aksi utama, tampil pertama + helper) */}
      {onOfflineDownload && (
        <Row
          icon={<IconBolt className="size-4 text-brand-amber-soft" />}
          label={downloading ? 'Menyimpan…' : 'Unduh Offline'}
          value={downloading ? 'Mohon tunggu' : 'Baca tanpa internet'}
          disabled={downloading}
          onClick={onOfflineDownload}
        />
      )}

      {/* PDF — SECONDARY (aksi alternatif, helper lebih netral) */}
      {onExportPdf && (
        <Row
          icon={<IconBolt className="size-4" />}
          label={exportingPdf ? 'Menyiapkan…' : 'Ekspor PDF'}
          value={exportingPdf ? 'Mohon tunggu' : 'File diunduh'}
          disabled={exportingPdf}
          onClick={onExportPdf}
        />
      )}

      {/* Hasil ekspor yang serah-filenya gagal — blok persisten sampai sukses/ditutup */}
      {pdfResult && (
        <div className="mx-4 mb-2 rounded-xl border border-ink-800 bg-ink-900 px-3 py-2">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[11.5px] text-ink-300">
              PDF siap · {pdfResult.filename}
            </p>
            <button
              type="button"
              onClick={onPdfResultDismiss}
              aria-label="Tutup pemberitahuan PDF"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-500 active:bg-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
            >
              <IconXmark className="size-3.5" />
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={handleFetchPdf}
              disabled={retrying}
              className="min-h-9 rounded-lg border border-brand-amber/40 bg-brand-amber/10 px-3 text-[11.5px] font-semibold text-brand-amber-soft active:scale-[0.97] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
            >
              {retrying ? 'Mengambil…' : 'Ambil PDF'}
            </button>
            <Link
              to="/rak?tab=unduhan"
              className="min-h-9 rounded-lg px-3 py-2 text-[11.5px] font-semibold text-ink-300 active:bg-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
            >
              Lihat di Rak
            </Link>
          </div>
          {retryFailed && (
            <p className="mt-1 text-[10.5px] text-red-400">Masih gagal — coba nanti dari Rak</p>
          )}
        </div>
      )}
    </>
  )
}
