/**
 * Satu baris jujur tentang sumber yang tidak tersedia.
 *
 * Kenapa ada: server sudah lama mengirim `failed_sources`, tapi UI hampir tidak
 * pernah menampilkannya. Akibatnya saat kiryuu mati, user melihat daftar yang
 * lebih tipis dan menyimpulkan aplikasinya kurang lengkap — padahal sumbernya
 * yang tidak bisa diakses.
 *
 * Aturan yang disengaja:
 * - `failed` DAN `pending` kosong -> `null`. Jangan makan ruang saat sehat.
 * - Sebut NAMA sumber, bukan "2/4". Angka tidak memberi tahu apa yang hilang.
 * - Tombol coba lagi hanya dirender kalau `onRetry` diberikan, supaya tidak
 *   pernah ada tombol mati.
 */

const LABEL: Record<string, string> = {
  komiku: 'Komiku',
  kiryuu: 'Kiryuu',
  mangaku: 'Mangaku',
  shinigami: 'Shinigami',
}

/** `kiryuu` -> `Kiryuu`; id yang tidak dikenal tetap dibaca manusia. */
function label(id: string): string {
  return LABEL[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

/** "A", "A dan B", "A, B, dan C" — kalimat, bukan daftar bertanda koma. */
function joinNames(ids: string[]): string {
  const names = ids.map(label)
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} dan ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, dan ${names[names.length - 1]}`
}

export interface SourceStatusProps {
  /** Sumber yang gagal (id dari server, mis. "kiryuu"). */
  failed: string[]
  /** Sumber yang masih diproses server (mode dua fase). */
  pending?: string[]
  /** Jumlah sumber yang digabung server, kalau diketahui. */
  sourcesTotal?: number
  /** Kalau diberikan, tombol "Coba lagi" dirender. */
  onRetry?: () => void
  className?: string
}

export function SourceStatus({
  failed,
  pending = [],
  sourcesTotal,
  onRetry,
  className = '',
}: SourceStatusProps) {
  const hasFailed = failed.length > 0
  const hasPending = pending.length > 0
  if (!hasFailed && !hasPending) return null

  const okCount =
    sourcesTotal !== undefined && sourcesTotal > 0
      ? Math.max(0, sourcesTotal - failed.length - pending.length)
      : null

  let message: string
  if (hasFailed) {
    message = `${joinNames(failed)} sedang tidak tersedia`
    if (okCount !== null) message += ` — tampil ${okCount} dari ${sourcesTotal} sumber`
  } else {
    message = `Melengkapi hasil dari ${joinNames(pending)}…`
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-source-status
      className={`flex flex-wrap items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn ring-1 ring-warn/25 ${className}`}
    >
      <span aria-hidden="true">{hasFailed ? '⚠' : '⏳'}</span>
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md bg-warn/20 px-2.5 py-1 text-[11px] font-bold text-warn transition hover:bg-warn/30"
        >
          Coba lagi
        </button>
      )}
    </div>
  )
}
