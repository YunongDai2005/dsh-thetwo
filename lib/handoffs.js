import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { atomicJson, readJson } from './files.js'
import { syncDigest } from './content.js'

const week = 7 * 86400000
const maxPerPeer = 32
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sessionId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,180}$/
const settled = state => state === 'submitted' || state === 'declined'
const validTask = task => typeof task === 'string' && task.trim().length > 0 && task.length <= 4000
export const validGrant = value => typeof value === 'string' && uuid.test(value)

export class Handoffs {
  static async open(home) {
    const file = join(home, 'session-link', 'handoffs.json')
    return new Handoffs(file, await readJson(file, []))
  }
  constructor(file, rows) {
    this.file = file
    this.rows = rows
    this.tail = Promise.resolve()
    this.awaitingReceipts = new Map()
  }
  active() { return this.rows.filter(row => row.expires > Date.now()) }
  update(change) {
    const work = this.tail.then(async () => {
      const rows = this.active().map(row => ({ ...row }))
      if (!change(rows) && rows.length === this.rows.length) return
      await atomicJson(this.file, rows)
      this.rows = rows
    })
    this.tail = work.catch(() => {})
    return work
  }
  offer(peer, session, minCount, callId, task, check) {
    if (!validTask(task) || typeof session !== 'string' || !sessionId.test(session) || !Number.isSafeInteger(minCount) || minCount < 0 || typeof callId !== 'string' || !callId) throw new Error('交接需要当前会话和 1–4000 字的任务。')
    return this.update(rows => {
      check()
      if (rows.some(r => r.direction === 'out' && r.callId === callId && r.session === session)) return false
      if (rows.filter(r => r.peer === peer && r.direction === 'out' && !settled(r.state)).length >= maxPerPeer) throw new Error('此设备的待接任务已满。')
      rows.push({ id: randomUUID(), direction: 'out', peer, session, minCount, callId, task: task.trim(), state: 'waiting', expires: Date.now() + week })
      return true
    })
  }
  confirm(id, grantFor) {
    return this.update(rows => {
      const row = rows.find(r => r.id === id && r.direction === 'out' && r.state === 'waiting')
      if (!row) throw new Error('此交接已经处理或过期。')
      const grant = grantFor(row.peer)
      if (!validGrant(grant)) throw new Error('对方尚未允许在本机确认此任务，请在接收设备接手。')
      if (row.confirmation === grant) return false
      row.confirmation = grant
      return true
    })
  }
  exchange(peer, catalog) {
    const offers = [], receipts = [], awaiting = []
    for (const row of this.active()) {
      if (row.peer !== peer) continue
      if (row.direction === 'in' && settled(row.state) && this.awaitingReceipts.get(peer)?.has(row.id)) receipts.push({ id: row.id, state: row.state })
      if (row.direction !== 'out' || settled(row.state)) continue
      awaiting.push(row.id)
      const entry = catalog.sessions.find(s => s.id === row.session && !s.conflict && s.count > row.minCount)
      if (entry) offers.push({ id: row.id, session: row.session, task: row.task, count: entry.count, digest: entry.digest, expires: row.expires, confirmation: row.confirmation })
    }
    return { offers, receipts, awaiting }
  }
  receive(peer, wire, check) {
    if (!wire || !Array.isArray(wire.offers) || !Array.isArray(wire.receipts)) return
    check()
    if (Array.isArray(wire.awaiting)) this.awaitingReceipts.set(peer, new Set(wire.awaiting.slice(0, maxPerPeer).filter(validGrant)))
    if (!wire.offers.length && !wire.receipts.length) return
    return this.update(rows => {
      check()
      let changed = false
      for (const offer of wire.offers.slice(0, maxPerPeer)) {
        if (!offer || !validGrant(offer.id) || typeof offer.session !== 'string' || !sessionId.test(offer.session) || !validTask(offer.task) ||
            !Number.isSafeInteger(offer.count) || offer.count < 1 || !/^[0-9a-f]{64}$/.test(offer.digest) ||
            !Number.isSafeInteger(offer.expires) || offer.expires <= Date.now()) continue
        const confirmation = validGrant(offer.confirmation) ? offer.confirmation : undefined
        const existing = rows.find(r => r.id === offer.id)
        if (existing) {
          if (existing.direction === 'in' && existing.peer === peer && existing.session === offer.session && existing.task === offer.task &&
              !settled(existing.state) && confirmation && existing.confirmation !== confirmation) {
            existing.confirmation = confirmation; changed = true
          }
          continue
        }
        if (rows.filter(r => r.peer === peer && r.direction === 'in' && !settled(r.state)).length >= maxPerPeer) continue
        rows.push({ id: offer.id, session: offer.session, task: offer.task, count: offer.count, digest: offer.digest, confirmation, expires: Math.min(offer.expires, Date.now() + week), direction: 'in', peer, state: 'waiting' })
        changed = true
      }
      for (const receipt of wire.receipts.slice(0, maxPerPeer)) {
        if (!receipt || !settled(receipt.state)) continue
        const row = rows.find(r => r.id === receipt.id && r.peer === peer && r.direction === 'out' && r.state === 'waiting')
        if (row) { row.state = receipt.state; changed = true }
      }
      return changed
    })
  }
  async prepare(id, library, check) {
    let target
    const initial = this.active().find(r => r.direction === 'in' && r.id === id && !settled(r.state))
    if (!initial) throw new Error('此交接已经处理或过期。')
    check(initial.peer)
    if (library.state.conflicts[initial.session]) throw new Error('请先在共享会话库中处理不同版本。')
    if (initial.nativeId && library.nativeId(initial.session) !== initial.nativeId) throw new Error('会话的最新版本已变更，请在最新会话重新发起交接。')
    const opened = await library.openConversation(initial.session)
    if (opened.archived) throw new Error('请先在共享会话库取消归档。')
    if (library.state.conflicts[initial.session] || (initial.nativeId && opened.id !== initial.nativeId)) throw new Error('会话版本已变更，请在最新会话重新发起交接。')
    const snapshot = await library.export(initial.session)
    if (snapshot.events.length < initial.count || syncDigest({ ...snapshot, events: snapshot.events.slice(0, initial.count) }) !== initial.digest) throw new Error('正在等待交接所需的完整会话，请稍后重试。')
    await this.update(rows => {
      check(initial.peer)
      const row = rows.find(r => r.id === id && !settled(r.state))
      if (!row) throw new Error('此交接已经处理或过期。')
      target = { id: row.nativeId ?? opened.id, task: row.task, requestId: id }
      if (row.nativeId) return false
      row.nativeId = opened.id
      row.state = 'submitting'
      return true
    })
    return target
  }
  settle(id, outcome, check) {
    return this.update(rows => {
      const row = rows.find(r => r.id === id && r.direction === 'in')
      if (!row || !settled(outcome)) throw new Error('无效的交接回执。')
      check(row.peer)
      if (row.state === outcome) return false
      if (row.state !== (outcome === 'submitted' ? 'submitting' : 'waiting')) throw new Error('交接状态已更新，请刷新。')
      row.state = outcome
      return true
    })
  }
  forget(peer) {
    this.awaitingReceipts.delete(peer)
    return this.update(rows => {
      const keep = rows.filter(row => row.peer !== peer)
      if (keep.length === rows.length) return false
      rows.splice(0, rows.length, ...keep)
      return true
    })
  }
}
