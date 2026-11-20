import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'
import { agentHarness, runtime, put, fixture } from './runtime.mjs'

async function device(t, name, hardware) {
  const { ctx, root } = await agentHarness(t)
  const web = await runtime('@deepseek-ai/dsh-host-webserver')
  await ctx.plugin(web.default, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(plugin, { home: root, name, hardware, host: '127.0.0.1', port: 0, discovery: false, intervalMs: 0 })
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const call = async (path, fields) => {
    const response = await fetch(origin + '/api/thetwo/' + path, fields && {
      method: 'POST', headers: { origin, 'x-thetwo': '1', 'content-type': 'application/json' }, body: JSON.stringify(fields),
    })
    const result = await response.json()
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  const status = () => call('status')
  return { ctx, root, status, act: (action, fields = {}) => call('action', { action, ...fields }), self: (await status()).self }
}

async function pair(t) {
  const a = await device(t, '工作 Windows', { platform: 'win32', arch: 'x64', cpu: 'Ryzen 7900', cores: 24, memoryGiB: 64, gpu: 'RTX 4070' })
  const b = await device(t, '工作 Mac', { platform: 'darwin', arch: 'arm64', cpu: 'Apple M3 Pro', cores: 12, memoryGiB: 36 })
  const url = `http://127.0.0.1:${b.self.port}`
  assert.equal((await (await fetch(url + '/hello')).json()).hardware, undefined)
  await a.act('probe', { address: url })
  await a.act('pair', { id: b.self.id })
  await b.act('allow', { id: a.self.id })
  await a.act('sync')
  return { a, b }
}

async function modelContext(ctx) {
  const assembled = await ctx.systemPrompt.assemble({})
  return assembled.contexts.find(row => row.name === 'thetwo-devices')?.text ?? ''
}

async function mountSessionController({ ctx, root }) {
  const host = (await runtime('@deepseek-ai/dsh-api-session-controller')).default
  // This text-only fixture has no browser uploads. DSH still binds the empty receipt list.
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) })
  const modules = [
    ['dsh-agent-default-model', { provider: 'fixture', model: 'fixture' }], ['dsh-fs-local', { cwd: root }],
    ['dsh-typert-registry'], ['dsh-attachment-local', { dshHome: root }], ['dsh-storage'], ['dsh-storage-json', { root: join(root, 'storage') }],
    ['dsh-storage-domain', { backend: 'json' }], ['dsh-workspace'], ['dsh-session-query-sqlite', { path: ':memory:', openAt: 'never' }],
  ]
  if (host.inject.includes('remoteAccess')) modules.push(['dsh-api-remote-access'], ['dsh-api-gateway'])
  for (const [name, config] of modules) {
    const mod = await runtime('@deepseek-ai/' + name)
    await ctx.plugin(mod.default ?? mod, config ?? {})
  }
  await ctx.plugin(host, { nativeOpen: false })
  assert.ok(ctx.get('sessionController'), 'the real native session controller is mounted')
}

test('one authenticated catalog exchange gives both models a concise device context and pausing removes it', async t => {
  const { a, b } = await pair(t)
  const local = await modelContext(a.ctx), remote = await modelContext(b.ctx)
  assert.match(local, /Ryzen 7900/); assert.match(local, /Apple M3 Pro/); assert.match(local, /RTX 4070/)
  assert.match(remote, /Ryzen 7900/); assert.match(remote, /36 GiB/)
  assert.ok(local.length < 600)
  assert.ok(!local.includes('127.0.0.1') && !local.includes(b.self.id))
  await a.act('pause', { id: b.self.id, paused: true })
  assert.equal(await modelContext(a.ctx), '')
})

test('a native model hands an arbitrary task to the chosen device in the same conversation and receives its reply', async t => {
  const { a, b } = await pair(t)
  const { LlmAdapter, createUserMessage } = await runtime('@deepseek-ai/dsh-llm')
  const task = '按当前对话的要求计算样本的均值，把结论写回这里。'
  const modelInputs = [], computed = []
  b.ctx.tools.register({
    name: 'sample_mean', description: 'Fixture computation on the selected machine.', parameters: { type: 'object', required: ['samples'], properties: { samples: { type: 'array', items: { type: 'number' } } } },
    output: { schema: { type: 'number' }, render: (_, value) => [{ type: 'text', text: String(value) }] },
    async execute({ samples }) { const result = samples.reduce((sum, value) => sum + value, 0) / samples.length; computed.push(result); return result },
  })
  class Adapter extends LlmAdapter {
    constructor(toolCall, reply) { super(); this.toolCall = toolCall; this.reply = reply }
    async *stream(options) {
      modelInputs.push(options)
      if (this.toolCall) {
        const { name, input } = this.toolCall
        this.toolCall = null
        const args = JSON.stringify(input)
        const block = { type: 'tool-call', id: 'call-' + name, name, arguments: args }
        yield { type: 'block-start', index: 0, blockType: 'tool-call', id: block.id, name: block.name }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = this.reply()
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  a.ctx.llm.registerAdapter(['fixture'], new Adapter({ name: 'thetwo_handoff', input: { device: b.self.id.slice(0, 12), task } }, () => '已发出交接。'))
  b.ctx.llm.registerAdapter(['fixture'], new Adapter({ name: 'sample_mean', input: { samples: [2, 8] } }, () => `这组样本的均值是 ${computed.at(-1)}。`))
  assert.ok(a.ctx.tools.get('thetwo_handoff'), 'the current model must be able to choose a device')
  const agentOptions = { provider: 'fixture', model: 'fixture' }, id = 'hardware-handoff'
  const send = async (handle, text) => {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    const reason = handle.agent.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason
    assert.equal(reason.kind, 'completed', JSON.stringify(reason))
  }
  const original = await a.ctx.agents.create({ sessionId: id, meta: { cwd: a.root }, agentOptions })
  t.after(() => original.dispose())
  await send(original, '样本是 2 和 8，请用工作 Mac 接手。')
  assert.match(JSON.stringify(modelInputs[0]), /Apple M3 Pro/)
  await a.act('sync')
  await a.act('sync')
  const incoming = (await b.status()).handoffs.filter(row => row.direction === 'in')
  assert.equal(incoming.length, 1)
  assert.equal(incoming[0].task, task)
  const ticket = incoming[0].id
  await mountSessionController(b)
  await assert.rejects(a.act('handoff-confirm', { id: ticket }), /对方/)
  const settings = (await b.status()).peers[0].settings
  await b.act('peer-settings', { id: a.self.id, values: { ...settings.values, acceptConfirmedTasks: true }, revision: settings.revision })
  await a.act('sync')
  assert.equal(b.ctx.agents.get(id), undefined, 'opting in never starts a proposal on its own')
  assert.equal((await a.status()).handoffs[0].canConfirm, true)
  await a.act('handoff-confirm', { id: ticket })
  await a.act('sync')
  await a.act('sync')
  const remote = b.ctx.agents.get(id)
  assert.ok(remote, JSON.stringify((await b.status()).handoffs))
  await remote.whenIdle()
  assert.deepEqual(computed, [5], 'the calculation ran once on the selected machine')
  const inputs = remote.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.rpcId === ticket)
  assert.equal(inputs.length, 1, 'DSH admits one native input on the selected device')
  assert.deepEqual(inputs[0].data.content, [{ type: 'text', text: task }])
  assert.match(JSON.stringify(modelInputs.at(-1).messages), /样本是 2 和 8/)
  await a.act('sync') // Only the initiating device needs a route to the receiver.
  assert.equal((await a.status()).handoffs[0].state, 'submitted')
  const latest = await a.act('open', { id })
  const file = await a.ctx.sessionPersistence.open(latest.id, 'read')
  try {
    const { events } = await file.read()
    assert.equal(events.filter(e => e.type === 'turn/end').length, 2)
    assert.match(JSON.stringify(events), /这组样本的均值是 5/)
  }
  finally { await file.close() }
})

test('an incoming task can be accepted on its own device, retried by the same DSH request ID, or declined', async t => {
  const { a, b } = await pair(t)
  const id = 'manual-handoff'
  await put(a.ctx, fixture(id), a.root)
  const tool = a.ctx.tools.get('thetwo_handoff')
  for (const callId of ['first', 'second']) {
    await tool.execute({ device: b.self.id.slice(0, 12), task: callId }, { callId, agent: { session: { id, seq: 0, header: {} } } })
  }
  await a.act('sync')
  const [first, second] = (await b.status()).handoffs
  const requests = []
  b.ctx.provide('sessionController', { async prompt(request) {
    requests.push(request)
    if (requests.length === 1) throw new Error('模型暂不可用')
    return { accepted: true }
  } })
  await b.act('handoff-decline', { id: second.id })
  await assert.rejects(b.act('handoff-run', { id: second.id }), /处理/)
  await assert.rejects(b.act('handoff-run', { id: first.id }), /模型暂不可用/)
  assert.equal((await b.status()).handoffs.find(row => row.id === first.id).state, 'submitting')
  await Promise.all([b.act('handoff-run', { id: first.id }), b.act('handoff-run', { id: first.id })].map(p => p.catch(e => { assert.match(e.message, /处理/) })))
  assert.deepEqual(requests.map(r => r.requestId), [first.id, first.id])
  await b.act('sync')
  assert.deepEqual((await a.status()).handoffs.map(r => r.state), ['submitted', 'declined'])
})

test('an old confirmation cannot start a task after the receiving device withdraws and renews permission', async t => {
  const { a, b } = await pair(t)
  const accepted = []
  b.ctx.provide('sessionController', { async prompt(request) { accepted.push(request); return { accepted: true } } })
  const setPermission = async enabled => {
    const { revision, values } = (await b.status()).peers[0].settings
    await b.act('peer-settings', { id: a.self.id, revision, values: { ...values, acceptConfirmedTasks: enabled } })
  }
  const id = 'renewed-permission'
  await setPermission(true)
  await put(a.ctx, fixture(id), a.root)
  await a.act('sync')
  await a.ctx.tools.get('thetwo_handoff').execute({ device: b.self.id, task: '继续原会话。' }, { callId: 'revoke', agent: { session: { id, header: {}, seq: 0 } } })
  const { id: ticket } = (await a.status()).handoffs[0]
  await a.act('handoff-confirm', { id: ticket })
  await setPermission(false); await setPermission(true)
  await a.act('sync')
  assert.equal(accepted.length, 0)
  assert.equal((await a.status()).handoffs[0].confirmed, false)
  await a.act('handoff-confirm', { id: ticket })
  await a.act('sync')
  assert.deepEqual(accepted.map(request => request.requestId), [ticket])
})
