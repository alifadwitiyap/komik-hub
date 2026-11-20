/**
 * Util murni untuk kontrol chrome reader (dipakai Reader + ReaderMarathon).
 *
 * Kunci pemicu hide/show chrome: 'H'/'h'. Modifiers dilewati supaya shortcut
 * browser/pembaca layar (Ctrl/H, Alt/H, Cmd/H) tidak dikalahkan. Handler TIDAK
 * memanggil preventDefault: di mode browse NVDA/VoiceOver, 'h' untuk lompat
 * heading ditangkap AT sebelum mencapai halaman.
 */
const CHROME_TOGGLE_KEYS = new Set(['H', 'h'])

export function isChromeToggleKey(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>,
): boolean {
  return (
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    CHROME_TOGGLE_KEYS.has(event.key)
  )
}
