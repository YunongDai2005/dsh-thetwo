// Local-machine broadcast/multicast smoke check. No pairing or session access.
import assert from 'node:assert/strict'
import { createIdentity } from '../lib/crypto.js'
import { Discovery } from '../lib/discovery.js'
const ids = [createIdentity('TheTwo LAN check A'), createIdentity('TheTwo LAN check B')]
const found = [new Set(), new Set()], errors = [], sockets = []
try {
  for (let i = 0; i < 2; i++) sockets.push(await Discovery.open({ identity: ids[i], port: 48792 + i, onPeer: peer => found[i].add(peer.id), onError: error => errors.push(error.code ?? error.message) }))
  const until = Date.now() + 12000
  while (Date.now() < until && !(found[0].has(ids[1].id) && found[1].has(ids[0].id))) await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(found[0].has(ids[1].id) && found[1].has(ids[0].id), `Broadcast/multicast mutual discovery failed: ${JSON.stringify(errors)}`)
  console.log(JSON.stringify({ test: 'local-machine LAN broadcast/multicast', mutualDiscovery: true, warnings: [...new Set(errors)], distinctPhysicalComputers: false }))
} finally { await Promise.allSettled(sockets.map(socket => socket.close())) }
