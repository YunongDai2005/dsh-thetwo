import { mkdir, writeFile, lstat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

// A separate, loopback-only DSH home. No user profile or model credentials are used.
const project = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const home = join(project, '.preview', 'dsh-home')
const profile = join(home, 'profiles', 'web')
const modules = join(profile, 'node_modules')
await mkdir(modules, { recursive: true })
const link = join(modules, 'dsh-thetwo')
if (!await lstat(link).catch(() => null)) await symlink(project, link, process.platform === 'win32' ? 'junction' : 'dir')
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'thetwo-isolated-preview', private: true,
  dependencies: { 'dsh-thetwo': `link:${project.replaceAll('\\', '/')}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-thetwo'] } },
}, null, 2))
await writeFile(join(profile, 'cordis.patch.yml'), `- id: thetwo
  config:
    name: 书房电脑
    host: 127.0.0.1
    port: 0
    discovery: false
- id: ui-settings-general
  config:
    welcomeNoticeVersion: 2026-09-28.1
`)
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
console.log(`TheTwo preview uses only ${home}`)
const child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', process.env.THETWO_PREVIEW_PORT || '51824', '--no-open'], {
  cwd: project, env: { ...process.env, DSH_HOME: home }, stdio: 'inherit', windowsHide: true,
})
process.on('SIGINT', () => child.kill())
process.on('SIGTERM', () => child.kill())
child.on('exit', code => { process.exitCode = code ?? 0 })
