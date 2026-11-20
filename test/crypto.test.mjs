import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdentity, seal, unseal, publicIdentity } from '../lib/crypto.js'

test('paired devices exchange encrypted messages without transferring their private keys', () => {
  const a = createIdentity('电脑 A'), b = createIdentity('电脑 B')
  const encrypted = seal(a, publicIdentity(b), { text: 'only our conversation' })
  assert.equal(JSON.stringify(encrypted).includes('only our conversation'), false)
  assert.deepEqual(unseal(b, encrypted).payload, { text: 'only our conversation' })
  assert.equal(unseal(b, encrypted).sender.id, a.id)
  assert.equal('privateKey' in publicIdentity(a), false)
})
test('another device and modified ciphertext cannot read or forge a message', () => {
  const a = createIdentity('A'), b = createIdentity('B'), c = createIdentity('C')
  const encrypted = seal(a, publicIdentity(b), { value: 1 })
  assert.throws(() => unseal(c, encrypted))
  assert.throws(() => unseal(b, { ...encrypted, cipher: Buffer.from('tampered').toString('base64') }))
})
test('expired envelopes and forged advertised identities are rejected', () => {
  const a = createIdentity('A'), b = createIdentity('B')
  assert.throws(() => unseal(b, seal(a, b, {}, 1)), /expired/)
  assert.throws(() => seal(a, { ...publicIdentity(b), id: 'forged' }, {}), /identity/)
})
