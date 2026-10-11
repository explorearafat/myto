import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const out = join(here, 'dist')

// Read the version straight from package.json so `myto --version` and the npm
// package can never drift apart (single source of truth). esbuild inlines the
// define, so there is no runtime file read at all.
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  entryPoints: [join(here, 'src/cli.ts')],
  outfile: join(out, 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // npm dependencies are dev-only tooling; the engine code comes from ../app/src.
  external: [],
  sourcemap: false,
  legalComments: 'none',
  minify: false,
  banner: {
    // esbuild does not preserve the source shebang; re-add it and make CRLF-safe.
    js: '#!/usr/bin/env node'
  },
  define: {
    'process.env.MYTO_CLI': '"1"',
    MYTO_CLI_VERSION: JSON.stringify(pkg.version ?? '0.0.0')
  },
  logLevel: 'info'
})

// esbuild writes LF, but the shebang must be on line 1 regardless; ensure the
// file is executable-bit friendly content-wise (npm sets the bit from bin).
const p = join(out, 'cli.js')
const text = readFileSync(p, 'utf8')
if (!text.startsWith('#!')) writeFileSync(p, '#!/usr/bin/env node\n' + text.replace(/^#!/, ''), 'utf8')

console.log('built dist/cli.js')
