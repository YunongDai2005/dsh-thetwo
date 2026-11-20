import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { DshLibrary } from '../lib/library.js'
import { SyncNode } from '../lib/node.js'

// Synthetic partner for visual QA. Both endpoints are loopback-only.
const home = fileURLToPath(new URL('../.preview/peer-home/', import.meta.url))
const cwd = join(home, 'demo-workspace')
await mkdir(cwd, { recursive: true })
const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(Persistence, { root: join(home, 'sessions'), compression: 'zstd' })
const library = await DshLibrary.open(ctx, home)
const existing = new Set((await library.catalog()).sessions.map(s => s.id))
const examples = [
  ['weekend', '周末去杭州，安排两天轻松一点的行程', '先留出半天西湖漫步，其他安排可以换台电脑接着聊。'],
  ['release', '整理这次版本发布前要检查的事情', '可以从变更说明、回归检查和安装验证开始。'],
  ['workspace', '书房的桌面工作区怎么布置更舒服', '先整理显示器高度，再安排灯光和常用物品的位置。'],
]
for (const [key, title, answer] of examples) {
  const id = `thetwo-preview-${key}`
  if (existing.has(id)) continue
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: title }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: answer }], source: { provider: 'fixture', model: 'offline-preview' } }), stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const handle = await ctx.sessionPersistence.create({ ...session.header, cwd }, { inheritedEventCount: 0 })
  await handle.append(session.snapshotEvents()); await handle.close()
}
const node = await SyncNode.open({ home, library, name: '便携电脑 · 演示', host: '127.0.0.1', port: 0, discovery: false })
console.log(`Synthetic peer: ${node.url}`)
if (process.argv[2]) {
  const target = new URL(process.argv[2])
  if (target.hostname !== '127.0.0.1') throw new Error('Preview peers must use 127.0.0.1')
  const peer = await node.probe(target.href)
  await node.requestPair(peer.id)
  console.log('Pairing request sent to the isolated preview. Approve it in the UI.')
}
async function stop() { await node.close(); await ctx.fiber.dispose(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
