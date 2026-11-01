import { IconBolt } from '../icons'
import { Row } from './ReaderSettingsSheet'

interface ReaderDownloadActionsProps {
  /** true = aksi PDF sedang berjalan (disable tombol). */
  exportingPdf?: boolean
  /** true = aksi unduh offline sedang berjalan (disable tombol). */
  downloading?: boolean
  /** Ekspor chapter saat ini sebagai PDF (server-side → tab Unduhan). */
  onExportPdf?: () => void
  /** Simpan chapter saat ini ke cache offline (service worker). */
  onOfflineDownload?: () => void
}

export default function ReaderDownloadActions({
  exportingPdf,
  downloading,
  onExportPdf,
  onOfflineDownload,
}: ReaderDownloadActionsProps) {
  if (!onExportPdf && !onOfflineDownload) return null
  return (
    <>
      <div className="mt-3 flex items-center gap-2 px-4">
        <span className="h-px flex-1 bg-ink-800" />
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-500">
          Unduhan
        </span>
        <span className="h-px flex-1 bg-ink-800" />
      </div>
      {onExportPdf && (
        <Row
          icon={<IconBolt className="size-4" />}
          label={exportingPdf ? 'Membuat PDF…' : 'Ekspor PDF'}
          value={exportingPdf ? 'Mohon tunggu' : undefined}
          disabled={exportingPdf}
          onClick={onExportPdf}
        />
      )}
      {onOfflineDownload && (
        <Row
          icon={<IconBolt className="size-4" />}
          label={downloading ? 'Mengunduh offline…' : 'Simpan untuk dibaca offline'}
          value={downloading ? 'Mohon tunggu' : undefined}
          disabled={downloading}
          onClick={onOfflineDownload}
        />
      )}
    </>
  )
}
