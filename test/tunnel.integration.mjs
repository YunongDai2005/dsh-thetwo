import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { SyncNode, routeKind, endpoint } from '../lib/node.js'
import { seal, unseal, createIdentity } from '../lib/crypto.js'
import { DshLibrary } from '../lib/library.js'
import { harness, fixture, put } from './runtime.mjs'

async function node(t, name, options = {}) {
  const app = await harness(t)
  const library = await DshLibrary.open(app.ctx, app.root)
  const open = () => SyncNode.open({ home: app.root, library, name, host: '127.0.0.1', port: 0, discovery: false, intervalMs: 0, ...options })
  const sync = await open()
  t.after(() => sync.close())
  return { ...app, library, sync, open }
}
// A port forward such as `ssh -L` or frp: the target sees every connection come from the forwarder, not from the caller.
async function forward(t, target) {
  const sockets = new Set()
  const server = net.createServer(socket => {
    const up = net.connect(target.port, '127.0.0.1')
    for (const end of [socket, up]) { sockets.add(end); end.on('error', () => {}); end.on('close', () => sockets.delete(end)) }
    socket.pipe(up).pipe(socket)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const close = () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve) })
  t.after(close)
  return { url: `http://127.0.0.1:${server.address().port}`, close }
}
// A firewall or a one-way tunnel: nothing can connect to this device, it can only connect out.
const unreachable = app => new Promise(resolve => { app.sync.server.close(resolve); app.sync.server.closeAllConnections() })
const sessions = async app => (await app.library.catalog()).sessions.map(s => s.id).sort()
const pair = async (a, b) => { await a.sync.probe(b.sync.url); await a.sync.requestPair(b.sync.identity.id); await b.sync.acceptPair(a.sync.identity.id) }
// Forget everything that was only seen, so the saved addresses are what gets tried.
const settle = (app, id) => { app.sync.discovered.delete(id); app.sync.hints.delete(id) }
// A server that takes connections and counts them. `answer` decides what happens to each.
async function counting(t, answer = socket => socket.destroy()) {
  const sockets = new Set(), state = { count: 0 }
  const server = net.createServer(socket => { state.count++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); answer(socket) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve) }))
  state.url = `http://127.0.0.1:${server.address().port}`
  return state
}
// One whole request, sent by hand.
const post = (url, envelope) => new Promise((resolve, reject) => {
  const bytes = Buffer.from(JSON.stringify(envelope))
  const req = http.request(`${url}/rpc`, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
  })
  req.on('error', reject); req.end(bytes)
})
// One sealed request sent by hand, in two parts, with `between` run while the second part has not been sent.
async function slowly(from, to, payload, between = async () => {}, time = Date.now()) {
  const envelope = seal(from.sync.identity, to.sync.identity, { checkpoint: 2, port: from.sync.port, deviceName: 'by hand', ...payload }, time)
  const bytes = Buffer.from(JSON.stringify(envelope))
  const send = (pause = between) => new Promise((resolve, reject) => {
    const req = http.request(`${to.sync.url}/rpc`, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.write(bytes.subarray(0, bytes.length >> 1), async () => { await new Promise(done => setTimeout(done, 80)); await pause(); req.end(bytes.subarray(bytes.length >> 1)) })
  })
  const answer = await send()
  return { ...answer, send, result: answer.status === 200 ? unseal(from.sync.identity, answer.body).payload : null }
}

test('two devices pair and sync through a port forward that only one of them can open', async t => {
  const a = await node(t, '外出的笔记本'), b = await node(t, '家里的电脑')
  const tunnel = await forward(t, b.sync)
  await unreachable(a)
  const found = await a.sync.probe(tunnel.url)
  await a.sync.requestPair(found.id)
  assert.equal(b.sync.status().requests[0].name, '外出的笔记本')

  assert.deepEqual(await b.sync.acceptPair(a.sync.identity.id), { waiting: true }, 'the approval waits for the asking device to collect it')
  assert.equal(b.sync.status().requests.length, 0, 'an answered request is not asked again')
  assert.equal(b.sync.status().peers.length, 0, 'an approval nobody has collected grants nothing yet')
  await a.sync.pollPairing()
  assert.equal(a.sync.status().peers[0].id, b.sync.identity.id)
  assert.equal(b.sync.status().peers[0].id, a.sync.identity.id)

  await put(a.ctx, fixture('from-laptop'), a.root)
  await put(b.ctx, fixture('from-home'), b.root)
  await a.sync.syncOnce()
  assert.deepEqual(await sessions(a), ['from-home', 'from-laptop'])
  assert.deepEqual(await sessions(b), ['from-home', 'from-laptop'])
  const out = a.sync.status().peers[0]
  assert.deepEqual([out.online, out.route, out.url], [true, 'forward', tunnel.url])

  // The home computer cannot connect back. That is how this link works, not a fault to report.
  await b.sync.syncOnce()
  const back = b.sync.status().peers[0]
  assert.deepEqual([back.online, back.inbound, back.route, back.error], [true, true, 'inbound', null])
  assert.deepEqual(b.sync.state.peers[a.sync.identity.id].urls, [], 'where a request came from is never saved as a proven address')
  assert.ok(back.lastSync, 'the last check is the laptop\'s own')

  // Its silence is the only sign that the laptop has gone.
  b.sync.live.get(a.sync.identity.id).seenAt -= 60000
  assert.equal(b.sync.status().peers[0].online, false)
})

test('a declined request stays declined while the asking device keeps collecting its answer', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B'), c = await node(t, 'C')
  await unreachable(a)
  await a.sync.probe(b.sync.url); await a.sync.requestPair(b.sync.identity.id)
  const requestId = b.sync.state.incoming[a.sync.identity.id].requestId
  await b.sync.acceptPair(a.sync.identity.id)

  // The approval belongs to the device that asked: another device cannot take it by naming the request.
  const peer = await c.sync.probe(b.sync.url)
  await assert.rejects(c.sync.rpc(peer, { action: 'catalog', pairing: requestId }), /not paired/)
  assert.equal(b.sync.status().peers.length, 0)

  await b.sync.declinePair(a.sync.identity.id)
  await a.sync.pollPairing(); await a.sync.pollPairing()
  assert.equal(a.sync.status().peers.length, 0)
  assert.equal(b.sync.status().peers.length, 0)
  assert.equal(b.sync.status().requests.length, 0, 'repeats sent on a timer never raise the question again')
  // Asking again by hand does.
  await a.sync.requestPair(b.sync.identity.id)
  assert.equal(b.sync.status().requests.length, 1)
})

test('a device keeps every address that worked, so leaving the LAN falls back to the tunnel, also after a restart', async t => {
  const a = await node(t, '笔记本'), b = await node(t, '台式机')
  const lan = await forward(t, b.sync), tunnel = await forward(t, b.sync)
  await a.sync.probe(lan.url); await a.sync.requestPair(b.sync.identity.id); await b.sync.acceptPair(a.sync.identity.id)
  await a.sync.syncOnce()
  await a.sync.probe(tunnel.url); await a.sync.syncOnce()
  const id = b.sync.identity.id
  assert.equal(a.sync.state.peers[id].urls[0], tunnel.url, 'the address that worked last comes first')
  assert.ok(a.sync.state.peers[id].urls.includes(lan.url))

  // Back on the LAN, that address is used again; the tunnel address is kept for later.
  settle(a, id); a.sync.observe(b.sync.identity, lan.url)
  await a.sync.syncOnce()
  assert.equal(a.sync.state.peers[id].url, lan.url)
  assert.ok(a.sync.state.peers[id].urls.includes(tunnel.url))

  await lan.close(); settle(a, id)
  a.sync.state.peers[id].urls = [lan.url, tunnel.url]
  await put(b.ctx, fixture('written-at-home'), b.root)
  await a.sync.syncOnce()
  assert.ok(await a.ctx.sessionPersistence.stat('written-at-home'), 'the same check moves on to the tunnel address')
  assert.equal(a.sync.status().peers[0].online, true)
  assert.equal(a.sync.state.peers[id].url, tunnel.url)

  await a.sync.close()
  const restarted = await a.open()
  t.after(() => restarted.close())
  await put(b.ctx, fixture('written-later'), b.root)
  await restarted.syncOnce()
  assert.ok(await a.ctx.sessionPersistence.stat('written-later'))
})

test('an address now held by another device is skipped, and that device is sent nothing but the question who it is', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B'), c = await node(t, 'C')
  await pair(a, b)
  const id = b.sync.identity.id
  settle(a, id); a.sync.proven.clear()
  // The tunnel handed B's old address to C.
  Object.assign(a.sync.state.peers[id], { url: c.sync.url, urls: [c.sync.url, b.sync.url] })
  const received = [], handle = c.sync.handle.bind(c.sync)
  c.sync.handle = (req, res) => { received.push(Number(req.headers['content-length'] ?? 0)); return handle(req, res) }
  let dispatched = 0; const dispatch = c.sync.dispatch.bind(c.sync)
  c.sync.dispatch = (...args) => { dispatched++; return dispatch(...args) }
  await put(a.ctx, fixture('for-b-only'), a.root)
  await a.sync.syncOnce()
  assert.deepEqual(await sessions(b), ['for-b-only'])
  assert.deepEqual(await sessions(c), [])
  assert.equal(received.length, 1, 'one short question, then nothing')
  assert.ok(received[0] < 4096 && dispatched === 0, 'no conversation, and nothing C could read')
  assert.equal(a.sync.status().peers[0].online, true)
  assert.equal(a.sync.state.peers[id].url, b.sync.url)
  assert.equal(a.sync.addresses(id).includes(c.sync.url), false, 'the wrong address waits before it is tried again')
})
test('a dead address gives way within the connect timeout and is left alone until it is due or the user asks', async t => {
  const a = await node(t, 'A', { connectTimeoutMs: 300 }), b = await node(t, 'B')
  await pair(a, b)
  const id = b.sync.identity.id, dead = 'http://10.255.255.1:48792'
  settle(a, id)
  Object.assign(a.sync.state.peers[id], { url: dead, urls: [dead, b.sync.url] })
  await put(b.ctx, fixture('behind-a-dead-address'), b.root)
  const started = Date.now()
  await a.sync.syncOnce()
  assert.ok(await a.ctx.sessionPersistence.stat('behind-a-dead-address'))
  assert.ok(Date.now() - started < 5000, 'one unreachable address must not cost a 15 second wait')
  assert.deepEqual(a.sync.addresses(id), [b.sync.url])

  // With every address failing, nothing connects to the device until an address is due.
  const gone = await counting(t)
  a.sync.failures.clear(); a.sync.proven.clear()
  Object.assign(a.sync.state.peers[id], { url: gone.url, urls: [gone.url] })
  await a.sync.syncOnce()
  assert.equal(a.sync.status().peers[0].online, false)
  assert.deepEqual(a.sync.addresses(id), [])
  const tried = gone.count
  assert.ok(tried > 0)
  await a.sync.syncOnce()
  await assert.rejects(a.sync.rpc(a.sync.peer(id), { action: 'catalog' }), error => error.unreachable === true)
  assert.equal(gone.count, tried, 'neither the check nor a direct request connects to an address in backoff')
  await a.sync.retry()
  assert.ok(gone.count > tried, 'asking by hand tries it again at once')
})
test('pairings saved by earlier versions keep their single address', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  await a.sync.probe(b.sync.url); await a.sync.requestPair(b.sync.identity.id); await b.sync.acceptPair(a.sync.identity.id)
  delete a.sync.state.peers[b.sync.identity.id].urls
  await a.sync.save(); await a.sync.close()
  const restarted = await a.open()
  t.after(() => restarted.close())
  assert.deepEqual(restarted.state.peers[b.sync.identity.id].urls, [b.sync.url])
  await put(b.ctx, fixture('after-upgrade'), b.root)
  await restarted.syncOnce()
  assert.ok(await a.ctx.sessionPersistence.stat('after-upgrade'))
})

test('the path shown to the user tells a port forward and an overlay network from the LAN', () => {
  assert.equal(routeKind('http://127.0.0.1:9000'), 'forward')
  assert.equal(routeKind('http://100.101.102.103:48792'), 'overlay')
  assert.equal(routeKind('http://192.168.1.20:48792'), 'lan')
  assert.equal(routeKind('http://10.0.0.8:48792'), 'lan')
})

test('a forwarder that leads nowhere, or a device that only claims the name, is found out in seconds', async t => {
  const a = await node(t, 'A', { connectTimeoutMs: 400 }), b = await node(t, 'B')
  await pair(a, b)
  const id = b.sync.identity.id
  // The first takes the connection and says nothing. The second answers every question with B's public identity,
  // which anyone on the network could copy, and nothing it could not know.
  const hole = await counting(t, () => {})
  const liar = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ protocol: 'dsh-session-link/1', id, name: 'B', publicKey: b.sync.identity.publicKey })) })
  await new Promise(resolve => liar.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { liar.closeAllConnections(); liar.close(resolve) }))
  const lie = `http://127.0.0.1:${liar.address().port}`
  settle(a, id); a.sync.proven.clear()
  Object.assign(a.sync.state.peers[id], { url: hole.url, urls: [hole.url, lie, b.sync.url] })
  await put(b.ctx, fixture('past-a-dead-forward'), b.root)
  const started = Date.now()
  await a.sync.syncOnce()
  assert.ok(await a.ctx.sessionPersistence.stat('past-a-dead-forward'))
  assert.ok(Date.now() - started < 5000, 'it must not take the 30 second silence limit to give up on it')
  assert.ok(hole.count > 0)
  assert.equal(a.sync.state.peers[id].url, b.sync.url)
  assert.deepEqual(a.sync.addresses(id), [b.sync.url], 'both wrong addresses wait out a failure')
})
test('an approval given before a refusal does not carry over, and the side left paired can ask again', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  await a.sync.probe(b.sync.url); await a.sync.requestPair(b.sync.identity.id)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const original = a.sync.dispatch.bind(a.sync)
  a.sync.dispatch = async (...args) => { if (args[1].action === 'pair/accept') { entered.resolve(); await release.promise } return original(...args) }
  const accepting = b.sync.acceptPair(a.sync.identity.id).then(value => ({ value }), error => ({ error }))
  await entered.promise
  await b.sync.declinePair(a.sync.identity.id)
  await a.sync.requestPair(b.sync.identity.id)
  release.resolve()
  assert.match((await accepting).error?.message ?? '', /取消或过期/)
  assert.equal(b.sync.status().peers.length, 0, 'the refusal stands')
  assert.equal(b.sync.status().requests.length, 1, 'asking again by hand raises a new question')

  // A took the approval that B then withdrew. It learns that from B's answer, and can ask again without being removed first.
  assert.equal(a.sync.status().peers.length, 1)
  await a.sync.syncOnce()
  assert.deepEqual([a.sync.status().peers[0].online, a.sync.status().peers[0].blocked], [true, 'not paired'])
  await a.sync.requestPair(b.sync.identity.id)
  assert.equal(a.sync.status().peers[0].requested, true)
  await b.sync.acceptPair(a.sync.identity.id)
  await a.sync.syncOnce()
  assert.deepEqual([a.sync.status().peers[0].blocked, b.sync.status().peers.length], [null, 1])
})
test('a cancelled pairing request is not started again by its own timer', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B'), c = await node(t, 'C')
  for (const other of [b, c]) { await a.sync.probe(other.sync.url); await a.sync.requestPair(other.sync.identity.id) }
  // The timer is already waiting on B when the request to C is cancelled.
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const original = b.sync.dispatch.bind(b.sync)
  b.sync.dispatch = async (...args) => { if (args[1].poll) { entered.resolve(); await release.promise } return original(...args) }
  let asked = 0; const dispatch = c.sync.dispatch.bind(c.sync)
  c.sync.dispatch = (...args) => { if (args[1].action === 'pair/request') asked++; return dispatch(...args) }
  const polling = a.sync.pollPairing()
  await entered.promise
  await a.sync.forget(c.sync.identity.id)
  release.resolve(); await polling
  await a.sync.requestPair(c.sync.identity.id, { quiet: true }); await a.sync.pollPairing()
  assert.deepEqual(Object.keys(a.sync.state.outgoing), [b.sync.identity.id])
  assert.equal(asked, 0, 'C hears nothing more')
})
test('a conversation still arriving when its sender is paused is not imported, also after an immediate resume', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B'), c = await node(t, 'C')
  await pair(a, b); await pair(c, b)
  const id = a.sync.identity.id
  await put(a.ctx, fixture('half-sent'), a.root)
  const snapshot = await a.library.export('half-sent')
  // Pausing another device leaves this one alone.
  assert.equal((await slowly(a, b, { action: 'catalog' }, async () => { await b.sync.pause(c.sync.identity.id, true); await b.sync.pause(c.sync.identity.id, false) })).result.ok, true)
  const refused = await slowly(a, b, { action: 'put', snapshot }, async () => { await b.sync.pause(id, true); await b.sync.pause(id, false) })
  assert.deepEqual([refused.result.ok, refused.result.error], [false, 'sync paused'])
  assert.deepEqual(await sessions(b), [], 'nothing of it was imported')
  assert.equal((await slowly(a, b, { action: 'put', snapshot })).result.ok, true, 'a request that starts after the resume is a new one')
  assert.deepEqual(await sessions(b), ['half-sent'])
})
test('a transfer that takes longer than the envelope window is judged by when it began, and cannot be replayed afterwards', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  await pair(a, b)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const slow = await slowly(a, b, { action: 'catalog' }, async () => t.mock.timers.tick(6 * 60000))
  assert.deepEqual([slow.status, slow.result.ok], [200, true], 'six minutes on the way is not six minutes old')
  assert.match((await slow.send()).body.error, /expired/)

  // A copy that starts to arrive just inside the window and is whole just outside it.
  const first = await slowly(a, b, { action: 'catalog' })
  assert.equal(first.result.ok, true)
  t.mock.timers.tick(299000)
  const copy = await first.send(async () => t.mock.timers.tick(2000))
  assert.deepEqual([copy.status, copy.body.error], [400, 'replayed request'], 'the record of the first outlasts every copy of it')

  // A sender whose clock runs ahead: its envelope stays acceptable for longer, and stays remembered for as long.
  const ahead = await slowly(a, b, { action: 'catalog' }, undefined, Date.now() + 299000)
  assert.equal(ahead.result.ok, true)
  t.mock.timers.tick(300001)
  assert.equal((await ahead.send()).body.error, 'replayed request')
})

test('what was sealed before a restart is not accepted by the device that comes back', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  await pair(a, b)
  const sent = await slowly(a, b, { action: 'catalog' })
  assert.equal(sent.result.ok, true)
  await new Promise(resolve => setTimeout(resolve, 5))
  await b.sync.close()
  const again = await SyncNode.open({ home: b.root, library: b.library, name: 'B', host: '127.0.0.1', port: b.sync.port, discovery: false, intervalMs: 0 })
  t.after(() => again.close())
  const copy = await sent.send()
  assert.equal(copy.status, 400)
  assert.match(copy.body.error, /before this device started/)
  assert.equal((await slowly(a, { sync: again }, { action: 'catalog' })).result.ok, true, 'a request sealed after the restart is fine')
})

test('strangers cannot use up the replay record that paired devices rely on', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  await pair(a, b)
  const stranger = createIdentity('stranger'), room = b.sync.seenUnpaired.size
  for (let i = 0; i < 40; i++) {
    const answer = await post(b.sync.url, seal(stranger, b.sync.identity, { checkpoint: 2, port: 1, action: i % 2 ? 'pair/confirm' : 'catalog', pairing: 'made-up' }))
    assert.equal(unseal(stranger, answer.body).payload.error, 'not paired')
  }
  assert.equal(b.sync.seenUnpaired.size, room, 'a message that changes nothing takes no room')
  // Pairing requests do take room, in an allowance of their own.
  for (let i = 0; i < 20; i++) await post(b.sync.url, seal(createIdentity(`s${i}`), b.sync.identity, { checkpoint: 2, port: 1, action: 'pair/request', requestId: `r${i}` }))
  assert.equal(b.sync.seenUnpaired.size, room + 20)
  assert.equal(b.sync.status().requests.length, 16, 'and the questions put to the user stay bounded')
  const before = b.sync.seen.size
  await a.sync.syncOnce()
  assert.ok(b.sync.seen.size > before && a.sync.status().peers[0].online)
})

test('a pairing left on one side only is reported as such and can be asked for again, keeping the device settings', async t => {
  const a = await node(t, '外出的笔记本'), b = await node(t, '家里的电脑')
  const tunnel = await forward(t, b.sync)
  await unreachable(a)
  await a.sync.probe(tunnel.url); await a.sync.requestPair(b.sync.identity.id)
  await b.sync.acceptPair(a.sync.identity.id)
  // The laptop collects the approval, but its confirmation never arrives and the approval runs out.
  const confirm = b.sync.confirmPair.bind(b.sync)
  b.sync.confirmPair = async () => { delete b.sync.state.incoming[a.sync.identity.id]; return undefined }
  await a.sync.pollPairing()
  b.sync.confirmPair = confirm
  assert.deepEqual([a.sync.status().peers.length, b.sync.status().peers.length], [1, 0])
  const id = b.sync.identity.id
  await a.sync.configurePeer(id, { deviceName: '书房', syncApiKeys: false, syncPlugins: true }, a.sync.peerSettingsSnapshot(id).revision)

  await a.sync.syncOnce()
  const stuck = a.sync.status().peers[0]
  assert.deepEqual([stuck.online, stuck.blocked, stuck.error], [true, 'not paired', null], 'reached, and told plainly why nothing syncs')
  await a.sync.requestPair(id)
  assert.equal(b.sync.status().requests.length, 1)
  await b.sync.acceptPair(a.sync.identity.id)
  await a.sync.pollPairing()
  await put(a.ctx, fixture('after-pairing-again'), a.root)
  await a.sync.syncOnce()
  assert.deepEqual(await sessions(b), ['after-pairing-again'])
  const healed = a.sync.status().peers[0]
  assert.deepEqual([healed.blocked, healed.name, healed.settings.values.syncPlugins], [null, '书房', true])
})
test('only a few large bodies may be arriving before their senders are known', async t => {
  const b = await node(t, 'B')
  const open = () => new Promise((resolve, reject) => {
    const req = http.request(`${b.sync.url}/rpc`, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ req, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject); req.write('{"protocol":', () => setTimeout(() => resolve({ req }), 60))
  })
  const held = [await open(), await open(), await open(), await open()]
  assert.equal(b.sync.uploads, 4)
  const fifth = await open()
  assert.deepEqual([fifth.status, JSON.parse(fifth.body).error], [503, 'device is busy'])
  for (const row of held) { row.req.on('error', () => {}); row.req.destroy() }
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(b.sync.uploads, 0, 'an abandoned upload gives its place back')
})

test('a link that stops working in one direction shows the device again as soon as it comes in', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  await pair(a, b)
  await b.sync.syncOnce()
  assert.deepEqual([b.sync.status().peers[0].online, b.sync.status().peers[0].inbound], [true, false])
  await unreachable(a)
  await a.sync.syncOnce(); await b.sync.syncOnce()
  assert.equal(b.sync.status().peers[0].online, false, 'reached a moment ago and now silent: it may have gone')
  await a.sync.syncOnce()
  assert.deepEqual([b.sync.status().peers[0].online, b.sync.status().peers[0].inbound], [true, true])
})

test('the node comes back on the port it used last, and a written-out port 80 is kept', async t => {
  const a = await node(t, 'A')
  const free = await new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) }) })
  a.sync.state.port = free; await a.sync.save(); await a.sync.close()
  const again = await SyncNode.open({ home: a.root, library: a.library, name: 'A', host: '127.0.0.1', discovery: false, intervalMs: 0 })
  t.after(() => again.close())
  assert.equal(again.port, free)
  assert.equal(again.state.port, free)
  // Without a remembered or given port it takes the default, or the next free one after it, and remembers that.
  const fresh = await harness(t), library = await DshLibrary.open(fresh.ctx, fresh.root)
  const first = await SyncNode.open({ home: fresh.root, library, name: 'F', host: '127.0.0.1', discovery: false, intervalMs: 0 })
  t.after(() => first.close())
  assert.ok(first.port >= 48792 && first.port < 48808)
  assert.equal(first.state.port, first.port)
  assert.equal(endpoint('192.168.5.10:80'), 'http://192.168.5.10:80')
  assert.equal(endpoint(endpoint('http://192.168.5.10:80/')), 'http://192.168.5.10:80')
  assert.equal(endpoint('192.168.5.10'), 'http://192.168.5.10:48792')
  assert.equal(endpoint(endpoint('192.168.5.10:8080')), 'http://192.168.5.10:8080')
})
