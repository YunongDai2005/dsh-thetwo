import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
const require = createRequire(join(resolve(process.env.DSH_TEST_NODE_MODULES ?? 'node_modules'), '__client__.cjs'))
const { JSDOM } = require('jsdom'), React = require('react'), { createRoot } = require('react-dom/client')
const { act } = React

test('native panel pairs without a PIN, receives an Allow dialog, and opens native DSH conversations', async t => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://127.0.0.1:3080' })
  const previous = { window: globalThis.window, document: globalThis.document }
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const actions = [], opened = [], unarchived = [], registrations = [], disposers = [], timers = []
  let warming = true, archived = false
  let status = { self: { name: '电脑 A', port: 48792 }, devices: [{ id: 'b', name: '电脑 B', url: 'http://192.168.1.2:48792' }], peers: [], requests: [], library: { conflicts: [], pending: [] }, settings: { revision: 0, values: { deviceName: '电脑 A', syncEnabled: true, discoverable: true, intervalSeconds: 5 } } }
  let plugin
  const context = vm.createContext({ window: { __ModuleLoader__: { load: module => { plugin = module.factory(require) } } }, document: dom.window.document, AbortController, Date, Set, console,
    setInterval: fn => { timers.push(fn); return 1 }, clearInterval() {},
    fetch: async (path, options) => {
      if (warming && path.endsWith('/status')) return { ok: false, status: 404, json: async () => { throw new SyntaxError("Unexpected token 'o', not found") } }
      if (path.endsWith('/action')) {
        const action = JSON.parse(options.body); actions.push(action)
        assert.equal(options.headers['x-thetwo'] ?? options.headers['x-session-link'], '1')
        if (action.action === 'pair') status = { ...status, devices: status.devices.map(p => ({ ...p, requested: true })) }
        if (action.action === 'allow') status = { ...status, requests: [] }
        if (action.action === 'handoff-run') status.handoffs.find(r => r.id === action.id).state = 'submitted'
        if (action.action === 'handoff-confirm') status.handoffs.find(r => r.id === action.id).confirmed = true
        return { ok: true, json: async () => ({ ok: true, value: action.action === 'open' ? { id: 'latest-chat-1', sharedId: 'chat-1', archived } : null }) }
      }
      return { ok: true, json: async () => ({ ok: true, value: path.endsWith('/status') ? status : { sessions: [{ id: 'chat-1', title: '<script>测试会话</script>', updatedAt: 1700000000000, archived }], waiting: [] } }) }
    },
  })
  vm.runInContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), context)
  const ctx = { effect(fn) { disposers.push(fn()) }, slots: { inject(_, fn) { fn() }, register(meta, component) { registrations.push({ meta, component }); return () => {} } }, sessions: { async refresh() {} },
    workspaces: { async unarchiveSession(id) { await Promise.resolve(); unarchived.push(id); archived = false } },
    uiWorkspace: { openSession(id) { assert.equal(archived, false, 'DSH clears archived selections; unarchive must finish first'); opened.push(id) } } }
  const root = createRoot(dom.window.document.getElementById('app'))
  t.after(async () => { await act(async () => { root.unmount(); for (const fn of disposers.reverse()) await fn() }); Object.assign(globalThis, previous); delete globalThis.IS_REACT_ACT_ENVIRONMENT; dom.window.close() })
  await act(async () => { plugin.apply(ctx) })
  const Panel = registrations.find(r => r.meta.name === 'main').component
  await act(async () => root.render(React.createElement(Panel)))
  const click = async label => { const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === label); assert.ok(button, label); await act(async () => button.click()) }
  assert.match(dom.window.document.body.textContent, /正在加载/)
  warming = false
  await act(async () => { for (const fn of timers) fn() })
  assert.equal(dom.window.document.querySelector('[role=alert]'), null, 'startup connection errors clear when the host is ready')
  assert.match(dom.window.document.body.textContent, /电脑 B/)
  assert.equal(!!dom.window.document.querySelector('.thetwo-heading svg'), false)
  assert.equal(dom.window.document.querySelector('.thetwo-heading p').textContent, '同一份会话')
  await click('同步'); assert.equal(actions[0].action, 'pair')
  assert.equal(dom.window.document.querySelector('input[type=password]'), null)
  status = { ...status, requests: [{ id: 'c', name: '电脑 C', url: 'http://192.168.1.3:48792' }] }
  await act(async () => { for (const fn of timers) fn() })
  assert.match(dom.window.document.querySelector('[role=dialog]').textContent, /电脑 C/)
  await click('允许同步'); assert.equal(actions.at(-1).action, 'allow')
  await click('打开'); assert.deepEqual(opened, ['latest-chat-1'])
  assert.equal(actions.at(-1).action, 'open')
  archived = true // Another surface archives it after the last library refresh.
  await click('打开')
  assert.deepEqual(opened, ['latest-chat-1'])
  assert.deepEqual(unarchived, [], 'ordinary Open must not undo a newly archived record')
  assert.match(dom.window.document.querySelector('[role=alert]').textContent, /已归档/)
  await click('取消归档并打开')
  assert.deepEqual(unarchived, ['latest-chat-1'])
  assert.deepEqual(opened, ['latest-chat-1', 'latest-chat-1'])
  status.handoffs = [
    { id: 'incoming', direction: 'in', name: '电脑 B', session: 'chat-1', task: '统计当前对话的数字', state: 'waiting' },
    { id: 'outgoing', direction: 'out', name: '工作 Mac', session: 'chat-1', task: '继续这份分析', state: 'waiting', canConfirm: true },
  ]
  await act(async () => { for (const fn of timers) fn() })
  assert.match(dom.window.document.body.textContent, /统计当前对话的数字/)
  await click('在本机执行')
  assert.deepEqual(actions.at(-1), { action: 'handoff-run', id: 'incoming' })
  await click('在「工作 Mac」执行')
  assert.deepEqual(actions.at(-1), { action: 'handoff-confirm', id: 'outgoing' })
  assert.match(dom.window.document.body.textContent, /已确认/)
  assert.match(dom.window.document.body.textContent, /已提交给 DSH/)
  assert.equal(dom.window.document.querySelector('script'), null)
})

test('native settings drafts save explicitly and the panel settings shortcut uses supported layout navigation', async t => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://127.0.0.1:3080' })
  const previous = { window: globalThis.window, document: globalThis.document }
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const registrations = [], disposers = [], actions = [], panels = []
  let settings = { revision: 0, values: { deviceName: '电脑 A', syncEnabled: true, discoverable: true, intervalSeconds: 5 } }
  const peers = ['B', 'C'].map(id => ({ id, name: `电脑 ${id}`, remoteName: `电脑 ${id}`, settings: { revision: 0, values: { deviceName: '', syncApiKeys: false, syncPlugins: false } } }))
  let plugin
  const status = () => ({ self: { name: settings.values.deviceName, port: 48792 }, peers, devices: [], requests: [], library: { conflicts: [], pending: [] }, settings })
  dom.window.__ModuleLoader__ = { load(module) { plugin = module.factory(require) } }
  const context = vm.createContext({ window: dom.window, document: dom.window.document, AbortController, Date, Set, console, setInterval: () => 1, clearInterval() {},
    fetch: async (path, options) => {
      let value
      if (path.endsWith('/action')) {
        const input = JSON.parse(options.body); actions.push(input)
        if (input.action === 'settings') settings = { revision: settings.revision + 1, values: input.values }
        if (input.action === 'peer-settings') {
          const peer = peers.find(p => p.id === input.id)
          peer.settings = { revision: peer.settings.revision + 1, values: input.values }; peer.name = input.values.deviceName || peer.remoteName
          value = peer.settings
        } else value = settings
      } else value = path.endsWith('/status') ? status() : { sessions: [], waiting: [] }
      return { ok: true, json: async () => ({ ok: true, value }) }
    },
  })
  vm.runInContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), context)
  const ctx = { effect(fn) { disposers.push(fn()) }, layout: { selectPanel(id) { panels.push(id) } }, slots: { inject(_, fn) { fn() }, register(meta, component) { registrations.push({ meta, component }); return () => {} } }, sessions: { async refresh() {} }, uiWorkspace: { openSession() {} } }
  const root = createRoot(dom.window.document.getElementById('app'))
  t.after(async () => { await act(async () => { root.unmount(); for (const fn of disposers.reverse()) await fn() }); Object.assign(globalThis, previous); delete globalThis.IS_REACT_ACT_ENVIRONMENT; dom.window.close() })
  await act(async () => { plugin.apply(ctx) })
  const section = registrations.find(row => row.meta.name === 'settings.section')
  assert.ok(section, 'TheTwo must contribute its native DSH settings page')
  await act(async () => root.render(React.createElement(section.component)))
  const input = dom.window.document.querySelector('input[aria-label="本机设备名称"]')
  assert.ok(input)
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, '书房电脑'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
  const sync = dom.window.document.querySelector('[role=switch][aria-label="自动同步"]')
  await act(async () => sync.click())
  assert.equal(sync.getAttribute('aria-checked'), 'false')
  assert.equal(actions.length, 0, 'editing settings must not save before the user chooses Save')
  const save = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === '保存设置')
  assert.equal(save.disabled, false)
  await act(async () => save.click())
  assert.equal(actions[0].action, 'settings')
  assert.equal(actions[0].values.deviceName, '书房电脑')
  assert.equal(actions[0].values.syncEnabled, false)
  assert.equal(actions[0].values.syncApiKeys, undefined)
  assert.equal(actions[0].values.syncPlugins, undefined)
  assert.equal(actions[0].revision, 0)
  assert.match(dom.window.document.body.textContent, /已保存/)
  const cards = [...dom.window.document.querySelectorAll('.thetwo-peer-settings')]
  assert.equal(cards.length, 2)
  const card = cards.find(el => el.dataset.peerId === 'B')
  await act(async () => card.querySelector('summary').click())
  assert.ok(card.open, 'each paired device expands separately')
  const name = card.querySelector('input')
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(name, '工作 Mac'); name.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
  const keys = card.querySelector('[role=switch][aria-label="同步 API 密钥"]')
  const plugins = card.querySelector('[role=switch][aria-label="共享插件列表"]')
  const tasks = card.querySelector('[role=switch][aria-label="允许对方确认任务"]')
  assert.ok(name.compareDocumentPosition(keys) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'device name comes before its sharing options')
  await act(async () => { keys.click(); plugins.click(); tasks.click() })
  assert.equal(actions.length, 1, 'peer drafts also require their own explicit save')
  await act(async () => [...card.querySelectorAll('button')].find(b => b.textContent === '保存设备设置').click())
  assert.equal(actions.at(-1).action, 'peer-settings'); assert.equal(actions.at(-1).id, 'B')
  assert.equal(peers[0].settings.values.deviceName, '工作 Mac')
  assert.equal(peers[0].settings.values.syncApiKeys, true)
  assert.equal(peers[0].settings.values.acceptConfirmedTasks, true)
  assert.equal(peers[1].settings.values.syncApiKeys, false)
  assert.equal(peers[1].settings.values.syncPlugins, false)
  const main = registrations.find(row => row.meta.name === 'main')
  await act(async () => root.render(React.createElement(main.component)))
  const open = dom.window.document.querySelector('button[aria-label="TheTwo 设置"]')
  assert.ok(open)
  await act(async () => open.click())
  assert.equal(panels.at(-1), 'thetwo-settings')
  const deviceSettings = dom.window.document.querySelector('button[aria-label="工作 Mac 的设备设置"]')
  assert.ok(deviceSettings, 'a connected device should lead directly to its own settings')
  const actionCount = actions.length
  await act(async () => deviceSettings.click())
  const settingsPage = registrations.find(row => row.meta.key === 'thetwo-settings')
  await act(async () => root.render(React.createElement(settingsPage.component)))
  const selected = dom.window.document.querySelector('[data-peer-id="B"]')
  assert.ok(selected.open, 'the selected device is expanded on arrival')
  assert.equal(dom.window.document.querySelector('[data-peer-id="C"]').open, false, 'other devices stay collapsed')
  assert.equal(dom.window.document.activeElement, selected.querySelector('summary'), 'keyboard focus follows the selected device')
  assert.equal(actions.length, actionCount, 'navigating to device settings does not change its permissions')
})
