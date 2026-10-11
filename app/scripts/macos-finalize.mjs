#!/usr/bin/env node
/**
 * Ad-hoc sign the packaged macOS app, then rebuild the dmg/zip from that signed
 * bundle.
 *
 * Why this exists
 * ---------------
 * electron-builder.yml sets `mac.identity: null` because this project has no
 * Apple Developer ID certificate. On x64 that is merely a Gatekeeper warning.
 * On arm64 (Apple silicon) it is fatal: the kernel refuses to execute a binary
 * with no signature at all, so an unsigned Myto.app does not launch — the icon
 * just bounces and dies. An ad-hoc signature (`codesign -s -`) is enough to make
 * it run. The user still sees Gatekeeper's "unidentified developer" prompt on
 * first open, which is the accepted trade-off documented on the download page.
 *
 * Ordering matters
 * ----------------
 * Signing must go bottom-up: nested code (dylibs, .node addons, frameworks,
 * Helper .app bundles) has to be sealed before the bundle that contains it, or
 * the outer signature records hashes that immediately become stale. Using
 * `codesign --deep` would paper over this, but Apple deprecated --deep for
 * signing precisely because it signs in an unreliable order and skips
 * entitlements on children. So we walk the tree ourselves, sorted by path depth
 * descending — deepest first.
 *
 * Repackaging
 * -----------
 * The dmg and zip produced by `electron-builder` were built from the *unsigned*
 * bundle. Editing the bundle in place leaves them stale, so we hand the signed
 * bundle back to electron-builder via `--prepackaged`, which regenerates both
 * targets from what is actually on disk. Pass --no-repackage to sign only.
 *
 * Usage (from app/):
 *   node scripts/macos-finalize.mjs [--no-repackage] [--arch=arm64|x64]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_DIR = join(APP_DIR, 'release')
const RESOURCES = join(APP_DIR, 'resources')

const PRODUCT_NAME = 'Myto'
const MAIN_ENTITLEMENTS = join(RESOURCES, 'entitlements.mac.plist')
const INHERIT_ENTITLEMENTS = join(RESOURCES, 'entitlements.mac.inherit.plist')

const argv = process.argv.slice(2)
const repackage = !argv.includes('--no-repackage')
const archArg = argv.find((a) => a.startsWith('--arch='))?.split('=')[1]

/** Run a command, echoing it, and fail loudly with its own stderr on error. */
function run(cmd, args, opts = {}) {
  process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`)
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

function fail(msg) {
  process.stderr.write(`\nmacos-finalize: ${msg}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. Locate the app bundle electron-builder just produced.
//    Output layout is release/mac-arm64/Myto.app, release/mac/Myto.app (x64), or
//    release/mac-universal/ for a universal build. Prefer an explicit --arch.
// ---------------------------------------------------------------------------
if (process.platform !== 'darwin') {
  // Not an error worth failing the whole CI job over if a Windows dev runs
  // `npm run dist:mac` by mistake — say so and stop cleanly.
  process.stdout.write('macos-finalize: not macOS, nothing to sign (skipping).\n')
  process.exit(0)
}

if (!existsSync(RELEASE_DIR)) fail(`no release/ directory at ${RELEASE_DIR}`)

const candidates = readdirSync(RELEASE_DIR)
  .filter((d) => d.startsWith('mac'))
  .map((d) => ({ dir: d, app: join(RELEASE_DIR, d, `${PRODUCT_NAME}.app`) }))
  .filter((c) => existsSync(c.app))

if (candidates.length === 0) fail(`no ${PRODUCT_NAME}.app found under ${RELEASE_DIR}`)

let target = candidates[0]
if (archArg) {
  const wanted = candidates.find((c) =>
    archArg === 'x64' ? c.dir === 'mac' || c.dir.includes('x64') : c.dir.includes(archArg),
  )
  if (!wanted) {
    fail(`no packaged app for --arch=${archArg}; found: ${candidates.map((c) => c.dir).join(', ')}`)
  }
  target = wanted
}

const APP = target.app
process.stdout.write(`macos-finalize: signing ${relative(APP_DIR, APP)}\n`)

// ---------------------------------------------------------------------------
// 2. Collect every nested piece of code, deepest path first.
// ---------------------------------------------------------------------------
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) {
        // A nested helper .app is sealed as a unit; do not descend into it.
        acc.push({ path: full, kind: 'app' })
      } else {
        walk(full, acc)
      }
    } else if (/\.(dylib|so|node)$/.test(entry.name)) {
      acc.push({ path: full, kind: 'lib' })
    } else if (entry.name === 'Electron Framework') {
      // The Mach-O binary inside Electron Framework.framework/Versions/A/.
      acc.push({ path: full, kind: 'lib' })
    }
  }
  return acc
}

const nested = walk(APP).sort((a, b) => b.path.split(/[\\/]/).length - a.path.split(/[\\/]/).length)

const frameworksDir = join(APP, 'Contents', 'Frameworks')
if (existsSync(frameworksDir)) {
  for (const entry of readdirSync(frameworksDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.framework')) {
      nested.push({ path: join(frameworksDir, entry.name), kind: 'framework' })
    }
  }
}

// Sign nested code first (no entitlements — these are libraries and helpers that
// never request device access; the main process brokers all of that).
for (const item of nested) {
  const args = ['--force', '--sign', '-', '--timestamp=none']
  if (item.kind === 'app') {
    // Helper .app bundles DO get the inherit entitlements: each runs its own V8
    // isolate and needs the JIT exceptions, mirroring mac.entitlementsInherit.
    args.push('--entitlements', INHERIT_ENTITLEMENTS)
  }
  args.push(item.path)
  try {
    run('codesign', args)
  } catch (err) {
    fail(`failed to sign ${relative(APP, item.path)}:\n${err.stderr || err.message}`)
  }
}

// ---------------------------------------------------------------------------
// 3. Seal the outer bundle last, with the full entitlement set.
// ---------------------------------------------------------------------------
try {
  run('codesign', [
    '--force',
    '--sign',
    '-',
    '--timestamp=none',
    '--entitlements',
    MAIN_ENTITLEMENTS,
    APP,
  ])
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', APP])
} catch (err) {
  fail(`signing/verification of the app bundle failed:\n${err.stderr || err.stdout || err.message}`)
}

// Show the resulting signature so the CI log proves what happened.
try {
  process.stdout.write(run('codesign', ['--display', '--verbose=4', APP]))
} catch {
  /* --display writes to stderr on some versions; non-fatal */
}

// ---------------------------------------------------------------------------
// 4. Rebuild dmg + zip from the signed bundle.
// ---------------------------------------------------------------------------
if (!repackage) {
  process.stdout.write('\nmacos-finalize: --no-repackage set; leaving existing dmg/zip alone.\n')
  process.exit(0)
}

if (!statSync(APP).isDirectory()) fail('app bundle vanished before repackaging')

// Drop the stale unsigned artifacts so a failed repackage cannot be mistaken
// for success by a later `ls release/*.dmg`.
for (const f of readdirSync(RELEASE_DIR)) {
  if (/\.(dmg|zip)$/.test(f)) rmSync(join(RELEASE_DIR, f), { force: true })
}

try {
  run(
    'npx',
    [
      'electron-builder',
      '--mac',
      `--prepackaged=${APP}`,
      '--publish',
      'never',
      ...(archArg ? [`--${archArg}`] : []),
    ],
    { cwd: APP_DIR },
  )
} catch (err) {
  fail(`repackaging from the signed bundle failed:\n${err.stderr || err.stdout || err.message}`)
}

const artifacts = readdirSync(RELEASE_DIR).filter((f) => /\.(dmg|zip)$/.test(f))
if (artifacts.length === 0) fail('repackaging produced no dmg/zip — check the electron-builder log above')

process.stdout.write('\nmacos-finalize: done. Signed artifacts:\n')
for (const f of artifacts) {
  process.stdout.write(`  ${f}  ${statSync(join(RELEASE_DIR, f)).size.toLocaleString()} bytes\n`)
}