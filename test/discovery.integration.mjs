import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Discovery } from '../lib/discovery.js'
import { createIdentity } from '../lib/crypto.js'
test('UDP discovery exchanges public identity and replies without releasing conversation data', async t => {
  const found = Promise.withResolvers()
  const a = await Discovery.open({ identity: createIdentity('A'), port: 48792, discoveryPort: 0, host: '127.0.0.1', broadcast: false, onPeer: () => {} })
  const b = await Discovery.open({ identity: createIdentity('B'), port: 48793, discoveryPort: 0, host: '127.0.0.1', broadcast: false, onPeer: (peer, url) => found.resolve({ peer, url }) })
  t.after(() => a.close()); t.after(() => b.close())
  a.sendTo('127.0.0.1', b.port)
  const { peer, url } = await Promise.race([found.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('UDP discovery timed out')), 2500).unref())])
  assert.equal(peer.name, 'A')
  assert.equal(url, 'http://127.0.0.1:48792')
  assert.equal('privateKey' in peer, false)
})
