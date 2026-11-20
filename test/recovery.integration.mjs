import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { openHarness } from './runtime.mjs'
import { DshLibrary } from '../lib/library.js'
import { harness, fixture, put, runtime } from './runtime.mjs'

async function workspaces(app) {
  for (const [name, config] of [['dsh-storage'], ['dsh-storage-json', { root: join(app.root, 'storages') }], ['dsh-storage-domain', { backend: 'json' }], ['dsh-workspace']]) {
    const mod = await runtime(`@deepseek-ai/${name}`)
    await app.ctx.plugin(mod.default ?? mod, config)
  }
}

for (const stage of ['metadata', 'workspace']) test(`restart completes shared workspace registration after an import ${stage} failure`, async t => {
  const a = await harness(t), b = await harness(t)
  await workspaces(b)
  await put(a.ctx, fixture('recover-import'), a.root)
  const source = await DshLibrary.open(a.ctx, a.root), library = await DshLibrary.open(b.ctx, b.root)
  const owner = stage === 'metadata' ? library : b.ctx.workspaceRegistry
  const method = stage === 'metadata' ? 'save' : 'create'
  const original = owner[method].bind(owner)
  let failed = false
  owner[method] = async (...args) => {
    if (!failed) { failed = true; throw new Error('simulated import interruption') }
    return original(...args)
  }
  await assert.rejects(library.accept(await source.export('recover-import')), /simulated import interruption/)
  assert.ok(await b.ctx.sessionPersistence.stat('recover-import'), 'the real conversation was persisted before the interruption')
  const restarted = await DshLibrary.open(b.ctx, b.root)
  await restarted.retryPending()
  assert.equal(restarted.status().pending.length, 0)
  assert.deepEqual((await restarted.export('recover-import')).events, (await source.export('recover-import')).events)
  assert.equal(b.ctx.workspaceRegistry.list().filter(row => row.path === restarted.cwd).length, 1, 'a complete import must be reachable from its native shared workspace')
  const again = await DshLibrary.open(b.ctx, b.root)
  assert.ok(again.state.imported['recover-import'], 'import bookkeeping must survive another restart')
})

test('retry without restart persists import bookkeeping after a transient metadata write failure', async t => {
  const a = await harness(t), b = await harness(t)
  await workspaces(b)
  await put(a.ctx, fixture('retry-import'), a.root)
  const source = await DshLibrary.open(a.ctx, a.root), library = await DshLibrary.open(b.ctx, b.root)
  const original = library.save.bind(library)
  let failed = false
  library.save = async () => { if (!failed) { failed = true; throw new Error('temporary write failure') } return original() }
  await assert.rejects(library.accept(await source.export('retry-import')), /temporary write failure/)
  await library.retryPending()
  const restarted = await DshLibrary.open(b.ctx, b.root)
  assert.ok(restarted.state.imported['retry-import'])
  assert.equal(restarted.status().pending.length, 0)
  assert.equal((await b.ctx.sessionPersistence.list()).length, 1)
  assert.equal(b.ctx.workspaceRegistry.list().filter(row => row.path === library.cwd).length, 1)
})

test('a terminated process resumes its durable inbox and complete native history in a fresh DSH store', { timeout: 15000 }, async t => {
  const a = await harness(t), b = await harness(t)
  await put(a.ctx, fixture('process-crash'), a.root)
  const source = await DshLibrary.open(a.ctx, a.root), snapshot = await source.export('process-crash')
  await workspaces(b)
  await b.ctx.fiber.dispose()
  const child = fork(new URL('./fixtures/crash-import.mjs', import.meta.url), [b.root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited })
  assert.equal((await once(child, 'message'))[0].phase, 'ready', stderr)
  const committed = once(child, 'message')
  child.send(snapshot)
  assert.equal((await committed)[0].phase, 'native-log-flushed', stderr)
  child.kill(); await exited
  const restartedApp = await openHarness(b.root)
  t.after(() => restartedApp.ctx.fiber.dispose())
  await workspaces(restartedApp)
  const restarted = await DshLibrary.open(restartedApp.ctx, b.root)
  assert.equal(restarted.status().pending.length, 1)
  await restarted.retryPending()
  assert.deepEqual((await restarted.export('process-crash')).events, snapshot.events)
  assert.equal(restarted.status().pending.length, 0)
  assert.ok(restarted.state.imported['process-crash'])
  assert.equal(restartedApp.ctx.workspaceRegistry.list().filter(row => row.path === restarted.cwd).length, 1)
  assert.equal((await restartedApp.ctx.sessionPersistence.list()).length, 1)
})
