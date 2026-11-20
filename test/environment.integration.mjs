import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { harness, runtime } from './runtime.mjs'
import { DshLibrary } from '../lib/library.js'
import { SyncNode } from '../lib/node.js'

async function pair(t) {
  const apps = []
  for (const name of ['A', 'B']) {
    const app = await harness(t)
    const credentials = await runtime('@deepseek-ai/dsh-credentials-local')
    await app.ctx.plugin(credentials.default, { dshHome: app.root, watch: false })
    const library = await DshLibrary.open(app.ctx, app.root)
    const sync = await SyncNode.open({ home: app.root, library, name, host: '127.0.0.1', port: 0, discovery: false, intervalMs: 0 })
    t.after(() => sync.close())
    apps.push({ ...app, library, sync })
  }
  const [a, b] = apps
  await a.sync.probe(b.sync.url); await a.sync.requestPair(b.sync.identity.id); await b.sync.acceptPair(a.sync.identity.id)
  return { a, b }
}
async function options(app, values) {
  const id = app.sync.status().peers[0].id, before = app.sync.peerSettingsSnapshot(id)
  await app.sync.configurePeer(id, { ...before.values, ...values }, before.revision)
}
test('API secrets stay local until both devices opt in and never enter status or pairing state', async t => {
  const { a, b } = await pair(t)
  await b.ctx.credentials.modifyRecord('llm-deepseek/deepseek', async () => ({ kind: 'api-key', key: 'test-key-only-not-real', env: { AWS_PROFILE: 'local-machine' } }))
  await b.ctx.credentials.modifyRecord('llm-test/oauth', async () => ({ kind: 'grant', payload: 'test-oauth-only' }))
  await b.ctx.credentials.modifyRecord('another-plugin/account', async () => ({ kind: 'api-key', key: 'unrelated-test-secret' }))
  await a.sync.syncOnce()
  assert.deepEqual(await a.ctx.credentials.listRecords(), [])
  await options(a, { syncApiKeys: true })
  await a.sync.syncOnce()
  assert.deepEqual(await a.ctx.credentials.listRecords(), [])
  await options(b, { syncApiKeys: true })
  await a.sync.syncOnce()
  assert.deepEqual(await a.ctx.credentials.readRecord('llm-deepseek/deepseek'), { kind: 'api-key', key: 'test-key-only-not-real' })
  assert.equal((await a.ctx.credentials.listRecords()).length, 1)
  assert.doesNotMatch(JSON.stringify(a.sync.status()) + await readFile(join(a.root, 'session-link', 'devices.json'), 'utf8'), /test-key-only|test-oauth|unrelated-test-secret/)
  await a.ctx.credentials.modifyRecord('llm-deepseek/deepseek', async () => ({ kind: 'api-key', key: 'local-key-wins' }))
  await a.sync.syncOnce()
  assert.equal((await a.ctx.credentials.readRecord('llm-deepseek/deepseek')).key, 'local-key-wins')
  assert.equal(a.sync.status().peers[0].environment.apiKeys.kept, 1)
  await options(a, { syncApiKeys: false })
  await assert.rejects(b.sync.rpc(b.sync.peer(a.sync.identity.id), { action: 'environment/keys' }), /关闭|disabled|unknown/)
})

test('plugin sharing proposes exact registry versions and installs only after local selection', async t => {
  const { a, b } = await pair(t)
  const installed = [], local = []
  const bundles = [
    { name: 'dsh-example', version: '1.2.3', source: 'dsh-example@^1.2.0', installed: true, availability: 'profile', enabled: true, official: false },
    { name: 'dsh-private', version: '1.0.0', source: 'file:/private/local', installed: true, availability: 'profile', enabled: true, official: false },
    { name: 'dsh-thetwo', version: '0.1.0', installed: true, availability: 'profile', enabled: true, official: false },
  ]
  // Only the package manager boundary is substituted: no external package is
  // installed by a test. Pairing, consent, transport and reconciliation are real.
  a.sync.environment.plugins = { listBundles: async () => local, installBundle: async (spec, opts) => { installed.push({ spec, opts }); local.push(bundles[0]); return { application: 'applied' } } }
  b.sync.environment.plugins = { listBundles: async () => bundles }
  await options(a, { syncPlugins: true }); await options(b, { syncPlugins: true })
  await a.sync.syncOnce()
  const plan = a.sync.status().peers[0].environment.plugins
  assert.deepEqual(plan.map(row => row.spec), ['dsh-example@1.2.3'])
  assert.equal(installed.length, 0)
  await assert.rejects(a.sync.installPlugins(b.sync.identity.id, ['file:/arbitrary']), /列表|插件/)
  await a.sync.installPlugins(b.sync.identity.id, ['dsh-example@1.2.3'])
  assert.equal(installed.length, 1)
  assert.equal(installed[0].spec, 'dsh-example@1.2.3')
  assert.equal(installed[0].opts.approvedBuilds, undefined)
  await a.sync.installPlugins(b.sync.identity.id, ['dsh-example@1.2.3'])
  assert.equal(installed.length, 1)
})

test('turning off key sharing while credentials are being read prevents returning their values', async t => {
  const { a, b } = await pair(t)
  await options(a, { syncApiKeys: true }); await options(b, { syncApiKeys: true })
  await b.ctx.credentials.modifyRecord('llm-deepseek/deepseek', async () => ({ kind: 'api-key', key: 'revocation-fixture-only' }))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const original = b.sync.environment.exportKeys.bind(b.sync.environment)
  b.sync.environment.exportKeys = async () => { const records = await original(); entered.resolve(); await release.promise; return records }
  const response = a.sync.rpc(a.sync.peer(b.sync.identity.id), { action: 'environment/keys' })
  const outcome = response.then(value => ({ value }), error => ({ error }))
  await entered.promise; await options(b, { syncApiKeys: false }); release.resolve()
  assert.match((await outcome).error?.message ?? '', /关闭|abort|停止/i)
  assert.deepEqual(await a.ctx.credentials.listRecords(), [])
})

test('revoking plugin sharing during the final local inventory read prevents installation', async t => {
  const { a, b } = await pair(t)
  const row = { name: 'dsh-example', version: '1.2.3', source: 'dsh-example@1.2.3', installed: true, availability: 'profile', enabled: true, official: false }
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), installed = []
  t.after(() => release.resolve())
  let reads = 0
  a.sync.environment.plugins = {
    async listBundles() { if (++reads === 2) { entered.resolve(); await release.promise } return [] },
    async installBundle(spec) { installed.push(spec); return { application: 'applied' } },
  }
  b.sync.environment.plugins = { listBundles: async () => [row] }
  await options(a, { syncPlugins: true }); await options(b, { syncPlugins: true })
  const outcome = a.sync.installPlugins(b.sync.identity.id, ['dsh-example@1.2.3']).then(value => ({ value }), error => ({ error }))
  await entered.promise; await options(a, { syncPlugins: false }); release.resolve()
  await outcome
  assert.deepEqual(installed, [])
})
