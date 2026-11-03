/**
 * ANALISIS STATIS + SIMULASI NUMERIK — `src/hooks/useChromeOnScroll.ts`.
 *
 * Jalankan:  node scripts/check-chrome-scroll-logic.ts
 * (tanpa framework & tanpa dependency — Node >= 22 type-stripping)
 *
 * Kenapa skrip ini ada: `useChromeOnScroll` adalah React hook, jadi tidak bisa
 * diimpor sebagai fungsi murni. Tapi BADAN logikanya murni: satu listener yang
 * membaca `window.scrollY`, membandingkan dengan `lastY`, dan memutuskan
 * `visible`. Dua hal bisa dibuktikan TANPA browser:
 *
 *   A. ANALISIS STATIS — sifat struktural file sumber.
 *   B. SIMULASI NUMERIK — transkripsi 1:1 badan `onScroll`, dijalankan pada
 *      deret `scrollY` realistis.
 *   C. PARITAS — simulasi dibandingkan dengan eksekusi SUNGGUHAN `onScroll`
 *      (diekstrak dari file sumber via `new Function`). Kalau transkripsi
 *      melenceng, paritas gagal dan Bagian B tidak boleh dipercaya.
 *   D. DAMPAK ke fitur maraton (rantai konsumen, dibaca dari sumber).
 *   E. VARIAN FIX — dibuktikan numerik, TIDAK diterapkan ke kode produk.
 *
 * ============================================================================
 * CATATAN PENTING — HIPOTESIS AWAL GAGAL DIBUKTIKAN
 * ============================================================================
 * `scripts/_probe_chrome_threshold.py` menuliskan hipotesis:
 *
 *   "saat |delta| < 40px, listener `return` SEBELUM `lastY.current = y`.
 *    Akibatnya delta menumpuk; scroll turun halus (30px berulang) justru
 *    dianggap 'naik' -> chrome TIDAK PERNAH sembunyi."
 *
 * Simulasi di Bagian B MEMBANTAH klaim "tidak pernah sembunyi": untuk SETIAP
 * deret scroll yang murni menurun, chrome AKHIRNYA sembunyi (B1, B2).
 *
 * Yang TERBUKTI adalah bagian pertama hipotesis (lastY memang tidak maju) —
 * dan dari situ muncul EMPAT cacat lain yang lebih tepat menjelaskan gejala
 * "kadang tidak ketrigger" (B3..B14).
 *
 * Ironisnya, "chrome tidak pernah sembunyi saat scroll halus" ADALAH yang
 * terjadi kalau orang menerapkan fix naif satu baris (pindahkan
 * `lastY.current = y` ke atas early-return) — dibuktikan di E1/E2. Jadi
 * hipotesis itu menggambarkan AKIBAT DARI FIX, bukan bug yang ada sekarang.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_PATH = resolve(HERE, '../src/hooks/useChromeOnScroll.ts')
const SRC = readFileSync(SRC_PATH, 'utf8')
const LINES = SRC.split(/\r?\n/)

let pass = 0
const failures: string[] = []
function t(name: string, fn: () => void): void {
  try {
    fn()
    pass++
  } catch (e) {
    failures.push(`${name}: ${(e as Error).message}`)
    console.error(`  FAIL ${name}\n       ${(e as Error).message.split('\n').join('\n       ')}`)
  }
}
const section = (s: string) => console.log(`\n${s}`)

// ============================================================================
// BAGIAN A — ANALISIS STATIS
// ============================================================================
section('A. ANALISIS STATIS — sifat struktural useChromeOnScroll.ts')

const THRESHOLD = Number((SRC.match(/const THRESHOLD_PX = (\d+)/) ?? [])[1])

t('A1  konstanta THRESHOLD_PX = 40 (dibaca dari sumber)', () => {
  assert.equal(THRESHOLD, 40)
})

t('A2  satu pembanding `Math.abs(d) < THRESHOLD_PX`', () => {
  assert.equal((SRC.match(/Math\.abs\(d\) < THRESHOLD_PX/g) ?? []).length, 1)
})

t('A3  `setVisible(d < 0)` — arah ditentukan TANDA delta relatif patokan', () => {
  assert.ok(/setVisible\(d < 0\)/.test(SRC), 'pola setVisible(d < 0) tidak ditemukan')
})

t('A4  patokan TIDAK dimajukan di jalur early-return (akumulasi disengaja)', () => {
  const returnLine = LINES.findIndex((l) => /if \(Math\.abs\(d\) < THRESHOLD_PX\) return/.test(l))
  assert.ok(returnLine >= 0, 'early-return threshold tidak ditemukan')
  const before = LINES.slice(0, returnLine).some((l) => /anchor\.current = y\b/.test(l))
  assert.equal(before, false, 'anchor dimajukan sebelum early-return -> akumulasi hilang')
  const after = LINES.findIndex((l, i) => i > returnLine && /anchor\.current = y\b/.test(l))
  assert.ok(after > returnLine, 'harus ada assignment anchor setelah early-return')
})

t('A5  anchor di-assign di puncak + normal + reset saat belok', () => {
  const assigns = LINES.filter((l) => /anchor\.current = /.test(l)).length
  // mount, reset-saat-belok, cabang y<=0, cabang normal
  assert.equal(assigns, 4, `ditemukan ${assigns}; struktur varian B berubah -> tinjau ulang`)
})

t('A6  anchor & lastSeen diinisialisasi dari `window.scrollY` saat mount', () => {
  assert.ok(/anchor\.current = window\.scrollY/.test(SRC), 'anchor tidak diinisialisasi')
  assert.ok(/lastSeen\.current = window\.scrollY/.test(SRC), 'lastSeen tidak diinisialisasi')
})

t('A7  gerbang `restoring` early-return TANPA memperbarui lastY', () => {
  // Bukan bug saat restore berjalan (memang harus diabaikan), tapi memicu
  // patokan basi untuk event pertama SESUDAHNYA — lihat B10.
  assert.ok(/if \(restoringRef\.current\(\)\) return/.test(SRC))
})

t('A8  cabang `y <= 0` ADA di DALAM gerbang threshold (tidak terjangkau saat d kecil)', () => {
  // Konsekuensi: kalau lastY sudah 0 dan y = 0, d = 0 < 40 -> return lebih dulu,
  // sehingga "selalu tampil di puncak" tidak dijalankan. Lihat B14.
  const ret = LINES.findIndex((l) => /if \(Math\.abs\(d\) < THRESHOLD_PX\) return/.test(l))
  const peak = LINES.findIndex((l) => /if \(y <= 0\)/.test(l))
  assert.ok(ret >= 0 && peak > ret, 'cabang puncak harus SETELAH gerbang threshold')
})

t('A9  listener `passive: true` (tidak memblokir scroll)', () => {
  assert.ok(/\{ passive: true \}/.test(SRC))
})

t('A10 cleanup melepas listener yang sama', () => {
  assert.ok(/removeEventListener\('scroll', onScroll\)/.test(SRC))
})

t('A11 efek ber-dependensi kosong -> listener dipasang SEKALI', () => {
  assert.ok(/\}, \[\]\)/.test(SRC), 'dependensi efek harus [] supaya tidak rebind tiap render')
})

t('A12 `restoringRef` di-update tiap render (tidak basi di closure)', () => {
  assert.ok(/restoringRef\.current = restoring/.test(SRC))
})

// ============================================================================
// BAGIAN B — SIMULASI NUMERIK
// ============================================================================
section('B. SIMULASI NUMERIK — transkripsi badan onScroll')

interface SimState {
  lastY: number
  visible: boolean
  /** posisi event sebelumnya — dipakai mendeteksi pembalikan arah (varian B) */
  lastSeen: number
  /** arah gerak terakhir: -1 naik, +1 turun, 0 belum ada gerak */
  dir: number
  trace: Array<{ y: number; d: number; acted: boolean; visible: boolean; lastY: number }>
}

function makeSim(startY: number, startVisible = true): SimState {
  return { lastY: startY, visible: startVisible, lastSeen: startY, dir: 0, trace: [] }
}

/** Transkripsi PERSIS useChromeOnScroll.ts onScroll (varian B: anchor+lastSeen+dir). */
function onScroll(s: SimState, y: number, restoring = false): SimState {
  if (restoring) return s // if (restoringRef.current()) return
  const move = y - s.lastSeen
  const moveDir = Math.sign(move)
  if (moveDir !== 0 && s.dir !== 0 && moveDir !== s.dir) {
    s.lastY = s.lastSeen // titik balik jadi patokan baru
  }
  if (moveDir !== 0) s.dir = moveDir
  s.lastSeen = y

  const d = y - s.lastY
  if (Math.abs(d) < THRESHOLD) {
    s.trace.push({ y, d, acted: false, visible: s.visible, lastY: s.lastY })
    return s
  }
  if (y <= 0) {
    s.visible = true
    s.lastY = y
    s.dir = 0
    s.trace.push({ y, d, acted: true, visible: s.visible, lastY: s.lastY })
    return s
  }
  s.visible = d < 0
  s.lastY = y
  s.trace.push({ y, d, acted: true, visible: s.visible, lastY: s.lastY })
  return s
}

function run(ys: number[], startY = 0, startVisible = true): SimState {
  const s = makeSim(startY, startVisible)
  for (const y of ys) onScroll(s, y)
  return s
}

// ---------------------------------------------------------------------------
// B1/B2 — KOREKSI TERHADAP HIPOTESIS
// ---------------------------------------------------------------------------
t('B1  KOREKSI: turun halus 30px x 10 (300px) AKHIRNYA menyembunyikan chrome', () => {
  // Hipotesis _probe_chrome_threshold.py: "TIDAK pernah sembunyi". Hasil
  // simulasi: SALAH. Yang terjadi: akumulasi meledak tiap event ke-2.
  const s = run(Array.from({ length: 10 }, (_, i) => (i + 1) * 30))
  assert.equal(s.visible, false, 'chrome HARUS sudah tersembunyi setelah 300px turun')
  assert.equal(s.lastY, 300)
  const actedAt = s.trace.map((x, i) => (x.acted ? i + 1 : -1)).filter((i) => i > 0)
  assert.deepEqual(actedAt, [2, 4, 6, 8, 10], 'bertindak tiap event GENAP (akumulasi 60px)')
})

t('B2  BUKTI KONSISTENSI: SEMUA deret murni-menurun tetap berakhir tersembunyi', () => {
  for (let step = 1; step < 40; step++) {
    const ys = Array.from({ length: 40 }, (_, i) => (i + 1) * step)
    assert.equal(run(ys).visible, false, `step ${step} gagal menyembunyikan`)
  }
})

// ---------------------------------------------------------------------------
// B3..B5 — CACAT 1: AMBANG MENGGEMBUNG
// ---------------------------------------------------------------------------
t('B3  CACAT 1 — AMBANG EFEKTIF = ceil(40/step) * step, bukan 40', () => {
  const effective = (step: number) => {
    const s = run(Array.from({ length: 10 }, (_, i) => (i + 1) * step))
    return s.trace.find((x) => x.acted)?.d ?? NaN
  }
  assert.equal(effective(10), 40, 'step 10 -> tepat 40')
  assert.equal(effective(20), 40, 'step 20 -> tepat 40')
  assert.equal(effective(25), 50, 'step 25 -> 50 (1,25x)')
  assert.equal(effective(30), 60, 'step 30 -> 60 (1,5x dari yang didokumentasikan)')
  assert.equal(effective(35), 70, 'step 35 -> 70 (1,75x)')
  assert.equal(effective(39), 78, 'step 39 -> 78 (1,95x)')
})

t('B4  CACAT 1b — akibatnya chrome bereaksi LEBIH LAMBAT pada scroll halus', () => {
  const s = run([39, 78])
  assert.equal(s.trace[0].acted, false, 'event 39px diabaikan walau cuma 1px di bawah ambang')
  assert.equal(s.trace[1].d, 78, 'event ke-2 dilaporkan sebagai delta 78px')
  assert.equal(s.visible, false)
})

t('B5  CACAT 1c — satu event kecil diperlakukan sebagai lompatan besar', () => {
  // 39, 78, 117 -> event 1 diabaikan (d=39), event 2 bertindak dengan d=78,
  // event 3 kembali diabaikan (d=117-78=39). Perhatikan: TIDAK ada event yang
  // dilaporkan sebagai 39px — yang dilaporkan 78px, hasil akumulasi.
  const s = run([39, 78, 117])
  assert.equal(s.trace[0].acted, false, 'event 39px diabaikan')
  assert.equal(s.trace[1].acted, true, 'event ke-2 bertindak')
  assert.equal(s.trace[1].d, 78, 'event ke-2 dilaporkan sebagai delta 78px (akumulasi 2x39)')
  assert.equal(s.trace[2].acted, false, 'event ke-3 kembali diabaikan (d=39 dari patokan 78)')
})

// ---------------------------------------------------------------------------
// B6..B9 — CACAT 2: DEAD ZONE SAAT ARAH BERBALIK (pemicu utama tombol "hilang")
// ---------------------------------------------------------------------------
t('B6  CACAT 2 — DEAD ZONE: setelah sembunyi di 100, naik 39px belum memunculkan', () => {
  const s = run([100, 61])
  assert.equal(s.visible, false, 'user sudah naik 39px tapi chrome tetap tersembunyi')
  assert.equal(s.lastY, 100, 'patokan masih di 100 (titik TERDALAM), bukan 61')
})

t('B7  CACAT 2b — butuh naik ~2x ambang untuk memunculkan kembali', () => {
  const s = run([100, 61, 22])
  assert.equal(s.trace[1].acted, false, 'event -39px diabaikan')
  assert.equal(s.trace[2].d, -78, 'event ke-2 memakai delta -78')
  assert.equal(s.visible, true, 'baru muncul setelah naik 78px, bukan 40px')
})

t('B8  DIPERBAIKI — gerakan balik arah 45px kini TERDETEKSI', () => {
  // 100 -> 139 (turun 39, diabaikan, anchor tetap 100)
  // 139 -> 94  (naik 45px; arah berbalik -> anchor = 139, d = -45 -> bertindak)
  const s = run([100, 139, 94])
  assert.equal(s.trace[1].acted, false)
  assert.equal(s.trace[2].acted, true, 'naik 45px dari 139 ke 94 harus bertindak')
  assert.equal(s.trace[2].d, -45, 'delta -45 dihitung dari TITIK BALIK 139, bukan -6')
  assert.equal(s.visible, true, 'chrome muncul kembali setelah user naik 45px')
})

t('B9  CACAT 2d — osilasi di sekitar titik terdalam tidak pernah memulihkan', () => {
  const s = run([100, 61, 100, 61, 100, 61])
  assert.equal(s.visible, false, 'enam event, tiga di antaranya naik 39px — tetap tersembunyi')
  assert.equal(s.trace.filter((x) => x.acted).length, 1, 'hanya event pertama yang bertindak')
})

// ---------------------------------------------------------------------------
// B10..B13 — CACAT 3: PATOKAN BASI SETELAH RESTORE (jalur maraton!)
// ---------------------------------------------------------------------------
t('B10 CACAT 3 — setelah restore melompat, event pertama memakai delta raksasa', () => {
  // Mount: lastY = 0. Restore memindahkan scroll ke 3000 (diabaikan gerbang
  // restoring, lastY TIDAK maju). Event pertama sesudahnya: d = y - 0.
  const s = makeSim(0, true)
  onScroll(s, 3000, true) // scroll programatik saat restore
  assert.equal(s.lastY, 0, 'patokan tidak maju selama restore')
  onScroll(s, 2990, false) // user menggeser NAIK 10px
  assert.equal(s.trace[0].d, 2990, 'delta 2990 (bukan -10)')
  assert.equal(s.visible, false, 'chrome disembunyikan padahal user NAIK')
})

t('B11 CACAT 3b — arah salah bertahan sampai gerakan melebihi jarak restore', () => {
  const s = makeSim(0, true)
  onScroll(s, 3000, true)
  onScroll(s, 2961, false) // naik 39px
  assert.equal(s.trace[0].d, 2961)
  assert.equal(s.visible, false, 'naik 39px pun masih terbaca "turun"')
})

t('B12 CACAT 3c — berlaku dua arah: turun sedikit pun diputuskan karena alasan salah', () => {
  const s = makeSim(0, true)
  onScroll(s, 3000, true)
  onScroll(s, 3010, false)
  assert.equal(s.trace[0].d, 3010, 'delta 3010, bukan +10')
  assert.equal(s.visible, false, 'kebetulan hasilnya "benar", tapi karena alasan yang salah')
})

t('B13 selama restoring semua event diabaikan dan lastY tidak maju', () => {
  const s = makeSim(0)
  for (const y of [100, 500, 1200]) onScroll(s, y, true)
  assert.equal(s.lastY, 0)
  assert.equal(s.trace.length, 0, 'tidak ada event yang bahkan dicatat')
})

// ---------------------------------------------------------------------------
// B14..B15 — CACAT 4: jaring pengaman `y <= 0` tidak terjangkau
// ---------------------------------------------------------------------------
t('B14 CACAT 4 — di puncak halaman, `y <= 0` di-skip kalau delta < ambang', () => {
  // lastY = 0 dan y = 0 -> d = 0 < 40 -> return SEBELUM cabang `y <= 0`.
  const s = run([0], 0, false)
  assert.equal(s.trace[0].acted, false, 'cabang puncak tidak dijalankan')
  assert.equal(s.visible, false, 'chrome tetap tersembunyi di scrollY = 0 (tepi atas layar)')
})

t('B15 jaring pengaman BEKERJA kalau delta cukup besar', () => {
  const s = run([500, 0])
  assert.equal(s.visible, true, 'kembali ke puncak dari jauh -> tampil')
  assert.equal(s.lastY, 0)
})

// ---------------------------------------------------------------------------
// B16..B18 — pembanding & batas
// ---------------------------------------------------------------------------
t('B16 pembanding: satu lompatan 400px selalu benar (tak ada akumulasi)', () => {
  const s = run([400])
  assert.equal(s.visible, false)
  assert.equal(s.lastY, 400)
})

t('B17 batas inklusif: |d| = 39 diabaikan, |d| = 40 bertindak', () => {
  assert.equal(run([39]).visible, true)
  assert.equal(run([40]).visible, false)
  assert.equal(run([-40], 100, true).visible, true)
})

t('B18 chrome berkedip saat osilasi melewati ambang', () => {
  // 41 (sembunyi) -> 1 (naik 40 -> tampil) -> 42 (turun 41 -> sembunyi)
  const s = run([41, 1, 42])
  assert.deepEqual(
    s.trace.map((x) => x.visible),
    [false, true, false],
    'tiga perubahan dalam tiga event — persis yang ingin dicegah komentar "threshold 40px"',
  )
})

// ============================================================================
// BAGIAN C — PARITAS dengan onScroll SUNGGUHAN
// ============================================================================
section('C. PARITAS — simulasi vs onScroll asli dari file sumber')

function extractOnScrollBody(src: string): string {
  const start = src.indexOf('const onScroll = () => {')
  assert.ok(start >= 0, 'const onScroll tidak ditemukan')
  const open = src.indexOf('{', start)
  let depth = 0
  let i = open
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  assert.ok(depth === 0, 'kurung kurawal tidak seimbang')
  return src.slice(open + 1, i)
}

const BODY = extractOnScrollBody(SRC)

function makeReal(
  initialY: number,
  initialVisible: boolean,
  restoring: () => boolean,
): { fire: (y: number) => void; state: { visible: boolean; lastY: number } } {
  const state = { visible: initialVisible, lastY: initialY }
  const window = { scrollY: initialY }
  const anchor = { current: initialY }
  const lastSeen = { current: initialY }
  const dir = { current: 0 }
  const setVisible = (v: boolean) => {
    state.visible = v
  }
  const restoringRef = { current: restoring }
  const fn = new Function(
    'window',
    'anchor',
    'lastSeen',
    'dir',
    'setVisible',
    'restoringRef',
    'THRESHOLD_PX',
    BODY,
  ) as (w: unknown, a: unknown, ls: unknown, d: unknown, s: unknown, r: unknown, th: number) => void
  return {
    state,
    fire: (y: number) => {
      window.scrollY = y
      fn(window, anchor, lastSeen, dir, setVisible, restoringRef, THRESHOLD)
      state.lastY = anchor.current
    },
  }
}

t('C1  badan onScroll diekstrak dari sumber (bukan disalin tangan)', () => {
  assert.ok(BODY.includes('Math.abs(d) < THRESHOLD_PX'))
  assert.ok(BODY.includes('setVisible(d < 0)'))
  assert.ok(BODY.length > 100 && BODY.length < 2000)
})

t('C2  PARITAS: 400 deret acak — hasil simulasi == hasil kode asli', () => {
  let seed = 0xc0ffee
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let iter = 0; iter < 400; iter++) {
    const startY = Math.floor(rnd() * 500)
    const startVisible = rnd() > 0.5
    const ys: number[] = []
    let y = startY
    for (let k = 0; k < 12; k++) {
      const r = rnd()
      const step = r < 0.5 ? Math.floor(rnd() * 45) : Math.floor(rnd() * 400) - 200
      y = Math.max(0, y + step)
      ys.push(y)
    }
    const sim = makeSim(startY, startVisible)
    for (const v of ys) onScroll(sim, v)
    const real = makeReal(startY, startVisible, () => false)
    for (const v of ys) real.fire(v)
    assert.equal(
      real.state.visible,
      sim.visible,
      `iterasi ${iter}: visible beda (asli=${real.state.visible}, sim=${sim.visible}) ys=${ys}`,
    )
    assert.equal(real.state.lastY, sim.lastY, `iterasi ${iter}: lastY beda`)
  }
})

t('C3  PARITAS gerbang restoring', () => {
  const sim = makeSim(0)
  onScroll(sim, 900, true)
  const real = makeReal(0, true, () => true)
  real.fire(900)
  assert.equal(real.state.lastY, sim.lastY)
  assert.equal(real.state.visible, sim.visible)
  assert.equal(real.state.lastY, 0, 'patokan basi — sumber cacat 3')
})

t('C4  PARITAS kasus puncak y <= 0 (termasuk kasus yang di-skip)', () => {
  const cases: Array<[number, number, boolean]> = [
    [0, 0, false],
    [500, 0, false],
    [2000, 0, true],
    [0, 0, true],
  ]
  for (const [start, y, vis] of cases) {
    const sim = run([y], start, vis)
    const real = makeReal(start, vis, () => false)
    real.fire(y)
    assert.equal(real.state.visible, sim.visible, `start=${start} y=${y}`)
    assert.equal(real.state.lastY, sim.lastY)
  }
})

// ============================================================================
// BAGIAN D — DAMPAK KE MARATON
// ============================================================================
section('D. DAMPAK KE MARATON — rantai konsumen (statis)')

const TOGGLE_SRC = readFileSync(resolve(HERE, '../src/components/ReaderMarathonToggle.tsx'), 'utf8')
const READER_SRC = readFileSync(resolve(HERE, '../src/pages/Reader.tsx'), 'utf8')
const MARATHON_SRC = readFileSync(resolve(HERE, '../src/pages/ReaderMarathon.tsx'), 'utf8')

t('D1  toggle: opacity ikut visible, pointer-events/inert/aria-hidden ikut interactive', () => {
  // opacity tetap dikendalikan `visible`
  assert.ok(/visible \? 'opacity-100' : 'opacity-0'/.test(TOGGLE_SRC), 'kelas opacity tidak ditemukan')
  // pointer-events, inert, aria-hidden ikut `interactive`
  assert.ok(/interactive \? '' : 'pointer-events-none'/.test(TOGGLE_SRC), 'pointer-events tidak ikut interactive')
  assert.ok(/inert=\{!interactive\}/.test(TOGGLE_SRC), 'inert tidak terikat ke interactive')
  assert.ok(/aria-hidden=\{!interactive\}/.test(TOGGLE_SRC), 'aria-hidden tidak terikat ke interactive')
})

t('D2  Reader memakai chrome.visible untuk tombol maraton', () => {
  assert.ok(/<ReaderMarathonToggle[\s\S]{0,200}visible=\{chrome\.visible\}/.test(READER_SRC))
})

t('D3  ReaderMarathon juga memakai chrome.visible', () => {
  assert.ok(/visible=\{chrome\.visible\}/.test(MARATHON_SRC))
})

t('D4  kedua halaman memakai gerbang restoring yang sama (pending != null)', () => {
  assert.ok(/useChromeOnScroll\(\(\) => pending\.current !== null\)/.test(READER_SRC))
  assert.ok(/useChromeOnScroll\(\(\) => pendingRef\.current !== null\)/.test(MARATHON_SRC))
})

t('D5  MEKANISME GEJALA: turun -> sembunyi, lalu naik < 2x ambang -> tetap sembunyi', () => {
  // Inilah rantai "kadang tidak ketrigger": tombol inert, tap tidak sampai.
  // 100 = titik terdalam saat chrome disembunyikan; 61 = user naik 39px.
  const s = run([100, 61])
  assert.equal(s.visible, false, 'toggle masih pointer-events-none saat user mencoba menekan')
})

t('D6  MEKANISME GEJALA 2: osilasi di sekitar titik terdalam tidak pernah memulihkan', () => {
  const s = run([100, 61, 100, 61])
  assert.equal(s.visible, false, 'empat event, tombol tetap tidak bisa ditekan')
})

t('D7  jalur restore maraton kena cacat 3 (patokan basi)', () => {
  // ReaderMarathon memulihkan posisi lewat setScrollToAnchor -> scrollTo.
  // Selama pendingRef != null, gerbang restoring menahan lastY. Event pertama
  // sesudah restore memakai delta sebesar jarak lompatan.
  assert.ok(/setScrollToAnchor\(el, \{ offsetRatio \}\)/.test(MARATHON_SRC))
  const s = makeSim(0, true)
  onScroll(s, 2500, true)
  onScroll(s, 2461, false) // user naik 39px setelah restore
  assert.equal(s.visible, false, 'chrome tetap tersembunyi padahal user naik')
})

t('D8  chrome.show() saat chapter berganti menutup sebagian kasus (bukan akar)', () => {
  // Reader & ReaderMarathon memanggil chrome.show() saat chapterId berubah,
  // jadi cacat 3 tidak permanen — hanya sampai interaksi berikutnya.
  assert.ok(/chrome\.show\(\)/.test(READER_SRC))
  assert.ok(/chrome\.show\(\)/.test(MARATHON_SRC))
})

// ============================================================================
// BAGIAN E — VARIAN FIX (simulasi; kode produk TIDAK diubah)
// ============================================================================
section('E. VARIAN FIX — dibuktikan numerik, TIDAK diterapkan')

/** Varian A (naif): SELALU perbarui lastY sebelum early-return. */
function variantAlwaysUpdate(s: SimState, y: number): SimState {
  const d = y - s.lastY
  s.lastY = y
  if (Math.abs(d) < THRESHOLD) {
    s.trace.push({ y, d, acted: false, visible: s.visible, lastY: s.lastY })
    return s
  }
  if (y <= 0) {
    s.visible = true
    s.trace.push({ y, d, acted: true, visible: s.visible, lastY: s.lastY })
    return s
  }
  s.visible = d < 0
  s.trace.push({ y, d, acted: true, visible: s.visible, lastY: s.lastY })
  return s
}

/**
 * Varian B — akumulasi DISENGAJA, tapi patokan di-reset saat ARAH BERBALIK.
 *
 * Perlu DUA posisi, bukan satu:
 *   - `anchor`   : patokan akumulasi (dipakai untuk memutuskan `visible`)
 *   - `lastSeen` : posisi event sebelumnya (dipakai untuk mendeteksi belok)
 *
 * Percobaan pertama di suite ini hanya menyimpan `anchor`, sehingga deteksi
 * "arah berbalik" membandingkan `y` dengan patokan BASI — bug yang sama
 * dengan yang sedang diperbaiki (d = -6 pada kasus 100→139→94). Itu sendiri
 * adalah bukti betapa mudahnya cacat ini muncul kembali.
 */
function variantResetOnReverse(
  s: SimState & { dir: number; lastSeen: number },
  y: number,
): SimState & { dir: number; lastSeen: number } {
  const move = y - s.lastSeen
  const dir = Math.sign(move)
  if (dir !== 0 && s.dir !== 0 && dir !== s.dir) {
    // belok: TITIK BALIK (posisi sebelumnya) jadi patokan baru
    s.lastY = s.lastSeen
  }
  if (dir !== 0) s.dir = dir
  s.lastSeen = y

  const d = y - s.lastY // s.lastY == anchor akumulasi
  if (Math.abs(d) < THRESHOLD) {
    s.trace.push({ y, d, acted: false, visible: s.visible, lastY: s.lastY })
    return s
  }
  if (y <= 0) {
    s.visible = true
    s.lastY = y
    s.dir = 0
    s.trace.push({ y, d, acted: true, visible: s.visible, lastY: s.lastY })
    return s
  }
  s.visible = d < 0
  s.lastY = y
  s.trace.push({ y, d, acted: true, visible: s.visible, lastY: s.lastY })
  return s
}

/** Buat state varian B. */
const makeVarB = (startY: number, startVisible = true) => ({
  ...makeSim(startY, startVisible),
  dir: 0,
  lastSeen: startY,
})

t('E1  VARIAN A (fix naif) MEMBUAT BUG YANG DIRAMALKAN HIPOTESIS', () => {
  // Temuan penting: memindahkan `lastY.current = y` ke atas early-return
  // membuat scroll halus 30px TIDAK PERNAH bertindak — persis "chrome tidak
  // pernah sembunyi" yang dituduhkan ke kode sekarang.
  const s = makeSim(0)
  for (const y of Array.from({ length: 10 }, (_, i) => (i + 1) * 30)) variantAlwaysUpdate(s, y)
  assert.equal(s.visible, true, 'turun 300px halus -> chrome TETAP tampil (regresi!)')
  assert.equal(s.lastY, 300, 'patokan benar, tapi tidak ada keputusan yang diambil')
  assert.equal(s.trace.filter((x) => x.acted).length, 0, 'nol event bertindak')
})

t('E2  varian A juga melumpuhkan scroll halus ke ATAS', () => {
  const s = makeSim(200, false)
  for (const y of [161, 122, 83, 44]) variantAlwaysUpdate(s, y)
  assert.equal(s.visible, false, 'naik 156px halus -> chrome tidak pernah muncul')
})

t('E3  varian B: turun halus 30px x 10 tetap menyembunyikan', () => {
  const s = makeVarB(0)
  for (const y of Array.from({ length: 10 }, (_, i) => (i + 1) * 30)) variantResetOnReverse(s, y)
  assert.equal(s.visible, false, 'akumulasi searah tetap diizinkan -> chrome sembunyi')
})

t('E4  varian B: naik 39px berulang MEMUNCULKAN chrome', () => {
  const s = makeVarB(200, false)
  for (const y of [161, 122, 83, 44]) variantResetOnReverse(s, y)
  assert.equal(s.visible, true, 'akumulasi searah ke atas akhirnya memunculkan')
})

t('E5  varian B: arah berbalik me-reset patokan ke TITIK BALIK', () => {
  const s = makeVarB(0)
  variantResetOnReverse(s, 30) // d = 30 < 40, dir = +1, anchor tetap 0
  assert.equal(s.lastY, 0, 'belum ada pembalikan -> patokan masih 0')
  variantResetOnReverse(s, 25) // berbalik: titik balik 30 jadi patokan
  assert.equal(s.lastY, 30, 'patokan di-reset ke titik balik (30)')
  assert.equal(s.visible, true)
})

t('E6  varian B MENUTUP cacat 2c: naik 45px yang tadinya ditelan kini terdeteksi', () => {
  // Kasus B8: 100 -> 139 (turun 39, diabaikan) -> 94 (naik 45, TADINYA ditelan).
  const s = makeVarB(0)
  for (const y of [100, 139, 94]) variantResetOnReverse(s, y)
  assert.equal(s.trace[2].d, -45, 'delta kini -45 (dari titik balik 139), bukan -6')
  assert.equal(s.visible, true, 'chrome muncul kembali — perilaku yang diharapkan')
})

t('E7  varian B: osilasi 100<->61 tetap tersembunyi (BUKAN regresi)', () => {
  // Jujur soal batas varian ini: osilasi 39px bolak-balik memang tidak
  // melewati ambang 40px di kedua arah, jadi chrome tetap tersembunyi.
  // Itu masuk akal — 39px < 40px. Yang penting bukan lagi "terjebak".
  const s = makeVarB(0)
  for (const y of [100, 61, 100, 61]) variantResetOnReverse(s, y)
  assert.equal(s.visible, false, 'osilasi di bawah ambang tetap tidak mengubah apa pun')
  assert.equal(s.lastY, 100, 'patokan = titik balik terakhir (100), bukan 61 yang basi')
})

t('E8  varian B tetap menangani puncak y <= 0 dari jauh', () => {
  const s = makeVarB(500, false)
  variantResetOnReverse(s, 0)
  assert.equal(s.visible, true)
})

t('E9  varian B tetap menyembunyikan pada lompatan besar', () => {
  const s = makeVarB(0)
  variantResetOnReverse(s, 400)
  assert.equal(s.visible, false)
})

// ============================================================================
section('RINGKASAN')
const total = pass + failures.length
if (failures.length === 0) {
  console.log(`check-chrome-scroll-logic: OK (${pass}/${total} asersi lulus, 0 gagal)`)
} else {
  console.error(`check-chrome-scroll-logic: GAGAL (${pass}/${total} lulus, ${failures.length} gagal)`)
  for (const f of failures) console.error(`  - ${f.split('\n')[0]}`)
}
process.exit(failures.length === 0 ? 0 : 1)
