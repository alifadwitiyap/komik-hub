import { usePwaInstall } from '../hooks/usePwaInstall'

/** Ajakan pasang satu baris di beranda — bukan modal, bisa ditutup 14 hari. */
export default function PwaInstallBanner() {
  const { isStandalone, dismissed, isIosSafari, canPromptAndroid, promptInstall, dismissBanner } =
    usePwaInstall()
  if (isStandalone || dismissed) return null

  return (
    <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-30 mx-2.5 mt-2 flex items-center gap-2 rounded-xl border border-ink-800 bg-ink-900/95 px-3 py-1.5 backdrop-blur-[16px]">
      <p className="min-w-0 flex-1 text-[12px] leading-tight text-ink-300">
        Pasang Komik Hub di layar utama untuk baca layar penuh.
        {isIosSafari && (
          <span className="block text-ink-500">
            Ketuk ikon Bagikan → Pilih &quot;Tambah ke Layar Utama&quot;
          </span>
        )}
      </p>
      {canPromptAndroid && (
        <button
          type="button"
          onClick={() => void promptInstall()}
          className="kh-tap shrink-0 rounded-lg bg-brand-amber px-3 py-1.5 text-[12px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
        >
          Pasang
        </button>
      )}
      <button
        type="button"
        onClick={dismissBanner}
        aria-label="Tutup ajangan pasang aplikasi"
        className="kh-tap grid size-11 shrink-0 place-items-center rounded-lg text-xl text-ink-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-amber"
      >
        ×
      </button>
    </div>
  )
}
