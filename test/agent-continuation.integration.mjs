import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshLibrary } from '../lib/library.js'
import { agentHarness, runtime } from './runtime.mjs'

test('real DSH Agents continue A → B → A without closing either original Agent', async t => {
  const a = await agentHarness(t), b = await agentHarness(t)
  const { createUserMessage, LlmAdapter } = await runtime('@deepseek-ai/dsh-llm')
  const requests = []
  class FixtureAdapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '银杏。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '银杏。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  for (const app of [a, b]) app.ctx.llm.registerAdapter(['fixture'], new FixtureAdapter())
  const agentOptions = { provider: 'fixture', model: 'fixture' }
  const send = async (handle, text) => {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    const reason = handle.agent.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason
    assert.equal(reason.kind, 'completed', JSON.stringify(reason))
  }
  const original = await a.ctx.agents.create({ sessionId: 'real-handoff', meta: { cwd: a.root }, agentOptions })
  t.after(() => original.dispose())
  await send(original, '项目代号是银杏。')
  const la = await DshLibrary.open(a.ctx, a.root), lb = await DshLibrary.open(b.ctx, b.root)
  await lb.accept(await la.export('real-handoff'))
  const remote = await b.ctx.agents.resume({ resumeSessionId: 'real-handoff', agentOptions })
  t.after(() => remote.dispose())
  await send(remote, '在第二台电脑继续。')
  assert.equal((await la.accept(await lb.export('real-handoff'))).status, 'pending')
  const target = await la.openConversation('real-handoff')
  const latest = await a.ctx.agents.resume({ resumeSessionId: target.id, agentOptions })
  t.after(() => latest.dispose())
  assert.equal(a.ctx.agents.get('real-handoff'), original.agent)
  assert.ok(latest.agent.session.seq > original.agent.session.seq)
  await send(latest, '项目代号是什么？')
  assert.equal(requests.length, 3, 'all three turns reach the model adapter through the real loop')
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('项目代号是银杏。'))
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('在第二台电脑继续。'))
  const events = latest.agent.session.snapshotEvents()
  assert.equal(events.findLast(e => e.type === 'turn/start').data.turn, 3)
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed')
  assert.equal(events.findLast(e => e.type === 'assistant/message').data.message.content[0].text, '银杏。')
  const catalog = await la.catalog()
  assert.equal(catalog.sessions.length, 1, JSON.stringify(catalog.waiting))
  await lb.accept(await la.export('real-handoff'))
  await lb.openConversation('real-handoff')
  assert.equal((await lb.catalog()).sessions[0].digest, catalog.sessions[0].digest)
})
