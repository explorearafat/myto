import { describe, it, expect } from 'vitest'
import {
  detectProjectProfile,
  vercelJson,
  netlifyToml,
  githubCiWorkflow,
  githubDeployWorkflow,
  dockerfile,
  dockerignore,
  gitignore,
  envExample,
  readme,
  mytoProjectJson,
  buildScaffold,
  ALL_SCAFFOLD_TARGETS,
  type PackageJsonLike,
  type ProjectProfile
} from './cowork-scaffold'

/** A package.json with the given fields merged over a minimal base. */
function pkg(over: PackageJsonLike): PackageJsonLike {
  return { name: 'demo', ...over }
}

/** A representative Vite SPA profile the generator tests reuse. */
const viteProfile: ProjectProfile = {
  kind: 'vite',
  packageManager: 'npm',
  installCommand: 'npm ci',
  buildCommand: 'npm run build',
  devCommand: 'npm run dev',
  outputDir: 'dist',
  nodeMajor: '20',
  hasTests: true,
  isServer: false
}

describe('detectProjectProfile', () => {
  it('detects Next.js', () => {
    const p = detectProjectProfile(pkg({ dependencies: { next: '14' }, scripts: { build: 'next build', dev: 'next dev' } }))
    expect(p.kind).toBe('next')
    expect(p.outputDir).toBe('.next')
    expect(p.buildCommand).toBe('npm run build')
  })
  it('detects Vite and respects the pnpm package manager', () => {
    const p = detectProjectProfile(pkg({ devDependencies: { vite: '5' }, scripts: { build: 'vite build' }, packageManager: 'pnpm@9' }))
    expect(p.kind).toBe('vite')
    expect(p.packageManager).toBe('pnpm')
    expect(p.installCommand).toBe('pnpm install --frozen-lockfile')
    expect(p.buildCommand).toBe('pnpm build')
  })
  it('detects create-react-app and a plain node server', () => {
    expect(detectProjectProfile(pkg({ dependencies: { 'react-scripts': '5' } })).kind).toBe('react-cra')
    const node = detectProjectProfile(pkg({ dependencies: { express: '4' }, scripts: { start: 'node server.js' } }))
    expect(node.kind).toBe('node')
    expect(node.isServer).toBe(true)
    expect(node.devCommand).toBe('npm run start')
  })
  it('falls back to static when package.json is absent but index.html exists', () => {
    const p = detectProjectProfile(null, ['index.html', 'style.css'])
    expect(p.kind).toBe('static')
    expect(p.buildCommand).toBeNull()
  })
  it('is unknown with neither package.json nor index.html', () => {
    expect(detectProjectProfile(null, ['notes.txt']).kind).toBe('unknown')
  })
})

describe('vercelJson', () => {
  it('sets the Next.js framework and is valid JSON', () => {
    const json = vercelJson(detectProjectProfile(pkg({ dependencies: { next: '14' } })))
    expect(JSON.parse(json)).toMatchObject({ framework: 'nextjs' })
  })
  it('points Vite at dist', () => {
    expect(JSON.parse(vercelJson(viteProfile))).toMatchObject({ framework: 'vite', outputDirectory: 'dist' })
  })
})

describe('netlifyToml', () => {
  it('adds an SPA redirect for client-routed apps', () => {
    const toml = netlifyToml(viteProfile)
    expect(toml).toContain('publish = "dist"')
    expect(toml).toContain('to = "/index.html"')
  })
  it('omits the SPA redirect for a node server', () => {
    const node = detectProjectProfile(pkg({ dependencies: { express: '4' }, scripts: { build: 'tsc' } }))
    expect(netlifyToml(node)).not.toContain('/index.html')
  })
})

describe('githubCiWorkflow', () => {
  it('installs, builds and tests with a cached node setup', () => {
    const yml = githubCiWorkflow(viteProfile)
    expect(yml).toContain('actions/setup-node@v4')
    expect(yml).toContain("cache: 'npm'")
    expect(yml).toContain('- run: npm ci')
    expect(yml).toContain('- run: npm run build')
    expect(yml).toContain('- run: npm run test')
  })
  it('adds pnpm/action-setup for a pnpm project', () => {
    const p = detectProjectProfile(pkg({ devDependencies: { vite: '5' }, scripts: { build: 'vite build' }, packageManager: 'pnpm@9' }))
    expect(githubCiWorkflow(p)).toContain('pnpm/action-setup@v4')
  })
})

describe('githubDeployWorkflow', () => {
  it('self-skips when no VERCEL_TOKEN secret is set so CI stays green', () => {
    const yml = githubDeployWorkflow()
    expect(yml).toContain('secrets.VERCEL_TOKEN')
    expect(yml).toContain('skipping deploy')
    expect(yml).toContain('vercel deploy --prebuilt --prod')
  })
})

describe('dockerfile', () => {
  it('serves a static site with nginx', () => {
    const p = detectProjectProfile(null, ['index.html'])
    expect(dockerfile(p)).toContain('FROM nginx:alpine')
  })
  it('runs a node server with start', () => {
    const p = detectProjectProfile(pkg({ dependencies: { express: '4' }, scripts: { start: 'node .' } }))
    const df = dockerfile(p)
    expect(df).toContain('FROM node:20-alpine')
    expect(df).toContain('CMD ["npm", "start"]')
  })
  it('builds an SPA then serves the output with nginx', () => {
    const df = dockerfile(viteProfile)
    expect(df).toContain('AS build')
    expect(df).toContain('COPY --from=build /app/dist /usr/share/nginx/html')
  })
})

describe('static config files', () => {
  it('keeps env.example out of the image but ignores real env', () => {
    expect(dockerignore()).toContain('!.env.example')
    expect(gitignore()).toContain('.env')
    expect(gitignore()).toContain('.myto/cache/')
    expect(envExample()).toContain('VERCEL_TOKEN')
  })
  it('writes a README with the name and a docker tag', () => {
    const md = readme('My Cool App', viteProfile)
    expect(md).toContain('# My Cool App')
    expect(md).toContain('docker build -t my-cool-app')
  })
})

describe('mytoProjectJson', () => {
  it('records framework, commands and the injected timestamp deterministically', () => {
    const json = mytoProjectJson({
      name: 'demo',
      now: '2026-09-25T00:00:00.000Z',
      profile: viteProfile,
      deployTargets: ['github', 'vercel']
    })
    const doc = JSON.parse(json)
    expect(doc).toMatchObject({ name: 'demo', createdAt: '2026-09-25T00:00:00.000Z', framework: 'vite' })
    expect(doc.commands.build).toBe('npm run build')
    expect(doc.deploy.targets).toEqual(['github', 'vercel'])
  })
})

describe('buildScaffold', () => {
  it('emits every target file when the target list is empty', () => {
    const files = buildScaffold(viteProfile, { targets: [], projectName: 'demo', now: 'T' })
    const paths = files.map((f) => f.path)
    expect(paths).toContain('.github/workflows/ci.yml')
    expect(paths).toContain('.github/workflows/deploy.yml')
    expect(paths).toContain('vercel.json')
    expect(paths).toContain('netlify.toml')
    expect(paths).toContain('Dockerfile')
    expect(paths).toContain('.dockerignore')
    expect(paths).toContain('.gitignore')
    expect(paths).toContain('.env.example')
    expect(paths).toContain('README.md')
    expect(paths).toContain('.myto/project.json')
    expect(ALL_SCAFFOLD_TARGETS).toContain('myto')
  })
  it('emits only the requested targets', () => {
    const files = buildScaffold(viteProfile, { targets: ['vercel', 'gitignore'], projectName: 'demo', now: 'T' })
    expect(files.map((f) => f.path).sort()).toEqual(['.gitignore', 'vercel.json'])
  })
})
