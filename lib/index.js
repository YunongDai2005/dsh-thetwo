import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DshLibrary } from './library.js'
import { SyncNode } from './node.js'

export const name = 'thetwo'
export const inject = ['webServer', 'sessionPersistence', 'sessions']
function homePath(config) {
  let path = config.home ?? (process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh'))
  if (path === '~') path = homedir()
  else if (/^~[/\\]/.test(path)) path = join(homedir(), path.slice(2))
  return resolve(path)
}
async function jsonBody(req) {
  const chunks = []; let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > 8192) throw new Error('操作请求过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export async function apply(ctx, config = {}) {
  const home = homePath(config), library = await DshLibrary.open(ctx, home)
  const node = await SyncNode.open({ ...config, home, library })
  ctx.effect(() => () => node.close(), 'thetwo.network')
  const handle = async (req, res) => {
    const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)) }
    try {
      const ip = String(req.socket.remoteAddress).replace(/^::ffff:/, '')
      const origin = ctx.webServer.getOrigin?.() ?? `http://127.0.0.1:${ctx.webServer.port}`
      if (!(ip === '::1' || /^127\./.test(ip)) || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return send(403, { ok: false, error: '请在本机 DSH 中操作' })
      const path = new URL(req.url, origin).pathname.replace(/^\/session-link\/api(?=\/|$)/, '/api/thetwo')
      if (req.method === 'GET' && path === '/api/thetwo/status') return send(200, { ok: true, value: node.status() })
      if (req.method === 'GET' && path === '/api/thetwo/library') return send(200, { ok: true, value: await library.catalog() })
      if (req.method !== 'POST' || path !== '/api/thetwo/action') return send(404, { ok: false, error: 'not found' })
      if ((req.headers['x-thetwo'] !== '1' && req.headers['x-session-link'] !== '1') || !req.headers['content-type']?.startsWith('application/json')) return send(403, { ok: false, error: 'invalid action request' })
      const input = await jsonBody(req); let result
      switch (input.action) {
        case 'settings': result = await node.configure(input.values, input.revision); break
        case 'peer-settings': result = await node.configurePeer(input.id, input.values, input.revision); break
        case 'pair': result = await node.requestPair(input.id); break
        case 'allow': result = await node.acceptPair(input.id); break
        case 'decline': result = await node.declinePair(input.id); break
        case 'pause': result = await node.pause(input.id, input.paused); break
        case 'forget': result = await node.forget(input.id); break
        case 'sync': result = await node.retry(); break
        case 'probe': result = await node.probe(input.address); break
        case 'recover': result = await library.recoverConflict(input.id); break
        case 'open': result = await library.openConversation(input.id); break
        case 'install-plugins': result = await node.installPlugins(input.id, input.specs); break
        default: throw new Error('不支持的操作')
      }
      return send(200, { ok: true, value: result ?? null })
    } catch (e) { send(e.code === 'SETTINGS_CONFLICT' ? 409 : 400, { ok: false, error: e.message }) }
  }
  for (const path of ['/api/thetwo', '/session-link/api']) ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler: handle }), 'thetwo.routes')
}
