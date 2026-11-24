import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { digest } from '../lib/content.js'
import { DshLibrary } from '../lib/library.js'
import { fixture, harness, put } from './runtime.mjs'

function delivery(seq, sessionId, sessionFormatVersion = 4) {
  return { seq, time: 1700000000000 + seq, type: 'session-log-deepseek/delivery-accepted', data: { sessionId, sessionFormatVersion, throughSeq: seq - 1 } }
}

// The history reader applies the format catalog's ownership checks when it opens a log.
async function restoreHistory(library, id) {
  const { header, inheritedEventCount, events } = await library.readNative(id)
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(header, inheritedEventCount), { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  return restore.finish()
}

async function savedConflict(t) {
  const a = await harness(t), b = await harness(t)
  const snapshot = fixture('source-fork')
  const id = snapshot.header.id
  Object.assign(snapshot.header, { isSeeded: true, parentSession: 'parent-session', delegationDepth: 0 })
  snapshot.events.push(
    delivery(2, 'parent-session'),
    { seq: 3, time: 1700000000003, type: 'session/end-seed', data: { inherited: true } },
    delivery(4, id),
    delivery(5, id, 3),
    { seq: 6, time: 1700000000006, type: 'example/reference', ignorable: true, data: { sessionId: id } },
  )
  snapshot.inheritedEventCount = 3
  await put(a.ctx, fixture(id), a.root)
  await put(b.ctx, snapshot, b.root)
  const library = await DshLibrary.open(a.ctx, a.root), peer = await DshLibrary.open(b.ctx, b.root)
  await restoreHistory(peer, id)
  const remote = await peer.export(id)
  assert.equal((await library.accept(remote)).status, 'conflict')
  return { a, library, remote, id }
}

test('DSH opens a linked conflict copy with its own deliveries and its parent’s inherited deliveries', async t => {
  const { library, remote, id } = await savedConflict(t)
  const { ids: [copyId] } = await library.recoverConflict(id)
  const restored = await restoreHistory(library, copyId)
  const expected = structuredClone(remote.events)
  expected[4].data.sessionId = copyId
  assert.deepEqual(restored.events, expected)
  assert.equal(restored.header.parentSession, 'parent-session')
  assert.equal(restored.inheritedEventCount, 3)
  assert.deepEqual((await library.recoverConflict(id)).ids, [copyId])
})

test('a checkpoint with a foreign current delivery is rejected before a native session is created', async t => {
  const a = await harness(t), library = await DshLibrary.open(a.ctx, a.root)
  const snapshot = fixture('unrelated-session')
  delete snapshot.title
  snapshot.events.push(delivery(2, 'different-owner'))
  snapshot.digest = digest(snapshot)
  await assert.rejects(library.accept(snapshot), /delivery marker names the wrong Session/)
  assert.equal(await a.ctx.sessionPersistence.stat(snapshot.header.id), undefined)
  assert.equal(library.status().pending.length, 0)
})

test('recovering a conflict after upgrading opens a valid copy of the checkpoint saved by 0.1.1', async t => {
  const { a, library, remote, id } = await savedConflict(t)
  const oldId = `linked-${digest({ id, events: remote.events }).slice(0, 32)}`
  await put(a.ctx, { ...remote, header: { ...remote.header, id: oldId } }, library.cwd)
  await assert.rejects(restoreHistory(library, oldId), /delivery marker names the wrong Session/)
  const restarted = await DshLibrary.open(a.ctx, a.root)
  const { ids: [copyId] } = await restarted.recoverConflict(id)
  const restored = await restoreHistory(restarted, copyId)
  assert.equal(restored.events[4].data.sessionId, copyId)
  assert.deepEqual((await restarted.recoverConflict(id)).ids, [copyId])
  assert.ok(await a.ctx.sessionPersistence.stat(oldId))
})

test('a peer checkpoint can be recovered when a published 0.1.1 continuation is unreadable', async t => {
  const a = await harness(t), b = await harness(t)
  const checkpoint = fixture('shared-before-upgrade')
  checkpoint.header.delegationDepth = 0
  const id = checkpoint.header.id
  checkpoint.events.push(delivery(2, id))
  await put(b.ctx, checkpoint, b.root)
  const peer = await DshLibrary.open(b.ctx, b.root), remote = await peer.export(id)
  const oldId = `two-${digest({ id, checkpoint: remote.digest }).slice(0, 40)}`
  await put(a.ctx, { ...remote, header: { ...remote.header, id: oldId } }, a.root)
  const library = await DshLibrary.open(a.ctx, a.root)
  library.state.routes[id] = { nativeId: oldId }
  await library.save()
  const updated = await DshLibrary.open(a.ctx, a.root)
  assert.equal((await updated.accept(remote)).status, 'conflict')
  const { ids: [copyId] } = await updated.recoverConflict(id)
  assert.equal((await restoreHistory(updated, copyId)).events[2].data.sessionId, copyId)
  assert.ok(await a.ctx.sessionPersistence.stat(oldId))
})

test('a routed continuation round-trips deliveries under each device’s native identity', async t => {
  const a = await harness(t), b = await harness(t)
  const base = fixture('shared-session')
  base.header.delegationDepth = 0
  const id = base.header.id
  base.events.push(delivery(2, id))
  await put(a.ctx, base, a.root)
  await put(b.ctx, base, b.root)
  const local = await DshLibrary.open(a.ctx, a.root), peer = await DshLibrary.open(b.ctx, b.root)
  const lock = await a.ctx.sessionPersistence.open(id, 'write')
  t.after(() => lock.close())
  async function append(app, nativeId, event) {
    const writer = await app.ctx.sessionPersistence.open(nativeId, 'write')
    try { await writer.append([event]) } finally { await writer.close() }
  }
  await append(b, id, delivery(3, id))
  assert.equal((await local.accept(await peer.export(id))).status, 'pending')
  const target = await local.openConversation(id)
  assert.notEqual(target.id, id)
  await restoreHistory(local, target.id)
  await append(a, target.id, delivery(4, target.id))
  assert.equal((await peer.accept(await local.export(id))).status, 'updated')
  assert.equal((await restoreHistory(peer, id)).events[4].data.sessionId, id)
  await append(b, id, delivery(5, id))
  assert.equal((await local.accept(await peer.export(id))).status, 'updated')
  assert.equal((await restoreHistory(local, target.id)).events[5].data.sessionId, target.id)
  assert.equal((await peer.accept(await local.export(id))).status, 'equal')
  assert.equal((await local.catalog()).sessions[0].digest, (await peer.catalog()).sessions[0].digest)
  assert.deepEqual((await lock.read()).events, base.events)
})
