import { IconPersonRunning } from '../icons'
import { Row } from './ReaderSettingsSheet'

interface ReaderMarathonActionsProps {
  /**
   * Mode maraton: buang posisi tersimpan sesi ini lalu mulai rantai dari
   * blok pertama. Tanpa ini, membuka maraton selalu melanjutkan posisi
   * terakhir dan pembaca tidak punya jalan kembali ke awal.
   */
  onRestartMarathon?: () => void
}

export default function ReaderMarathonActions({ onRestartMarathon }: ReaderMarathonActionsProps) {
  if (!onRestartMarathon) return null
  return (
    <>
      <div className="mt-3 flex items-center gap-2 px-4">
        <span className="h-px flex-1 bg-ink-800" />
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-500">
          Maraton
        </span>
        <span className="h-px flex-1 bg-ink-800" />
      </div>
      <Row
        icon={<IconPersonRunning className="size-4" />}
        label="Mulai maraton dari awal"
        value="Hapus posisi tersimpan"
        onClick={onRestartMarathon}
      />
    </>
  )
}
