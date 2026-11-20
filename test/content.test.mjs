import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareEvents, digest, validateSnapshot } from '../lib/content.js'

const events = [
  { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, time: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]
const snapshot = () => ({ header: { version: 4, id: 'session-example', createdAt: 1, isSeeded: false }, inheritedEventCount: 0, events: structuredClone(events) })

// A wrong prefix decision would overwrite a separately continued conversation.
test('same conversation can advance A to B then B to A without making a new id', () => {
  assert.equal(compareEvents(events, [...events, { seq: 2, type: 'session/title', time: 3, data: { title: '标题' } }]), 'behind')
  assert.equal(compareEvents([...events, { seq: 2, type: 'session/title', time: 3, data: { title: '标题' } }], events), 'ahead')
  assert.equal(compareEvents(events, structuredClone(events)), 'equal')
})
test('divergent content is a conflict even when one history is longer', () => {
  const changed = structuredClone(events); changed[0].data.turn = 2
  assert.equal(compareEvents(events, [...changed, { seq: 2, time: 3, type: 'session/title', data: {} }]), 'conflict')
})
test('object key order does not manufacture a conflict', () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }))
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }))
})
test('an unfinished turn cannot be published as a resumable checkpoint', () => {
  assert.throws(() => validateSnapshot({ ...snapshot(), events: [events[0]] }), /unfinished/)
  assert.doesNotThrow(() => validateSnapshot(snapshot()))
})
test('malformed sequences and unsafe ids are refused before persistence', () => {
  const s = snapshot(); s.events[1].seq = 4
  assert.throws(() => validateSnapshot(s), /sequence/)
  const unsafe = snapshot(); unsafe.header.id = '../credentials'
  assert.throws(() => validateSnapshot(unsafe), /identity/)
})
test('future session formats and incorrect inherited cuts are refused', () => {
  const s = snapshot(); s.header.version = 999
  assert.throws(() => validateSnapshot(s), /format/)
  const inherited = snapshot(); inherited.inheritedEventCount = 999
  assert.throws(() => validateSnapshot(inherited), /inherited/)
})
