import { generateKeyPairSync, createPublicKey, createPrivateKey, createHash, diffieHellman, hkdfSync, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto'

const PROTOCOL = 'dsh-session-link/1'
const keyId = key => createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')
export function createIdentity(name) {
  const keys = generateKeyPairSync('x25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return { id: keyId(publicKey), name: String(name).slice(0,64), publicKey, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }
}
export function publicIdentity(identity) {
  if (!identity || typeof identity.publicKey !== 'string' || identity.publicKey.length !== 60 || keyId(identity.publicKey) !== identity.id) throw new Error('invalid device identity')
  const key = createPublicKey({ key: Buffer.from(identity.publicKey, 'base64'), type: 'spki', format: 'der' })
  if (key.asymmetricKeyType !== 'x25519') throw new Error('invalid device key')
  return { id: identity.id, name: String(identity.name ?? 'DSH').slice(0,64), publicKey: identity.publicKey }
}
function sharedKey(self, peer) {
  publicIdentity(peer)
  const secret = diffieHellman({ privateKey: createPrivateKey({ key: Buffer.from(self.privateKey, 'base64'), type: 'pkcs8', format: 'der' }), publicKey: createPublicKey({ key: Buffer.from(peer.publicKey, 'base64'), type: 'spki', format: 'der' }) })
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from([self.id, peer.id].sort().join(':')), Buffer.from(PROTOCOL), 32))
}
function aad(sender, recipient, id, time) { return Buffer.from(`${PROTOCOL}:${sender}:${recipient}:${id}:${time}`) }
export function seal(self, peer, payload, time = Date.now()) {
  const sender = publicIdentity(self), recipient = publicIdentity(peer), id = randomUUID(), nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sharedKey(self, peer), nonce)
  cipher.setAAD(aad(sender.id, recipient.id, id, time))
  const bytes = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return { protocol: PROTOCOL, sender, recipient: recipient.id, id, time, nonce: nonce.toString('base64'), cipher: bytes.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}
export function unseal(self, envelope, now = Date.now()) {
  if (!envelope || envelope.protocol !== PROTOCOL || envelope.recipient !== self.id) throw new Error('wrong recipient or protocol')
  if (!Number.isSafeInteger(envelope.time) || Math.abs(envelope.time - now) > 300000) throw new Error('expired envelope')
  if (typeof envelope.id !== 'string' || envelope.id.length > 80) throw new Error('invalid envelope id')
  const sender = publicIdentity(envelope.sender)
  const nonce = Buffer.from(envelope.nonce, 'base64'), tag = Buffer.from(envelope.tag, 'base64')
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid envelope')
  const decipher = createDecipheriv('aes-256-gcm', sharedKey(self, sender), nonce)
  decipher.setAAD(aad(sender.id, self.id, envelope.id, envelope.time)); decipher.setAuthTag(tag)
  const text = Buffer.concat([decipher.update(Buffer.from(envelope.cipher, 'base64')), decipher.final()]).toString('utf8')
  return { sender, id: envelope.id, payload: JSON.parse(text) }
}
