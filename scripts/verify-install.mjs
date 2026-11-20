import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openHarness, runtime } from '../test/runtime.mjs'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const archive = resolve(process.argv[2] ?? `artifacts/${manifest.name}-${manifest.version}.tgz`)
const hostRequire = createRequire(join(resolve(process.env.DSH_TEST_NODE_MODULES ?? 'node_modules'), '__install.cjs'))
const hostManifest = hostRequire.resolve('@deepseek-ai/dsh/package.json')
const host = JSON.parse(await readFile(hostManifest, 'utf8'))
const cli = join(dirname(hostManifest), host.bin.dsh)
const home = await mkdtemp(join(tmpdir(), 'thetwo-install-'))

try {
  execFileSync(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', archive], {
    cwd: home, env: { ...process.env, DSH_HOME: home }, stdio: 'inherit', windowsHide: true, timeout: 180_000,
  })
  const installed = join(home, 'profiles', 'web', 'node_modules', manifest.name)
  const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(installedManifest.version, manifest.version)
  const plugin = await import(pathToFileURL(join(installed, installedManifest.main)).href)
  const { ctx } = await openHarness(home)
  try {
    const web = await runtime('@deepseek-ai/dsh-host-webserver')
    await ctx.plugin(web.default, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(plugin, { home, host: '127.0.0.1', port: 0, discovery: false, intervalMs: 0 })
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/api/thetwo/status`)
    assert.equal(response.status, 200)
    const status = await response.json()
    assert.equal(status.ok, true)
    assert.deepEqual(status.value.peers, [])
    console.log(`Installed ${manifest.name}@${manifest.version} with DSH ${host.version}; the installed plugin served its status.`)
  } finally {
    await ctx.fiber.dispose()
  }
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
