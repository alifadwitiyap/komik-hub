import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Label konteks untuk pesan, mis. "halaman ini". */
  what?: string
}

interface State {
  error: Error | null
}

/**
 * Menangkap error render — termasuk chunk `React.lazy` yang gagal diambil.
 *
 * Kenapa ini wajib ada: `Suspense` hanya menangani status *pending*, BUKAN
 * *error*. Kalau `import()` chunk reject (deploy baru menghapus hash lama,
 * atau jaringan putus), React 19 melempar ulang error itu saat render dan —
 * tanpa boundary — meng-unmount SELURUH pohon ke root container. Hasilnya
 * `#root` kosong total, tanpa pesan apa pun, dan pohon React-nya mati permanen
 * (history.back() dan popstate tidak memulihkan; hanya full reload).
 *
 * Terukur: dengan chunk `Reader-*.js` diblokir, `#root.innerHTML.length` = 0
 * dan `document.querySelectorAll('a').length` = 0.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Satu-satunya jejak yang tersisa kalau UI fallback juga gagal render.
    console.error('ErrorBoundary:', error, info.componentStack)
  }

  private reload = () => {
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const what = this.props.what ?? 'halaman ini'
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-base font-semibold text-ink-200">Gagal memuat {what}</p>
        <p className="mt-1 text-sm text-ink-400">
          Sebagian aplikasi gagal diambil — biasanya karena versi baru baru saja dipasang. Muat
          ulang untuk mengambil versi terbaru.
        </p>
        <button
          type="button"
          onClick={this.reload}
          className="mt-5 rounded-full bg-brand-amber px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-brand-amber-soft"
        >
          Muat ulang
        </button>
        <p className="mt-3 break-words text-[10.5px] text-ink-600">{error.message}</p>
      </div>
    )
  }
}
