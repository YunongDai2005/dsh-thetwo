import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshLibrary } from '../lib/library.js'
import { harness, runtime, put } from './runtime.mjs'

async function attached(t) {
  const app = await harness(t)
  const mod = await runtime('@deepseek-ai/dsh-attachment-local')
  await app.ctx.plugin(mod.default, { dshHome: app.root })
  return { ...app, library: await DshLibrary.open(app.ctx, app.root) }
}
async function conversation(refs) {
  const { Session } = await runtime('@deepseek-ai/dsh-session')
  const { createUserMessage } = await runtime('@deepseek-ai/dsh-llm')
  const s = Session.create('with-attachments')
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', createUserMessage({ content: refs.map(ref => ({ type: ref.mediaType ? 'image' : 'file', attachment: ref })), source: { kind: 'user' } }), { surfaceOp: 'append' })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { header: s.header, events: s.snapshotEvents(), inheritedEventCount: 0 }
}
test('real DSH file and image attachments arrive before the owning conversation', async t => {
  const a = await attached(t), b = await attached(t)
  const file = await a.ctx.attachments.saveFile({ data: Buffer.from('附件原文\n'), name: '说明.txt' })
  const { default: sharp } = await runtime('sharp')
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer()
  const img = await a.ctx.attachments.saveImage({ data: image, mediaType: 'image/png', name: 'pixel.png' })
  await put(a.ctx, await conversation([file, img]), a.root)
  assert.equal((await a.library.catalog()).sessions.length, 1)
  const checkpoint = await a.library.export('with-attachments')
  assert.equal(checkpoint.attachments.length, 2)
  assert.equal((await b.library.accept(checkpoint)).status, 'imported')
  const chunks = []
  for await (const chunk of b.ctx.attachments.readFileStream(file)) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString(), '附件原文\n')
  assert.deepEqual((await b.ctx.attachments.readImage(img)).data, (await a.ctx.attachments.readImage(img)).data)
  assert.equal((await b.library.export('with-attachments')).digest, checkpoint.digest)
})
test('missing or corrupt attachment bytes never publish a broken conversation', async t => {
  const a = await attached(t), b = await attached(t)
  const file = await a.ctx.attachments.saveFile({ data: Buffer.from('verified'), name: 'example.txt' })
  await put(a.ctx, await conversation([file]), a.root)
  const checkpoint = await a.library.export('with-attachments')
  const missing = structuredClone(checkpoint); missing.attachments = []
  await assert.rejects(b.library.accept(missing), /附件/)
  const corrupt = structuredClone(checkpoint); corrupt.attachments[0].data = Buffer.from('modified').toString('base64')
  await assert.rejects(b.library.accept(corrupt), /附件/)
  assert.equal(await b.ctx.sessionPersistence.stat('with-attachments'), undefined)
  assert.equal(b.library.status().pending.length, 0)
})
