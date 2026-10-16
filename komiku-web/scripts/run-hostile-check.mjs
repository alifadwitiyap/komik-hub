/**
 * Runner QA adversarial (W3–W7). Tidak menyentuh file produksi.
 * Pola sama dengan scripts/run-wiring-check.mjs: fixture server + bundling
 * + child check di satu proses (port acak).
 *
 *   node scripts/run-hostile-check.mjs          → analisa statis + render SSR
 *   node scripts/run-hostile-check.mjs --browser → + probe browser nyata
 *
 * Mode --browser meluncurkan browser (jika ada) dan mengerjakan skrip
 * scripts/browser-probe.cjs lintas halaman; gagal CDP/launcher = BLOCKED
 * (bukan FAIL), sesuai kontrak laporan QA.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startHostileServer } from './hostile-fixture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const withBrowser = process.argv.includes('--browser')

const { server, base } = await startHostileServer(0)
fs.writeFileSync(path.join(ROOT, '.checkbase'), base)
console.log(`hostile fixture server: ${base}`)

function sh(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' })
    c.on('exit', (code) => resolve(code ?? 1))
  })
}

// ------------------------------------------------------- fase 1: node statis
const bundleCode = await sh(process.execPath, [
  path.join(ROOT, 'scripts/vite-run-check.mjs'),
  'scripts/hostile-check.ts',
  path.join(ROOT, '.checktmp'),
])
if (bundleCode !== 0) {
  fs.rmSync(path.join(ROOT, '.checkbase'), { force: true })
  server.close()
  console.error('FASE 1 (bundling) GAGAL')
  process.exitCode = 1
} else {
  const checkCode = await sh(process.execPath, [path.join(ROOT, '.checktmp/check.mjs')])
  if (checkCode !== 0) process.exitCode = 1
  console.log(checkCode === 0 ? 'FASE 1 (analisa statis + render SSR): PASS' : 'FASE 1: FAIL')
}

// --------------------------------------------------- fase 2: browser nyata
if (withBrowser) {
  console.log('\nFASE 2 (browser nyata):')
  const browserCode = await sh(process.execPath, [
    path.join(ROOT, 'scripts/browser-probe.cjs'),
    base,
  ])
  console.log(browserCode === 0 ? 'FASE 2: PASS' : 'FASE 2: hasil di atas')
} else {
  console.log('FASE 2 (browser nyata): dilewati (pakai --browser)')
}

fs.rmSync(path.join(ROOT, '.checkbase'), { force: true })
server.close()
