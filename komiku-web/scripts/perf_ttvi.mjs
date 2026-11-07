#!/usr/bin/env node
/**
 * perf_ttvi.mjs — evaluator Time-To-Visible-Image (ulw-perf, fase audit).
 *
 * Beda dengan perf_ttfi.mjs: TTFI berhenti di `naturalWidth > 0` (gambar
 * decoded tapi MASIH bisa opacity-0 / di luar viewport = layar masih skeleton
 * putih). TTVI berhenti saat gambar HALAMAN PERTAMA benar-benar terbaca user:
 *   1. selector `.reader-page img[data-page]` (bukan logo / cover / LQIP)
 *   2. `naturalWidth > 0`                  → bytes gambar sudah di-decode
 *   3. computed `opacity >= 0.99`          → ComicImage `shown` sudah true
 *      (komiku-web/src/components/ComicImage.tsx:506-508 crossfade 200 ms)
 *   4. getBoundingClientRect beririsan viewport → tidak cuma ter-mount
 *
 * Fase (relatif ke t0 = navigasi/klik chapter), diukur terpisah supaya
 * bottleneck ketahuan, bukan cuma angka akhir:
 *   A  t0 → first-byte HTML
 *   B  HTML → response /api/unified/chapter
 *   C  API → atribut src pertama di-set (MutationObserver SEBELUM navigasi)
 *   D  src → decoded (naturalWidth>0)
 *   E  decoded → VISIBLE (opacity 1 + intersect viewport)  ← pembeda TTVI
 *   TTVI = t0 → visible;  TTFD = t0 → decoded (pembanding evaluator lama)
 *
 * Isolasi domain: `--family` memilih kumpulan URL gambar NYATA dari satu
 * keluarga host (.ttvi-audit/workload.json, diverifikasi HTTP 200 + magic
 * bytes image). Respons `/api/unified/chapter` DAN `/api/unified/series`
 * di-stub lewat page.route sehingga variabel latency upstream agregator
 * hilang; yang diukur murni jalur RENDER → /img proxy → CDN. Handler route
 * TIDAK boleh sleep (mem-blok event loop Playwright → artefak pengukuran).
 * `/img` tetap lewat server Rust asli (proxy + disk cache + CDN sungguhan).
 *
 * Arm:
 *   cold → serviceWorkers:'block' (camelCase WAJIB di Playwright JS), context
 *          BARU per iterasi (Cache-Control immutable bikin iterasi 2/3 hangat
 *          kalau context dipakai ulang), server di-restart per iterasi dengan
 *          KOMIKU_IMGCACHE_DIR berbeda supaya disk cache /img benar-benar
 *          kosong (evaluator lama TIDAK melakukan ini → iterasi 2/3 "cold"
 *          sebenarnya hangat, DAN opsi snake_case-nya diabaikan → SW aktif).
 *   warm → serviceWorkers:'allow', satu context, navigasi #1 = prime (isi
 *          cache SW /img yang cache-first), navigasi #2..N = diukur.
 *          Catatan: cache disk server ikut hangat; ini disengaja karena
 *          merepresentasikan revisit user di produksi.
 *
 * Gate: `--budget-ms N` → median TTVI > N = exit 1. `--budget-from <file>`
 * menurunkan budget = median baseline × (1 + --tolerance-pct/100) sesuai
 * ulw-perf. Tanpa keduanya = MODE BASELINE (report-only, exit 0), dipakai
 * untuk mengukur baseline sebelum budget ditetapkan.
 *
 * Contoh:
 *   node scripts/perf_ttvi.mjs --family komiku_org --arm cold \
 *     --port 8811 --out D:/project/.ttvi-audit/out/komiku_org-cold.json
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/project';
const SERVER = path.join(ROOT, 'komiku-server');
const DEF_BIN = path.join(SERVER, 'target/debug/komiku-server.exe');
const DEF_WORKLOAD = path.join(ROOT, '.ttvi-audit/workload.json');
const CHROMIUM_EXE = process.env.PLAYWRIGHT_CHROMIUM_EXE
  || 'C:/Users/LENOVO LEGION/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe';

// --- CLI ---
const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(n);

const FAMILY = val('--family', null);
const WORKLOAD = val('--workload', DEF_WORKLOAD);
const ARM = val('--arm', 'cold');
const PORT = parseInt(val('--port', '8810'), 10);
const OUT = val('--out', null);
const ITERS = parseInt(val('--iters', '3'), 10);
const PAGES = parseInt(val('--pages', '12'), 10);
const DOWN_MBPS = parseFloat(val('--down-mbps', '4'));
const RTT_MS = parseInt(val('--rtt-ms', '400'), 10);
const VW = parseInt(val('--viewport-w', '390'), 10);
const VH = parseInt(val('--viewport-h', '844'), 10);
const RATE_WINDOW_MS = parseInt(val('--rate-window-ms', '6000'), 10);
const SAMPLE_MS = parseInt(val('--sample-ms', '100'), 10);
const RATE_SLICE_MS = parseInt(val('--rate-slice-ms', '2000'), 10);
const BUDGET_MS = parseFloat(val('--budget-ms', '0')); // 0 = baseline mode
const BUDGET_FROM = val('--budget-from', null);
const TOLERANCE_PCT = parseFloat(val('--tolerance-pct', '15'));
const CACHE_ROOT = val('--cache-root', path.join(ROOT, '.ttvi-audit/cache'));
const BIN = val('--server-binary', DEF_BIN);
const NO_SERVER = flag('--no-server'); // server sudah jalan di PORT (hemat fan-in)
const BASE = `http://127.0.0.1:${PORT}`;
const DOWN_BPS = Math.round(DOWN_MBPS * 1024 * 1024 / 8);
const UP_BPS = Math.round(DOWN_BPS / 3);
const CHAPTER_PATH = '/baca/komiku%3A6167/1';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (x) => Number.isFinite(x) ? x.toFixed(1) : 'n/a';
const r2 = (x) => Number.isFinite(x) ? x.toFixed(2) : 'n/a';

// --- workload ---------------------------------------------------------------
function loadUrls() {
  const w = JSON.parse(readFileSync(WORKLOAD, 'utf8'));
  const all = w.verified?.[FAMILY];
  if (!all || !all.length) throw new Error(`family '${FAMILY}' tidak punya URL terverifikasi di ${WORKLOAD}`);
  const urls = [];
  for (let i = 0; i < PAGES; i++) urls.push(all[i % all.length]);
  return { urls, unique: Math.min(all.length, PAGES), verifiedPool: all.length };
}

// --- server lifecycle (cache dir per proses → cold benar-benar cold) --------
async function waitPort(port, timeoutMs = 30000) {
  const net = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function tick() {
      const s = net.connect({ port, host: '127.0.0.1' });
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) return reject(new Error(`server :${port} timeout`));
        setTimeout(tick, 200);
      });
    })();
  });
}
function startServer(cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const child = spawn(BIN, [], {
    cwd: SERVER,
    env: {
      ...process.env,
      PORT: String(PORT),
      KOMIKU_IMGCACHE_DIR: cacheDir,
      TMP: 'C:/rusttmp', TEMP: 'C:/rusttmp',
    },
    stdio: 'ignore', windowsHide: true,
  });
  let killed = false;
  child.on('error', e => { if (!killed) console.error(`[server] ${e.message}`); });
  child.on('exit', (c, s) => { if (!killed) console.error(`[server] premature exit ${c}/${s}`); });
  return {
    async stop() {
      killed = true;
      try { child.kill(); } catch {}
      await sleep(400);
      try { child.kill('SIGKILL'); } catch {}
      await sleep(250);
    },
  };
}

// --- instrumentasi in-page: dijalankan SEBELUM navigasi ---------------------
const INIT = `
(() => {
  const S = {
    t0Epoch: null, firstSrc: null, decoded: null, visible: null,
    visibleDetail: null, visibleEver: new Set(), selector: null,
  };
  window.__ttvi = S;
  const pick = () => {
    const a = [...document.querySelectorAll('.reader-page img[data-page]')];
    if (a.length) { S.selector = '.reader-page img[data-page]'; return a; }
    const b = [...document.querySelectorAll('img[data-page]')];
    S.selector = 'img[data-page] (fallback)';
    return b;
  };
  const inView = (r) => r.width > 0 && r.height > 0 &&
    r.bottom > 0 && r.top < window.innerHeight &&
    r.right > 0 && r.left < window.innerWidth;
  S.check = () => {
    const now = Date.now();
    for (const im of pick()) {
      if (!im.getAttribute('src')) continue;
      if (S.firstSrc === null) S.firstSrc = now;
      const decodedOk = im.complete && im.naturalWidth > 0;
      if (decodedOk && S.decoded === null) S.decoded = now;
      if (!decodedOk) continue;
      const op = parseFloat(getComputedStyle(im).opacity || '0');
      const r = im.getBoundingClientRect();
      const vis = op >= 0.99 && inView(r);
      if (vis) S.visibleEver.add(im);
      if (vis && S.visible === null) {
        S.visible = now;
        S.visibleDetail = {
          dataPage: im.getAttribute('data-page'),
          opacity: op, naturalWidth: im.naturalWidth,
          naturalHeight: im.naturalHeight,
          src: (im.currentSrc || im.src || '').slice(0, 300),
          className: String(im.className).slice(0, 160),
          rect: { top: Math.round(r.top), bottom: Math.round(r.bottom),
                  left: Math.round(r.left), right: Math.round(r.right) },
          selector: S.selector,
        };
      }
    }
  };
  const attach = () => {
    const root = document.documentElement || document;
    const obs = new MutationObserver(() => S.check());
    obs.observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'srcset', 'class', 'style'] });
    S.check();
  };
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
  setInterval(S.check, 25);
  try {
    new PerformanceObserver(() => {}).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
})();
`;

// --- stub dua endpoint (bukan /img) -----------------------------------------
function chapterBody(urls, family) {
  return JSON.stringify({
    title: 'Chapter 1', number: '1', source: 'komiku',
    title_key: `ttvi-${family}`, series_title: `TTVI Audit ${family}`,
    images: urls, image_sizes: urls.map(() => null),
    prev: null, next: null, switched_from: null, note: null,
  });
}
const SERIES_BODY = (family) => JSON.stringify({
  manga: { title: `TTVI Audit ${family}`, title_key: `ttvi-${family}`, cover_url: null },
  chapters: [], source: 'komiku', failed_sources: [], representative_source: null,
});

// --- satu iterasi pengukuran ------------------------------------------------
async function measureOnce(page, ctx, urls, family) {
  const ev = { t0: null, html: null, api: null };
  const imgResp = [];
  // Response dari navigasi PRIME (warm) masih bisa mampir setelah t0 kalau
  // SW / bandwidth menahannya. Hanya terima request yang dimulai SETELAH t0.
  const liveReq = new WeakSet();
  const onRequest = (req) => { if (ev.t0 !== null) liveReq.add(req); };
  page.on('request', onRequest);
  const onResponse = (r) => {
    const u = r.url();
    const now = Date.now();
    const req = r.request();
    if (ev.t0 === null || !liveReq.has(req)) return;
    if (req.isNavigationRequest() && req.resourceType() === 'document' && ev.html === null) ev.html = now;
    if (u.includes('/api/unified/chapter') && ev.api === null) ev.api = now;
    if (u.includes('/img?u=')) {
      try {
        imgResp.push({
          url: u, status: r.status(),
          swCached: r.headers()['x-komiku-cached'] ?? null,
          at: now - ev.t0,
        });
      } catch {}
    }
  };
  page.on('response', onResponse);

  await page.route('**/api/unified/chapter/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: chapterBody(urls, family) }));
  await page.route('**/api/unified/series/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: SERIES_BODY(family) }));

  // t0 di Node (Date.now) searah dengan Date.now() di page = clock mesin sama.
  ev.t0 = Date.now();
  await page.goto(`${BASE}${CHAPTER_PATH}`, { waitUntil: 'commit', timeout: 60000 });

  // tunggu visible (bukan cuma decoded)
  const deadline = Date.now() + 60000;
  let visible = null;
  while (Date.now() < deadline && visible === null) {
    visible = await page.evaluate(() => window.__ttvi?.visible ?? null);
    if (visible === null) await sleep(50);
  }

  const snap = await page.evaluate(() => {
    const S = window.__ttvi || {};
    return {
      firstSrc: S.firstSrc ?? null,
      decoded: S.decoded ?? null,
      visible: S.visible ?? null,
      detail: S.visibleDetail ?? null,
      selector: S.selector ?? null,
      everCount: S.visibleEver ? S.visibleEver.size : 0,
    };
  });

  // Bukti arm: cold WAJIB tanpa controller SW & tanpa X-Komiku-Cached.
  // Playwright JS memakai `serviceWorkers` (camelCase); `service_workers`
  // diabaikan diam-diam → SW aktif dan "cold" terukur sebagai warm.
  const swProof = await page.evaluate(async () => {
    let registrations = -1;
    try { registrations = (await navigator.serviceWorker.getRegistrations()).length; } catch {}
    let controller = null;
    try { controller = !!navigator.serviceWorker.controller; } catch {}
    return { controller, registrations };
  }).catch(() => ({ controller: null, registrations: -1 }));

  // progressive visible-rate: gambar yang BENAR-BENAR terlihat, bukan decoded
  const samples = [];
  const start = Date.now();
  let nextScroll = start + 1200, scrolled = 0, ever = snap.everCount;
  while (Date.now() - start < RATE_WINDOW_MS) {
    const n = await page.evaluate(() => window.__ttvi?.visibleEver?.size ?? 0);
    ever = Math.max(ever, n);
    samples.push({ t: Date.now() - start, n });
    if (Date.now() >= nextScroll && scrolled < 20) {
      await page.evaluate(() => window.scrollBy({ top: Math.min(700, innerHeight * 0.8), behavior: 'instant' }));
      scrolled++; nextScroll = Date.now() + 800;
    }
    await sleep(SAMPLE_MS);
  }

  // atribusi resource timing per host gambar
  const resources = await page.evaluate(() => {
    const out = [];
    for (const e of performance.getEntriesByType('resource')) {
      if (!e.name.includes('/img?u=')) continue;
      let host = '(unknown)';
      try { host = new URL(decodeURIComponent(new URL(e.name).searchParams.get('u') || '')).host; } catch {}
      out.push({
        host, durMs: Math.round(e.duration),
        ttfbMs: Math.round(e.responseStart - e.startTime),
        transferMs: Math.round(e.responseEnd - e.responseStart),
        bytes: e.transferSize || 0,
      });
    }
    return out;
  });

  const resByHost = {};
  for (const r of resources) {
    const k = r.host || '(unknown)';
    (resByHost[k] ||= []).push(r.durMs);
  }
  const hostStats = Object.fromEntries(Object.entries(resByHost).map(([h, ds]) => [h, {
    requests: ds.length, medianDurMs: Math.round(median(ds)),
  }]));

  page.off('response', onResponse);
  page.off('request', onRequest);
  await page.unroute('**/api/unified/chapter/**');
  await page.unroute('**/api/unified/series/**');

  const c0 = samples.length ? samples[0].n : ever;
  const avgRate = (ever - c0) / (RATE_WINDOW_MS / 1000);
  const atSlice = samples.find(s => s.t >= RATE_SLICE_MS) || { t: RATE_SLICE_MS, n: c0 };
  const sliceRate = (ever - atSlice.n) / ((RATE_WINDOW_MS - atSlice.t) / 1000);

  const d = (x) => x !== null && x !== undefined ? x - ev.t0 : null;
  return {
    ok: snap.visible !== null,
    ttviMs: d(snap.visible),
    ttfdMs: d(snap.decoded),
    phases: {
      A_htmlMs: ev.html !== null ? ev.html - ev.t0 : null,
      B_apiMs: ev.api !== null && ev.html !== null ? ev.api - ev.html : null,
      C_srcMs: snap.firstSrc !== null && ev.api !== null ? snap.firstSrc - ev.api : null,
      D_decodeMs: snap.decoded !== null && snap.firstSrc !== null ? snap.decoded - snap.firstSrc : null,
      E_revealMs: snap.visible !== null && snap.decoded !== null ? snap.visible - snap.decoded : null,
    },
    visibleDetail: snap.detail, selector: snap.selector,
    progressive: { avgRate, sliceRate, totalVisible: ever, samples: samples.length },
    hostStats, swProof,
    imgRequests: imgResp.length,
    swCacheHits: imgResp.filter(r => r.swCached === '1').length,
    imgStatuses: [...new Set(imgResp.map(r => r.status))],
  };
}

// --- main -------------------------------------------------------------------
async function main() {
  if (!FAMILY || !OUT) {
    console.error('wajib: --family <nama> --out <path.json>');
    process.exit(2);
  }
  if (!['cold', 'warm'].includes(ARM)) { console.error('--arm harus cold|warm'); process.exit(2); }
  if (!existsSync(BIN) && !NO_SERVER) { console.error(`binary tidak ada: ${BIN}`); process.exit(2); }
  const { urls, unique, verifiedPool } = loadUrls();

  // budget: eksplisit atau diturunkan dari baseline × (1+tolerance)
  let budget = BUDGET_MS || null;
  if (BUDGET_FROM) {
    const b = JSON.parse(readFileSync(BUDGET_FROM, 'utf8'));
    const base = b.summary?.medianTtviMs;
    if (!Number.isFinite(base)) throw new Error(`baseline tidak ada di ${BUDGET_FROM}`);
    budget = Math.round(base * (1 + TOLERANCE_PCT / 100));
  }

  const meta = {
    schema: 1, family: FAMILY, arm: ARM, port: PORT, iters: ITERS,
    pages: PAGES, uniqueUrls: unique, verifiedPool,
    hosts: [...new Set(urls.map(u => { try { return new URL(u).host; } catch { return '?'; } }))],
    env: {
      throttle: { downMbps: DOWN_MBPS, rttMs: RTT_MS },
      viewport: { w: VW, h: VH }, serviceWorkers: ARM === 'warm' ? 'allow' : 'block',
      rateWindowMs: RATE_WINDOW_MS, rateSliceMs: RATE_SLICE_MS,
      chromium: CHROMIUM_EXE, serverBinary: BIN, cacheRoot: CACHE_ROOT,
      stubbed: ['/api/unified/chapter/*', '/api/unified/series/*'],
      notStubbed: ['/img?u=* (proxy Rust → CDN asli)'],
    },
    budgetMs: budget, tolerancePct: TOLERANCE_PCT,
    baselineMode: budget === null,
  };
  console.log(`=== perf_ttvi  family=${FAMILY} arm=${ARM} port=${PORT} iters=${ITERS} ===`);
  console.log(`    pages=${PAGES} (unique=${unique}/${verifiedPool}) hosts=[${meta.hosts.join(', ')}]`);
  console.log(`    throttle ${DOWN_MBPS} Mbps / RTT ${RTT_MS} ms | SW ${meta.env.serviceWorkers} | budget ${budget ?? 'BASELINE(report-only)'}`);

  const runs = [];
  let browser = null, exit = 0;
  const cacheDir = path.join(CACHE_ROOT, `${FAMILY}-${ARM}-p${PORT}`);
  let server = null;

  try {
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXE });

    // SATU context = SATU iterasi cold. `Cache-Control: immutable` (img.rs:216)
    // membuat iterasi 2/3 hangat walau server di-restart, kalau context dipakai
    // ulang. Playwright JS: `serviceWorkers` (camelCase); `service_workers`
    // diabaikan diam-diam → SW aktif dan arm "cold" palsu.
    async function makeCtx() {
      const c = await browser.newContext({
        viewport: { width: VW, height: VH },
        serviceWorkers: ARM === 'warm' ? 'allow' : 'block',
      });
      await c.addInitScript(INIT);
      await c.addInitScript(() => {
        try { localStorage.setItem('komik.login-promo.dismissed.v1', String(Date.now())); } catch {}
      });
      const p = await c.newPage();
      const cdp = await c.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: RTT_MS,
        downloadThroughput: DOWN_BPS, uploadThroughput: UP_BPS,
      });
      return { ctx: c, page: p };
    }

    let ctx = null, page = null;
    if (ARM === 'warm') {
      ({ ctx, page } = await makeCtx());
      // satu server + satu context: prime lalu ukur navigasi #2..N
      server = NO_SERVER ? { stop: async () => {} } : startServer(cacheDir);
      await waitPort(PORT); await sleep(600);
      await page.route('**/api/unified/chapter/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: chapterBody(urls, FAMILY) }));
      await page.route('**/api/unified/series/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: SERIES_BODY(FAMILY) }));
      await page.goto(`${BASE}${CHAPTER_PATH}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => window.__ttvi?.visible !== null, null, { timeout: 60000 }).catch(() => {});
      // Tunggu sampai SEMUA /img yang diminta prime sudah benar-benar tersimpan
      // di Cache Storage (bukan cuma 1,5 s tetap). Prime yang masih menyedot
      // bandwidth bikin iterasi #1 terukur 6 s padahal API-nya di-stub.
      // Loop di Node (bukan waitForFunction async: JSHandle-nya bisa bernilai false).
      let primeCount = 0;
      for (let k = 0; k < 60; k++) {
        primeCount = await page.evaluate(async () => {
          const keys = (await caches.keys()).filter(k => k.startsWith('komiku-img-'));
          let n = 0;
          for (const k of keys) n += (await (await caches.open(k)).keys()).length;
          return n;
        }).catch(() => 0);
        if (primeCount >= 3) break;
        await sleep(500);
      }
      meta.swPrimeCount = primeCount;
      if (primeCount < 3) console.warn(`[warn] prime /img cuma ${primeCount} entri di Cache Storage`);
      // beri napas agar request prime terakhir selesai sebelum t0 iterasi #1
      await sleep(600);
      const sw = await page.evaluate(async () => {
        try { await navigator.serviceWorker.ready; } catch {}
        return { controller: !!navigator.serviceWorker.controller,
                 scope: navigator.serviceWorker.ready?.scope ?? null };
      });
      meta.swPrime = sw;
      if (!sw.controller) console.warn('[warn] SW belum controller → arm warm bisa terukur sebagai cold');
      await page.unroute('**/api/unified/chapter/**');
      await page.unroute('**/api/unified/series/**');
      for (let i = 0; i < ITERS; i++) {
        process.stdout.write(`[warm ${i + 1}/${ITERS}] `);
        const r = await measureOnce(page, ctx, urls, FAMILY);
        runs.push({ iter: i + 1, ...r });
        console.log(`TTVI=${r1(r.ttviMs)} ms (TTFD=${r1(r.ttfdMs)}, reveal=${r1(r.phases.E_revealMs)}), visible=${r.progressive.totalVisible}, SW hits=${r.swCacheHits}/${r.imgRequests}`);
      }
    } else {
      // cold: server FRESH + cache-dir BERBEDA + context BARU tiap iterasi
      for (let i = 0; i < ITERS; i++) {
        ({ ctx, page } = await makeCtx());
        const dir = `${cacheDir}-i${i + 1}-${Date.now()}`;
        if (!NO_SERVER) { server = startServer(dir); await waitPort(PORT); await sleep(500); }
        else { server = { stop: async () => {} }; await sleep(200); }
        process.stdout.write(`[cold ${i + 1}/${ITERS}] `);
        let r;
        try { r = await measureOnce(page, ctx, urls, FAMILY); }
        catch (e) { r = { ok: false, error: e.message, ttviMs: NaN, ttfdMs: NaN, phases: {}, progressive: {}, hostStats: {} }; }
        runs.push({ iter: i + 1, cacheDir: dir, ...r });
        console.log(`TTVI=${r1(r.ttviMs)} ms (TTFD=${r1(r.ttfdMs)}, reveal=${r1(r.phases.E_revealMs)}), visible=${r.progressive?.totalVisible ?? '-'}, imgs=${r.imgRequests ?? '-'}${r.error ? ' ERR=' + r.error : ''}`);
        await server.stop();
        server = null;
        await ctx.close().catch(() => {}); ctx = null; page = null;
        if (i < ITERS - 1) await sleep(300);
      }
    }
    if (ctx) await ctx.close().catch(() => {});
  } catch (e) {
    console.error(`[fatal] ${e.stack || e.message}`);
    meta.fatal = e.message;
    exit = 2;
  } finally {
    if (server) await server.stop().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  const med = (k) => median(runs.map(r => r[k]));
  const medPhase = (k) => median(runs.map(r => r.phases?.[k]).filter(Number.isFinite));
  const summary = {
    medianTtviMs: med('ttviMs'), medianTtfdMs: med('ttfdMs'),
    medianGapRevealMs: median(runs.map(r => Number.isFinite(r.ttviMs) && Number.isFinite(r.ttfdMs) ? r.ttviMs - r.ttfdMs : NaN)),
    phases: {
      A_htmlMs: medPhase('A_htmlMs'), B_apiMs: medPhase('B_apiMs'),
      C_srcMs: medPhase('C_srcMs'), D_decodeMs: medPhase('D_decodeMs'),
      E_revealMs: medPhase('E_revealMs'),
    },
    medianAvgRate: median(runs.map(r => r.progressive?.avgRate)),
    medianSliceRate: median(runs.map(r => r.progressive?.sliceRate)),
    runsOk: runs.filter(r => r.ok).length, runsTotal: runs.length,
    armProof: {
      coldClean: runs.filter(r => r.swProof?.controller === false && r.swCacheHits === 0).length,
      warmControlled: runs.filter(r => r.swProof?.controller === true && r.swCacheHits > 0).length,
      totalSwHits: runs.reduce((a, r) => a + (r.swCacheHits || 0), 0),
    },
  };
  // ulw-perf: kegagalan harness BUKAN regresi. Arm yang tidak sesuai
  // → baseline ditolak (exit 2), jangan pernah dijadikan angka produksi.
  const armOk = ARM === 'cold'
    ? summary.armProof.coldClean >= Math.ceil(ITERS / 2)
    : summary.armProof.warmControlled >= Math.ceil(ITERS / 2);
  if (!meta.fatal && !armOk) {
    meta.fatal = `ARM_INVALID (${ARM}): ${JSON.stringify(summary.armProof)} — cek opsi serviceWorkers & HTTP cache`;
    console.error(`[fatal] ${meta.fatal}`);
    exit = 2;
  }
  let gate = { applied: false, verdict: 'BASELINE_ONLY' };
  if (budget !== null) {
    const breach = !Number.isFinite(summary.medianTtviMs) || summary.medianTtviMs > budget;
    const noVisible = summary.runsOk < Math.ceil(ITERS / 2);
    gate = { applied: true, budgetMs: budget, tolerancePct: TOLERANCE_PCT,
      verdict: (breach || noVisible) ? 'FAIL' : 'PASS',
      reasons: [...(breach ? [`median TTVI ${r1(summary.medianTtviMs)} > ${budget}`] : []),
                ...(noVisible ? [`hanya ${summary.runsOk}/${ITERS} run menghasilkan gambar visible`] : [])] };
    if (gate.verdict === 'FAIL') exit = 1;
  }
  summary.gate = gate;
  meta.summary = summary;
  meta.runs = runs;

  console.log('\n--- median fase (ms) ---');
  for (const [k, v] of Object.entries(summary.phases)) console.log(`  ${k.padEnd(14)} ${r1(v).padStart(9)}`);
  console.log(`  ${'TTFD'.padEnd(14)} ${r1(summary.medianTtfdMs).padStart(9)}`);
  console.log(`  ${'TTVI'.padEnd(14)} ${r1(summary.medianTtviMs).padStart(9)}  <-- metrik user`);
  console.log(`  gap TTVI-TTFD ${r1(summary.medianGapRevealMs)} ms | rate ${r2(summary.medianAvgRate)} img/s | runs ok ${summary.runsOk}/${ITERS}`);
  console.log(`GATE ${gate.verdict}${gate.budgetMs ? ` (budget ${gate.budgetMs} ms)` : ''}`);

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(meta, null, 2));
  console.log(`wrote ${OUT}`);
  process.exit(exit);
}

main();
