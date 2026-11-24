import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

test('DSH can load TheTwo after a host upgrade without a version exemption', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const hostVersion of ['0.2.0', '0.2.0-rc.2', '0.2.2-rc.5', '0.3.0', '1.0.0-rc.1']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, hostVersion), undefined, hostVersion)
  }
})

test('the public catalog offers the current release from npm or a pinned TheTwo commit', async () => {
  const { parseMarketIndex, marketInstallTarget } = await import('@deepseek-ai/dsh-plugin-market-index')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.license, 'MIT')
  assert.ok(manifest.keywords.includes('dsh-plugin'))
  const url = 'https://raw.githubusercontent.com/YunongDai2005/dsh-thetwo/main/market-index.json'
  const index = parseMarketIndex(JSON.parse(await readFile(new URL('../market-index.json', import.meta.url), 'utf8')), url)
  const plugin = index.plugins.find(entry => entry.name === manifest.name)
  assert.ok(plugin)
  assert.equal(plugin.versions[0].version, manifest.version)
  assert.ok(plugin.metadata.keywords.includes('会话同步'))
  for (const version of plugin.versions) {
    const { spec } = marketInstallTarget(plugin.name, version)
    if (version.source.type === 'npm') {
      assert.equal(spec, `${plugin.name}@${version.version}`)
    } else {
      assert.match(spec, /^git\+https:\/\/github\.com\/YunongDai2005\/dsh-thetwo\.git#[0-9a-f]{40}$/)
    }
    assert.equal(version.engines.dsh, undefined)
  }
})
