import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SyncNode } from '../lib/node.js'
import { DshLibrary } from '../lib/library.js'
import { harness, runtime, put, fixture } from './runtime.mjs'

async function station(t, name) {
  const app = await harness(t), credentials = await runtime('@deepseek-ai/dsh-credentials-local')
  await app.ctx.plugin(credentials.default, { dshHome: app.root, watch: false })
  const library = await DshLibrary.open(app.ctx, app.root)
  const options = { home: app.root, library, name, host: '127.0.0.1', port: 0, discovery: false, intervalMs: 0 }
  const sync = await SyncNode.open(options)
  t.after(() => sync.close())
  return { ...app, library, sync, options }
}
async function pair(a, b) {
  await a.sync.probe(b.sync.url); await a.sync.requestPair(b.sync.identity.id); await b.sync.acceptPair(a.sync.identity.id)
}
async function configure(a, b, values) {
  const current = a.sync.peerSettingsSnapshot(b.sync.identity.id)
  return a.sync.configurePeer(b.sync.identity.id, { ...current.values, ...values }, current.revision)
}

test('three devices share conversations while optional permissions apply only to the selected peer', async t => {
  const a = await station(t, 'A'), b = await station(t, 'B'), c = await station(t, 'C')
  await pair(a, b); await pair(a, c)
  await a.ctx.credentials.modifyRecord('llm-test/fixture', async () => ({ kind: 'api-key', key: 'synthetic-device-specific-key' }))
  a.sync.environment.plugins = { listBundles: async () => [{ name: 'dsh-example', version: '1.2.3', installed: true, availability: 'profile', enabled: false }] }
  for (const target of [b, c]) {
    target.sync.environment.plugins = { listBundles: async () => [] }
    await configure(target, a, { syncApiKeys: true, syncPlugins: true })
  }
  await configure(a, b, { syncApiKeys: true, syncPlugins: true })
  await put(a.ctx, fixture('shared-by-three'), a.root)
  await b.sync.syncOnce(); await c.sync.syncOnce()
  for (const target of [b, c]) assert.equal((await target.library.export('shared-by-three')).digest, (await a.library.export('shared-by-three')).digest)
  assert.equal((await b.ctx.credentials.readRecord('llm-test/fixture')).key, 'synthetic-device-specific-key')
  assert.equal(await c.ctx.credentials.readRecord('llm-test/fixture'), undefined)
  assert.equal(b.sync.status().peers[0].environment.plugins[0].spec, 'dsh-example@1.2.3')
  assert.equal(c.sync.status().peers[0].environment.plugins, undefined)
  await assert.rejects(c.sync.rpc(c.sync.peer(a.sync.identity.id), { action: 'environment/keys' }), /关闭/)
  await assert.rejects(c.sync.rpc(c.sync.peer(a.sync.identity.id), { action: 'environment/plugins' }), /关闭/)
  await configure(a, b, { syncApiKeys: false, syncPlugins: false })
  assert.equal(a.sync.permitted(b.sync.identity.id, 'syncApiKeys'), false)
  assert.equal(a.sync.peerSettingsSnapshot(c.sync.identity.id).values.syncApiKeys, false)
})

test('device naming and options persist independently and stale peer edits are rejected', async t => {
  const a = await station(t, 'A'), b = await station(t, 'B'), c = await station(t, 'C')
  await pair(a, b); await pair(a, c)
  const original = a.sync.peerSettingsSnapshot(b.sync.identity.id)
  const saved = await configure(a, b, { deviceName: '  工作 Mac  ', syncPlugins: true })
  assert.equal(saved.values.deviceName, '工作 Mac')
  await assert.rejects(a.sync.configurePeer(b.sync.identity.id, original.values, original.revision), { code: 'SETTINGS_CONFLICT' })
  await assert.rejects(configure(a, b, { deviceName: 'bad\nname' }), /名称/)
  await assert.rejects(configure(a, b, { unsupported: true }), /选项/)
  await a.sync.rememberName(b.sync.identity.id, 'B renamed remotely')
  assert.equal(a.sync.status().peers.find(p => p.id === b.sync.identity.id).name, '工作 Mac')
  assert.equal(a.sync.status().peers.find(p => p.id === b.sync.identity.id).remoteName, 'B renamed remotely')
  assert.equal(a.sync.status().peers.find(p => p.id === c.sync.identity.id).name, 'C')
  await a.sync.close()
  const restarted = await SyncNode.open(a.options); t.after(() => restarted.close())
  assert.deepEqual(restarted.peerSettingsSnapshot(b.sync.identity.id), saved)
  assert.equal(restarted.peerSettingsSnapshot(c.sync.identity.id).values.syncPlugins, false)
})

test('revoking one device during a credential read does not revoke another device', async t => {
  const a = await station(t, 'A'), b = await station(t, 'B'), c = await station(t, 'C')
  await pair(a, b); await pair(a, c)
  await configure(a, b, { syncApiKeys: true }); await configure(a, c, { syncApiKeys: true })
  await a.ctx.credentials.modifyRecord('llm-test/fixture', async () => ({ kind: 'api-key', key: 'revocation-fixture' }))
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let reads = 0
  t.after(() => release.resolve())
  const original = a.sync.environment.exportKeys.bind(a.sync.environment)
  a.sync.environment.exportKeys = async () => { const records = await original(); if (++reads === 2) entered.resolve(); await release.promise; return records }
  const request = target => target.sync.rpc(target.sync.peer(a.sync.identity.id), { action: 'environment/keys' }).then(value => ({ value }), error => ({ error }))
  const denied = request(b), allowed = request(c)
  await entered.promise; await configure(a, b, { syncApiKeys: false }); release.resolve()
  assert.match((await denied).error?.message ?? '', /关闭|abort|revoked/i)
  assert.equal((await allowed).value[0].key, 'revocation-fixture')
  assert.equal(a.sync.permitted(c.sync.identity.id, 'syncApiKeys'), true)
})

test('upgrading global optional sharing never grants it to all paired devices', async t => {
  const a = await station(t, 'A'), b = await station(t, 'B')
  await pair(a, b)
  a.sync.state.settings.syncApiKeys = true; a.sync.state.settings.syncPlugins = true
  delete a.sync.state.peers[b.sync.identity.id].settings
  await a.sync.save(); await a.sync.close()
  const restarted = await SyncNode.open(a.options); t.after(() => restarted.close())
  assert.equal(restarted.permitted(b.sync.identity.id, 'syncApiKeys'), false)
  assert.equal(restarted.permitted(b.sync.identity.id, 'syncPlugins'), false)
  assert.equal(restarted.settingsSnapshot().values.syncApiKeys, undefined)
  await assert.rejects(restarted.configure({ ...restarted.settingsSnapshot().values, syncApiKeys: true }, restarted.settingsSnapshot().revision), /选项/)
})

test('three paired devices continue one shared identity without duplicate events or sync loops', async t => {
  const a = await station(t, 'A'), b = await station(t, 'B'), c = await station(t, 'C')
  await pair(a, b); await pair(a, c); await pair(b, c)
  await put(a.ctx, fixture('three-way-history'), a.root)
  await a.sync.syncOnce()
  for (const [owner, turn] of [[b, 2], [c, 3]]) {
    const writer = await owner.ctx.sessionPersistence.open('three-way-history', 'write')
    try { await writer.append(fixture('three-way-history', '', turn, (turn - 1) * 2).events); await writer.flush() }
    finally { await writer.close() }
    await owner.sync.syncOnce()
  }
  const expected = await c.library.export('three-way-history')
  for (const owner of [a, b, c]) {
    await owner.sync.syncOnce()
    const actual = await owner.library.export('three-way-history')
    assert.equal(actual.digest, expected.digest); assert.equal(actual.events.length, 6)
    assert.equal(owner.library.status().conflicts.length, 0)
    assert.equal((await owner.library.catalog()).sessions.length, 1)
  }
})

test('three independent branches are recoverable on every owner without repeated transfer', async t => {
  const a = await station(t, 'A'), b = await station(t, 'B'), c = await station(t, 'C'), all = [a, b, c]
  await pair(a, b); await pair(a, c); await pair(b, c)
  await put(a.ctx, fixture('three-way-conflict'), a.root); await a.sync.syncOnce()
  const branches = []
  for (const [index, owner] of all.entries()) {
    const writer = await owner.ctx.sessionPersistence.open('three-way-conflict', 'write')
    try { await writer.append(fixture('three-way-conflict', '', 2, 2).events.map(e => ({ ...e, time: e.time + index * 100 }))); await writer.flush() }
    finally { await writer.close() }
    branches.push((await owner.library.export('three-way-conflict')).events)
  }
  for (const owner of all) await owner.sync.syncOnce()
  for (const [index, owner] of all.entries()) {
    const recovered = await owner.library.recoverConflict('three-way-conflict')
    assert.equal(recovered.ids.length, 2, 'both other device branches must be available')
    const copies = await Promise.all(recovered.ids.map(async id => JSON.stringify((await owner.library.export(id)).events)))
    assert.deepEqual(copies.sort(), branches.filter((_, i) => i !== index).map(events => JSON.stringify(events)).sort())
    assert.deepEqual((await owner.library.export('three-way-conflict')).events, branches[index])
    await owner.sync.syncOnce() // Publish recovered copies before checking convergence.
  }
  for (const owner of all) await owner.sync.syncOnce()
  let repeated = 0
  for (const owner of all) {
    const original = owner.sync.rpc.bind(owner.sync)
    owner.sync.rpc = async (peer, payload, signal) => { if (['get', 'put'].includes(payload.action)) repeated++; return original(peer, payload, signal) }
  }
  for (const owner of all) await owner.sync.syncOnce()
  assert.equal(repeated, 0)
})
