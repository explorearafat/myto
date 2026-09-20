#!/usr/bin/env node
/*
 * Fixtures for remove-comments.mjs. Plain node:assert so it runs with
 * `node scripts/remove-comments.test.mjs` and needs no vitest config in either
 * workspace. Each case pins a preservation rule the remover must never break.
 *
 *   shebang · URL in a string · `//` in JSX copy · regex containing //
 *   template literal with ${} and backticks · JSX brace-comment removal
 * Never write a real comment closer inside this header, even as an example.
 *   @ts-* / eslint / @license directives kept · trailing comment keeps its code
 *   Dart nested block comments · Dart raw + triple-quoted strings · CRLF
 *   idempotence (a second pass finds nothing left to remove)
 */

import assert from 'node:assert/strict'
import { stripComments, applyRemovals, commentRangesFor } from './remove-comments.mjs'

const cases = []
const test = (name, fn) => cases.push([name, fn])
const run = (text, file) => stripComments(text, { path: file }).out
const tally = (text, file) => stripComments(text, { path: file }).stats

const dedent = (s) =>
  s
    .split('\n')
    .slice(1, -1)
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n') + '\n'

test('removes a whole-line // comment and the line with it', () => {
  assert.equal(run('const a = 1\n// gone\nconst b = 2\n', 'a.ts'), 'const a = 1\nconst b = 2\n')
})

test('removes a block comment that owns its lines', () => {
  assert.equal(run('/*\n * gone\n */\nconst a = 1\n', 'a.ts'), 'const a = 1\n')
})

test('trims a trailing // comment but keeps the code and the next line', () => {
  assert.equal(run('const a = 1 // trailing\nconst b = 2\n', 'a.ts'), 'const a = 1\nconst b = 2\n')
})

test('keeps code that follows an inline block comment', () => {
  assert.equal(run('const a = /* mid */ 1\n', 'a.ts'), 'const a =  1\n')
  assert.equal(run('x = y /* a */ + z\n', 'a.ts'), 'x = y  + z\n')
})

test('preserves a shebang, and still cleans after it', () => {
  assert.equal(run('#!/usr/bin/env node\n// gone\nexport const a = 1\n', 'a.mjs'), '#!/usr/bin/env node\nexport const a = 1\n')
})

test('preserves URLs inside strings and template literals', () => {
  const src = dedent(`
    const url = 'https://api.b.ai/v1/' // gone
    const md = \`read [docs](https://example.com/a) and // not a comment\` // gone
    export { url, md }
  `)
  const out = run(src, 'a.ts')
  assert.match(out, /'https:\/\/api\.b\.ai\/v1\/'/)
  assert.match(out, /https:\/\/example\.com\/a\) and \/\/ not a comment/)
  assert.equal(out.includes('gone'), false)
})

test('preserves a regex literal whose body contains // and a slash', () => {
  const src = "const re = /a[//]b\\/c/g // gone\nconst div = 4 / 2\n"
  const out = run(src, 'a.ts')
  assert.match(out, /\/a\[\/\/\]b\\\/c\/g/)
  assert.match(out, /const div = 4 \/ 2/)
  assert.ok(!out.includes('gone'))
})

test('preserves /* inside a regex character class', () => {
  const src = "const re = /\/*[/*]/ // gone\n"
  const out = run(src, 'a.ts')
  assert.match(out, /\/\*\[\/\*\]\//)
  assert.ok(!out.includes('gone'))
})

test('keeps comments inside a template literal body, removes real ones', () => {
  const src = 'const t = `// not a comment\n/* nor this */`\n// gone\nexport default t\n'
  const out = run(src, 'a.ts')
  assert.match(out, /`\/\/ not a comment/)
  assert.match(out, /\/\* nor this \*\//)
  assert.ok(!out.includes('gone'))
})

test('sees through a nested ${} in a template literal', () => {
  const src = 'const t = `${a /* gone */} and ${f("// kept as string")}`\n'
  const out = run(src, 'a.ts')
  assert.match(out, /\$\{a \}/)
  assert.match(out, /"\/\/ kept as string"/)
})

test('removes a {/* */} comment inside JSX but not // written as copy', () => {
  const src = dedent(`
    export const A = () => (
      <p>
        {/* gone */}
        See https://x.io/y and a // b for details.
      </p>
    )
  `)
  const out = run(src, 'Hero.tsx')
  assert.ok(!out.includes('gone'), 'JSX expression comment removed')
  assert.match(out, /https:\/\/x\.io\/y/)
  assert.match(out, /a \/\/ b for details/)
})

test('keeps tool directives, and strips them on request', () => {
  const src = [
    '// @ts-expect-error — deliberate',
    'const a: number = b // eslint-disable-line no-undef',
    '/* eslint-disable */',
    '/* istanbul ignore next */',
    '// @license MIT',
    '// plain',
    'export default a\n',
  ].join('\n')
  const kept = stripComments(src, { path: 'a.ts' })
  for (const frag of ['@ts-expect-error', 'eslint-disable-line', '/* eslint-disable */', 'istanbul ignore next', '@license MIT']) {
    assert.ok(kept.out.includes(frag), frag)
  }
  assert.ok(!kept.out.includes('// plain'))
  assert.equal(kept.stats.kept, 5)
  const stripped = stripComments(src, { path: 'a.ts', keepDirectives: false })
  assert.ok(!stripped.out.includes('@ts-expect-error'))
  assert.ok(!stripped.out.includes('eslint-disable'))
  assert.ok(!stripped.out.includes('@license'))
  assert.equal(stripped.stats.kept, 0)
})

test('preserves a comment-start token inside a string on a comment line', () => {
  assert.equal(run('const s = "//x" // gone\n', 'a.ts'), 'const s = "//x"\n')
})

test('keeps a blank line that was blank, and one that becomes empty after a trailing comment', () => {
  assert.equal(run('a\n\nb\n', 'a.ts'), 'a\n\nb\n')
})

test('leaves the indentation of a comment line that shares itself with code', () => {
  const src = '  if (ok) {\n    doThing() // gone\n  }\n'
  assert.equal(run(src, 'a.ts'), '  if (ok) {\n    doThing()\n  }\n')
})

test('handles CRLF line endings without mixing them up', () => {
  const out = run('const a = 1\r\n// gone\r\nconst b = 2 // also\r\n', 'a.ts')
  assert.equal(out, 'const a = 1\r\nconst b = 2\r\n')
})

test('is idempotent over a real-shaped TS module', () => {
  const src = dedent(`
    import path from 'node:path'

    // Header block.
    /** Doc comment. */
    export function go(dir /* inline */) {
      const url = 'https://x.dev' // trailing
      const re = /^\\/api\\/.*$/
      return path.join(dir, url, String(re.test('a/b')))
    }
  `)
  const once = run(src, 'a.ts')
  assert.equal(run(once, 'a.ts'), once)
  assert.equal(tally(once, 'a.ts').line + tally(once, 'a.ts').block, 0)
  assert.match(once, /\^\\\/api\\\/\.\*\$\//)
})

test('Dart: removes // and /// docs, keeps package URIs and strings', () => {
  const src = dedent(`
    // Header comment.
    /// Doc comment.
    import 'package:flutter/material.dart';
    import 'dart:async'; // trailing

    const kUrl = 'https://sylor.dev/x';
    const kPath = r'C:\\logs\\//keep';

    void main() {
      runApp(const App()); // ignore: prefer_const_constructors
    }
  `)
  const out = run(src, 'a.dart')
  assert.match(out, /package:flutter\/material\.dart/)
  assert.match(out, /'https:\/\/sylor\.dev\/x'/)
  assert.match(out, /r'C:\\\\logs\\\\\/\/keep'/)
  assert.match(out, /ignore: prefer_const_constructors/)
  assert.ok(!out.includes('Header comment'))
  assert.ok(!out.includes('Doc comment'))
})

test('Dart: nested block comments close correctly', () => {
  const src = '/* outer /* inner */ still outer */\nconst a = 1;\n'
  assert.equal(run(src, 'a.dart'), 'const a = 1;\n')
})

test('Dart: triple-quoted strings and ${} interpolation are respected', () => {
  const src = "const s = '''\n// not a comment\n/* nor this */\n''';\nconst t = '\${x /* gone */} y';\n"
  const out = run(src, 'a.dart')
  assert.match(out, /\/\/ not a comment/)
  assert.match(out, /\/\* nor this \*\//)
  assert.ok(!out.includes('gone'))
})

test('Dart: a // inside a normal string is not a comment', () => {
  assert.equal(run("const a = 'x//y';\n// gone\n", 'a.dart'), "const a = 'x//y';\n")
})

test('applies an empty range list untouched', () => {
  const { out } = applyRemovals('const a = 1\n', [])
  assert.equal(out, 'const a = 1\n')
})

test('overlapping ranges do not double count or corrupt', () => {
  const src = '// gone\nconst a = 1\n'
  const ranges = commentRangesFor('a.ts', src)
  const doubled = [...ranges, ...ranges]
  assert.equal(applyRemovals(src, doubled).out, 'const a = 1\n')
})

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}`)
    console.log(String(err.message).split('\n').slice(0, 12).map((l) => `        ${l}`).join('\n'))
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
if (failed) process.exit(1)
