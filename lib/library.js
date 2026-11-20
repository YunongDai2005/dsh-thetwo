import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicJson, readJson } from './files.js'
import { compareEvents, digest, syncDigest, validateSnapshot } from './content.js'
import { exportAttachments, importAttachments } from './attachments.js'

function titleOf(events, id) {
  const title = events.findLast(e => e.type === 'session/title')?.data?.title
  if (typeof title === 'string') return title.slice(0,160)
  const text = events.find(e => e.type === 'user/message')?.data?.content?.find(p => p.type === 'text')?.text
  return typeof text === 'string' ? text.slice(0,80) : `会话 ${id.slice(-8)}`
}
function identityOf(s) {
  const { cwd, ...header } = s.header
  return { header, inheritedEventCount: s.inheritedEventCount }
}
export class DshLibrary {
  constructor(ctx, home, state) {
    this.ctx = ctx; this.root = join(home, 'session-link'); this.state = state; this.tail = Promise.resolve()
    this.cwd = join(this.root, 'conversations'); this.pending = new Map()
    for (const key of ['routes', 'retired', 'preparing', 'conflicts', 'imported']) this.state[key] = Object.assign(Object.create(null), this.state[key] ?? {})
    this.catalogCache = new Map(); this.retiredRevisions = new Map()
  }
  static async open(ctx, home) {
    const state = await readJson(join(home, 'session-link', 'library.json'), { conflicts: {}, imported: {} })
    const library = new DshLibrary(ctx, home, state)
    await mkdir(join(library.root, 'pending'), { recursive: true })
    await mkdir(library.cwd, { recursive: true })
    for (const file of await readdir(join(library.root, 'pending'))) {
      if (!file.endsWith('.json')) continue
      try {
        const s = await readJson(join(library.root, 'pending', file), null)
        if (s) { validateSnapshot(s); library.pending.set(s.header.id, { id: s.header.id, title: s.title, digest: syncDigest(s) }) }
      } catch (error) { library.lastPendingError = error.message }
    }
    let migrated = false
    for (const conflict of Object.values(library.state.conflicts)) {
      if (Array.isArray(conflict.digests)) continue
      const copies = await Promise.all(conflict.copies.map(path => readJson(path, null)))
      conflict.digests = [...new Set(copies.filter(Boolean).map(syncDigest))]; migrated = true
    }
    if (migrated) await library.save()
    return library
  }
  async save() { await atomicJson(join(this.root, 'library.json'), this.state) }
  nativeId(id) { return this.state.routes[id]?.nativeId ?? id }
  async readNative(id) {
    const handle = await this.ctx.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
    } finally { await handle.close() }
  }
  async read(id) {
    const snapshot = await this.readNative(this.nativeId(id))
    return { ...snapshot, header: { ...snapshot.header, id } }
  }
  async export(id, flush = true) {
    if (flush) await this.ctx.sessionPersistence.flush()
    const snapshot = validateSnapshot(await this.read(id))
    const attachments = await exportAttachments(this.ctx.get?.('attachments'), snapshot.events, !flush)
    if (snapshot.header.origin === 'subagent') throw new Error('内部子任务暂不单独同步')
    const portable = { ...snapshot, ...identityOf(snapshot) }
    return { ...portable, title: titleOf(snapshot.events, id), digest: digest(portable), ...(attachments?.length ? { attachments } : {}) }
  }
  catalog() { return this.enqueue(() => this.catalogOne()) }
  async catalogOne() {
    await this.ctx.sessionPersistence.flush()
    await this.checkRetired()
    const rows = await this.ctx.sessionPersistence.list(), sessions = [], waiting = []
    const archived = new Set(this.ctx.get?.('workspaceRegistry')?.archivedSessionIds ?? [])
    const routes = new Map(Object.entries(this.state.routes).map(([id, route]) => [route.nativeId, id]))
    const present = new Set()
    for (const { header, revision } of rows) {
      if (this.state.retired[header.id] || this.state.preparing[header.id]) continue
      const id = routes.get(header.id) ?? header.id
      present.add(id)
      try {
        let cached = this.catalogCache.get(id)
        if (!cached || revision === undefined || cached.revision !== revision || cached.nativeId !== header.id) {
          const s = await this.export(id, false)
          const row = s.events.some(e => e.type === 'turn/start' || e.type === 'user/message') ? { id, nativeId: header.id, title: s.title, digest: syncDigest(s), count: s.events.length, updatedAt: s.events.at(-1)?.time ?? header.createdAt } : null
          cached = { revision, nativeId: header.id, row }; this.catalogCache.set(id, cached)
        }
        if (cached.row) sessions.push({ ...cached.row, conflict: !!this.state.conflicts[id], conflictDigests: this.state.conflicts[id]?.digests ?? [], archived: archived.has(header.id) })
      } catch (e) { waiting.push({ id, reason: e.message }) }
    }
    for (const id of this.catalogCache.keys()) if (!present.has(id)) this.catalogCache.delete(id)
    return { sessions, waiting, pending: [...this.pending.values()] }
  }
  status() { return { conflicts: Object.values(this.state.conflicts).map(({ copies, ...row }) => ({ ...row, copyCount: copies.length })), pending: [...this.pending.values()], lastPendingError: this.lastPendingError ?? null } }
  async ensureImported(id, title, cwd) {
    if (cwd !== this.cwd) return
    if (!this.state.imported[id]) {
      this.state.imported[id] = { title, at: Date.now() }
      try { await this.save() }
      catch (error) { delete this.state.imported[id]; throw error }
    }
    const registry = this.ctx.get?.('workspaceRegistry')
    if (registry && !registry.list().some(w => w.path === this.cwd)) await registry.create(this.cwd, '共享会话')
  }
  async clearPending(id, path) { await unlink(path); this.pending.delete(id) }
  enqueue(run) {
    const pending = this.tail.then(run, run); this.tail = pending.catch(() => {})
    return pending
  }
  accept(snapshot, check = () => {}) { return this.enqueue(() => this.acceptOne(snapshot, check)) }
  async acceptOne(snapshot, check = () => {}) {
    check()
    validateSnapshot(snapshot)
    const payload = { ...identityOf(snapshot), events: snapshot.events }
    if (snapshot.digest !== digest(payload)) throw new Error('checkpoint checksum mismatch')
    // Use DSH's native schema and surface validator before creating any durable
    // session. prepare constructs an unpublished Session and owns only this copy.
    const validationId = `two-validate-${randomUUID()}`
    this.ctx.sessions.prepare(validationId, { meta: { ...snapshot.header, id: validationId, cwd: this.cwd }, seed: structuredClone(snapshot.events), inheritedEventCount: snapshot.inheritedEventCount, eventState: 'detached' })
    await importAttachments(this.ctx.get?.('attachments'), snapshot)
    const id = snapshot.header.id
    const staged = join(this.root, 'pending', `${digest(id)}.json`)
    // Persist an inbox before claiming the DSH writer. Restart retries this exact checkpoint.
    const old = await readJson(staged, null)
    check()
    if (old && compareEvents(old.events, snapshot.events) === 'ahead') snapshot = old
    if (old && compareEvents(old.events, snapshot.events) === 'conflict') {
      await this.keepConflict(snapshot, old); await this.keepConflict(old, snapshot)
      await this.clearPending(id, staged)
      return { status: 'conflict', id }
    }
    await atomicJson(staged, snapshot)
    this.pending.set(id, { id, title: snapshot.title, digest: syncDigest(snapshot) })
    let handle
    try {
      const nativeId = this.nativeId(id)
      const existing = await this.ctx.sessionPersistence.stat(nativeId)
      if (existing) {
        const local = await this.read(id)
        // A previous attempt may have committed the log but failed before
        // registering its workspace. Finish that transaction before discarding
        // an equal/ahead inbox, including after a process restart.
        await this.ensureImported(id, snapshot.title, local.header.cwd)
        const sameIdentity = digest(identityOf(local)) === digest(identityOf(snapshot))
        const relation = sameIdentity ? compareEvents(local.events, snapshot.events) : 'conflict'
        if (relation === 'conflict' || (relation === 'behind' && this.state.conflicts[id])) {
          await this.keepConflict(local, snapshot); await this.clearPending(id, staged)
          return { status: 'conflict', id }
        }
        if (relation === 'equal' || relation === 'ahead') { await this.clearPending(id, staged); return { status: relation, id } }
        // An open/live local conversation must be released by its DSH owner.
        // Never take its lock, write behind its back, or tear down an Agent we do not own.
        try { handle = await this.ctx.sessionPersistence.open(nativeId, 'write') }
        catch (e) {
          if (e.name === 'SessionAlreadyOwnedError') return { status: 'pending', id, reason: '本机会话仍被 DSH 占用，更新已保存，释放后自动应用' }
          throw e
        }
        // Recheck after acquiring ownership; the local log may have advanced while we waited.
        const fresh = (await handle.read()).events
        const current = compareEvents(fresh, snapshot.events)
        if (current === 'conflict') {
          await this.keepConflict({ ...local, events: fresh }, snapshot); await this.clearPending(id, staged)
          return { status: 'conflict', id }
        }
        if (current === 'behind') { await handle.append(snapshot.events.slice(fresh.length)); await handle.flush() }
        await this.clearPending(id, staged)
        return { status: current === 'behind' ? 'updated' : current, id }
      }
      handle = await this.ctx.sessionPersistence.create({ ...snapshot.header, id: nativeId, cwd: this.cwd }, { inheritedEventCount: snapshot.inheritedEventCount })
      await handle.append(snapshot.events); await handle.flush()
      await this.ensureImported(id, snapshot.title, this.cwd)
      await this.clearPending(id, staged)
      return { status: 'imported', id }
    } finally { if (handle) await handle.close() }
  }
  openConversation(id) {
    return this.enqueue(async () => {
      const staged = join(this.root, 'pending', `${digest(id)}.json`)
      const snapshot = await readJson(staged, null)
      if (snapshot) {
        const result = await this.acceptOne(snapshot)
        if (result.status === 'pending') await this.continuePending(id, snapshot, staged)
      }
      const nativeId = this.nativeId(id)
      if (!await this.ctx.sessionPersistence.stat(nativeId)) throw new Error('找不到此会话')
      return { id: nativeId, sharedId: id, archived: !!this.ctx.get?.('workspaceRegistry')?.archivedSessionIds?.includes(nativeId) }
    })
  }
  async continuePending(id, snapshot, staged) {
    const previousId = this.nativeId(id)
    const agent = this.ctx.get?.('agents')?.get(previousId)
    if (agent?.status === 'running') throw new Error('本机会话正在回复，结束后再打开最新记录')
    await this.ctx.sessionPersistence.flush()
    const local = validateSnapshot(await this.read(id))
    if (compareEvents(local.events, snapshot.events) !== 'behind') return
    // A supported, independent persistence handle retains the exact event log.
    // Never dispose another plugin's Agent or append into its in-memory Session.
    const nativeId = `two-${digest({ id, checkpoint: snapshot.digest }).slice(0,40)}`
    this.state.preparing[nativeId] = { sharedId: id }
    await this.save()
    const existing = await this.ctx.sessionPersistence.stat(nativeId)
    let handle
    try {
      handle = existing ? await this.ctx.sessionPersistence.open(nativeId, 'write') : await this.ctx.sessionPersistence.create({ ...snapshot.header, id: nativeId, cwd: local.header.cwd ?? this.cwd }, { inheritedEventCount: snapshot.inheritedEventCount })
      const events = (await handle.read()).events
      if (!['equal', 'behind'].includes(compareEvents(events, snapshot.events))) throw new Error('续聊版本与收到的记录不一致，已保留原记录')
      await handle.append(snapshot.events.slice(events.length)); await handle.flush()
    } finally { if (handle) await handle.close() }
    const previousRoute = this.state.routes[id], previousRetired = this.state.retired[previousId]
    this.state.retired[previousId] = { sharedId: id, count: local.events.length, fingerprint: digest(local.events) }
    this.state.routes[id] = { nativeId }
    delete this.state.preparing[nativeId]
    // Publish routing before clearing the inbox, so a crash can always retry.
    try { await this.save() }
    catch (error) {
      if (previousRoute) this.state.routes[id] = previousRoute; else delete this.state.routes[id]
      if (previousRetired) this.state.retired[previousId] = previousRetired; else delete this.state.retired[previousId]
      this.state.preparing[nativeId] = { sharedId: id }
      throw error
    }
    await this.clearPending(id, staged)
  }
  async checkRetired() {
    for (const [nativeId, retired] of Object.entries(this.state.retired)) {
      const stat = await this.ctx.sessionPersistence.stat(nativeId)
      if (!stat || (stat.revision !== undefined && this.retiredRevisions.get(nativeId) === stat.revision)) continue
      const old = await this.readNative(nativeId), fingerprint = digest(old.events)
      if (fingerprint === retired.fingerprint || fingerprint === retired.savedFingerprint) { this.retiredRevisions.set(nativeId, stat.revision); continue }
      // An old native tab can still be used. Keep its independently written tail
      // once it reaches a complete turn, and stop reconciliation of this identity.
      try { validateSnapshot(old) } catch { continue }
      const normalized = { ...old, header: { ...old.header, id: retired.sharedId } }
      const portable = { ...normalized, ...identityOf(normalized) }
      await this.keepConflict(await this.read(retired.sharedId), { ...portable, title: titleOf(old.events, retired.sharedId) })
      retired.savedFingerprint = fingerprint; await this.save()
      this.retiredRevisions.set(nativeId, stat.revision)
    }
  }
  async keepConflict(local, remote) {
    const id = remote.header.id
    const file = join(this.root, 'conflicts', `${digest(id)}-${digest(remote.events)}.json`)
    await atomicJson(file, remote)
    const prior = this.state.conflicts[id]
    this.state.conflicts[id] = { id, title: remote.title ?? titleOf(local.events, id), at: prior?.at ?? Date.now(), copies: [...new Set([...(prior?.copies ?? []), file])], digests: [...new Set([...(prior?.digests ?? []), syncDigest(remote)])], reason: '不同设备分别续写，已保留本机记录和收到的完整副本' }
    await this.save()
  }
  async recoverConflict(id) {
    const conflict = this.state.conflicts[id]
    if (!conflict) throw new Error('找不到冲突记录')
    const ids = []
    for (const path of conflict.copies) {
      const s = await readJson(path, null)
      if (!s) throw new Error('冲突副本不存在')
      const copyId = `linked-${digest({ id, events: s.events }).slice(0,32)}`
      const portable = { header: { ...s.header, id: copyId }, inheritedEventCount: s.inheritedEventCount, events: s.events }
      const attachments = s.attachments ?? await exportAttachments(this.ctx.get?.('attachments'), s.events)
      const result = await this.accept({ ...portable, attachments, title: `${s.title}（另一版本）`, digest: digest(portable) })
      if (result.status === 'conflict' || result.status === 'pending') throw new Error('另一版本尚未就绪')
      ids.push(copyId)
    }
    return { ids }
  }
  async retryPending() {
    this.lastPendingError = null
    for (const file of await readdir(join(this.root, 'pending'))) {
      if (!file.endsWith('.json')) continue
      try {
        const snapshot = await readJson(join(this.root, 'pending', file), null)
        if (snapshot) await this.accept(snapshot)
      } catch (e) { this.lastPendingError = e.message }
    }
  }
}
