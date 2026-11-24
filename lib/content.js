import { createHash } from 'node:crypto'

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex') }

function isOwnDelivery({ header, inheritedEventCount }, event) {
  return event.type === 'session-log-deepseek/delivery-accepted'
    && event.seq >= inheritedEventCount
    && event.data?.sessionFormatVersion === header.version
}

export function logForSession(snapshot, id) {
  const { header, inheritedEventCount, events } = snapshot
  if (header.id === id) return { header, inheritedEventCount, events }
  return {
    header: { ...header, id }, inheritedEventCount,
    events: events.map(event => isOwnDelivery(snapshot, event) && event.data.sessionId === header.id
      ? { ...event, data: { ...event.data, sessionId: id } }
      : event),
  }
}

export function copyDigest(snapshot, key) {
  // 0.1.1 may already have persisted the old ID with unreadable delivery markers.
  // Keep retries deterministic and reuse existing IDs for all unaffected logs.
  return digest(snapshot.events.some(event => isOwnDelivery(snapshot, event)) ? { ...key, rebindDeliveries: true } : key)
}

// DSH stamps an otherwise identical lifecycle marker when each machine opens
// a stored conversation. Its wall-clock time does not represent a new message.
function comparableEvent(event) {
  return event?.type === 'session/end-seed' && event.data && Object.keys(event.data).length === 0 ? { ...event, time: 0 } : event
}
export function syncDigest(snapshot) {
  const { header, inheritedEventCount, events } = snapshot
  return digest({ header, inheritedEventCount, events: events.map(comparableEvent) })
}
export function compareEvents(local, remote) {
  for (let i = 0; i < Math.min(local.length, remote.length); i++) {
    if (canonical(comparableEvent(local[i])) !== canonical(comparableEvent(remote[i]))) return 'conflict'
  }
  return local.length === remote.length ? 'equal' : local.length < remote.length ? 'behind' : 'ahead'
}
export function containsAttachment(value) {
  if (!value || typeof value !== 'object') return false
  if (typeof value.attachmentId === 'string') return true
  return Object.values(value).some(containsAttachment)
}
export function validateSnapshot(snapshot) {
  const { header, events, inheritedEventCount } = snapshot ?? {}
  if (!header || header.version !== 4) throw new Error('unsupported session format')
  if (typeof header.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,180}$/.test(header.id)) throw new Error('invalid session identity')
  if (!Array.isArray(events)) throw new Error('missing events')
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length || (!header.isSeeded && inheritedEventCount !== 0)) throw new Error('invalid inherited cut')
  let turn = null
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (!e || e.seq !== i || typeof e.type !== 'string') throw new Error('invalid event sequence')
    if (isOwnDelivery(snapshot, e) && e.data.sessionId !== header.id) throw new Error('current-generation delivery marker names the wrong Session')
    if (e.type === 'turn/start') {
      if (turn !== null) throw new Error('unfinished nested turn')
      turn = e.data.turn
    }
    if (e.type === 'turn/end') {
      if (turn === null || e.data.turn !== turn) throw new Error('invalid turn boundary')
      turn = null
    }
  }
  if (turn !== null) throw new Error('unfinished turn')
  return snapshot
}
