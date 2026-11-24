/* ---------------------------------------------------------------------------
   MOTION PRESETS — Mobile-First UI/UX & Motion Engineering Plan (Fase 2).
   Token gerak terpusat. Nilai spring persis dari plan; konstanta CSS di bawah
   dipakai komponen lewat inline style / class agar satu sumber kebenaran.

   ponytail: implementasi gesture saat ini CSS transition + pointer events
   (tanpa dependensi baru) demi 60fps di HP kelas menengah — layoutId/drag JS
   berjalan di main thread dan drop frame saat load. Preset spring di sini
   adalah token siap pakai; upgrade: install `motion` bila butuh spring asli.
   --------------------------------------------------------------------------- */

// Spring responsif ala aplikasi native iOS/Android tanpa efek karet (bounce: 0)
export const nativeSpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 38,
  mass: 0.85,
}

// Bottom sheet — spring teredam kritis dari plan (bounce 0).
export const sheetSpring = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 36,
  mass: 0.8,
}

// Spring lebih cepat untuk indikator tab, pill filter, dan toggle
export const snappySpring = {
  type: 'spring' as const,
  stiffness: 520,
  damping: 40,
  mass: 0.7,
}

// Transisi antar halaman ringan & tidak memblokir input
export const pageTransition = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.12, ease: [0.22, 1, 0.36, 1] },
  },
}

// Popover / Menu Sortir (Origin-aware, mulai dari scale 0.96 — bukan 0)
export const popoverMotion = {
  initial: { opacity: 0, scale: 0.96, y: -4 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
  },
}

/* Konstanta CSS yang benar-benar dikonsumsi komponen (satu sumber dengan
   token di styles/motion.css). */
export const EASE_OUT_EXPO = 'cubic-bezier(0.16, 1, 0.3, 1)'
export const EASE_SNAPPY = 'cubic-bezier(0.16, 1, 0.3, 1)'
export const EASE_OUT_EMIL = 'cubic-bezier(0.22, 1, 0.36, 1)'
export const EASE_OUT_QUINT = 'cubic-bezier(0.22, 1, 0.36, 1)'
export const EASE_IN_OUT_FAST = 'cubic-bezier(0.4, 0, 0.2, 1)'

/* Plan D2 aliases — framer-motion tuple form of the curves above (same values
   as EASE_OUT_EMIL / EASE_SNAPPY, no new deps). Defined before popoverVariants
   so the object initializer does not hit the temporal dead zone. */
export const EMIL_EASE = [0.22, 1, 0.36, 1] as const
export const SNAPPY_EASE = [0.16, 1, 0.3, 1] as const

/* BottomNav shared pill — critically damped (bounce 0), plan D2/D3. */
export const tabPillSpring = {
  type: 'spring' as const,
  stiffness: 500,
  damping: 40,
  mass: 1,
}

/* Plan D2 popover variants: scale 0.96→1, 160ms in / 120ms out. popoverMotion
   above stays untouched so existing imports/contracts are unchanged. */
export const popoverVariants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.16, ease: EMIL_EASE },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    transition: { duration: 0.12, ease: EMIL_EASE },
  },
}

export const DUR_PRESS_MS = 100
export const DUR_HUD_MS = 140
export const DUR_MICRO_MS = 150
export const DUR_UI_MS = 220
export const DUR_SHEET_MS = 240

// Drag-to-dismiss peka kecepatan (plan 3.4): flick > 110 px/s atau tarik > 100 px.
export const SHEET_DISMISS_VELOCITY_PX_S = 110
export const SHEET_DISMISS_DISTANCE_PX = 100