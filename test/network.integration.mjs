import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SyncNode } from '../lib/node.js'
import { DshLibrary } from '../lib/library.js'
import { harness, fixture, put } from './runtime.mjs'
import { setImmediate as nextTurn } from 'node:timers/promises'

async function node(t, name) {
  const app = await harness(t)
  const library = await DshLibrary.open(app.ctx, app.root)
  const sync = await SyncNode.open({ home: app.root, library, name, host: '127.0.0.1', port: 0, discovery: false, intervalMs: 0 })
  t.after(() => sync.close())
  return { ...app, library, sync }
}
async function paired(t) {
  const a = await node(t, '电脑 A'), b = await node(t, '电脑 B')
  await a.sync.probe(b.sync.url)
  await a.sync.requestPair(b.sync.identity.id)
  await b.sync.acceptPair(a.sync.identity.id)
  return { a, b }
}

async function divergentPair(t) {
  const pair = await paired(t), id = 'two-sided-conflict'
  await put(pair.a.ctx, fixture(id), pair.a.root)
  await pair.a.sync.syncOnce()
  for (const [app, shift] of [[pair.a, 100], [pair.b, 200]]) {
    const handle = await app.ctx.sessionPersistence.open(id, 'write')
    try {
      const events = fixture(id, '', 2, 2).events.map(event => ({ ...event, time: event.time + shift }))
      await handle.append(events); await handle.flush()
    } finally { await handle.close() }
  }
  return { ...pair, id }
}

test('both peers can recover the opposite branch when one peer detects divergence first', async t => {
  const { a, b, id } = await divergentPair(t)
  const originalA = await a.library.export(id), originalB = await b.library.export(id)
  await a.sync.syncOnce()
  assert.equal(a.library.status().conflicts.length, 1)
  assert.equal(b.library.status().conflicts.length, 1, 'the other computer must also be offered the opposite branch')
  const recoveredA = await a.library.recoverConflict(id), recoveredB = await b.library.recoverConflict(id)
  assert.deepEqual((await a.library.export(recoveredA.ids[0])).events, originalB.events)
  assert.deepEqual((await b.library.export(recoveredB.ids[0])).events, originalA.events)
  assert.deepEqual((await a.library.export(id)).events, originalA.events)
  assert.deepEqual((await b.library.export(id)).events, originalB.events)
})

test('a failed reciprocal conflict transfer is retried after the first peer has saved its conflict', async t => {
  const { a, b, id } = await divergentPair(t)
  const original = b.sync.dispatch.bind(b.sync)
  let interrupted = false
  b.sync.dispatch = async (sender, payload, address) => {
    if (payload.action === 'put' && payload.snapshot.header.id === id && !interrupted) {
      interrupted = true; throw new Error('temporary conflict return failure')
    }
    return original(sender, payload, address)
  }
  await a.sync.syncOnce()
  assert.equal(interrupted, true, 'divergence must be returned to the paired computer')
  assert.equal(a.library.status().conflicts.length, 1)
  assert.equal(b.library.status().conflicts.length, 0)
  await a.sync.syncOnce()
  assert.equal(b.library.status().conflicts.length, 1)
  assert.equal(a.sync.status().peers[0].issues.length, 0)
})

test('polling an already conflicted peer recovers the missing opposite branch', async t => {
  const { a, b, id } = await divergentPair(t)
  const originalA = await a.library.export(id)
  // This is the persisted one-sided state produced by older releases or a
  // return connection failure; only the previously unaware peer polls now.
  await a.library.accept(await b.library.export(id))
  await b.sync.syncOnce()
  assert.equal(b.library.status().conflicts.length, 1)
  const recovered = await b.library.recoverConflict(id)
  assert.deepEqual((await b.library.export(recovered.ids[0])).events, originalA.events)
})

for (const action of ['pause', 'forget', 'disable']) test(`${action} during an upload stops the already running batch`, async t => {
  const { a, b } = await paired(t)
  await put(a.ctx, fixture('not-sent-after-stop'), a.root)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const exportOriginal = a.library.export.bind(a.library)
  a.library.export = async (id, flush) => {
    const snapshot = await exportOriginal(id, flush)
    if (flush !== false) { entered.resolve(); await release.promise }
    return snapshot
  }
  const syncing = a.sync.syncOnce()
  await entered.promise
  const peerId = b.sync.identity.id
  const stopped = action === 'disable'
    ? a.sync.configure({ ...a.sync.settingsSnapshot().values, syncEnabled: false }, a.sync.settingsSnapshot().revision)
    : action === 'pause' ? a.sync.pause(peerId, true) : a.sync.forget(peerId)
  await nextTurn()
  release.resolve()
  await stopped; await syncing
  assert.equal(await b.ctx.sessionPersistence.stat('not-sent-after-stop'), undefined)
  if (action === 'pause') {
    await a.sync.pause(peerId, false); await a.sync.syncOnce()
    assert.ok(await b.ctx.sessionPersistence.stat('not-sent-after-stop'), 'a new batch works after resuming')
  }
  if (action === 'forget') assert.equal(a.sync.live.has(peerId), false, 'late results must not recreate forgotten peer status')
})

test('pausing while an incoming read is pending refuses the completed payload', async t => {
  const { a, b } = await paired(t)
  await put(b.ctx, fixture('do-not-return'), b.root)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const original = b.library.export.bind(b.library)
  b.library.export = async (...args) => { const snapshot = await original(...args); entered.resolve(); await release.promise; return snapshot }
  const response = a.sync.rpc(a.sync.peer(b.sync.identity.id), { action: 'get', id: 'do-not-return' })
  const outcome = response.then(value => ({ value }), error => ({ error }))
  await entered.promise; await b.sync.pause(a.sync.identity.id, true); release.resolve()
  assert.match((await outcome).error?.message ?? '', /paused|abort|停止/i)
})

test('forgetting a peer cancels an incoming checkpoint still waiting for the library queue', async t => {
  const { a, b } = await paired(t)
  await put(a.ctx, fixture('queued-before-forget'), a.root)
  const snapshot = await a.library.export('queued-before-forget')
  const release = Promise.withResolvers(), entered = Promise.withResolvers()
  t.after(() => release.resolve())
  const held = b.library.enqueue(() => release.promise)
  const original = b.library.accept.bind(b.library)
  b.library.accept = (...args) => { const result = original(...args); entered.resolve(); return result }
  const response = a.sync.rpc(a.sync.peer(b.sync.identity.id), { action: 'put', snapshot })
  const outcome = response.then(value => ({ value }), error => ({ error }))
  await entered.promise; await b.sync.forget(a.sync.identity.id); release.resolve(); await held
  assert.ok((await outcome).error, 'a queued request loses its authority when the pairing is removed')
  assert.equal(await b.ctx.sessionPersistence.stat('queued-before-forget'), undefined)
  assert.deepEqual(b.library.status().pending, [])
})

test('pause followed by immediate resume does not revive the cancelled upload', async t => {
  const { a, b } = await paired(t)
  await put(a.ctx, fixture('old-batch'), a.root)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const original = a.library.export.bind(a.library)
  a.library.export = async (id, flush) => { const snapshot = await original(id, flush); if (flush !== false) { entered.resolve(); await release.promise } return snapshot }
  const running = a.sync.syncOnce()
  await entered.promise
  await a.sync.pause(b.sync.identity.id, true); await a.sync.pause(b.sync.identity.id, false)
  release.resolve(); await running
  assert.equal(await b.ctx.sessionPersistence.stat('old-batch'), undefined)
  await a.sync.syncOnce()
  assert.ok(await b.ctx.sessionPersistence.stat('old-batch'))
})

test('pausing aborts a network wait without waiting for the peer response', { timeout: 10000 }, async t => {
  const { a, b } = await paired(t)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const original = b.library.catalog.bind(b.library)
  b.library.catalog = async () => { entered.resolve(); await release.promise; return original() }
  const running = a.sync.syncOnce()
  await entered.promise
  let watchdogFired = false
  const watchdog = setTimeout(() => { watchdogFired = true; release.resolve() }, 2000)
  try {
    await a.sync.pause(b.sync.identity.id, true); await running
    assert.equal(watchdogFired, false, 'cancellation must close its request, not rely on the remote response')
  } finally { clearTimeout(watchdog); release.resolve() }
})

test('a failed pairing request is immediately retryable and reuses its pending request id', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  await a.sync.probe(b.sync.url)
  const original = b.sync.dispatch.bind(b.sync)
  let attempts = 0, requestedId
  b.sync.dispatch = async (sender, payload, address) => {
    if (payload.action === 'pair/request') {
      if (++attempts === 1) { requestedId = payload.requestId; throw new Error('temporary pairing interruption') }
      assert.equal(payload.requestId, requestedId)
    }
    return original(sender, payload, address)
  }
  await assert.rejects(a.sync.requestPair(b.sync.identity.id), /temporary/)
  assert.equal(a.sync.status().devices[0].requested, false, 'a failed send must not disable the pairing button for five minutes')
  await a.sync.requestPair(b.sync.identity.id)
  await b.sync.acceptPair(a.sync.identity.id)
  assert.equal(a.sync.status().peers.length, 1)
})

test('a cancelled incoming pairing cannot be restored by a late approval response', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  await a.sync.probe(b.sync.url); await a.sync.requestPair(b.sync.identity.id)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const original = a.sync.dispatch.bind(a.sync)
  a.sync.dispatch = async (...args) => { const result = await original(...args); if (args[1].action === 'pair/accept') { entered.resolve(); await release.promise } return result }
  const accepting = b.sync.acceptPair(a.sync.identity.id).then(value => ({ value }), error => ({ error }))
  await entered.promise; await b.sync.declinePair(a.sync.identity.id); release.resolve()
  await accepting
  assert.equal(b.sync.status().peers.length, 0)
})

test('an expired discovery address cannot mask the saved reachable pairing address', async t => {
  const { a, b } = await paired(t)
  await put(b.ctx, fixture('saved-address'), b.root)
  a.sync.discovered.set(b.sync.identity.id, { ...a.sync.peer(b.sync.identity.id), url: 'http://127.0.0.1:1', seenAt: Date.now() - 60000 })
  await a.sync.syncOnce()
  assert.ok(await a.ctx.sessionPersistence.stat('saved-address'))
})

test('an unreachable discovery interface falls back to the authenticated saved address in the same cycle', async t => {
  const { a, b } = await paired(t)
  await put(b.ctx, fixture('multiple-interfaces'), b.root)
  a.sync.observe(b.sync.identity, 'http://127.0.0.1:1')
  await a.sync.syncOnce()
  assert.ok(await a.ctx.sessionPersistence.stat('multiple-interfaces'))
  assert.equal(a.sync.peer(b.sync.identity.id).url, b.sync.url)
  assert.equal(a.sync.status().peers[0].online, true)
})

test('authenticated incoming traffic refreshes a paired address after a peer restarts on a new port', async t => {
  const { a, b } = await paired(t)
  await b.sync.close()
  const restarted = await SyncNode.open({ home: b.root, library: b.library, name: 'B', host: '127.0.0.1', port: 0, discovery: false, intervalMs: 0 })
  t.after(() => restarted.close())
  assert.notEqual(restarted.port, b.sync.port)
  await restarted.syncOnce()
  assert.equal(a.sync.peer(restarted.identity.id).url, restarted.url)
  await put(a.ctx, fixture('after-reconnect'), a.root)
  await a.sync.syncOnce()
  assert.ok(await b.ctx.sessionPersistence.stat('after-reconnect'))
})

test('one button requests pairing and one Allow completes it without a PIN', async t => {
  const a = await node(t, '电脑 A'), b = await node(t, '电脑 B')
  const found = await a.sync.probe(b.sync.url)
  assert.equal(found.name, '电脑 B')
  await a.sync.requestPair(found.id)
  assert.equal(b.sync.status().requests[0].name, '电脑 A')
  assert.equal(b.sync.status().peers.length, 0)
  await b.sync.acceptPair(a.sync.identity.id)
  assert.equal(a.sync.status().peers[0].id, b.sync.identity.id)
  assert.equal(b.sync.status().peers[0].id, a.sync.identity.id)
})

test('unpaired devices cannot enumerate conversations even when their address is known', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  const peer = await a.sync.probe(b.sync.url)
  await assert.rejects(a.sync.rpc(peer, { action: 'catalog' }), /not paired/)
  await a.sync.requestPair(peer.id)
  await assert.rejects(a.sync.rpc(peer, { action: 'catalog' }), /not paired/)
})

test('paired devices reconcile their whole conversation libraries and keep working after a peer closes', async t => {
  const { a, b } = await paired(t)
  await put(a.ctx, fixture('session-a'), a.root)
  await put(b.ctx, fixture('session-b'), b.root)
  await a.sync.syncOnce()
  assert.deepEqual((await a.library.catalog()).sessions.map(s => s.id).sort(), ['session-a', 'session-b'])
  assert.deepEqual((await b.library.catalog()).sessions.map(s => s.id).sort(), ['session-a', 'session-b'])
  await a.sync.close()
  const writer = await b.ctx.sessionPersistence.open('session-a', 'write')
  await writer.append(fixture('session-a', '', 2, 2).events); await writer.close()
  await b.sync.syncOnce()
  assert.equal((await b.library.export('session-a')).events.length, 4)
  assert.equal(b.sync.status().peers[0].online, false)
})

test('pausing a device stops incoming reads and writes', async t => {
  const { a, b } = await paired(t)
  await b.sync.pause(a.sync.identity.id, true)
  await assert.rejects(a.sync.rpc(a.sync.status().peers[0], { action: 'catalog' }), /paused/)
  await b.sync.pause(a.sync.identity.id, false)
  assert.deepEqual((await a.sync.rpc(a.sync.status().peers[0], { action: 'catalog' })).sessions, [])
})

test('pairing survives restarts and an unknown acceptance cannot grant trust', async t => {
  const { a, b } = await paired(t)
  const id = a.sync.identity.id
  await a.sync.close()
  const restarted = await SyncNode.open({ home: a.root, library: a.library, name: 'A', host: '127.0.0.1', port: 0, discovery: false, intervalMs: 0 })
  t.after(() => restarted.close())
  assert.equal(restarted.identity.id, id)
  assert.equal(restarted.status().peers[0].id, b.sync.identity.id)
  const c = await node(t, 'C'); const peer = await c.sync.probe(b.sync.url)
  await assert.rejects(c.sync.rpc(peer, { action: 'pair/accept', requestId: 'made-up', port: c.sync.port }), /no pending/)
  assert.equal(b.sync.status().peers.length, 1)
})

test('retrying the same approved pairing after a lost acknowledgement is idempotent', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  await a.sync.probe(b.sync.url); await a.sync.requestPair(b.sync.identity.id)
  const pending = b.sync.state.incoming[a.sync.identity.id]
  const approval = { action: 'pair/accept', requestId: pending.requestId, port: b.sync.port }
  await b.sync.rpc(pending, approval)
  // Simulate the reply being lost before B saves the approved peer locally.
  await b.sync.acceptPair(a.sync.identity.id)
  assert.equal(b.sync.status().peers.length, 1)
  assert.equal(a.sync.status().peers.length, 1)
})

test('the global sync setting pauses both incoming and outgoing conversation exchange', async t => {
  const { a, b } = await paired(t)
  const settings = a.sync.status().settings
  assert.ok(settings, 'TheTwo exposes editable sync preferences')
  await put(b.ctx, fixture('while-paused'), b.root)
  await a.sync.configure({ ...settings.values, syncEnabled: false }, settings.revision)
  await assert.rejects(b.sync.rpc(b.sync.peer(a.sync.identity.id), { action: 'catalog' }), /paused/)
  await a.sync.syncOnce()
  assert.equal((await a.library.catalog()).sessions.length, 0)
  const paused = a.sync.status().settings
  await a.sync.configure({ ...paused.values, syncEnabled: true }, paused.revision)
  await a.sync.syncOnce()
  assert.equal((await a.library.catalog()).sessions[0].id, 'while-paused')
})

test('renaming a device reaches its paired peer without changing the pairing identity', async t => {
  const { a, b } = await paired(t), id = a.sync.identity.id
  const before = a.sync.status().settings
  await a.sync.configure({ ...before.values, deviceName: '书房电脑' }, before.revision)
  await a.sync.syncOnce()
  assert.equal(b.sync.status().peers[0].name, '书房电脑')
  assert.equal(b.sync.status().peers[0].id, id)
})

test('a conversation that changes during transfer does not block other conversations or mark the device offline', async t => {
  const { a, b } = await paired(t)
  await put(b.ctx, fixture('a-changing'), b.root)
  await put(b.ctx, fixture('z-ready'), b.root)
  const original = b.library.export.bind(b.library)
  b.library.export = async (id, flush) => {
    if (id === 'a-changing' && flush !== false) throw new Error('unfinished turn')
    return original(id, flush)
  }
  await a.sync.syncOnce()
  assert.ok((await a.library.catalog()).sessions.some(s => s.id === 'z-ready'))
  assert.equal(a.sync.status().peers[0].online, true)
  assert.equal(a.sync.status().peers[0].issues.length, 1)
})

test('a saved pending checkpoint is not downloaded repeatedly while DSH holds its writer', async t => {
  const { a, b } = await paired(t)
  await put(a.ctx, fixture('waiting-on-writer'), a.root)
  await a.sync.syncOnce()
  const held = await a.ctx.sessionPersistence.open('waiting-on-writer', 'write')
  t.after(() => held.close())
  const newer = await b.ctx.sessionPersistence.open('waiting-on-writer', 'write')
  await newer.append(fixture('waiting-on-writer', '', 2, 2).events); await newer.close()
  let downloads = 0
  const original = b.library.export.bind(b.library)
  b.library.export = async (id, flush) => { if (flush !== false) downloads++; return original(id, flush) }
  await a.sync.syncOnce()
  assert.equal(downloads, 1)
  await a.sync.syncOnce(); await a.sync.syncOnce()
  assert.equal(downloads, 1)
  assert.equal(a.library.status().pending.length, 1)
})

test('incompatible preview peers are refused before checkpoint exchange', async t => {
  const { a, b } = await paired(t)
  await put(b.ctx, fixture('new-format'), b.root)
  const original = b.sync.dispatch.bind(b.sync)
  b.sync.dispatch = async (sender, payload, address) => {
    const result = await original(sender, payload, address)
    if (payload.action === 'catalog') delete result.capabilities
    return result
  }
  await a.sync.syncOnce()
  assert.equal((await a.library.catalog()).sessions.length, 0)
  assert.match(a.sync.status().peers[0].blocked, /升级/)
  assert.equal(a.sync.status().peers[0].online, true, 'the device answered: the sync is held up, the connection is not')
})
