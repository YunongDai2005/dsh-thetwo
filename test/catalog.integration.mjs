import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshLibrary } from '../lib/library.js'
import { harness, fixture, put, runtime } from './runtime.mjs'
import { join } from 'node:path'

test('local archive changes appear without changing the sync digest or silently unarchiving', async t => {
  const app = await harness(t)
  await put(app.ctx, fixture('archived-chat'), app.root)
  for (const [name, config] of [['dsh-storage'], ['dsh-storage-json', { root: join(app.root, 'storages') }], ['dsh-storage-domain', { backend: 'json' }], ['dsh-workspace']]) {
    const mod = await runtime(`@deepseek-ai/${name}`)
    await app.ctx.plugin(mod.default ?? mod, config)
  }
  const library = await DshLibrary.open(app.ctx, app.root)
  const first = (await library.catalog()).sessions[0]
  assert.equal(first.archived, false)
  await app.ctx.workspaceRegistry.archiveSession('archived-chat')
  const next = (await library.catalog()).sessions[0]
  assert.equal(next.archived, true)
  assert.equal(next.digest, first.digest, 'archival is local metadata, not a conversation fork')
  assert.equal((await library.openConversation('archived-chat')).archived, true)
  assert.deepEqual([...app.ctx.workspaceRegistry.archivedSessionIds], ['archived-chat'])
  await app.ctx.workspaceRegistry.unarchiveSession('archived-chat')
  assert.equal((await library.catalog()).sessions[0].archived, false)
  assert.equal((await library.openConversation('archived-chat')).archived, false)
})

test('unchanged libraries reuse revision metadata and decode only a changed conversation', async t => {
  const app = await harness(t)
  for (const id of ['one','two','three']) await put(app.ctx, fixture(id), app.root)
  const library = await DshLibrary.open(app.ctx, app.root)
  let reads = 0
  const read = library.readNative.bind(library)
  library.readNative = async id => { reads++; return read(id) }
  const first = await library.catalog()
  assert.equal(first.sessions.length, 3)
  const initial = reads
  assert.deepEqual(await library.catalog(), first)
  assert.equal(reads, initial, 'periodic checks must not decode every unchanged log')
  const writer = await app.ctx.sessionPersistence.open('two', 'write')
  await writer.append(fixture('two', '', 2, 2).events); await writer.close()
  const next = await library.catalog()
  assert.equal(next.sessions.find(s => s.id === 'two').count, 4)
  assert.equal(reads, initial + 1)
})
