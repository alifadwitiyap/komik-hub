/**
 * Runner cek lane akun (web): bundle skrip TS lalu jalankan di node
 * (pakai bundler Vite yang sudah jadi dependency — tanpa tooling baru).
 * Terpisah dari run-wiring-check.mjs supaya hitungan gate utama tidak berubah.
 *
 *   node scripts/akun-check.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '.checktmp-akun')

const run = (args) =>
  new Promise((resolve, reject) => {
    const c = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
    c.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`node ${args.join(' ')} exit ${code}`)),
    )
  })

try {
  await run(['scripts/vite-run-check.mjs', 'scripts/akun-check.ts', OUT])
  await run([path.join(OUT, 'check.mjs')])
} finally {
  fs.rmSync(OUT, { recursive: true, force: true })
}
