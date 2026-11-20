import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Plugin from '../lib/index.js'
import { harness, runtime, put, fixture } from './runtime.mjs'

test('real DSH host serves local management and refuses cross-origin actions', async t => {
  const app = await harness(t)
  const WebServer = await runtime('@deepseek-ai/dsh-host-webserver')
  await app.ctx.plugin(WebServer.default, { host: '127.0.0.1', port: 0 })
  const fiber = await app.ctx.plugin(Plugin, { home: app.root, host: '127.0.0.1', port: 0, discovery: false, intervalMs: 0 })
  const origin = `http://127.0.0.1:${app.ctx.webServer.port}`
  const get = await fetch(`${origin}/session-link/api/status`)
  assert.equal(get.status, 200)
  const status = await get.json()
  assert.equal(status.ok, true)
  assert.equal(status.value.peers.length, 0)
  const post = (headers, body = { action: 'sync' }) => fetch(`${origin}/session-link/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  assert.equal((await post({ origin: 'https://untrusted.example', 'x-session-link': '1' })).status, 403)
  assert.equal((await post({ origin })).status, 403)
  assert.equal((await post({ origin, 'x-session-link': '1' })).status, 200)
  await put(app.ctx, fixture('open-test'), app.root)
  const open = await post({ origin, 'x-session-link': '1' }, { action: 'open', id: 'open-test' })
  assert.equal(open.status, 200)
  assert.equal((await open.json()).value.id, 'open-test')
  assert.equal((await post({ origin, 'x-session-link': '1' }, { action: 'syncCredentials' })).status, 400)
  await fiber.dispose()
  assert.equal((await fetch(`${origin}/session-link/api/status`)).status, 404)
})

test('TheTwo saves validated settings, rejects stale edits, and keeps them after plugin restart', async t => {
  const app = await harness(t), WebServer = await runtime('@deepseek-ai/dsh-host-webserver')
  await app.ctx.plugin(WebServer.default, { host: '127.0.0.1', port: 0 })
  const options = { home: app.root, name: 'Original', host: '127.0.0.1', port: 0, discovery: false, intervalMs: 0 }
  let fiber = await app.ctx.plugin(Plugin, options)
  const origin = `http://127.0.0.1:${app.ctx.webServer.port}`
  const response = await fetch(`${origin}/api/thetwo/status`)
  assert.equal(response.status, 200, 'TheTwo management endpoint must be mounted')
  const before = (await response.json()).value
  const values = { deviceName: '  书房电脑  ', syncEnabled: false, discoverable: false, intervalSeconds: 30 }
  const save = (v, revision) => fetch(`${origin}/api/thetwo/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-thetwo': '1', origin }, body: JSON.stringify({ action: 'settings', values: v, revision }) })
  const saved = await save(values, before.settings.revision)
  assert.equal(saved.status, 200)
  const after = (await saved.json()).value
  assert.equal(after.values.deviceName, '书房电脑')
  assert.equal((await save(values, before.settings.revision)).status, 409)
  assert.equal((await save({ ...after.values, deviceName: '' }, after.revision)).status, 400)
  assert.equal((await save({ ...after.values, intervalSeconds: 0 }, after.revision)).status, 400)
  assert.equal((await save({ ...after.values, apiKey: 'must-not-be-accepted' }, after.revision)).status, 400)
  await fiber.dispose()
  fiber = await app.ctx.plugin(Plugin, options)
  const restarted = (await (await fetch(`${origin}/api/thetwo/status`)).json()).value
  assert.deepEqual(restarted.settings, after)
  assert.equal(restarted.self.name, '书房电脑')
  assert.equal(restarted.self.id, before.self.id)
  await fiber.dispose()
})
