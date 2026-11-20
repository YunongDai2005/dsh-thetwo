import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshLibrary } from '../lib/library.js'
import { harness, fixture, put, runtime } from './runtime.mjs'
import { readFile } from 'node:fs/promises'
import { digest } from '../lib/content.js'

test('native DSH event validation rejects corrupt messages before publishing a session', async t => {
  const a = await harness(t), library = await DshLibrary.open(a.ctx, a.root)
  const snapshot = fixture('malformed-message')
  snapshot.events.splice(1, 0, { seq: 1, time: 1, type: 'user/message', data: { id: 'bad', content: [{ type: 'text', text: 'no surface' }], source: { kind: 'user' } } })
  snapshot.events[2].seq = 2
  delete snapshot.title
  snapshot.digest = digest(snapshot)
  await assert.rejects(library.accept(snapshot), /surface|message/)
  assert.equal(await a.ctx.sessionPersistence.stat(snapshot.header.id), undefined)
  assert.equal(library.status().pending.length, 0)
})

test('valid session ids that match Object properties remain visible and transferable', async t => {
  const a = await harness(t), b = await harness(t)
  await put(a.ctx, fixture('constructor'), a.root)
  const la = await DshLibrary.open(a.ctx, a.root), lb = await DshLibrary.open(b.ctx, b.root)
  assert.equal((await la.catalog()).sessions[0]?.id, 'constructor')
  await lb.accept(await la.export('constructor'))
  assert.equal((await lb.catalog()).sessions[0]?.id, 'constructor')
})

test('two real DSH stores continue the same session A → B → A', async t => {
  const a = await harness(t), b = await harness(t)
  await put(a.ctx, fixture(), a.root)
  const la = await DshLibrary.open(a.ctx, a.root), lb = await DshLibrary.open(b.ctx, b.root)
  assert.equal((await lb.accept(await la.export('session-demo'))).status, 'imported')
  const bWriter = await b.ctx.sessionPersistence.open('session-demo', 'write')
  await bWriter.append(fixture('session-demo', 'world', 2, 2).events); await bWriter.close()
  assert.equal((await la.accept(await lb.export('session-demo'))).status, 'updated')
  assert.equal((await la.export('session-demo')).events.length, 4)
  assert.equal((await a.ctx.sessionPersistence.list()).length, 1)
  assert.equal((await lb.accept(await la.export('session-demo'))).status, 'equal')
})

test('replay survives a library restart without duplicating events', async t => {
  const a = await harness(t), b = await harness(t)
  await put(a.ctx, fixture(), a.root)
  const la = await DshLibrary.open(a.ctx, a.root)
  const lb = await DshLibrary.open(b.ctx, b.root)
  const snapshot = await la.export('session-demo')
  await lb.accept(snapshot)
  const reopened = await DshLibrary.open(b.ctx, b.root)
  assert.equal((await reopened.accept(snapshot)).status, 'equal')
  assert.equal((await reopened.export('session-demo')).events.length, 2)
})

test('two divergent pending checkpoints both survive while a local writer is held', async t => {
  const a = await harness(t), b = await harness(t), c = await harness(t)
  for (const x of [a,b,c]) await put(x.ctx, fixture(), x.root)
  const la = await DshLibrary.open(a.ctx, a.root), lb = await DshLibrary.open(b.ctx, b.root), lc = await DshLibrary.open(c.ctx, c.root)
  for (const [x, change] of [[a, 10], [c, 20]]) {
    const writer = await x.ctx.sessionPersistence.open('session-demo', 'write')
    const events = fixture('session-demo', '', 2, 2).events
    events[0].time += change; await writer.append(events); await writer.close()
  }
  const lock = await b.ctx.sessionPersistence.open('session-demo', 'write')
  const first = await la.export('session-demo'), second = await lc.export('session-demo')
  await lb.accept(first); await lb.accept(second)
  const copies = await Promise.all(lb.state.conflicts['session-demo'].copies.map(async p => JSON.parse(await readFile(p, 'utf8'))))
  assert.ok(copies.some(s => s.digest === first.digest))
  assert.ok(copies.some(s => s.digest === second.digest))
  await lock.close()
})

test('a conflicting remote history can be opened as a stable separate native conversation', async t => {
  const a = await harness(t), b = await harness(t)
  await put(a.ctx, fixture(), a.root)
  const other = fixture(); other.events[0].time += 10
  await put(b.ctx, other, b.root)
  const la = await DshLibrary.open(a.ctx, a.root), lb = await DshLibrary.open(b.ctx, b.root)
  await la.accept(await lb.export('session-demo'))
  const result = await la.recoverConflict('session-demo')
  assert.equal(result.ids.length, 1)
  assert.notEqual(result.ids[0], 'session-demo')
  assert.deepEqual((await la.export(result.ids[0])).events, other.events)
  assert.deepEqual(await la.recoverConflict('session-demo'), result)
  assert.equal((await a.ctx.sessionPersistence.list()).length, 2)
})

test('a preview does not advertise a complete copy when its attachment bytes are unsupported', async t => {
  const a = await harness(t), f = fixture()
  f.events[0].data.attachment = { attachmentId: 'a'.repeat(64), name: 'photo.png' }
  await put(a.ctx, f, a.root)
  const library = await DshLibrary.open(a.ctx, a.root)
  const catalog = await library.catalog()
  assert.equal(catalog.sessions.length, 0)
  assert.match(catalog.waiting[0].reason, /附件/)
})

test('an active DSH writer is never overwritten and receives a durable pending update', async t => {
  const a = await harness(t), b = await harness(t)
  await put(a.ctx, fixture(), a.root)
  const la = await DshLibrary.open(a.ctx, a.root), lb = await DshLibrary.open(b.ctx, b.root)
  await lb.accept(await la.export('session-demo'))
  const writer = await b.ctx.sessionPersistence.open('session-demo', 'write')
  const extra = await a.ctx.sessionPersistence.open('session-demo', 'write')
  await extra.append(fixture('session-demo', '', 2, 2).events); await extra.close()
  assert.equal((await lb.accept(await la.export('session-demo'))).status, 'pending')
  assert.equal((await writer.read()).events.length, 2)
  await writer.close()
  const reopened = await DshLibrary.open(b.ctx, b.root)
  await reopened.retryPending()
  assert.equal((await reopened.export('session-demo')).events.length, 4)
})

test('separately continued histories keep both copies without rewriting the local conversation', async t => {
  const a = await harness(t), b = await harness(t)
  await put(a.ctx, fixture(), a.root); await put(b.ctx, fixture(), b.root)
  const wa = await a.ctx.sessionPersistence.open('session-demo', 'write'), wb = await b.ctx.sessionPersistence.open('session-demo', 'write')
  await wa.append(fixture('session-demo', '', 2, 2).events)
  const divergent = fixture('session-demo', '', 2, 2).events; divergent[0].time += 1000
  await wb.append(divergent); await wa.close(); await wb.close()
  const la = await DshLibrary.open(a.ctx, a.root), lb = await DshLibrary.open(b.ctx, b.root)
  const localBefore = await lb.export('session-demo')
  const result = await lb.accept(await la.export('session-demo'))
  assert.equal(result.status, 'conflict')
  assert.deepEqual((await lb.export('session-demo')).events, localBefore.events)
  assert.equal(lb.status().conflicts.length, 1)
  await lb.accept(await la.export('session-demo'))
  assert.equal(lb.status().conflicts.length, 1)
})

test('uncommitted conversation tails do not enter the advertised shared library', async t => {
  const a = await harness(t)
  await put(a.ctx, { ...fixture(), events: [fixture().events[0]] }, a.root)
  const la = await DshLibrary.open(a.ctx, a.root)
  const catalog = await la.catalog()
  assert.equal(catalog.sessions.length, 0)
  assert.equal(catalog.waiting.length, 1)
})

test('native DSH restores the same model-visible text messages after transfer', async t => {
  const a = await harness(t), b = await harness(t)
  const { Session } = await runtime('@deepseek-ai/dsh-session')
  const { createUserMessage, createAssistantMessage } = await runtime('@deepseek-ai/dsh-llm')
  const source = Session.create('conversation-text')
  source.append('turn/start', { turn: 1 })
  source.append('step/start', { turn: 1, step: 1 })
  source.append('user/message', createUserMessage({ content: [{ type: 'text', text: '记住：项目代号是银杏。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  source.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '记住了，代号是银杏。' }], source: { provider: 'fixture', model: 'local-fixture' } }), stream: [] }, { surfaceOp: 'append' })
  source.append('step/end', { turn: 1, step: 1 })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await put(a.ctx, { header: source.header, inheritedEventCount: 0, events: source.snapshotEvents() }, a.root)
  const la = await DshLibrary.open(a.ctx, a.root), lb = await DshLibrary.open(b.ctx, b.root)
  await lb.accept(await la.export(source.id))
  const copied = await lb.read(source.id)
  const restored = Session.create(source.id, copied.events, copied.header, copied.inheritedEventCount)
  assert.deepEqual(restored.deriveMessages(), source.deriveMessages())
  assert.equal((await lb.export(source.id)).title, '记住：项目代号是银杏。')
})

test('independently opening identical histories does not conflict solely on DSH resume-marker timestamps', async t => {
  const a = await harness(t), b = await harness(t)
  const first = fixture(), second = fixture()
  first.events.push({ seq: 2, time: 100, type: 'session/end-seed', data: {} })
  second.events.push({ seq: 2, time: 200, type: 'session/end-seed', data: {} })
  await put(a.ctx, first, a.root); await put(b.ctx, second, b.root)
  const la = await DshLibrary.open(a.ctx, a.root), lb = await DshLibrary.open(b.ctx, b.root)
  assert.equal((await la.catalog()).sessions[0].digest, (await lb.catalog()).sessions[0].digest)
  const writer = await b.ctx.sessionPersistence.open('session-demo', 'write')
  await writer.append(fixture('session-demo', '', 2, 3).events); await writer.close()
  assert.equal((await la.accept(await lb.export('session-demo'))).status, 'updated')
  assert.equal((await la.export('session-demo')).events[2].time, 100)
  assert.equal((await la.export('session-demo')).events.length, 5)
})
