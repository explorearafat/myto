/**
 * Cowork deploy & platform scaffolding — PURE generators (no fs / no electron imports) so
 * the whole module is unit-testable, the same extract-the-core pattern as cowork-browser.ts.
 * tools/scaffold.ts calls buildScaffold() and writes the returned files into the Cowork
 * working folder. Goal: whatever Myto builds lands deploy-ready — pushable to GitHub and
 * hostable on Vercel / Netlify / Docker — without hand-writing CI YAML, plus a
 * .myto/project.json recording project metadata as one source of truth for later runs.
 */

/** Frameworks we tune the generated config to. 'static' = plain HTML/CSS/JS, no build step. */
export type ProjectKind = 'next' | 'vite' | 'react-cra' | 'node' | 'static' | 'unknown'

export type PackageManager = 'npm' | 'pnpm' | 'yarn'

/** A normalized view of the project the generators read — produced by detectProjectProfile. */
export interface ProjectProfile {
  kind: ProjectKind
  packageManager: PackageManager
  installCommand: string
  /** null = no build step (static site / plain node script). */
  buildCommand: string | null
  devCommand: string | null
  /** Where deployable output lands: '.', 'dist', '.next', 'build'. */
  outputDir: string
  nodeMajor: string
  hasTests: boolean
  /** true = long-running server (needs `start`), false = static/prebuilt output. */
  isServer: boolean
}

/** The subset of package.json the detector reads. */
export interface PackageJsonLike {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
}

const DEFAULT_NODE = '20'

function pmFrom(pkg: PackageJsonLike | null): PackageManager {
  const pm = pkg?.packageManager ?? ''
  if (pm.startsWith('pnpm')) return 'pnpm'
  if (pm.startsWith('yarn')) return 'yarn'
  return 'npm'
}

function pmRun(pm: PackageManager, script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`
}

function pmInstall(pm: PackageManager): string {
  if (pm === 'pnpm') return 'pnpm install --frozen-lockfile'
  if (pm === 'yarn') return 'yarn install --frozen-lockfile'
  return 'npm ci'
}

/** A safe lowercase-dashed identifier from a project name (Docker image tag, etc.). */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
}

/** Infer a ProjectProfile from a parsed package.json (null if none) + an optional file list. */
export function detectProjectProfile(pkg: PackageJsonLike | null, files: string[] = []): ProjectProfile {
  if (!pkg) {
    const isStatic = files.some((f) => /(^|[\\/])index\.html$/i.test(f))
    return {
      kind: isStatic ? 'static' : 'unknown',
      packageManager: 'npm',
      installCommand: '',
      buildCommand: null,
      devCommand: null,
      outputDir: '.',
      nodeMajor: DEFAULT_NODE,
      hasTests: false,
      isServer: false
    }
  }
  const pm = pmFrom(pkg)
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(deps, name)
  const scripts = pkg.scripts ?? {}
  const hasScript = (s: string): boolean => {
    const v = scripts[s]
    return typeof v === 'string' && v.length > 0
  }
  let kind: ProjectKind
  if (has('next')) kind = 'next'
  else if (has('vite')) kind = 'vite'
  else if (has('react-scripts')) kind = 'react-cra'
  else if (has('react') || has('vue') || has('svelte')) kind = 'vite'
  else kind = 'node'
  const outputDir =
    kind === 'next' ? '.next' : kind === 'react-cra' ? 'build' : kind === 'node' ? '.' : 'dist'
  return {
    kind,
    packageManager: pm,
    installCommand: pmInstall(pm),
    buildCommand: hasScript('build') ? pmRun(pm, 'build') : null,
    devCommand: hasScript('dev') ? pmRun(pm, 'dev') : hasScript('start') ? pmRun(pm, 'start') : null,
    outputDir,
    nodeMajor: DEFAULT_NODE,
    hasTests: hasScript('test'),
    isServer: kind === 'node'
  }
}

/** vercel.json tuned to the framework so `vercel` / the dashboard import needs no clicks. */
export function vercelJson(p: ProjectProfile): string {
  const cfg: Record<string, unknown> = { $schema: 'https://openapi.vercel.sh/vercel.json' }
  switch (p.kind) {
    case 'next':
      cfg.framework = 'nextjs'
      break
    case 'vite':
      cfg.framework = 'vite'
      cfg.outputDirectory = 'dist'
      break
    case 'react-cra':
      cfg.framework = 'create-react-app'
      cfg.outputDirectory = 'build'
      break
    case 'static':
      cfg.framework = null
      cfg.outputDirectory = '.'
      break
    default:
      cfg.framework = null
      if (p.buildCommand) cfg.buildCommand = p.buildCommand
      cfg.outputDirectory = p.outputDir
  }
  return JSON.stringify(cfg, null, 2) + '\n'
}

/** netlify.toml — build command + publish dir, plus an SPA fallback for client-routed apps. */
export function netlifyToml(p: ProjectProfile): string {
  const lines = ['[build]', `  command = "${p.buildCommand ?? ''}"`, `  publish = "${p.outputDir}"`, '']
  if (p.kind === 'vite' || p.kind === 'react-cra' || p.kind === 'static') {
    lines.push('# SPA fallback so client-side routes resolve', '[[redirects]]')
    lines.push('  from = "/*"', '  to = "/index.html"', '  status = 200', '')
  }
  return lines.join('\n')
}

/** .github/workflows/ci.yml — install + build + test on every push and PR to main. */
export function githubCiWorkflow(p: ProjectProfile): string {
  const steps: string[] = ['      - uses: actions/checkout@v4']
  if (p.kind === 'static' && !p.installCommand) {
    steps.push('      - run: echo "Static site — nothing to build."')
  } else {
    if (p.packageManager === 'pnpm') steps.push('      - uses: pnpm/action-setup@v4')
    steps.push(
      '      - uses: actions/setup-node@v4',
      '        with:',
      `          node-version: '${p.nodeMajor}'`,
      `          cache: '${p.packageManager}'`,
      `      - run: ${p.installCommand || 'npm ci'}`
    )
    if (p.buildCommand) steps.push(`      - run: ${p.buildCommand}`)
    if (p.hasTests) steps.push(`      - run: ${pmRun(p.packageManager, 'test')}`)
  }
  return [
    'name: CI',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...steps,
    ''
  ].join('\n')
}

/**
 * .github/workflows/deploy.yml — deploy to Vercel on push to main. Written to STAY GREEN
 * when the repo has no VERCEL_TOKEN secret yet (it skips instead of failing), so a fresh
 * push never shows a red X before the user has connected Vercel — the "0% stall" spirit.
 */
export function githubDeployWorkflow(): string {
  return [
    'name: Deploy',
    '# Set these repo secrets to enable: VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID',
    '# (GitHub → Settings → Secrets and variables → Actions). Until then this job self-skips.',
    'on:',
    '  push:',
    '    branches: [main]',
    'concurrency:',
    '  group: deploy-${{ github.ref }}',
    '  cancel-in-progress: true',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    "        with:",
    "          node-version: '20'",
    '      - name: Deploy to Vercel',
    '        env:',
    '          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}',
    '          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}',
    '          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}',
    '        run: |',
    '          if [ -z "$VERCEL_TOKEN" ]; then',
    '            echo "No VERCEL_TOKEN secret set — skipping deploy (CI stays green)."',
    '            exit 0',
    '          fi',
    '          npm i -g vercel@latest',
    '          vercel pull --yes --environment=production --token="$VERCEL_TOKEN"',
    '          vercel build --prod --token="$VERCEL_TOKEN"',
    '          vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"',
    ''
  ].join('\n')
}

/** A Dockerfile matched to the project shape: static→nginx, server→node, SPA→build+nginx. */
export function dockerfile(p: ProjectProfile): string {
  if (p.kind === 'static') {
    return ['FROM nginx:alpine', 'COPY . /usr/share/nginx/html', 'EXPOSE 80', ''].join('\n')
  }
  const serverLike = p.isServer || p.kind === 'next'
  if (serverLike) {
    return [
      `FROM node:${p.nodeMajor}-alpine`,
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm install --omit=dev',
      'COPY . .',
      ...(p.buildCommand ? [`RUN ${p.buildCommand}`] : []),
      'ENV NODE_ENV=production',
      'EXPOSE 3000',
      `CMD ["${p.packageManager}", "start"]`,
      ''
    ].join('\n')
  }
  const outDir = p.outputDir === '.' ? 'dist' : p.outputDir
  return [
    `FROM node:${p.nodeMajor}-alpine AS build`,
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm install',
    'COPY . .',
    `RUN ${p.buildCommand ?? 'npm run build'}`,
    '',
    'FROM nginx:alpine',
    `COPY --from=build /app/${outDir} /usr/share/nginx/html`,
    'EXPOSE 80',
    ''
  ].join('\n')
}

/** .dockerignore — keep the build context small and secrets out of the image. */
export function dockerignore(): string {
  return ['node_modules', 'dist', '.next', 'build', '.git', '.env', '.env.*', '!.env.example', 'npm-debug.log*', 'Dockerfile', '.dockerignore', ''].join('\n')
}

/** A sensible .gitignore for a JS/TS web project (keeps .myto/project.json, drops its cache). */
export function gitignore(): string {
  return [
    '# Dependencies',
    'node_modules/',
    '',
    '# Build output',
    'dist/',
    'build/',
    '.next/',
    'out/',
    '',
    '# Env & secrets',
    '.env',
    '.env.*',
    '!.env.example',
    '',
    '# Logs',
    '*.log',
    'npm-debug.log*',
    '',
    '# OS / editor',
    '.DS_Store',
    'Thumbs.db',
    '.vscode/',
    '.idea/',
    '',
    '# Coverage',
    'coverage/',
    '',
    '# Vercel',
    '.vercel',
    '',
    '# Myto (project.json is committed; the cache is not)',
    '.myto/cache/',
    ''
  ].join('\n')
}

/** .env.example — documents the env the app expects; real .env stays git-ignored. */
export function envExample(): string {
  return [
    '# Copy this file to .env and fill in real values. Never commit .env.',
    'NODE_ENV=development',
    'PORT=3000',
    '',
    '# Vercel deploy — set these as GitHub Actions repo secrets, NOT here:',
    '# VERCEL_TOKEN=',
    '# VERCEL_ORG_ID=',
    '# VERCEL_PROJECT_ID=',
    ''
  ].join('\n')
}

/** A README with run/build/deploy instructions derived from the detected profile. */
export function readme(projectName: string, p: ProjectProfile): string {
  const lines: string[] = [`# ${projectName}`, '', '> Scaffolded by [Myto](https://mytocode.vercel.app).', '', '## Getting started', '', '```bash']
  if (p.installCommand) lines.push(p.installCommand)
  if (p.devCommand) lines.push(p.devCommand)
  if (!p.installCommand && !p.devCommand) lines.push('# open index.html in your browser')
  lines.push('```', '')
  if (p.buildCommand) lines.push('## Build', '', '```bash', p.buildCommand, '```', '')
  const tag = slug(projectName)
  lines.push(
    '## Deploy',
    '',
    '- **Vercel** — push to GitHub, then import the repo at [vercel.com/new](https://vercel.com/new). To auto-deploy from CI, add the `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` repo secrets and the included `.github/workflows/deploy.yml` takes over.',
    `- **Docker** — \`docker build -t ${tag} . && docker run -p 3000:3000 ${tag}\``,
    ''
  )
  return lines.join('\n')
}

/** The platforms/files buildScaffold can emit. */
export type ScaffoldTarget = 'github' | 'vercel' | 'netlify' | 'docker' | 'gitignore' | 'readme' | 'env' | 'myto'

/** One generated file: a working-folder-relative path and its full contents. */
export interface ScaffoldFile {
  path: string
  contents: string
}

/** Everything mytoProjectJson needs; `now` is injected (not new Date()) for deterministic tests. */
export interface MytoProjectMeta {
  name: string
  now: string
  profile: ProjectProfile
  deployTargets: ScaffoldTarget[]
}

/**
 * .myto/project.json — the single source of truth about this project that later Myto runs
 * (and other platforms) read: framework, commands, output dir, and which deploy targets are
 * wired. This is the ".myto/ … where data will be stored" deliverable.
 */
export function mytoProjectJson(meta: MytoProjectMeta): string {
  const doc = {
    $schema: 'https://mytocode.vercel.app/schemas/project.json',
    name: meta.name,
    createdBy: 'myto',
    createdAt: meta.now,
    framework: meta.profile.kind,
    packageManager: meta.profile.packageManager,
    node: meta.profile.nodeMajor,
    commands: {
      install: meta.profile.installCommand || null,
      dev: meta.profile.devCommand,
      build: meta.profile.buildCommand
    },
    outputDir: meta.profile.outputDir,
    deploy: { targets: meta.deployTargets, vercel: 'vercel.json', github: '.github/workflows' },
    artifacts: [] as string[]
  }
  return JSON.stringify(doc, null, 2) + '\n'
}

/** Every target buildScaffold emits when the caller passes an empty target list. */
export const ALL_SCAFFOLD_TARGETS: ScaffoldTarget[] = [
  'github', 'vercel', 'netlify', 'docker', 'gitignore', 'readme', 'env', 'myto'
]

/** Options for one scaffold run. An empty `targets` list means "emit everything". */
export interface ScaffoldOptions {
  targets: ScaffoldTarget[]
  projectName: string
  now: string
}

/**
 * Turn a ProjectProfile into the full set of deploy/platform files. Pure: it returns
 * { path, contents }[] and never touches disk — tools/scaffold.ts writes them (respecting
 * the workspace sandbox) so this stays unit-testable.
 */
export function buildScaffold(profile: ProjectProfile, opts: ScaffoldOptions): ScaffoldFile[] {
  const targets = opts.targets.length ? opts.targets : ALL_SCAFFOLD_TARGETS
  const want = (t: ScaffoldTarget): boolean => targets.includes(t)
  const out: ScaffoldFile[] = []
  if (want('github')) {
    out.push({ path: '.github/workflows/ci.yml', contents: githubCiWorkflow(profile) })
    out.push({ path: '.github/workflows/deploy.yml', contents: githubDeployWorkflow() })
  }
  if (want('vercel')) out.push({ path: 'vercel.json', contents: vercelJson(profile) })
  if (want('netlify')) out.push({ path: 'netlify.toml', contents: netlifyToml(profile) })
  if (want('docker')) {
    out.push({ path: 'Dockerfile', contents: dockerfile(profile) })
    out.push({ path: '.dockerignore', contents: dockerignore() })
  }
  if (want('gitignore')) out.push({ path: '.gitignore', contents: gitignore() })
  if (want('env')) out.push({ path: '.env.example', contents: envExample() })
  if (want('readme')) out.push({ path: 'README.md', contents: readme(opts.projectName, profile) })
  if (want('myto')) {
    out.push({
      path: '.myto/project.json',
      contents: mytoProjectJson({ name: opts.projectName, now: opts.now, profile, deployTargets: targets })
    })
  }
  return out
}
