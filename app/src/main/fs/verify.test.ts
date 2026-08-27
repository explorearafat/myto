import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { contextManager } from '@main/context/manager'
import { describeIssues, recheckWrittenFile, verifyWrittenFile } from '@main/fs/verify'

/**
 * The checker resolves references (imports, assets) against
 * `contextManager.getRoot()`, so each case gets a throwaway project root.
 *
 * The heaviest emphasis here is on what the checker must NOT report. A false
 * positive doesn't just annoy — it is fed straight back into the agent loop as
 * "fix this", which would send Sylor off rewriting code that already worked. Every
 * "leaves good files alone" case below is a shape that a naive scanner gets wrong.
 */
let root: string
let originalRoot: string

beforeEach(() => {
  originalRoot = contextManager.getRoot()
  root = mkdtempSync(join(tmpdir(), 'sylor-verify-'))
  contextManager.setRoot(root)
})

afterEach(() => {
  contextManager.setRoot(originalRoot)
  rmSync(root, { recursive: true, force: true })
})

/** The messages the checker produced for `path`. */
function check(path: string, content: string): string[] {
  return verifyWrittenFile(path, content).map((issue) => issue.message)
}

/** Creates a project file (and any parent dirs) so references to it resolve. */
function touch(relPath: string, content = ''): void {
  const abs = join(root, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

describe('leaves good files alone (a false positive is worse than no check)', () => {
  it('passes a real React component, JSX closing tags and all', () => {
    touch('src/Button.tsx', 'export const Button = () => null\n')
    const content = `import { Button } from './Button'

export function List({ items }: { items: string[] }): JSX.Element {
  return (
    <div className="list">
      <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>
      <Button />
      {items.length === 0 && <p>Nothing yet</p>}
    </div>
  )
}
`
    // Every `</…>` sits directly after a `<`, which a naive regex heuristic reads
    // as the start of a regex literal — swallowing the `)` and `}` after `</li>`
    // and reporting this valid component as truncated.
    expect(check('src/List.tsx', content)).toEqual([])
  })

  it('passes regex literals containing braces, quotes and slashes', () => {
    const content = `const BRACE = /\\{\\{|\\$\\{/
const QUOTED = /['"\`]/g
const PATH = /^\\/src\\//
const CLASS = /[^{}]+/
export const all = [BRACE, QUOTED, PATH, CLASS]
`
    expect(check('src/regexes.ts', content)).toEqual([])
  })

  it('passes an arrow function whose body is a regex test', () => {
    // `=>` is why `>` cannot count as a value position: misreading this regex as
    // division would leak its `{` onto the bracket stack.
    const content = `export const starts = (xs: string[]) => xs.filter((s) => /^\\{a/.test(s))\n`
    expect(check('src/filter.ts', content)).toEqual([])
  })

  it('passes nested template literals with interpolation', () => {
    const content = `const name = 'world'
const inner = \`inner \${name}\`
const outer = \`a \${ { k: \`\${inner}\` }.k } b \${name === '}' ? '{' : '}'} c\`
export default outer
`
    expect(check('src/templates.ts', content)).toEqual([])
  })

  it('passes strings and comments that contain code punctuation', () => {
    const content = `// don't worry about this }
/* this ) is not a closer, nor is this { */
const open = '{'
const close = "}"
const url = 'https://example.com/a//b'
const notAComment = '/* still a string */'
export default [open, close, url, notAComment]
`
    expect(check('src/punctuation.ts', content)).toEqual([])
  })

  it('passes ordinary division', () => {
    const content = `export const half = (total: number, n: number): number => total / n / 2\n`
    expect(check('src/math.ts', content)).toEqual([])
  })

  it('passes CSS with url(), media queries and calc()', () => {
    touch('bg.png')
    const content = `@media (min-width: 600px) {
  .hero {
    background: url(bg.png) no-repeat;
    width: calc(100% / 3);
    content: "}";
  }
}
`
    expect(check('styles.css', content)).toEqual([])
  })

  it('accepts a tsconfig with comments and a trailing comma', () => {
    // JSONC: legal for tsconfig/jsconfig/.vscode, and strict-parsing it would
    // report a syntax error in a file every toolchain reads happily.
    const jsonc = `{
  // the app's compiler options
  "compilerOptions": {
    "strict": true,
  }
}
`
    expect(check('tsconfig.json', jsonc)).toEqual([])
    expect(check('tsconfig.app.json', jsonc)).toEqual([])
    expect(check('jsconfig.json', jsonc)).toEqual([])
    expect(check('.vscode/settings.json', jsonc)).toEqual([])
  })

  it('says nothing about file types it cannot judge', () => {
    expect(check('README.md', '# Title {{{ unbalanced ((( on purpose')).toEqual([])
    expect(check('main.py', 'def f(:\n')).toEqual([])
    expect(check('notes.txt', '}}}')).toEqual([])
    expect(check('Makefile', 'all:\n\techo {')).toEqual([])
  })

  it('ignores bare, scoped and aliased imports', () => {
    // None of these are ours to resolve: they live in node_modules or behind a
    // bundler/tsconfig alias table, so judging them would be confident nonsense.
    const content = `import React from 'react'
import { z } from '@scope/lib'
import type { Thing } from '@shared/types'
import { store } from '@/store'
import { util } from '~/util'
import 'side-effect-package/styles.css'
export default [React, z, store, util] as unknown as Thing
`
    expect(check('src/imports.ts', content)).toEqual([])
  })

  it('ignores remote, data and templated HTML references', () => {
    const content = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="https://cdn.example.com/a.css" />
    <link rel="canonical" href="/about" />
    <script src="//cdn.example.com/b.js"></script>
  </head>
  <body>
    <img src="data:image/gif;base64,R0lGOD" alt="" />
    <img src="{{ user.avatar }}" alt="" />
    <img src="<%= asset_path %>" alt="" />
    <a href="does-not-exist-yet.html">Later</a>
    <a href="#top">Top</a>
  </body>
</html>
`
    expect(check('index.html', content)).toEqual([])
  })

  it('ignores markup that is commented out', () => {
    const content = `<!doctype html>
<!-- <script src="deleted.js"></script> -->
<p>hi</p>
`
    expect(check('index.html', content)).toEqual([])
  })

  it('ignores an import that is commented out', () => {
    const content = `// import { gone } from './gone'
/* import { alsoGone } from './also-gone' */
export const kept = 1
`
    expect(check('src/kept.ts', content)).toEqual([])
  })
})

describe('malformed JSON', () => {
  it('reports invalid JSON, quoting the parser', () => {
    const issues = check('package.json', '{ "name": "app", }')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatch(/not valid JSON/)
  })

  it('reports a package.json truncated mid-write', () => {
    // The one that poisons everything after it: no script can run.
    expect(check('package.json', '{ "scripts": { "dev": ')[0]).toMatch(/not valid JSON/)
  })

  it('says nothing about an empty file', () => {
    // A deliberate placeholder, not a mistake.
    expect(check('data.json', '')).toEqual([])
    expect(check('data.json', '\n  \n')).toEqual([])
  })

  it('passes valid JSON', () => {
    expect(check('package.json', '{\n  "name": "app"\n}\n')).toEqual([])
  })
})

describe('truncated or unbalanced source', () => {
  it('reports an unclosed brace and where it opened', () => {
    const issues = check('src/greet.ts', 'export function greet() {\n  console.log(1)\n')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatch(/'\{' opened on line 1/)
    expect(issues[0]).toMatch(/never closed/)
  })

  it('counts how many are left open', () => {
    const issues = check('src/deep.ts', 'function a() {\n  if (x) {\n    while (y) {\n')
    expect(issues[0]).toMatch(/3 unclosed in total/)
  })

  it('reports an unterminated string', () => {
    const issues = check('src/a.ts', "const a = 'hello\nconst b = 2\n")
    expect(issues[0]).toMatch(/unterminated string starting on line 1/)
  })

  it('reports an unterminated template literal', () => {
    const issues = check('src/a.ts', 'const a = `hello\nworld\n')
    expect(issues[0]).toMatch(/unterminated template literal starting on line 1/)
  })

  it('reports an unterminated block comment', () => {
    const issues = check('src/a.ts', 'const a = 1\n/* explaining a\n')
    expect(issues[0]).toMatch(/unterminated block comment opened on line 2/)
  })

  it('reports a closer that contradicts its opener', () => {
    const issues = check('src/a.ts', 'function f() {\n  return [1, 2)\n}\n')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatch(/'\)' on line 2 does not close '\[' from line 2/)
  })

  it('stays silent about a surplus closer', () => {
    // Deliberate: a stray closer is the one thing a mis-tokenized regex can
    // manufacture, so reporting it would risk inventing errors in good files.
    // A misparse can then only ever hide a problem, never create one.
    expect(check('src/a.ts', 'const a = 1\n}\n')).toEqual([])
  })

  it('reports truncated CSS', () => {
    const issues = check('styles.css', '.hero {\n  color: red;\n')
    expect(issues[0]).toMatch(/never closed/)
  })

  it('skips the import scan on a truncated file', () => {
    // The dangling half-written tail is noise; the structural problem is the story.
    const issues = check('src/a.ts', "import { x } from './missing'\nfunction f() {\n")
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatch(/never closed/)
  })
})

describe('HTML pointing at assets that are not there', () => {
  it('names every missing render-blocking asset', () => {
    const content = `<!doctype html>
<html>
  <head><link rel="stylesheet" href="styles.css" /></head>
  <body>
    <img src="hero.png" alt="" />
    <script src="app.js"></script>
  </body>
</html>
`
    const issues = check('index.html', content)
    expect(issues).toHaveLength(3)
    expect(issues.join('\n')).toMatch(/styles\.css/)
    expect(issues.join('\n')).toMatch(/hero\.png/)
    expect(issues.join('\n')).toMatch(/app\.js/)
    expect(issues[0]).toMatch(/line 3/)
  })

  it('passes once the assets exist', () => {
    touch('styles.css', 'body{}')
    touch('app.js', 'console.log(1)')
    const content =
      '<!doctype html><link rel="stylesheet" href="styles.css"><script src="app.js"></script>'
    expect(check('index.html', content)).toEqual([])
  })

  it('resolves a root-relative reference from the project root', () => {
    touch('assets/app.js', '')
    const page = '<script src="/assets/app.js"></script>'
    // Same page nested two levels deep: `/assets/app.js` is still project-root
    // relative, which is exactly how the preview server serves it.
    expect(check('pages/deep/about.html', page)).toEqual([])
  })

  it('resolves a relative reference from the page own folder', () => {
    touch('pages/local.css', '')
    touch('shared.css', '')
    expect(check('pages/about.html', '<link rel="icon" href="local.css">')).toEqual([])
    expect(check('pages/about.html', '<link rel="icon" href="../shared.css">')).toEqual([])
    // ...and the same name at the root is NOT what a nested page means.
    const issues = check('pages/about.html', '<link rel="stylesheet" href="shared.css">')
    expect(issues).toHaveLength(1)
  })

  it('reports each missing reference once, however often it appears', () => {
    const content = '<img src="a.png"><img src="a.png"><img src="a.png">'
    expect(check('index.html', content)).toHaveLength(1)
  })
})

describe('relative imports that resolve to nothing', () => {
  it('reports a missing module and where', () => {
    const issues = check('src/App.tsx', "import { Button } from './Button'\n")
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatch(/imports '\.\/Button'/)
    expect(issues[0]).toMatch(/line 1/)
  })

  it('resolves an extensionless import through every source extension', () => {
    for (const [file, spec] of [
      ['src/a.ts', './a'],
      ['src/b.tsx', './b'],
      ['src/c.js', './c'],
      ['src/d.mjs', './d'],
      ['src/e.json', './e'],
      ['src/f.vue', './f']
    ]) {
      touch(file, '')
      expect(check('src/App.tsx', `import x from '${spec}'\n`), spec).toEqual([])
    }
  })

  it('resolves a folder with an index file, and a folder without one', () => {
    touch('src/components/index.ts', '')
    expect(check('src/App.tsx', "import x from './components'\n")).toEqual([])
    // A bare directory still counts: a package main field can make it work, and
    // guessing wrong here would be a false alarm.
    mkdirSync(join(root, 'src', 'lib'), { recursive: true })
    expect(check('src/App.tsx', "import x from './lib'\n")).toEqual([])
  })

  it('strips Vite-style query suffixes before resolving', () => {
    touch('src/logo.svg', '<svg/>')
    touch('src/shader.glsl', '')
    expect(check('src/App.tsx', "import url from './logo.svg?url'\n")).toEqual([])
    expect(check('src/App.tsx', "import raw from './shader.glsl?raw'\n")).toEqual([])
  })

  it('follows a parent-relative path', () => {
    touch('src/lib/util.ts', '')
    expect(check('src/pages/Home.tsx', "import { u } from '../lib/util'\n")).toEqual([])
    const issues = check('src/pages/Home.tsx', "import { u } from '../util'\n")
    expect(issues).toHaveLength(1)
  })

  it('catches require and dynamic import too', () => {
    const cjs = "const a = require('./a')\nconst b = import('./b')\n"
    expect(check('src/main.js', cjs)).toHaveLength(2)
  })

  it('catches a side-effect-only import', () => {
    expect(check('src/main.ts', "import './styles.css'\n")).toHaveLength(1)
  })

  it('reports each missing specifier once', () => {
    const content = "import a from './x'\nimport b from './x'\nexport default [a, b]\n"
    expect(check('src/main.ts', content)).toHaveLength(1)
  })

  it('never judges a path that climbs out of the project', () => {
    // Unknowable, not missing: the sandbox stops us looking, and in a monorepo
    // (root set to `app/`) importing `../../shared/x` is perfectly normal.
    expect(check('src/main.ts', "import a from '../../../../etc/passwd'\n")).toEqual([])
    expect(check('src/main.ts', "import a from '../../shared/util'\n")).toEqual([])
    expect(check('index.html', '<script src="../outside.js"></script>')).toEqual([])
  })
})

describe('recheckWrittenFile (an issue can be fixed from another file)', () => {
  it('clears once the missing asset is created', () => {
    touch('index.html', '<link rel="stylesheet" href="styles.css">')
    expect(recheckWrittenFile('index.html')).toHaveLength(1)

    // The agent fixes index.html by writing styles.css — a different file. Without
    // re-checking, it would be nagged forever about a page that is now fine.
    touch('styles.css', 'body{}')
    expect(recheckWrittenFile('index.html')).toEqual([])
  })

  it('reads the current bytes, not whatever was written first', () => {
    touch('data.json', '{ "a": }')
    expect(recheckWrittenFile('data.json')).toHaveLength(1)
    touch('data.json', '{ "a": 1 }')
    expect(recheckWrittenFile('data.json')).toEqual([])
  })

  it('says nothing about a file that no longer exists', () => {
    expect(recheckWrittenFile('gone.json')).toEqual([])
    mkdirSync(join(root, 'adir'), { recursive: true })
    expect(recheckWrittenFile('adir')).toEqual([])
  })

  it('says nothing about a path outside the project', () => {
    expect(recheckWrittenFile('../../../etc/passwd')).toEqual([])
  })
})

describe('describeIssues (what the model actually reads)', () => {
  it('is empty when nothing was found', () => {
    // Silence means "nothing detectable" — never a claim that the file is correct.
    expect(describeIssues([])).toBe('')
  })

  it('lists each problem and asks for a fix', () => {
    const text = describeIssues(['a is broken', 'b is broken'])
    expect(text).toMatch(/2 problems detected/)
    expect(text).toContain('  - a is broken')
    expect(text).toContain('  - b is broken')
    expect(text).toMatch(/Fix this before moving on/)
  })

  it('reads naturally for a single problem', () => {
    expect(describeIssues(['a is broken'])).toMatch(/1 problem detected/)
  })
})

describe("this project's own source", () => {
  it('finds nothing wrong with real files', () => {
    // The strongest false-positive guard available: large, real TypeScript and TSX
    // with regex literals, nested templates, JSX and deep relative imports. If the
    // checker flags any of these, it would flag the code Sylor writes too.
    contextManager.setRoot(process.cwd())
    for (const file of [
      'src/main/workflow/engine.ts',
      'src/main/fs/verify.ts',
      'src/main/fs/operations.ts',
      'src/main/preview/server.ts',
      'src/renderer/src/components/ChatPanel.tsx',
      'src/renderer/src/store/useChatStore.ts',
      'src/shared/types.ts',
      'package.json'
    ]) {
      expect(recheckWrittenFile(file).map((i) => i.message), file).toEqual([])
    }
  })
})
