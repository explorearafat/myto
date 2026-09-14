import { describe, expect, it } from 'vitest'
import { classifyCommand } from './commandClassifier'

const WORKSPACE = '/home/user/project'

describe('classifyCommand — read-only', () => {
  const cases: Array<[string, string]> = [
    ['ls', 'plain ls'],
    ['ls -la', 'ls with flags'],
    ['cat README.md', 'cat a file'],
    ['grep "foo" src/', 'grep search'],
    ['git status', 'git status'],
    ['git log --oneline', 'git log'],
    ['git diff HEAD~1', 'git diff'],
    ['npm ls', 'npm list packages'],
    ['tsc --noEmit', 'typecheck'],
    ['eslint src/', 'lint'],
    ['vitest list', 'list tests'],
    ['echo "hello"', 'echo'],
    ['node --version', 'version check'],
    ['pwd', 'print working directory'],
    ['find . -name "*.ts"', 'find files'],
    ['ps aux', 'list processes'],
    ['docker ps', 'list containers'],
    ['kubectl get pods', 'k8s get'],
    ['man git', 'manual page'],
    ['git config --get user.name', 'git config get']
  ]

  for (const [cmd, label] of cases) {
    it(`classifies "${cmd}" as read-only (${label})`, () => {
      expect(classifyCommand(cmd, WORKSPACE)).toBe('read-only')
    })
  }
})

describe('classifyCommand — mutating', () => {
  const cases: Array<[string, string]> = [
    ['npm install', 'install packages'],
    ['git commit -m "fix"', 'git commit'],
    ['git push origin main', 'git push (normal)'],
    ['mv old.txt new.txt', 'move file'],
    ['cp a.txt b.txt', 'copy file'],
    ['mkdir build', 'create directory'],
    ['touch file.txt', 'create empty file'],
    ['npm install lodash', 'install specific package'],
    ['git add .', 'stage files'],
    ['git checkout -b feature', 'create branch'],
    ['echo "data" > output.txt', 'redirect inside workspace'],
    ['echo "data" >> log.txt', 'append inside workspace'],
    ['npm run build', 'build script'],
    ['make', 'make build'],
    ['cargo build', 'cargo build'],
    ['docker build -t app .', 'docker build'],
    ['git merge feature', 'git merge'],
    ['git rebase main', 'git rebase (not destructive)']
  ]

  for (const [cmd, label] of cases) {
    it(`classifies "${cmd}" as mutating (${label})`, () => {
      expect(classifyCommand(cmd, WORKSPACE)).toBe('mutating')
    })
  }
})

describe('classifyCommand — destructive', () => {
  const cases: Array<[string, string]> = [
    ['rm -rf node_modules', 'rm -rf'],
    ['rm -fr build/', 'rm -fr'],
    ['git reset --hard HEAD', 'git reset --hard'],
    ['git clean -fdx', 'git clean force'],
    ['git push --force', 'git push force'],
    ['git push -f origin main', 'git push -f'],
    ['git branch -D feature', 'git branch force delete'],
    ['sudo apt-get install', 'sudo (privilege escalation)'],
    ['su root', 'su (switch user)'],
    ['dd if=/dev/zero of=/dev/sda', 'dd (disk write)'],
    ['npm uninstall react', 'npm uninstall'],
    ['yarn remove lodash', 'yarn remove'],
    ['docker rm -f container', 'docker rm'],
    ['kubectl delete pod', 'kubectl delete'],
    ['kill -9 1234', 'SIGKILL'],
    ['pkill node', 'pkill'],
    ['echo "data" > /etc/config', 'redirect outside workspace (absolute)'],
    ['echo "data" > ../../../etc/passwd', 'redirect up-and-out'],
    ['rmdir /r /s build', 'Windows recursive delete']
  ]

  for (const [cmd, label] of cases) {
    it(`classifies "${cmd}" as destructive (${label})`, () => {
      expect(classifyCommand(cmd, WORKSPACE)).toBe('destructive')
    })
  }
})

describe('classifyCommand — edge cases', () => {
  it('classifies empty command as read-only (no-op)', () => {
    expect(classifyCommand('', WORKSPACE)).toBe('read-only')
    expect(classifyCommand('   ', WORKSPACE)).toBe('read-only')
  })

  it('classifies redirect inside workspace as mutating, not destructive', () => {
    expect(classifyCommand('echo "log" > ./output.txt', WORKSPACE)).toBe('mutating')
    expect(classifyCommand('cat foo > bar.txt', WORKSPACE)).toBe('mutating')
  })

  it('classifies redirect outside workspace as destructive', () => {
    expect(classifyCommand('echo "x" > /tmp/file.txt', WORKSPACE)).toBe('destructive')
    expect(classifyCommand('echo "x" > ../../outside.txt', WORKSPACE)).toBe('destructive')
  })

  it('does not match read-only as substring (e.g. "listen" is not "ls")', () => {
    expect(classifyCommand('listen 8080', WORKSPACE)).toBe('mutating')
    expect(classifyCommand('list-packages', WORKSPACE)).toBe('mutating')
  })

  it('matches read-only case-insensitively', () => {
    expect(classifyCommand('LS -la', WORKSPACE)).toBe('read-only')
    expect(classifyCommand('GIT STATUS', WORKSPACE)).toBe('read-only')
  })

  it('matches destructive patterns case-insensitively', () => {
    expect(classifyCommand('RM -RF node_modules', WORKSPACE)).toBe('destructive')
    expect(classifyCommand('Git Reset --Hard', WORKSPACE)).toBe('destructive')
  })
})
