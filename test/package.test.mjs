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
