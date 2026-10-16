/// Bundler check script (TSX + JSX) → ESM runnable by node.
/// Vite sudah dependency project, jadi TIDAK ada tooling baru.
/// Argumen: <entry.ts> <outDir>
import { build } from 'vite'
import path from 'node:path'
import fs from 'node:fs'

const entry = path.resolve(process.argv[2])
const out = path.resolve(process.argv[3])

// URL fixture server dibaca dari file .checkbase (ditulis runner) dan
// di-define sebagai literal saat bundling, supaya benar-benar terbawa.
let base = ''
const baseFile = path.join(process.cwd(), '.checkbase')
if (fs.existsSync(baseFile)) base = fs.readFileSync(baseFile, 'utf8').trim()

await build({
  root: process.cwd(),
  logLevel: 'error',
  publicDir: false,
  define: {
    'process.env.NODE_ENV': '"development"',
    KOMIKU_CHECK_BASE: JSON.stringify(base),
  },
  // SSR: pakai transform React (jsx) bawaan Vite, target node
  ssr: { noExternal: true },
  build: {
    ssr: entry,
    outDir: out,
    emptyOutDir: true,
    minify: false,
    write: true,
    lib: false,
    assetsInlineLimit: 100000000,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'check.mjs',
        assetFileNames: '[name][extname]',
      },
    },
  },
  resolve: { conditions: ['node', 'import', 'require', 'default'] },
})
