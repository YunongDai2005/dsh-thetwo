import { test } from 'node:test'
import assert from 'node:assert/strict'
import { broadcastTargets } from '../lib/discovery.js'
import { endpoint } from '../lib/node.js'
test('discovery broadcasts on every attached IPv4 subnet without scanning unrelated networks', () => {
  const interfaces = { wifi: [{ family: 'IPv4', address: '192.168.5.17', netmask: '255.255.255.0', internal: false }], wired: [{ family: 'IPv4', address: '10.0.2.10', netmask: '255.255.254.0', internal: false }], loop: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }] }
  assert.deepEqual(broadcastTargets(interfaces).sort(), ['10.0.3.255', '192.168.5.255'])
})
test('manual fallback refuses public websites, embedded credentials and URL paths', () => {
  assert.equal(endpoint('192.168.5.10'), 'http://192.168.5.10:48792')
  assert.throws(() => endpoint('https://example.com'))
  assert.throws(() => endpoint('http://user:password@192.168.1.1:48792'))
  assert.throws(() => endpoint('http://192.168.1.1/admin'))
})
