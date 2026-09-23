#!/usr/bin/env node
/*
 * copy-electron-build.js
 *
 * Finds the Windows installer that app/ just built and copies it into the website's
 * public/electron/ folder as Myto-Setup.exe, so download/index.html can link to
 * /electron/Myto-Setup.exe without hardcoding a version.
 *
 * A script rather than a shell command because the artifact name is set by
 * app/electron-builder.yml and its output dir is release/, neither of which globs portably
 * from a package.json script on Windows and macOS. Root package.json is "type": "module", so
 * this file is ESM. Plain node:fs, no deps, no network.
 *
 * Set SYLOR_ALLOW_MISSING_ELECTRON=1 for a web-only build: warn and exit 0 instead of failing.
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// release/ is what app/electron-builder.yml configures; dist/ is probed as a fallback.
const SOURCE_DIRS = [join(ROOT, 'app', 'release'), join(ROOT, 'app', 'dist')]
const TARGET_NAME = 'Myto-Setup.exe'
const TARGET_DIR = join(ROOT, 'public', 'electron')
const TARGET_PATH = join(TARGET_DIR, TARGET_NAME)

function rel(p) {
  return p.slice(ROOT.length).replace(/^[/\\]+/, '').split(/[/\\]/).join('/')
}

async function candidates() {
  const found = []
  for (const dir of SOURCE_DIRS) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase()
      // Top-level .exe only: win-unpacked/ is a directory, and NSIS writes a matching
      // intermediate file (Myto-Setup.__uninstaller.exe) beside the real installer.
      if (!entry.isFile() || !lower.endsWith('.exe')) continue
      if (lower.includes('uninstall') || lower.includes('portable') || lower.includes('elevate')) continue
      const info = await stat(join(dir, entry.name))
      found.push({ name: entry.name, path: join(dir, entry.name), size: info.size, mtime: info.mtimeMs })
    }
  }
  const score = (n) => (n === TARGET_NAME ? 0 : n.toLowerCase().includes('setup') ? 1 : 2)
  return found.sort((a, b) => score(a.name) - score(b.name) || b.mtime - a.mtime || b.size - a.size)
}

async function main() {
  const found = await candidates()

  if (!found.length) {
    const where = SOURCE_DIRS.map(rel).join(' or ')
    if (process.env.SYLOR_ALLOW_MISSING_ELECTRON === '1') {
      console.warn('[copy-electron-build] no installer in ' + where + ' - skipped (web-only build).')
      return
    }
    throw new Error(
      '[copy-electron-build] no .exe installer found in ' + where + '.\n' +
        'Run npm run build:electron first (npm --prefix app run dist:win), which writes\n' +
        'app/release/Myto-Setup.exe via electron-builder.\n' +
        'For a web-only build, set SYLOR_ALLOW_MISSING_ELECTRON=1.'
    )
  }

  const source = found[0]
  await mkdir(TARGET_DIR, { recursive: true })

  // Idempotent: a re-copy of the same bytes would invalidate the CDN cache for a ~150 MB file.
  try {
    const existing = await stat(TARGET_PATH)
    if (existing.size === source.size) {
      console.log('[copy-electron-build] ' + TARGET_NAME + ' is up to date (' + source.name + ').')
      return
    }
  } catch {
    // nothing copied yet
  }

  await copyFile(source.path, TARGET_PATH)
  const copied = await stat(TARGET_PATH)
  console.log(
    '[copy-electron-build] ' + rel(source.path) + ' -> public/electron/' + TARGET_NAME +
      ' (' + (copied.size / 1024 / 1024).toFixed(1) + ' MB)'
  )
  if (found.length > 1) {
    console.log('[copy-electron-build] other .exe files ignored: ' + found.slice(1).map((f) => f.name).join(', '))
  }
  console.log('[copy-electron-build] served by the site at /electron/' + TARGET_NAME)
  console.log(
    '[copy-electron-build] run the web build AFTER this: Vite copies public/ into dist/ when\n' +
      '                    it runs, so an installer that arrives later is never published.'
  )
}

main().catch((err) => {
  console.error(err.message || String(err))
  process.exit(1)
})
