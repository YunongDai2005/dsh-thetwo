import http from 'node:http'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createIdentity, publicIdentity, seal, unseal } from './crypto.js'
import { atomicJson, readJson } from './files.js'
import { Discovery } from './discovery.js'
import { validateSettings, validatePeerSettings } from './settings.js'
import { EnvironmentSync } from './environment.js'

export const HTTP_PORT = 48792
const MAX_BODY = 64 * 1024 * 1024
const CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EPIPE'])
// A dead address gives way to the next one after CONNECT_TIMEOUT; once connected, only IDLE_TIMEOUT of silence or
// TOTAL_TIMEOUT overall ends a request, so a slow tunnel can still carry a large conversation. A hint about where a
// device is stays fresh for FRESH; an address that answered as the device is trusted without asking again for PROVEN.
const CONNECT_TIMEOUT = 4000, IDLE_TIMEOUT = 30000, TOTAL_TIMEOUT = 600000, FRESH = 30000, PROVEN = 90000, MAX_ADDRESSES = 4, BACKOFF = [10000, 60000]
// An envelope is accepted within WINDOW of its own time. Request bodies are buffered before the sender is known, so
// only LARGE_UPLOADS bodies over LARGE_BODY may be arriving at once.
const WINDOW = 300000, LARGE_BODY = 1024 * 1024, LARGE_UPLOADS = 4
const cleanIp = ip => String(ip).replace(/^::ffff:/, '')
// How a device is reached, for the status shown to the user: a local port forward, an overlay network or the LAN.
export function routeKind(url) {
  const n = new URL(url).hostname.split('.').map(Number)
  return n[0] === 127 ? 'forward' : n[0] === 100 && n[1] >= 64 && n[1] <= 127 ? 'overlay' : 'lan'
}
export function privateIp(ip) {
  ip = cleanIp(ip)
  const n = ip.split('.').map(Number)
  return ip === '::1' || (/^[0-9.]+$/.test(ip) && n.length === 4 && n.every(x => Number.isInteger(x) && x >= 0 && x < 256) && (n[0] === 127 || n[0] === 10 || (n[0] === 192 && n[1] === 168) || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 169 && n[1] === 254) || (n[0] === 100 && n[1] >= 64 && n[1] <= 127)))
}
export function endpoint(input) {
  const u = new URL(input.includes('://') ? input : `http://${input}`)
  if (u.protocol !== 'http:' || !privateIp(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('请输入可互通的局域网 IP 和端口')
  // The URL parser drops port 80 as the default. A forward to port 80 that the user wrote out is not our own default port.
  return `http://${u.hostname}:${u.port || (/:0*80\/?$/.test(input) ? 80 : HTTP_PORT)}`
}
async function readBody(stream, limit = MAX_BODY) {
  let bytes = 0; const chunks = []
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('conversation is larger than the 64 MiB preview limit')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
// `meta.at` receives the moment the answer began to arrive.
async function request(url, body, signal, { connect = CONNECT_TIMEOUT, total = TOTAL_TIMEOUT, limit = MAX_BODY, meta } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body))
    if (bytes?.length > MAX_BODY) return reject(Object.assign(new Error('conversation is larger than the 64 MiB preview limit'), { code: 'ETOOBIG' }))
    const req = http.request(url, { method: bytes ? 'POST' : 'GET', signal, timeout: IDLE_TIMEOUT, headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {} }, async res => {
      if (meta) meta.at = Date.now()
      try {
        const result = await readBody(res, limit)
        if (res.statusCode !== 200) throw new Error(result.error ?? `HTTP ${res.statusCode}`)
        resolve(result)
      } catch (e) { reject(e) }
    })
    const lost = () => req.destroy(Object.assign(new Error('device connection timed out'), { code: 'ETIMEDOUT' }))
    const whole = setTimeout(lost, total)
    req.once('close', () => clearTimeout(whole))
    req.on('socket', socket => {
      if (!socket.connecting) return
      const timer = setTimeout(lost, connect)
      socket.once('connect', () => clearTimeout(timer)); req.once('close', () => clearTimeout(timer))
    })
    req.on('timeout', lost)
    req.on('error', reject); req.end(bytes)
  })
}
export class SyncNode {
  constructor(options, state) {
    this.options = options; this.library = options.library; this.state = state; this.identity = state.identity
    this.environment = new EnvironmentSync(this.library.ctx)
    this.pluginInstalls = Promise.resolve(); this.operations = new Set()
    this.transfers = new Map()
    this.file = join(options.home, 'session-link', 'devices.json')
    this.discovered = new Map(); this.live = new Map(); this.seen = new Map(); this.saves = Promise.resolve()
    // Where each device's own requests came from, and which addresses failed lately. Neither is saved.
    this.hints = new Map(); this.failures = new Map(); this.proven = new Map(); this.polling = Promise.resolve()
    // Requests still arriving when a device loses permission must not pass once it is resumed: each remembers the
    // count of revocations at its start, and is refused if its sender was revoked after that.
    this.revocations = 0; this.revokedAll = 0; this.revokedAt = new Map(); this.uploads = 0
    // Replays are refused from memory. What was sealed before this process started cannot be checked, so it is not accepted.
    this.seenUnpaired = new Map(); this.startedAt = Date.now(); this.clock = 0
    this.abort = new AbortController(); this.closed = false
    this.changes = Promise.resolve()
  }
  static async open(options) {
    const file = join(options.home, 'session-link', 'devices.json')
    const state = await readJson(file, { identity: createIdentity(options.name ?? hostname()), peers: {}, incoming: {}, outgoing: {} })
    publicIdentity(state.identity)
    // Legacy global opt-ins never grant optional access to every paired device.
    const { syncApiKeys: legacyKeys, syncPlugins: legacyPlugins, ...settings } = state.settings ?? { deviceName: state.identity.name, syncEnabled: true, discoverable: options.discovery !== false, intervalSeconds: 5 }
    state.settings = validateSettings(settings)
    for (const peer of Object.values(state.peers)) {
      peer.settings = validatePeerSettings(peer.settings ?? { deviceName: '', syncApiKeys: false, syncPlugins: false })
      peer.settingsRevision ??= 0
      // `urls` holds the addresses that answered as this device. Older versions kept one address, `url`.
      peer.urls = [...new Set((Array.isArray(peer.urls) ? peer.urls : [peer.url]).flatMap(url => { try { return [endpoint(url)] } catch { return [] } }))].slice(0, MAX_ADDRESSES)
    }
    state.settingsRevision ??= 0
    if (legacyKeys !== undefined || legacyPlugins !== undefined) state.settingsRevision++
    state.identity.name = state.settings.deviceName
    const node = new SyncNode(options, state)
    // Come back on the port used last time when it is free, so a tunnel or forward set up for it keeps working.
    await node.listen(options.port ?? (Number.isInteger(state.port) && state.port > 0 && state.port < 65536 ? state.port : HTTP_PORT))
    if (options.port === undefined) state.port = node.port
    await node.save()
    await node.updateActivity()
    return node
  }
  async updateActivity() {
    clearInterval(this.timer); this.timer = null
    if (this.discovery && (!this.state.settings.discoverable || this.options.discovery === false)) {
      await this.discovery.close(); this.discovery = null; this.discovered.clear(); this.discoveryError = null
    }
    if (!this.discovery && this.options.discovery !== false && this.state.settings.discoverable) {
      try {
        this.discovery = await Discovery.open({ identity: this.identity, port: this.port, onPeer: (peer,url) => this.observe(peer,url), onError: e => { this.discoveryError = e.message } })
        this.discoveryError = null
      } catch (e) { this.discoveryError = e.message }
    }
    const interval = this.options.intervalMs ?? this.state.settings.intervalSeconds * 1000
    if (!this.closed && interval) {
      this.timer = setInterval(() => {
        // A long gap between ticks means the computer slept or was suspended: the network may have changed, so every address is due again.
        const now = Date.now(), slept = now - (this.tickAt ?? now) > 3 * interval + 5000
        this.tickAt = now
        if (slept) this.failures.clear()
        void this.pollPairing(); void this.syncOnce().catch(e => { this.lastError = e.message })
      }, Math.max(1000, interval)); this.timer.unref()
    }
  }
  // A moment on a clock that only runs forward, in milliseconds and never the same twice: what happened first stays
  // first, also when the computer's time is corrected.
  stamp() { return this.clock = Math.max(performance.now(), this.clock + 0.001) }
  settingsSnapshot() { return { revision: this.state.settingsRevision, values: { ...this.state.settings } } }
  peerSettingsSnapshot(id) {
    const peer = this.state.peers[id]
    if (!peer) throw new Error('设备尚未配对')
    return { revision: peer.settingsRevision ?? 0, values: { deviceName: '', syncApiKeys: false, syncPlugins: false, ...peer.settings } }
  }
  configurePeer(id, values, revision) {
    const change = async () => {
      if (this.closed) throw new Error('同步服务已停止')
      const before = this.peerSettingsSnapshot(id), peer = this.state.peers[id]
      if (revision !== before.revision) throw Object.assign(new Error('设备设置已在另一处更新，请重新载入后保存'), { code: 'SETTINGS_CONFLICT' })
      const valid = validatePeerSettings(values)
      peer.settings = valid; peer.settingsRevision = before.revision + 1
      if (['syncApiKeys', 'syncPlugins'].some(key => before.values[key] && !valid[key])) {
        this.cancelTransfers(id)
        const live = this.live.get(id)
        if (live) this.live.set(id, { ...live, environment: {}, pluginInstallResults: [] })
      }
      try { await this.save() }
      catch (error) { peer.settings = before.values; peer.settingsRevision = before.revision; throw error }
      return this.peerSettingsSnapshot(id)
    }
    const next = this.changes.then(change, change); this.changes = next.catch(() => {}); return next
  }
  configure(values, revision) {
    const change = async () => {
      if (this.closed) throw new Error('同步服务已停止')
      if (revision !== this.state.settingsRevision) throw Object.assign(new Error('设置已在另一处更新，请重新载入后保存'), { code: 'SETTINGS_CONFLICT' })
      const valid = validateSettings(values), before = this.settingsSnapshot()
      this.state.settings = valid; this.state.identity.name = valid.deviceName; this.state.settingsRevision++
      if (before.values.syncEnabled && !valid.syncEnabled) this.cancelTransfers()
      try { await this.save() }
      catch (e) { this.state.settings = before.values; this.state.settingsRevision = before.revision; this.state.identity.name = before.values.deviceName; throw e }
      await this.updateActivity()
      if (!valid.syncEnabled) await this.running?.catch(() => {})
      return this.settingsSnapshot()
    }
    const next = this.changes.then(change, change); this.changes = next.catch(() => {}); return next
  }
  save() {
    const text = structuredClone(this.state)
    const write = () => atomicJson(this.file, text)
    const p = this.saves.then(write, write); this.saves = p.catch(() => {}); return p
  }
  async listen(preferred) {
    for (let i = 0; i < 16; i++) {
      const server = http.createServer((req, res) => {
        const task = this.handle(req, res)
        this.operations.add(task); task.finally(() => this.operations.delete(task)).catch(() => {})
      })
      // A whole conversation may take minutes to arrive through a slow tunnel; a silent connection is still dropped.
      server.requestTimeout = TOTAL_TIMEOUT; server.headersTimeout = 10000; server.timeout = 45000; server.maxConnections = 32
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(preferred === 0 ? 0 : preferred + i, this.options.host ?? '0.0.0.0', resolve) })
        this.server = server; this.port = server.address().port; this.url = `http://127.0.0.1:${this.port}`; return
      } catch (e) { if (e.code !== 'EADDRINUSE' || preferred === 0 || i === 15) throw e }
    }
  }
  async handle(req, res) {
    const send = (status, value, headers) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(value)) } }
    // Turned away before its body is read: the connection ends with the answer.
    const refuse = (status, error) => send(status, { error }, { connection: 'close' })
    let large = false
    try {
      const address = cleanIp(req.socket.remoteAddress)
      if (!privateIp(address)) return send(403, { error: 'LAN only' })
      if (req.method === 'GET' && req.url === '/hello') return send(200, { protocol: 'dsh-session-link/1', ...publicIdentity(this.identity), port: this.port })
      if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { error: 'not found' })
      // The envelope is judged at the moment it began to arrive: a transfer that needs minutes through a slow
      // tunnel is not stale by the time it is whole.
      const arrived = Date.now(), epoch = this.revocations, length = Number(req.headers['content-length'])
      if (!Number.isSafeInteger(length) || length < 2 || length > MAX_BODY) return refuse(413, 'conversation is larger than the 64 MiB preview limit')
      if (length > LARGE_BODY) {
        if (this.uploads >= LARGE_UPLOADS) return refuse(503, 'device is busy')
        large = true; this.uploads++
      }
      const envelope = await readBody(req, length), decoded = unseal(this.identity, envelope, arrived)
      if (envelope.time < this.startedAt) throw new Error('request was sent before this device started; if this keeps happening, check the clocks of both computers')
      const now = Date.now(), id = decoded.sender.id
      for (const record of [this.seen, this.seenUnpaired]) for (const [key, expires] of record) if (expires < now) record.delete(key)
      // Paired devices, and devices in a pairing exchange with this one, are protected against replays. Each group
      // has its own allowance, so strangers cannot use up the room paired devices need. Anything else a stranger
      // sends changes nothing here and is not recorded.
      const record = this.state.peers[id] ? this.seen : decoded.payload?.action === 'pair/request' || this.state.incoming[id] || this.state.outgoing[id] ? this.seenUnpaired : null
      if (record) {
        if (this.seen.has(decoded.id) || this.seenUnpaired.has(decoded.id)) throw new Error('replayed request')
        if (record.size >= (record === this.seen ? 20000 : 256)) throw new Error('too many requests')
        // Kept until no copy of the envelope can be accepted any more: it may begin to arrive until its window ends
        // (later if the sender's clock runs ahead) and then take as long as a request is given to arrive.
        record.set(decoded.id, Math.max(now, envelope.time) + WINDOW + TOTAL_TIMEOUT)
      }
      const revoked = () => this.revokedAll > epoch || (this.revokedAt.get(id) ?? 0) > epoch
      let result
      try { result = { ok: true, value: await this.dispatch(decoded.sender, decoded.payload, address, revoked) } }
      catch (e) { result = { ok: false, error: e.message } }
      send(200, seal(this.identity, decoded.sender, { ...result, requestId: envelope.id, deviceName: this.identity.name }))
    } catch (e) { send(400, { error: e.message }) }
    finally { if (large) this.uploads-- }
  }
  // `typed`: the address came from the user, not from the device announcing itself on the LAN.
  observe(advert, url, typed = false) {
    const peer = { ...publicIdentity(advert), url: endpoint(url), seenAt: Date.now(), typed }
    if (peer.id === this.identity.id) return peer
    // Anything on the network can announce itself: keep the sightings bounded, oldest out first.
    if (!this.discovered.has(peer.id) && this.discovered.size >= 64) this.discovered.delete(this.discovered.keys().next().value)
    this.discovered.set(peer.id, peer)
    return peer
  }
  async probe(url) {
    url = endpoint(url)
    const peer = await this.hello(url, this.abort.signal)
    if (peer.protocol !== 'dsh-session-link/1') throw new Error('该地址不是会话同步插件')
    const found = this.observe(peer, url, true)
    // An address the user just typed is worth trying at once, also for a device that looked unreachable.
    if (this.state.peers[found.id]) void this.retry(found.id).catch(() => {})
    return found
  }
  // A short question that any TheTwo answers: who is at this address. It costs little and has to finish quickly.
  hello(url, signal) {
    const wait = this.options.connectTimeoutMs ?? CONNECT_TIMEOUT
    return request(`${url}/hello`, undefined, signal, { connect: wait, total: wait, limit: 4096 })
  }
  // Every address a device may be at, best first: where it just announced itself on the LAN (the direct path, when
  // there is one); then the newer of where its own requests just came from and an address the user just typed; then
  // the addresses that answered as this device before, most recent first; last the unproven address from pairing. A
  // stale sighting only counts for a device that is not paired yet. The source of a request is a hint, never proof:
  // behind a port forward or a NAT it is the forwarder's address, so only an address that answered as this device
  // enters `urls`.
  known(id) {
    const now = Date.now(), saved = this.state.peers[id], found = this.discovered.get(id), hint = this.hints.get(id)
    const fresh = row => row && now - row.seenAt < FRESH ? row : null
    const recent = [fresh(hint), found?.typed ? fresh(found) : null].filter(Boolean).sort((a, b) => b.seenAt - a.seenAt)
    return [...new Set([!found?.typed && fresh(found)?.url, ...recent.map(row => row.url), ...(saved?.urls ?? []), saved?.url, !saved && found?.url, !saved && hint?.url].filter(Boolean))]
  }
  // The same list without the addresses that failed a moment ago; empty while every one of them waits out its backoff.
  addresses(id) {
    const now = performance.now()
    return this.known(id).filter(url => !(this.failures.get(`${id} ${url}`)?.until > now))
  }
  failed(id, url) {
    const key = `${id} ${url}`, wait = Math.min(BACKOFF[1], (this.failures.get(key)?.wait ?? BACKOFF[0] / 2) * 2)
    this.failures.set(key, { wait, until: performance.now() + wait }); this.proven.delete(key)
  }
  async reached(id, url) {
    this.failures.delete(`${id} ${url}`); this.proven.set(`${id} ${url}`, performance.now())
    this.live.set(id, { ...this.live.get(id), outAt: this.stamp() })
    const saved = this.state.peers[id]
    if (!saved || saved.urls?.[0] === url) return
    saved.urls = [url, ...(saved.urls ?? []).filter(row => row !== url)].slice(0, MAX_ADDRESSES); saved.url = url
    await this.save()
  }
  // Try a device again now, without waiting for failed addresses to become due.
  retry(id) {
    for (const key of [...this.failures.keys()]) if (id === undefined || key.startsWith(`${id} `)) this.failures.delete(key)
    return this.syncOnce()
  }
  peer(id) {
    const peer = this.state.peers[id] ?? this.discovered.get(id)
    if (!peer) throw new Error('device not found')
    return { ...peer, url: this.addresses(id)[0] ?? this.known(id)[0] ?? peer.url }
  }
  // `force`: the user asked for this, so addresses still waiting out a failure are tried as well.
  async rpc(peer, payload, signal = this.abort.signal, { force = false } = {}) {
    const key = url => `${peer.id} ${url}`
    const urls = [...new Set([...(force ? this.known(peer.id) : this.addresses(peer.id)), ...(peer.url ? [endpoint(peer.url)] : [])])].filter(url => force || !(this.failures.get(key(url))?.until > performance.now()))
    // One sealed question and its sealed answer. Each attempt has a fresh envelope; logical operations remain idempotent.
    const ask = async (url, body, quick) => {
      const envelope = seal(this.identity, peer, { checkpoint: 2, port: this.port, interval: this.state.settings.intervalSeconds, pairing: this.state.peers[peer.id]?.acceptedRequestId, ...body, deviceName: this.identity.name }), meta = {}
      const response = await request(`${url}/rpc`, envelope, signal, { connect: this.options.connectTimeoutMs, total: quick, limit: quick ? 16384 : undefined, meta })
      signal.throwIfAborted()
      const opened = unseal(this.identity, response, meta.at)
      if (opened.sender.id !== peer.id || opened.payload.requestId !== envelope.id) throw new Error('device response did not match request')
      return opened.payload
    }
    let failure
    for (const url of urls) {
      signal.throwIfAborted()
      let result
      try {
        // An address that has not answered as this device lately first gets a short sealed question. Only the device
        // itself can answer it, so a forwarder that leads nowhere, another device holding the address, or one that
        // merely claims the name is found out in seconds and is sent nothing more.
        if (!(performance.now() - this.proven.get(key(url)) < PROVEN)) await ask(url, { action: 'ping' }, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT)
        result = await ask(url, payload)
      } catch (error) {
        if (signal.aborted || error.code === 'ETOOBIG') throw error
        // Anything short of this device's own authenticated answer means the address is wrong or down: another
        // device or a forwarder may be listening there. Move on, and report the most telling failure if none works.
        this.failed(peer.id, url)
        if (!failure || (CONNECTION_ERRORS.has(failure.code) && !CONNECTION_ERRORS.has(error.code))) failure = error
        continue
      }
      peer.url = url
      await this.reached(peer.id, url)
      await this.rememberName(peer.id, result.deviceName)
      if (!result.ok) throw new Error(result.error)
      return result.value
    }
    throw Object.assign(failure ?? new Error(urls.length || !this.known(peer.id).length ? 'device not found' : 'device could not be reached a moment ago'), { unreachable: true })
  }
  async rememberName(id, name) {
    // Names inside the authenticated payload can update an existing pairing.
    if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) return
    const peer = this.state.peers[id]
    if (peer && peer.name !== name) { peer.name = name; const observed = this.discovered.get(id); if (observed) observed.name = name; await this.save() }
  }
  // `quiet` asks again for a request that is still open, without touching what the user sees if the device cannot be reached.
  async requestPair(id, { quiet = false } = {}) {
    if (id === this.identity.id) throw new Error('cannot pair with this device')
    const pending = this.state.outgoing[id]
    // A repeat only continues a request that is still open. It never starts one, and it waits out failed addresses.
    if (quiet && (!pending || pending.failed || pending.expires < Date.now())) return
    const peer = this.discovered.has(id) || !pending ? this.peer(id) : { ...pending }
    // Already paired, unless that device has told us it holds no pairing with this one: then asking again is the way back.
    if (this.state.peers[id] && this.live.get(id)?.blocked !== 'not paired') return
    const requestId = pending?.expires > Date.now() ? pending.requestId : randomUUID()
    const outgoing = quiet && pending ? pending : { ...publicIdentity(peer), url: peer.url, requestId, expires: Date.now() + 300000, failed: false }
    if (outgoing !== pending) { this.state.outgoing[id] = outgoing; await this.save() }
    let reply
    try { reply = await this.rpc(peer, { action: 'pair/request', requestId, port: this.port, poll: quiet || undefined }, this.abort.signal, { force: !quiet }) }
    catch (error) {
      if (!quiet && this.state.outgoing[id] === outgoing) { outgoing.failed = true; await this.save() }
      throw error
    }
    if (this.state.outgoing[id] === outgoing && outgoing.url !== peer.url) { outgoing.url = peer.url; await this.save() }
    // The other device could not reach us to say yes, so its approval came back in this reply. Tell it we have it;
    // if that message is lost, the next sync request carries the same proof.
    if (reply?.accepted && this.state.outgoing[id] === outgoing) {
      await this.finishPair(peer, requestId)
      await this.rpc(this.peer(id), { action: 'pair/confirm' }).catch(() => {})
    }
  }
  // The device we asked has allowed the request: with its own pair/accept, or in its reply where only we can open the connection.
  // The request reached that device at `outgoing.url`, so that address is proven; where its answer came from is only a hint.
  async finishPair(sender, requestId, hint) {
    const outgoing = this.state.outgoing[sender.id]
    if (!outgoing || outgoing.expires < Date.now() || outgoing.requestId !== requestId) throw new Error('no pending pairing request')
    this.state.peers[sender.id] = this.pairedRecord(sender, outgoing.url, [outgoing.url], requestId)
    this.live.set(sender.id, { ...this.live.get(sender.id), blocked: null })
    if (hint) this.hints.set(sender.id, { url: hint, seenAt: Date.now() })
    delete this.state.outgoing[sender.id]; await this.save()
  }
  // A device that is paired again keeps the name and the choices the user made for it.
  pairedRecord(identity, url, urls, requestId) {
    const before = this.state.peers[identity.id]
    return { ...publicIdentity(identity), url, urls, pairedAt: Date.now(), paused: before?.paused ?? false, acceptedRequestId: requestId, ...(before ? { settings: before.settings, settingsRevision: before.settingsRevision } : {}) }
  }
  // Ask again for every pairing request still open: over a link that only this side can open, that is how the approval arrives.
  pollPairing() {
    if (this.pollingBusy || this.closed) return this.polling
    this.pollingBusy = true
    this.polling = (async () => {
      for (const outgoing of Object.values(this.state.outgoing)) {
        if (this.closed) break
        // The list was read before the waits in this loop: a request cancelled or replaced meanwhile is not ours to repeat.
        if (this.state.outgoing[outgoing.id] !== outgoing || outgoing.failed || outgoing.expires < Date.now()) continue
        await this.requestPair(outgoing.id, { quiet: true }).catch(() => {})
      }
    })().finally(() => { this.pollingBusy = false })
    return this.polling
  }
  async acceptPair(id) {
    const pending = this.state.incoming[id]
    if (!pending || pending.declined || pending.expires < Date.now()) throw new Error('no pending pairing request')
    // Still the very request the user is answering. One that was declined, or asked again after that, is a different
    // record even under the same id: an approval given before the refusal does not carry over.
    const current = () => !this.closed && this.state.incoming[id] === pending && !pending.declined && pending.expires >= Date.now() ? pending : null
    try { await this.rpc(pending, { action: 'pair/accept', requestId: pending.requestId, port: this.port }, this.abort.signal, { force: true }) }
    catch (error) {
      // We cannot open a connection to the device that asked (a one-way tunnel, its firewall, a NAT). Keep the user's
      // approval; the device collects it with its next request and proves that before it is trusted.
      const now = current()
      if (!error.unreachable || !now) throw error
      now.accepted = true; now.expires = Date.now() + 300000; await this.save()
      return { waiting: true }
    }
    if (!current()) throw new Error('配对请求已取消或过期')
    this.state.peers[id] = this.pairedRecord(pending, pending.url, [pending.url], pending.requestId)
    this.live.set(id, { ...this.live.get(id), blocked: null })
    delete this.state.incoming[id]; await this.save()
  }
  // A device whose request the user allowed here shows that it took the approval: it is paired from now on.
  // We have never connected to it, so no address is proven: `url` is only where its requests came from.
  async confirmPair(sender, requestId, source) {
    const pending = this.state.incoming[sender.id]
    if (!pending?.accepted || pending.declined || pending.requestId !== requestId || pending.expires < Date.now()) return undefined
    this.state.peers[sender.id] = this.pairedRecord(pending, source ?? pending.url, [], requestId)
    delete this.state.incoming[sender.id]; await this.save()
    return this.state.peers[sender.id]
  }
  // How a device is connected right now, from what was last seen in each direction. 'out': our last attempt to reach
  // it worked. 'in': we cannot reach it, but it keeps coming to us at its own pace (a one-way tunnel, its firewall).
  // A device we had reached moments before the failure has to show itself again first; without that it is 'down'.
  link(live = {}, now = performance.now()) {
    const failAt = live.failAt ?? 0
    if (live.outAt > failAt) return 'out'
    const coming = now - live.seenAt < (2 * (live.every ?? 60) + 10) * 1000
    return coming && (live.seenAt > failAt || !(failAt - live.outAt < 15000)) ? 'in' : 'down'
  }
  // A declined request stays until it expires, so the asking device's repeats cannot bring the question back.
  async declinePair(id) {
    const pending = this.state.incoming[id]
    if (pending) this.state.incoming[id] = { ...pending, accepted: false, declined: true }
    await this.save()
  }
  async pause(id, paused) { if (!this.state.peers[id]) throw new Error('not paired'); this.state.peers[id].paused = !!paused; if (paused) this.cancelTransfers(id); await this.save() }
  async forget(id) {
    this.cancelTransfers(id); delete this.state.peers[id]; delete this.state.incoming[id]; delete this.state.outgoing[id]; this.live.delete(id); this.hints.delete(id)
    for (const map of [this.failures, this.proven]) for (const key of [...map.keys()]) if (key.startsWith(`${id} `)) map.delete(key)
    await this.save()
  }
  cancelTransfers(id) {
    const count = ++this.revocations
    if (id === undefined) this.revokedAll = count; else this.revokedAt.set(id, count)
    for (const [key, controller] of this.transfers) {
      if (id !== undefined && key !== id) continue
      controller.abort(new Error('sync paused or permission revoked'))
      this.transfers.delete(key)
    }
  }
  transfer(id, setting) {
    let controller = this.transfers.get(id)
    if (!controller) { controller = new AbortController(); this.transfers.set(id, controller) }
    const signal = AbortSignal.any([this.abort.signal, controller.signal])
    const check = () => {
      if (!this.state.peers[id]) throw new Error('not paired')
      if (this.closed || !this.state.settings.syncEnabled || this.state.peers[id].paused) throw new Error('sync paused')
      if (setting && !this.state.peers[id].settings?.[setting]) throw new Error(setting === 'syncApiKeys' ? '此设备的 API 密钥同步已关闭' : '此设备的插件同步已关闭')
      // Resume grants a new batch; it never revives work that already lost
      // permission while awaiting network or disk.
      signal.throwIfAborted()
    }
    check()
    return { signal, check }
  }
  async dispatch(sender, payload, address, revoked) {
    if (!payload || typeof payload.action !== 'string') throw new Error('invalid request')
    // Proof of who is at this address, and nothing else: the sealed answer is the point.
    if (payload.action === 'ping') return { pong: true }
    const id = sender.id
    let paired = this.state.peers[id]
    // Where the request came from, with the port the sender listens on: the observed source, never a host it names.
    const source = Number.isInteger(payload.port) && payload.port > 0 && payload.port <= 65535 ? endpoint(`http://${address}:${payload.port}`) : null
    if (payload.action === 'pair/request') {
      if (!source || typeof payload.requestId !== 'string' || payload.requestId.length > 80) throw new Error('invalid pairing request')
      if (paired?.acceptedRequestId === payload.requestId) return { requested: true, accepted: true }
      for (const [key, request] of Object.entries(this.state.incoming)) if (request.expires < Date.now()) delete this.state.incoming[key]
      const known = this.state.incoming[id]
      if (known?.requestId === payload.requestId && known.accepted) return { requested: true, accepted: true }
      // A repeat sent on the device's own schedule only collects an answer. It never raises the question again.
      if (payload.poll) return { requested: known?.requestId === payload.requestId && !known.declined }
      // Asked again by hand while the question is still open: the same record, so an answer under way stays valid.
      if (known?.requestId === payload.requestId && !known.declined) { known.url = source; known.expires = Date.now() + 300000; await this.save(); return { requested: true } }
      if (Object.keys(this.state.incoming).length >= 16 && !known) throw new Error('too many pairing requests')
      this.state.incoming[id] = { ...sender, url: source, requestId: payload.requestId, expires: Date.now() + 300000 }
      await this.save(); return { requested: true }
    }
    if (payload.action === 'pair/accept') {
      if (paired?.acceptedRequestId === payload.requestId) return { accepted: true }
      if (!source) throw new Error('invalid peer port')
      await this.finishPair(sender, payload.requestId, source)
      return { accepted: true }
    }
    // Paired here already, and the same device now proves a newer approval of ours: it asked again after its side was lost.
    if (typeof payload.pairing === 'string' && payload.pairing.length <= 80 && (!paired || this.state.incoming[id]?.accepted)) paired = await this.confirmPair(sender, payload.pairing, source) ?? paired
    if (!paired) throw new Error('not paired')
    if (payload.action === 'pair/confirm') return { confirmed: true }
    if (payload.checkpoint !== 2) throw new Error('请将相连设备的 TheTwo 都升级到当前版本')
    const setting = payload.action === 'environment/keys' ? 'syncApiKeys' : payload.action === 'environment/plugins' ? 'syncPlugins' : undefined
    // Permission was withdrawn while this request was still arriving. Resuming does not let it through.
    if (revoked?.()) throw new Error('sync paused')
    const transfer = this.transfer(id, setting)
    await this.rememberName(id, payload.deviceName)
    transfer.check()
    // An authenticated peer can reach us after its own IP/port changes even when multicast cannot cross its subnet.
    // Its source address is the first place to try next; it is saved only once it answers as this device.
    const live = this.live.get(id) ?? {}
    if (source) this.hints.set(id, { url: source, seenAt: Date.now() })
    // The device is reaching us. If it had gone, it is back, so its addresses are due again.
    if (this.link(live) === 'down') for (const key of [...this.failures.keys()]) if (key.startsWith(`${id} `)) this.failures.delete(key)
    this.live.set(id, { ...live, seenAt: this.stamp(), every: [5, 10, 30, 60].includes(payload.interval) ? payload.interval : 60 })
    let result
    switch (payload.action) {
      case 'catalog': result = { ...await this.library.catalog(), capabilities: { checkpoint: 2, apiKeys: this.permitted(id, 'syncApiKeys'), plugins: this.permitted(id, 'syncPlugins') } }; break
      case 'get': result = await this.library.export(payload.id); break
      case 'put': result = await this.library.accept(payload.snapshot, transfer.check); break
      case 'environment/keys': result = await this.environment.exportKeys(); break
      case 'environment/plugins': result = await this.environment.exportPlugins(); break
      default: throw new Error('unknown action')
    }
    transfer.check()
    // Where only the other device can connect, its checks are the ones that count as the last sync.
    if (payload.action === 'catalog' && this.link(this.live.get(id)) === 'in') this.live.set(id, { ...this.live.get(id), lastSync: Date.now() })
    return result
  }
  permitted(id, setting) { return !this.closed && this.state.settings.syncEnabled && !!this.state.peers[id]?.settings?.[setting] && !this.state.peers[id].paused }
  installPlugins(id, specs) {
    const run = async () => {
      if (!this.permitted(id, 'syncPlugins')) throw new Error('插件同步已关闭或设备未配对')
      const transfer = this.transfer(id, 'syncPlugins')
      if (!Array.isArray(specs) || !specs.length || specs.length > 256 || specs.some(spec => typeof spec !== 'string')) throw new Error('插件列表无效')
      const rows = await this.environment.planPlugins(await this.rpc(this.peer(id), { action: 'environment/plugins' }, transfer.signal, { force: true }))
      transfer.check()
      if (specs.some(spec => !rows.some(row => row.spec === spec))) throw new Error('只能安装对端当前共享列表中的插件')
      const results = await this.environment.install(rows.filter(row => specs.includes(row.spec)), () => !transfer.signal.aborted && this.permitted(id, 'syncPlugins'))
      transfer.check()
      this.live.set(id, { ...this.live.get(id), pluginInstallResults: results })
      await this.syncOnce()
      return results
    }
    const result = this.pluginInstalls.then(run, run); this.pluginInstalls = result.catch(() => {}); return result
  }
  syncOnce() {
    if (this.closed || !this.state.settings.syncEnabled) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.cycle().finally(() => { this.running = null })
    return this.running
  }
  async cycle() {
    await this.library.retryPending()
    for (const saved of Object.values(this.state.peers)) {
      if (this.closed || !this.state.settings.syncEnabled || saved.paused) continue
      // Every address failed a moment ago: leave this device until one is due, so it cannot hold up the others.
      if (!this.addresses(saved.id).length) continue
      const peer = this.peer(saved.id)
      let transfer
      try {
        transfer = this.transfer(saved.id)
        const rpc = payload => { transfer.check(); return this.rpc(peer, payload, transfer.signal) }
        const remote = await rpc({ action: 'catalog' })
        if (remote.capabilities?.checkpoint !== 2) throw new Error('请将相连设备的 TheTwo 都升级到当前版本')
        const before = await this.library.catalog(), localById = new Map(before.sessions.map(s => [s.id, s]))
        const localPending = new Map((before.pending ?? []).map(row => [row.id, row.digest]))
        const results = [], issues = []
        for (const row of remote.sessions) {
          transfer.check()
          const localRow = localById.get(row.id)
          // A conflict can have more than two owners. Receive every unseen
          // branch once, while never importing an unknown conflicted identity.
          if ((row.conflict && !localRow) || localRow?.conflictDigests?.includes(row.digest)) continue
          if (localById.get(row.id)?.digest !== row.digest && localPending.get(row.id) !== row.digest) {
            try { results.push(await this.library.accept(await rpc({ action: 'get', id: row.id }), transfer.check)) }
            catch (error) { transfer.check(); issues.push({ id: row.id, reason: error.message }) }
          }
        }
        const after = await this.library.catalog(), remoteById = new Map(remote.sessions.map(s => [s.id, s]))
        const remotePending = new Map((remote.pending ?? []).map(row => [row.id, row.digest])), pendingIds = new Set((after.pending ?? []).map(row => row.id))
        for (const row of after.sessions) {
          transfer.check()
          const remoteRow = remoteById.get(row.id)
          if (pendingIds.has(row.id) || (row.conflict && !remoteRow) || remoteRow?.conflictDigests?.includes(row.digest)) continue
          if (row.digest !== remoteById.get(row.id)?.digest && row.digest !== remotePending.get(row.id)) {
            try { results.push(await rpc({ action: 'put', snapshot: await this.library.export(row.id) })) }
            catch (error) { transfer.check(); issues.push({ id: row.id, reason: error.message }) }
          }
        }
        const pending = (after.pending?.length ?? 0) + (remote.pending?.length ?? 0) + results.filter(x => x.status === 'pending' && !pendingIds.has(x.id)).length
        const conflicts = after.sessions.filter(x => x.conflict).length
        const environment = {}
        if (remote.capabilities?.apiKeys && this.permitted(saved.id, 'syncApiKeys')) {
          try { environment.apiKeys = await this.environment.importKeys(await rpc({ action: 'environment/keys' }), () => !transfer.signal.aborted && this.permitted(saved.id, 'syncApiKeys')) }
          catch (error) { environment.keyError = error.message }
        }
        if (remote.capabilities?.plugins && this.permitted(saved.id, 'syncPlugins')) {
          try { environment.plugins = await this.environment.planPlugins(await rpc({ action: 'environment/plugins' })) }
          catch (error) { environment.pluginError = error.message }
        }
        transfer.check()
        this.live.set(saved.id, { ...this.live.get(saved.id), lastSync: Date.now(), pending, conflicts, issues, environment, waiting: after.waiting.length + remote.waiting.length + issues.length, error: null, blocked: null })
      } catch (e) {
        if (!this.state.peers[saved.id] || transfer?.signal.aborted) continue
        // No address answered: the connection failed, and link() works out from that and from what the device sends
        // us whether it still counts as connected. Anything else came from a device we did reach: the sync is
        // blocked (it paused us, it holds no pairing, a version mismatch), the connection is not.
        const live = this.live.get(saved.id) ?? {}
        this.live.set(saved.id, e.unreachable ? { ...live, failAt: this.stamp(), error: e.message } : { ...live, blocked: e.message, error: null })
      }
    }
  }
  status() {
    const now = Date.now()
    return {
      self: { ...publicIdentity(this.identity), port: this.port },
      settings: this.settingsSnapshot(),
      devices: [...this.discovered.values()].filter(p => !this.state.peers[p.id] && now - p.seenAt < 30000).map(p => ({ ...p, requested: (this.state.outgoing[p.id]?.expires ?? 0) > now && this.state.outgoing[p.id]?.failed !== true })),
      peers: Object.values(this.state.peers).map(p => {
        const live = this.live.get(p.id) ?? {}, link = this.link(live), online = link !== 'down', inbound = link === 'in', used = link === 'out' ? p.urls?.[0] ?? p.url : null
        // `route` is read off the address in use; it names the kind of address, not a particular tunnel product.
        return { ...p, ...live, online, inbound, route: inbound ? 'inbound' : used ? routeKind(used) : null, via: used ? used.replace('http://', '') : null, error: online ? null : live.error ?? null, blocked: online ? live.blocked ?? null : null, requested: (this.state.outgoing[p.id]?.expires ?? 0) > now && this.state.outgoing[p.id]?.failed !== true, remoteName: p.name, name: p.settings?.deviceName || p.name, settings: this.peerSettingsSnapshot(p.id) }
      }),
      requests: Object.values(this.state.incoming).filter(p => p.expires > now && !p.accepted && !p.declined),
      // Allowed here, waiting for the asking device to collect the answer; declining still cancels it.
      approved: Object.values(this.state.incoming).filter(p => p.expires > now && p.accepted && !p.declined).map(p => ({ id: p.id, name: p.name, expires: p.expires })),
      syncing: !!this.running, lastError: this.lastError ?? null, discoveryError: this.discoveryError ?? null, library: this.library.status(),
    }
  }
  async close() {
    if (this.closed) return
    this.closed = true; clearInterval(this.timer); this.abort.abort()
    await this.changes
    clearInterval(this.timer)
    await this.discovery?.close()
    if (this.server) await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections() })
    await this.running?.catch(() => {}); await this.polling; await this.pluginInstalls
    await Promise.allSettled([...this.operations]); await this.library.tail; await this.saves
  }
}
