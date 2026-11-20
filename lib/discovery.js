import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { publicIdentity } from './crypto.js'

export const DISCOVERY_PORT = 48791
const GROUP = '239.255.47.91'
const PROTOCOL = 'dsh-session-link/discovery/1'
export function broadcastTargets(interfaces = networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat().filter(x => x?.family === 'IPv4' && !x.internal).map(x => {
    const ip = x.address.split('.').map(Number), mask = x.netmask.split('.').map(Number)
    return ip.map((v,i) => (v | (~mask[i] & 255))).join('.')
  }))]
}
export class Discovery {
  static async open(options) {
    const instance = new Discovery(); instance.options = options; instance.closed = false
    instance.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    instance.socket.on('error', e => { options.onError?.(e) })
    await new Promise((resolve,reject) => {
      instance.socket.once('error', reject)
      instance.socket.bind(options.discoveryPort ?? DISCOVERY_PORT, options.host ?? '0.0.0.0', () => { instance.socket.off('error', reject); resolve() })
    })
    instance.port = instance.socket.address().port
    instance.socket.on('message', (bytes, remote) => {
      if (bytes.length > 2048) return
      try {
        const packet = JSON.parse(bytes.toString('utf8'))
        if (packet.protocol !== PROTOCOL || packet.identity?.id === options.identity.id || !Number.isInteger(packet.port) || packet.port < 1 || packet.port > 65535) return
        const peer = publicIdentity(packet.identity)
        options.onPeer(peer, `http://${remote.address}:${packet.port}`)
        if (!packet.reply) instance.sendTo(remote.address, remote.port, true)
      } catch { /* unrelated or malformed network traffic */ }
    })
    if (options.broadcast !== false) {
      instance.socket.setBroadcast(true); instance.socket.setMulticastTTL(4)
      // Interfaces come and go (sleep, another network, a tunnel coming up): join the group on each as it appears.
      const joined = new Set()
      const join = () => {
        const present = new Set(Object.values(networkInterfaces()).flat().filter(row => row?.family === 'IPv4' && !row.internal).map(row => row.address))
        for (const address of joined) if (!present.has(address)) joined.delete(address)
        for (const address of present) {
          if (joined.has(address)) continue
          // Counted as joined only once it worked, so an interface that was not ready is tried again with the next announcement.
          try { instance.socket.addMembership(GROUP, address); joined.add(address) } catch (e) { options.onError?.(e) }
        }
      }
      const announce = () => {
        if (instance.closed) return
        join()
        for (const address of [...broadcastTargets(), GROUP]) instance.sendTo(address, DISCOVERY_PORT)
      }
      instance.timer = setInterval(announce, 4000); instance.timer.unref(); announce()
    }
    return instance
  }
  sendTo(address, port = DISCOVERY_PORT, reply = false) {
    if (this.closed) return
    const packet = Buffer.from(JSON.stringify({ protocol: PROTOCOL, identity: publicIdentity(this.options.identity), port: this.options.port, reply }))
    this.socket.send(packet, port, address, e => { if (e) this.options.onError?.(e) })
  }
  async close() {
    if (this.closed) return
    this.closed = true; clearInterval(this.timer)
    await new Promise(resolve => this.socket.close(resolve))
  }
}
