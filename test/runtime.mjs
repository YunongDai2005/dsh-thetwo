import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
const require = createRequire(join(resolve(process.env.DSH_TEST_NODE_MODULES ?? 'node_modules'), '__test__.cjs'))
export const runtime = name => import(pathToFileURL(require.resolve(name)).href)
export async function openHarness(root) {
  const { Context } = await runtime('@deepseek-ai/cordis')
  const SessionStore = await runtime('@deepseek-ai/dsh-session')
  const Persistence = await runtime('@deepseek-ai/dsh-session-persistence-jsonl')
  const ctx = new Context()
  await ctx.plugin(SessionStore.default)
  await ctx.plugin(Persistence.default ?? Persistence, { root: join(root, 'sessions'), compression: 'zstd' })
  return { ctx, root }
}
export async function harness(t) {
  const root = await mkdtemp(resolve('test-data-')), app = await openHarness(root)
  t.after(async () => { await app.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return app
}
export function fixture(id = 'session-demo', words = 'hello', turn = 1, offset = 0) {
  return {
    header: { version: 4, id, createdAt: 1700000000000, isSeeded: false }, inheritedEventCount: 0,
    events: [
      { seq: offset, time: 1700000000000 + offset, type: 'turn/start', data: { turn } },
      { seq: offset + 1, time: 1700000000001 + offset, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    ], title: words,
  }
}
export async function put(ctx, snapshot, cwd) {
  const h = await ctx.sessionPersistence.create({ ...snapshot.header, cwd }, { inheritedEventCount: snapshot.inheritedEventCount })
  try { await h.append(snapshot.events); await h.flush() } finally { await h.close() }
}

export async function mountAgentServices(ctx) {
  for (const name of ['dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-llm', 'dsh-session-projection', 'dsh-agent-loop']) {
    const mod = await runtime(`@deepseek-ai/${name}`)
    await ctx.plugin(mod.default, name === 'dsh-agent-loop' ? { agents: [], maxParallelToolCalls: 1 } : {})
  }
  if (typeof ctx.tools.setExecutor === 'function') {
    await ctx.plugin(await runtime('@deepseek-ai/dsh-tool-executor-native'))
  }
}

export async function agentHarness(t) {
  const app = await harness(t)
  await mountAgentServices(app.ctx)
  return app
}
