// Manual two-computer acceptance station. Real DSH services, synthetic model/data.
// The management listener is loopback-only; only the production SyncNode uses LAN.
import http from 'node:http'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { hostname } from 'node:os'
import { mountAgentServices, openHarness, runtime } from '../test/runtime.mjs'
import { DshLibrary } from '../lib/library.js'
import { SyncNode } from '../lib/node.js'

const station = process.argv[2]
if (!/^[a-z][a-z0-9-]{0,30}$/.test(station ?? '')) throw new Error('Usage: node scripts/lan-station.mjs windows|mac')
const home = resolve('.preview', `lan-acceptance-${station}`)
await mkdir(home, { recursive: true })
const app = await openHarness(home), ctx = app.ctx
for (const [name, config] of [
  ['dsh-attachment-local', { dshHome: home }],
  ['dsh-storage'], ['dsh-storage-json', { root: join(home, 'storages') }],
  ['dsh-storage-domain', { backend: 'json' }], ['dsh-workspace'],
]) { const mod = await runtime(`@deepseek-ai/${name}`); await ctx.plugin(mod.default ?? mod, config) }
await mountAgentServices(ctx)
const { createUserMessage, LlmAdapter } = await runtime('@deepseek-ai/dsh-llm')
const requests = [], handles = new Map()
class FixtureAdapter extends LlmAdapter {
  async *stream(options) {
    requests.push(options)
    const answer = `TheTwo 实机验收：${station} 本地固定回复。`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['thetwo-acceptance'], new FixtureAdapter())
const agentOptions = { provider: 'thetwo-acceptance', model: 'offline-fixture' }
const library = await DshLibrary.open(ctx, home)
const options = { home, library, name: `TheTwo 验收 · ${station}`, port: 48800, discovery: true }
let node = await SyncNode.open(options)
const sha = data => createHash('sha256').update(data).digest('hex')
const eventsLog = []
async function evidence(id) {
  const s = await library.export(id)
  return {
    id, nativeId: library.nativeId(id), digest: s.digest, events: s.events.length,
    turns: s.events.filter(e => e.type === 'turn/end').length,
    texts: s.events.filter(e => ['user/message', 'assistant/message'].includes(e.type)).flatMap(e => (e.data.message ?? e.data).content ?? []).filter(c => c.type === 'text').map(c => c.text),
    attachments: (s.attachments ?? []).map(a => ({ ...a, data: undefined, bytes: Buffer.from(a.data, 'base64').length, actualSha256: sha(Buffer.from(a.data, 'base64')) })),
  }
}
async function act(input) {
  const { action, id } = input
  switch (action) {
    case 'status': return { station, host: hostname(), platform: process.platform, home, sync: node.status(), catalog: await library.catalog() }
    case 'probe': return node.probe(input.address)
    case 'pair': return node.requestPair(id)
    case 'allow': return node.acceptPair(id)
    case 'decline': return node.declinePair(id)
    case 'sync': await node.syncOnce(); return node.status()
    case 'pause': return node.pause(id, input.paused)
    case 'forget': return node.forget(id)
    case 'settings': { const s = node.settingsSnapshot(); return node.configure({ ...s.values, ...input.values }, s.revision) }
    case 'open': return library.openConversation(id)
    case 'recover': return library.recoverConflict(id)
    case 'evidence': return evidence(id)
    case 'restart-network': await node.close(); node = await SyncNode.open({ ...options, port: input.port ?? 48801 }); return node.status()
    case 'release': for (const handle of handles.values()) await handle.dispose(); handles.clear(); return { released: true }
    case 'turn': {
      if (!/^(thetwo-acceptance-|linked-)[a-zA-Z0-9-]+$/.test(id)) throw new Error('Only synthetic acceptance conversation IDs are allowed')
      if (typeof input.text !== 'string' || input.text.length > 2000) throw new Error('Invalid fixture message')
      let target = id
      const exists = await ctx.sessionPersistence.stat(library.nativeId(id))
      if (exists) target = (await library.openConversation(id)).id
      let handle = handles.get(target)
      if (!handle) {
        handle = exists ? await ctx.agents.resume({ resumeSessionId: target, agentOptions }) : await ctx.agents.create({ sessionId: id, meta: { cwd: home }, agentOptions })
        handles.set(target, handle)
      }
      const content = [{ type: 'text', text: input.text }]
      if (input.attachments) {
        const file = await ctx.attachments.saveFile({ data: Buffer.from('TheTwo 双机附件原文：银杏。\n'), name: 'thetwo-acceptance.txt' })
        const { default: sharp } = await runtime('sharp')
        const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer()
        const image = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'thetwo-acceptance.png' })
        content.push({ type: 'file', attachment: file }, { type: 'image', attachment: image })
      }
      const before = requests.length
      handle.agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      assert.equal(handle.agent.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.kind, 'completed')
      assert.equal(requests.length, before + 1, 'the real Agent must invoke its model adapter')
      const modelHistory = JSON.stringify(requests.at(-1).messages)
      const checkedHistory = (input.expect ?? []).map(text => ({ text, found: modelHistory.includes(text) }))
      for (const row of checkedHistory) assert.ok(row.found, `Model history is missing: ${row.text}`)
      return { ...await evidence(id), checkedHistory, liveAgents: handles.size }
    }
    case 'stop': setImmediate(stop); return { stopping: true }
    default: throw new Error('Unknown acceptance action')
  }
}
let tail = Promise.resolve()
const control = http.createServer(async (req, res) => {
  const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  const origin = `http://127.0.0.1:${control.address().port}`
  if (req.headers.host !== new URL(origin).host || req.headers.origin || req.headers['x-thetwo-acceptance'] !== '1') return send(403, { error: 'Local acceptance controller only' })
  try {
    if (req.method !== 'POST' || req.url !== '/action' || !req.headers['content-type']?.startsWith('application/json')) return send(404, {})
    let body = ''
    for await (const part of req) { body += part; if (Buffer.byteLength(body) > 8192) throw new Error('Action too large') }
    const input = JSON.parse(body)
    const operation = tail.then(() => act(input)); tail = operation.catch(() => {})
    const value = await operation
    const entry = { at: new Date().toISOString(), action: input.action, id: input.id, value: value ?? null }
    eventsLog.push(entry)
    await writeFile(join(home, 'acceptance-log.json'), JSON.stringify(eventsLog, null, 2))
    send(200, { ok: true, value: value ?? null })
  } catch (error) { send(400, { ok: false, error: error.message }) }
})
control.requestTimeout = 30000
await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve) })
const ready = { station, host: hostname(), platform: process.platform, pid: process.pid, home, controller: `http://127.0.0.1:${control.address().port}`, peerId: node.identity.id, lanPort: node.port }
await writeFile(join(home, 'ready.json'), JSON.stringify(ready, null, 2))
console.log(JSON.stringify(ready))
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  control.close(); control.closeIdleConnections()
  await node.close()
  for (const handle of handles.values()) await handle.dispose()
  await ctx.fiber.dispose()
}
process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
