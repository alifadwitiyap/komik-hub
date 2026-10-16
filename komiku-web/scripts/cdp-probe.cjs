/**
 * Probe browser nyata via CDP (tanpa dependency): submit pencarian pada
 * fixture server BROKEN (semua /api/unified/* → 500 HTML) dan memeriksa
 * apakah Search.tsx jatuh ke fallback /api/search legacy — bukan layar putih.
 *
 *   node scripts/cdp-probe.cjs <baseUrl> <baseQuery>
 * Contoh: node scripts/cdp-probe.cjs http://127.0.0.1:8900 q=one
 */
const http = require('node:http')

const BASE = process.argv[2]
const STEP = process.argv[3] || 'search'
const CDP = 'http://127.0.0.1:9333'

/** WS minimal: cukup untuk Target.attachToTarget/runtime messages (tanpa lib). */
function httpJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get(CDP + path, (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(d))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

async function main() {
  const list = await httpJson('/json/list')
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('tidak ada target page di CDP')

  // Websocket ke ws endpoint (pakai modul undici? Node 22 punya WebSocket global)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result?.result?.value
  }

  if (STEP === 'nav') {
    await send('Page.navigate', { url: BASE })
    await new Promise((r) => setTimeout(r, 2500))
    const html = await evalJs('document.documentElement.outerHTML')
    console.log(html)
    ws.close()
    return
  }

  // STEP = search: buka /cari, ketik query, submit, tunggu render
  await send('Page.navigate', { url: `${BASE}/cari` })
  await new Promise((r) => setTimeout(r, 1500))
  const typed = await evalJs(`
    (() => {
      const form = document.querySelector('form')
      const input = form?.querySelector('input')
      if (!form || !input) return { ok:false, reason:'form tidak terrender' }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
      setter.call(input, 'one')
      input.dispatchEvent(new Event('input', {bubbles:true}))
      return { ok:true, q: input.value }
    })()
  `)
  if (!typed?.ok) throw new Error('input pencarian tidak ditemukan: ' + JSON.stringify(typed))
  await new Promise((r) => setTimeout(r, 300))
  const submitted = await evalJs(`
    (() => {
      const form = document.querySelector('form')
      form?.requestSubmit ? form.requestSubmit() : form?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 3000))
  const state = await evalJs(`
    (() => {
      const txt = document.body.innerText
      let rows = 0
      try { rows = document.querySelectorAll('ul[class*="space-y-2"] > li').length } catch (e) {}
      return {
        rows,
        hasilHeader: (txt.match(/(\\d+) hasil/)?.[1]) ?? null,
        legacyHit: txt.includes('LEGACY'),
        failedBanner: txt.includes('sumber gagal'),
        errorEmpty: txt.includes('Pencarian gagal') || txt.includes('Gagal memuat'),
        notFoundRoute: txt.includes('Halaman tidak ada'),
        bodyEmpty: txt.bodyInner ?? (txt.trim().length === 0),
        bodyLen: txt.trim().length,
        snippet: txt.slice(0, 240),
      }
    })()
  `)
  const html = await evalJs('document.documentElement.outerHTML')
  const rawScript = /<script>alert\(\d\)<\/script>/.test(html)
  const rawHandler = /<img[^>]+onerror=/i.test(html)
  console.log(
    JSON.stringify(
      { submitted, state, rawScriptInDom: rawScript, rawHandlerInDom: rawHandler },
      null,
      2,
    ),
  )
  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('PROBE ERROR:', e.message)
  process.exitCode = 1
})
