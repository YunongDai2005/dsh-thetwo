import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshLibrary } from '../lib/library.js'
import { harness, fixture, put } from './runtime.mjs'

async function linked(t) {
  const a = await harness(t), b = await harness(t)
  await put(a.ctx, fixture(), a.root)
  const la = await DshLibrary.open(a.ctx, a.root), lb = await DshLibrary.open(b.ctx, b.root)
  await lb.accept(await la.export('session-demo'))
  const lock = await a.ctx.sessionPersistence.open('session-demo', 'write')
  t.after(() => lock.close())
  const writer = await b.ctx.sessionPersistence.open('session-demo', 'write')
  await writer.append(fixture('session-demo', '', 2, 2).events); await writer.close()
  await la.accept(await lb.export('session-demo'))
  return { a, b, la, lb, lock }
}

test('opening a received update continues the latest complete history without restarting or touching the held writer', async t => {
  const { a, la, lock } = await linked(t)
  assert.equal(typeof la.openConversation, 'function', 'opening shared history must resolve pending updates')
  const target = await la.openConversation('session-demo')
  assert.notEqual(target.id, 'session-demo')
  const handle = await a.ctx.sessionPersistence.open(target.id, 'read')
  assert.equal((await handle.read()).events.length, 4); await handle.close()
  assert.equal((await lock.read()).events.length, 2)
  assert.equal((await la.catalog()).sessions.length, 1)
  assert.equal((await la.catalog()).sessions[0].id, 'session-demo')
  assert.equal(la.status().pending.length, 0)
})

test('a continued local version syncs back under the shared identity and survives restart', async t => {
  const { a, la, lb } = await linked(t)
  assert.equal(typeof la.openConversation, 'function')
  const target = await la.openConversation('session-demo')
  const writer = await a.ctx.sessionPersistence.open(target.id, 'write')
  await writer.append(fixture('session-demo', '', 3, 4).events); await writer.close()
  assert.equal((await lb.accept(await la.export('session-demo'))).status, 'updated')
  assert.equal((await lb.export('session-demo')).events.length, 6)
  const reopened = await DshLibrary.open(a.ctx, a.root)
  assert.equal((await reopened.openConversation('session-demo')).id, target.id)
  assert.equal((await reopened.catalog()).sessions.length, 1)
  assert.equal((await reopened.export('session-demo')).events.length, 6)
})

test('typing in a retained old native tab is preserved as a conflict instead of silently discarded', async t => {
  const { la, lock } = await linked(t)
  assert.equal(typeof la.openConversation, 'function')
  await la.openConversation('session-demo')
  const divergent = fixture('session-demo', '', 2, 2).events
  divergent[0].time += 100
  await lock.append(divergent); await lock.flush()
  const catalog = await la.catalog()
  assert.equal(catalog.sessions[0].conflict, true)
  const result = await la.recoverConflict('session-demo')
  const copies = await Promise.all(result.ids.map(id => la.export(id)))
  assert.ok(copies.some(s => s.events[2].time === divergent[0].time))
})

test('repeated opening of a pending update creates only one continuation', async t => {
  const { a, la } = await linked(t)
  assert.equal(typeof la.openConversation, 'function')
  const results = await Promise.all([la.openConversation('session-demo'), la.openConversation('session-demo')])
  assert.equal(results[0].id, results[1].id)
  assert.equal((await a.ctx.sessionPersistence.list()).length, 2)
})

test('a crash while publishing a continuation never advertises its native copy as a second shared conversation', async t => {
  const { a, la } = await linked(t)
  const save = la.save.bind(la)
  la.save = async () => {
    if (la.state.routes['session-demo']) throw new Error('simulated disk interruption')
    return save()
  }
  await assert.rejects(la.openConversation('session-demo'), /simulated disk interruption/)
  const restarted = await DshLibrary.open(a.ctx, a.root)
  assert.equal((await restarted.catalog()).sessions.length, 1)
  const target = await restarted.openConversation('session-demo')
  assert.notEqual(target.id, 'session-demo')
  assert.equal((await restarted.export('session-demo')).events.length, 4)
  assert.equal((await a.ctx.sessionPersistence.list()).length, 2)
})
