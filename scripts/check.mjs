import { readdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
for (const file of await readdir(new URL('../lib/', import.meta.url))) {
  if (!file.endsWith('.js')) continue
  const result = spawnSync(process.execPath, ['--check', `lib/${file}`], { encoding: 'utf8', stdio: 'pipe' })
  assert.equal(result.status, 0, `${file}: ${result.stderr}`)
}
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'))
for (const path of [manifest.main, manifest.exports['./client'], manifest.dsh.bundle.patch, 'README.md']) await readFile(path)
console.log('Syntax, package entry points and DSH client declarations checked.')
