window.__ModuleLoader__.load({
  id: 'dsh-thetwo',
  factory: require => {
    const React = require('react'), { createRoot } = require('react-dom/client'), h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React
    const panelId = 'thetwo', settingsPanelId = 'thetwo-settings', version = '0.1.0'
    // TheOne's cell with a second, smaller nucleus. Everything is plain vector geometry (no filters), so it stays anti-aliased:
    // the membrane is a smooth closed curve, both nuclei wander on layered sine waves, a metaball neck joins them when they
    // meet, and the small one bulges the membrane when it nears the edge. `link` blends from 0 (no device connected: the cell only
    // breathes, the nuclei keep apart and the small one stays inside) to 1 (connected: the full interplay). t = 0 is the still pose.
    const cellWaves = [0.23, 0.37, 0.41, 0.67, 0.19, 0.53, 0.29, 0.47, 0.18, -0.11, 0.25]
    const cellPhases = [0, 0, 0, 0, -Math.PI / 2, 0, Math.PI / 2, 0, 0, 0, 0]
    const fix = value => value.toFixed(3)
    // A smooth closed curve through the points.
    const closed = points => {
      const n = points.length
      let d = `M${fix(points[0][0])} ${fix(points[0][1])}`
      points.forEach((p1, i) => {
        const p0 = points[(i + n - 1) % n], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n]
        d += `C${fix(p1[0] + (p2[0] - p0[0]) / 6)} ${fix(p1[1] + (p2[1] - p0[1]) / 6)} ${fix(p2[0] - (p3[0] - p1[0]) / 6)} ${fix(p2[1] - (p3[1] - p1[1]) / 6)} ${fix(p2[0])} ${fix(p2[1])}`
      })
      return `${d}Z`
    }
    const cellNeck =(c1, r1, c2, r2, reach) => {
      const { acos, atan2, cos, sin, hypot, min, abs, PI } = Math, d = hypot(c2.x - c1.x, c2.y - c1.y)
      if (d > r1 + r2 + reach || d <= abs(r1 - r2)) return ''
      const u1 = d < r1 + r2 ? acos((r1 * r1 + d * d - r2 * r2) / (2 * r1 * d)) : 0, u2 = d < r1 + r2 ? acos((r2 * r2 + d * d - r1 * r1) / (2 * r2 * d)) : 0
      const toward = atan2(c2.y - c1.y, c2.x - c1.x), spread = acos((r1 - r2) / d)
      const a1 = toward + u1 + (spread - u1) / 2, a2 = toward - u1 - (spread - u1) / 2
      const a3 = toward + PI - u2 - (PI - u2 - spread) / 2, a4 = toward - PI + u2 + (PI - u2 - spread) / 2
      const at = (p, a, r) => ({ x: p.x + r * cos(a), y: p.y + r * sin(a) }), xy = p => `${fix(p.x)} ${fix(p.y)}`
      const p1 = at(c1, a1, r1), p2 = at(c1, a2, r1), p3 = at(c2, a3, r2), p4 = at(c2, a4, r2)
      const pull = min(1.2, hypot(p3.x - p1.x, p3.y - p1.y) / (r1 + r2)) * min(1, d * 2 / (r1 + r2))
      const h1 = at(p1, a1 - PI / 2, r1 * pull), h2 = at(p2, a2 + PI / 2, r1 * pull), h3 = at(p3, a3 + PI / 2, r2 * pull), h4 = at(p4, a4 - PI / 2, r2 * pull)
      return `M${xy(p1)}C${xy(h1)} ${xy(h3)} ${xy(p3)}A${r2} ${r2} 0 ${d > r1 ? 1 : 0} 0 ${xy(p4)}C${xy(h4)} ${xy(h2)} ${xy(p2)}Z`
    }
    const cellFrame = (t, pace = cellWaves, link = 0) => {
      const { sin, cos, atan2, hypot, exp, max, PI } = Math, wave = i => sin(pace[i] * t + cellPhases[i])
      const angle = -PI / 4 + (0.5 + 0.4 * link) * wave(0) + (0.3 + 0.3 * link) * wave(1)
      const reach = 3.6 + 0.5 * wave(2) + link * (0.4 + 0.6 * wave(2) + 0.95 * wave(3))
      const ball = { x: 10 + reach * cos(angle), y: 10 + reach * sin(angle) }
      const core = { x: 9 + 1.4 * wave(4) + 0.6 * wave(5), y: 11 + 1.3 * wave(6) + 0.5 * wave(7) }
      const gap = hypot(core.x - ball.x, core.y - ball.y), least = 3.6 + 1.6 * (1 - link)
      if (gap < least) { core.x = ball.x + (core.x - ball.x) / gap * least; core.y = ball.y + (core.y - ball.y) / gap * least }
      const bulge = max(0, reach - 4.7), points = Array.from({ length: 44 }, (_, i) => {
        const a = i / 44 * 2 * PI, off = atan2(sin(a - angle), cos(a - angle))
        const r = 7.4 + 0.12 * sin(pace[10] * t) + 0.22 * sin(2 * a + pace[8] * t) + 0.07 * sin(3 * a + pace[9] * t) + bulge * exp(-off * off / 0.405)
        return [10 + r * cos(a), 10 + r * sin(a)]
      })
      return { membrane: closed(points), core, ball, neck: cellNeck(core, 2.6, ball, 1.5, 1.8 * link) }
    }
    // state: undefined holds still; 'idle' breathes slowly; 'linked' and 'syncing' play the full interplay, 'syncing' faster.
    function CellMark({ size, state }) {
      const svg = useRef(null), target = useRef({ speed: 0.7, link: 0 }), still = cellFrame(0), live = !!state
      target.current = { speed: state === 'syncing' ? 2.2 : state === 'linked' ? 1 : 0.7, link: state === 'idle' ? 0 : 1 }
      useEffect(() => {
        if (!live || typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return
        const [membrane, core, ball, neck] = svg.current.children
        const paint = frame => {
          membrane.setAttribute('d', frame.membrane); neck.setAttribute('d', frame.neck)
          core.setAttribute('cx', fix(frame.core.x)); core.setAttribute('cy', fix(frame.core.y))
          ball.setAttribute('cx', fix(frame.ball.x)); ball.setAttribute('cy', fix(frame.ball.y))
        }
        // Each mark gets slightly different tempos, so two marks on screen never move in step.
        const pace = cellWaves.map(w => w * (0.85 + Math.random() * 0.3))
        let t = 0, speed = target.current.speed, link = 0, last = performance.now(), frame = requestAnimationFrame(function step(now) {
          const dt = Math.min(0.1, (now - last) / 1000), ease = Math.min(1, dt * 2); last = now
          speed += (target.current.speed - speed) * ease; link += (target.current.link - link) * ease * 0.5; t += dt * speed
          paint(cellFrame(t, pace, link)); frame = requestAnimationFrame(step)
        })
        return () => { cancelAnimationFrame(frame); paint(cellFrame(0)) }
      }, [live])
      return h('svg', { ref: svg, className: 'thetwo-mark', width: size, height: size, viewBox: '0 0 20 20', 'aria-hidden': true, focusable: false },
        h('path', { d: still.membrane, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
        h('circle', { cx: fix(still.core.x), cy: fix(still.core.y), r: 2.6, fill: 'currentColor' }),
        h('circle', { cx: fix(still.ball.x), cy: fix(still.ball.y), r: 1.5, fill: 'currentColor' }),
        h('path', { d: still.neck, fill: 'currentColor' }))
    }
    const mark = (size = 24, state) => h(CellMark, { size, state })

    // TheOne hangs its topics under the main-chat card as a raft of cells. TheTwo hangs its devices there the same way: one
    // cell per device, drawn like the mark (a smooth membrane, a nucleus, the name inside), centred under the card. Paired
    // devices carry their name, nearby ones are small and dashed. Cells that touch share a flat wall, like soap bubbles. A
    // cell shows what sync is doing with its device: it breathes only while connected, and while records are being checked
    // or have just arrived, vesicles cross between the mark and the cell.
    const NS = 'http://www.w3.org/2000/svg', TAU = Math.PI * 2, CELL_R = 22, CELL_MAX = 30, CELL_FEW = 34, NEAR_R = 12, MINI = 0.32, TOP_GAP = 8, PRESS = 3, WALL = 2
    const smin = (a, b, k) => { const g = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - g * g * k / 4 }
    const ease = (value, to, rate, dt) => value + (to - value) * Math.min(1, dt * rate)
    // One cell's outline: a circle that breathes by `live` and gives way to each neighbour in `near` ({ x, y, r }).
    const blob = (x, y, r, t = 0, phase = 0, live = 0, near = []) => closed(Array.from({ length: 40 }, (_, i) => {
      const a = i / 40 * TAU
      let reach = r * (1 + live * (0.022 * Math.sin(2 * a + 0.18 * t + phase) + 0.008 * Math.sin(3 * a - 0.11 * t + phase)))
      for (const o of near) {
        const d = Math.hypot(o.x - x, o.y - y), facing = Math.cos(a - Math.atan2(o.y - y, o.x - x))
        if (d > 0 && d < r + o.r + WALL && facing > 0.15) reach = smin(reach, Math.max(r * 0.35, (d * d + r * r - o.r * o.r) / (2 * d) - WALL / 2) / facing, 5)
      }
      return [x + reach * Math.cos(a), y + reach * Math.sin(a)]
    }))
    // What sync is doing with a device, for its card on the page (`state`) and for its cell (`cell`): waiting to be paired,
    // paused, offline, held up by something the user should look at, syncing right now, or in sync.
    const peerState = (peer, discovered, enabled, syncing) => {
      if (discovered) return peer.requested ? { state: 'new', cell: 'pending', label: '等待对方允许' } : { state: 'new', cell: 'offer', label: '可以开始同步' }
      if (!enabled || peer.paused) return { state: 'idle', cell: 'paused', label: '已暂停同步' }
      if (!peer.online) return peer.error === 'sync paused' ? { state: 'idle', cell: 'paused', label: '对方已暂停同步' } : { state: 'idle', cell: 'offline', label: '离线 · 本机会话仍可使用' }
      // Reached, but the sync is held up on the other side.
      if (peer.blocked === 'sync paused') return { state: 'idle', cell: 'paused', label: '对方已暂停同步' }
      if (peer.blocked === 'not paired') return peer.requested ? { state: 'new', cell: 'pending', label: '已重新请求，等待对方允许' } : { state: 'waiting', cell: 'wait', label: '对方没有这台设备的配对记录' }
      if (peer.blocked) return { state: 'waiting', cell: 'wait', label: '同步未完成' }
      const held = peer.pending ? '更新待应用' : peer.conflicts ? '有不同版本需要查看' : peer.waiting ? '部分会话暂未同步' : ''
      if (held) return { state: 'waiting', cell: 'wait', label: held }
      return syncing ? { state: 'online', cell: 'syncing', label: '正在同步' } : { state: 'online', cell: 'synced', label: peer.lastSync ? '已同步' : '已连接' }
    }
    const inkWidth = text => [...text].reduce((w, ch) => w + (ch > '⹿' ? 1 : ch === ' ' ? 0.3 : /[A-Z0-9mw]/.test(ch) ? 0.66 : 0.54), 0)
    // The name a cell carries: whole if it fits, else its first word, and the cell grows up to `most` to hold it. A longer name stays in the hint.
    const cellName = (name, most) => {
      for (const text of [name.trim(), name.trim().split(/[\s·•|/\\,，:：()（）[\]【】_—-]+/).find(Boolean) ?? '']) {
        const r = Math.hypot(inkWidth(text) * 10.5 / 2 + 6, 11)
        if (text && r <= most) return { text, r: Math.max(CELL_R, r) }
      }
      return { text: '', r: CELL_R }
    }
    // Rows centred under the card, so two or three devices sit in the middle; sets each cell's home and returns the height used.
    const arrange = (cells, width, k) => {
      const rows = [[]], step = c => 2 * c.r * k - PRESS * k
      let x = 0, top = TOP_GAP
      for (const c of cells) { if (rows.at(-1).length && x + 2 * c.r * k > width - 4) { rows.push([]); x = 0 } rows.at(-1).push(c); x += step(c) }
      rows.forEach(row => {
        const tall = Math.max(0, ...row.map(c => c.r)) * k, span = row.reduce((sum, c) => sum + step(c), PRESS * k)
        let left = (width - span) / 2
        row.forEach((c, i) => { const r = c.r * k; c.hx = left + r; c.hy = top + tall + (tall - r) * (i % 2 ? 0.5 : -0.5); left += step(c) })
        top += 2 * tall - PRESS * k
      })
      return cells.length ? top + PRESS * k + 4 : 0
    }
    const glyphPath = blob(18, 18, 15, 0, 0.6, 1)
    // The same cell, still, beside a device's name on the page.
    const cellGlyph = (cell, size = 36) => h('svg', { className: 'thetwo-glyph', width: size, height: size, viewBox: '0 0 36 36', 'aria-hidden': true, focusable: false },
      h('g', { className: `thetwo-cell ${cell}` }, h('path', { 'data-part': 'body', d: glyphPath }), h('path', { 'data-part': 'membrane', d: glyphPath }), h('circle', { 'data-part': 'nucleus', cx: 18, cy: 18, r: 2.6 })))
    // `read` returns the current { status, library }; `pick(cell, box)` is called when a cell is pressed.
    function mountCluster({ button, rail, read, pick }) {
      if (typeof requestAnimationFrame !== 'function' || typeof matchMedia !== 'function') return { setRail() {}, destroy() {} }
      const el = (tag, attrs, parent) => { const node = document.createElementNS(NS, tag); for (const key in attrs) node.setAttribute(key, attrs[key]); parent.append(node); return node }
      const host = document.createElement('div'), tip = document.createElement('div'), calm = matchMedia('(prefers-reduced-motion: reduce)')
      host.className = 'thetwo-foam'; tip.className = 'thetwo-foam-tip'; tip.setAttribute('role', 'tooltip'); document.body.append(host, tip)
      const svg = el('svg', { role: 'group', 'aria-label': 'TheTwo 设备' }, host), cells = new Map(), vesicles = []
      let k = rail ? MINI : 1, first = true, settled = false, height = 0, margin = '', box = '', seen = null, stamp = null, t = 0, last = performance.now()
      const hint = c => {
        if (!c) { tip.classList.remove('on'); return }
        const r = c.g.getBoundingClientRect()
        tip.textContent = `${c.peer.name} · ${c.label}`; tip.classList.add('on')
        tip.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - tip.offsetWidth / 2, window.innerWidth - tip.offsetWidth - 8))}px`; tip.style.top = `${r.bottom + 6}px`
      }
      const create = () => {
        const g = el('g', { tabindex: 0, role: 'button' }, svg)
        const c = { g, body: el('path', { 'data-part': 'body' }, g), membrane: el('path', { 'data-part': 'membrane' }, g), nucleus: el('circle', { 'data-part': 'nucleus' }, g), text: el('text', {}, g),
          phase: Math.random() * TAU, scale: first ? 1 : 0, x: NaN, y: 0, nx: 0, ny: 0, lit: 0 }
        const press = () => { hint(null); pick(c, g.getBoundingClientRect()) }
        g.addEventListener('click', press)
        g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); press() } })
        g.addEventListener('pointerenter', () => hint(c)); g.addEventListener('pointerleave', () => hint(null))
        g.addEventListener('focus', () => { if (g.matches(':focus-visible')) hint(c) }); g.addEventListener('blur', () => hint(null))
        return c
      }
      // A record on its way: a vesicle between the mark and a cell, out and back in turn.
      const carry = c => {
        const node = el('g', { class: 'thetwo-vesicle' }, svg); el('circle', { 'data-part': 'membrane', r: 3.4 }, node); el('circle', { 'data-part': 'nucleus', r: 1.1 }, node)
        vesicles.push({ c, node, at: 0, back: c.back = !c.back })
      }
      // Bring the cells in line with the devices TheTwo reports; true when something was read.
      const sync = () => {
        const view = read()
        if (view === seen) return false
        const { status, library } = seen = view, enabled = status?.settings.values.syncEnabled !== false, keep = new Set(), most = status?.peers.length > 3 ? CELL_MAX : CELL_FEW
        for (const [peer, discovered] of status ? [...status.peers.map(p => [p, false]), ...status.devices.map(p => [p, true])] : []) {
          if (keep.has(peer.id)) continue
          keep.add(peer.id)
          if (!cells.has(peer.id)) cells.set(peer.id, create())
          const c = cells.get(peer.id), state = peerState(peer, discovered, enabled, status.syncing), name = discovered ? { text: '', r: NEAR_R } : cellName(peer.name, most)
          Object.assign(c, { peer, discovered, label: state.label, r: name.r, named: !!name.text, gone: false, live: state.state === 'online' || state.state === 'waiting' ? 1 : 0, busy: state.cell === 'syncing' })
          if (c.kind !== state.cell) { c.kind = state.cell; c.g.setAttribute('class', `thetwo-cell ${state.cell}`) }
          if (c.text.textContent !== name.text) c.text.textContent = name.text
          c.g.setAttribute('aria-label', `${peer.name}，${state.label}`)
        }
        for (const [id, c] of cells) if (!keep.has(id)) c.gone = true
        const next = library ? library.sessions.map(s => `${s.id}:${s.updatedAt}`).join() : null
        if (stamp !== null && next !== null && next !== stamp && !calm.matches) for (const c of cells.values()) if (c.live && !c.gone) carry(c)
        if (next !== null) stamp = next
        return true
      }
      let frame = requestAnimationFrame(function step(now) {
        frame = requestAnimationFrame(step)
        const dt = Math.min(0.1, (now - last) / 1000), still = calm.matches, b = button.getBoundingClientRect(); last = now
        if (!b.width || !button.isConnected) { host.style.visibility = 'hidden'; box = ''; return }
        const place = `${b.left}px,${b.bottom}px,${b.width}px`, fresh = sync()
        if (place !== box) { box = place; host.style.visibility = ''; host.style.left = `${b.left}px`; host.style.top = `${b.bottom}px`; host.style.width = `${b.width}px`; settled = false }
        if (settled && !fresh) return
        settled = true
        const snap = still || first, goal = rail ? MINI : 1, moving = (from, to, slack) => { if (Math.abs(from - to) > slack) settled = false }
        k = snap || Math.abs(k - goal) < 0.004 ? goal : ease(k, goal, 6, dt); moving(k, goal, 0)
        if (!still) t += dt
        const list = [...cells.values()], want = arrange(list.filter(c => !c.gone), b.width, k)
        const sign = button.querySelector('.thetwo-mark')?.getBoundingClientRect(), origin = sign ? { x: sign.left + sign.width / 2 - b.left, y: sign.top + sign.height / 2 - b.bottom } : { x: 22, y: -20 }
        for (const c of list) {
          const size = c.gone ? 0 : 1
          if (snap) { c.x = c.hx; c.y = c.hy; c.scale = size }
          else if (Number.isNaN(c.x)) { c.x = origin.x; c.y = origin.y }
          else { c.x = ease(c.x, c.hx, 7, dt); c.y = ease(c.y, c.hy, 7, dt); c.scale = ease(c.scale, size, 6, dt) }
          moving(c.x, c.hx, 0.05); moving(c.y, c.hy, 0.05); moving(c.scale, size, 0.004)
          if (c.gone && c.scale < 0.03) { c.g.remove(); cells.delete(c.peer.id) }
        }
        const drawn = [...cells.values()], words = Math.max(0, Math.min(1, (k - 0.7) / 0.3))
        for (const c of drawn) {
          const r = c.r * k * c.scale, d = blob(c.x, c.y, r, t, c.phase, still ? 0 : c.live, drawn.filter(o => o !== c).map(o => ({ x: o.x, y: o.y, r: o.r * k * o.scale })))
          c.body.setAttribute('d', d); c.membrane.setAttribute('d', d)
          // While this device is syncing its nucleus wanders, like a topic that is answering, and vesicles keep crossing.
          const roam = c.busy && !still
          c.due = roam ? (c.due ?? 0) - dt : 0
          if (roam && c.due <= 0) { c.due = 1.1; carry(c) }
          c.nx = ease(c.nx, roam ? 1.4 * Math.sin(t * 0.53 + c.phase) + 0.5 * Math.sin(t * 1.1 + c.phase * 2) : 0, 3, dt); c.ny = ease(c.ny, roam ? Math.sin(t * 0.41 + c.phase * 1.7) : 0, 3, dt)
          const lift = c.named ? 7 * words * c.scale : 0, hollow = c.kind === 'paused' || c.kind === 'wait'
          c.nucleus.setAttribute('cx', fix(c.x + c.nx * k)); c.nucleus.setAttribute('cy', fix(c.y - lift + c.ny * k)); c.nucleus.setAttribute('r', fix((hollow ? 2.6 : 2.2) * c.scale * Math.max(0.62, k)))
          c.text.setAttribute('x', fix(c.x)); c.text.setAttribute('y', fix(c.y + 7 * c.scale)); c.text.setAttribute('font-size', fix(10.5 * c.scale)); c.text.style.opacity = fix(words * c.scale)
          if (c.lit) { c.lit = Math.max(0, c.lit - dt); c.g.classList.toggle('lit', c.lit > 0); settled = false }
          if ((c.live || Math.abs(c.nx) + Math.abs(c.ny) > 0.02) && !still) settled = false
        }
        for (const v of [...vesicles]) {
          v.at += dt / 0.9
          const u = Math.min(1, v.at), s = v.back ? 1 - u * u * (3 - 2 * u) : u * u * (3 - 2 * u), gone = u >= 1 || !cells.has(v.c.peer.id)
          v.node.setAttribute('transform', `translate(${fix(origin.x + (v.c.x - origin.x) * s)} ${fix(origin.y + (v.c.y - origin.y) * s)}) scale(${fix(Math.max(0.5, k))})`); v.node.style.opacity = fix(Math.min(1, 4 * u, 4 * (1 - u)))
          if (gone) { v.node.remove(); vesicles.splice(vesicles.indexOf(v), 1); if (!v.back) v.c.lit = 0.5 }
          settled = false
        }
        height = snap || Math.abs(height - want) < 0.3 ? want : ease(height, want, 8, dt); moving(height, want, 0)
        // The rows below the card make room for the cells.
        const room = height < 1 ? '' : `${(rail ? height + 4 : Math.max(18, height + 6)).toFixed(1)}px`
        if (room !== margin) { margin = room; button.style.marginBottom = room; host.style.height = `${height.toFixed(1)}px` }
        if (read().status) first = false
      })
      return {
        setRail(on) { rail = on; settled = false; host.classList.toggle('rail', on) },
        destroy() { cancelAnimationFrame(frame); host.remove(); tip.remove(); button.style.marginBottom = '' },
      }
    }
    const connected =status => !!status?.settings.values.syncEnabled && status.peers.some(peer => peer.online && !peer.paused)
    const motion = status => !connected(status) ? 'idle' : status.syncing ? 'syncing' : 'linked'
    const wordmark = () => h('span', { className: 'thetwo-wordmark', translate: 'no' }, h('span', null, 'The'), h('b', null, 'Two', h('i', { 'aria-hidden': true })))
    const icon = (type, size = 18) => {
      const paths = {
        device: 'M3 4h18v12H3zM8 21h8m-4-5v5',
        settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6',
        back: 'M19 12H5m5-5-5 5 5 5',
        search: 'M21 21l-5-5M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15',
        refresh: 'M20 8a8.5 8.5 0 0 0-14-4L3 7m0-5v5h5M4 16a8.5 8.5 0 0 0 14 4l3-3m0 5v-5h-5',
        chat: 'M4 3h16v14H9l-5 4zM8 7h8m-8 5h5',
        shield: 'm12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5zM8 11l3 3 5-6',
      }
      return h('svg', { className: 'thetwo-icon', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: paths[type] }))
    }
    const button = (label, onClick, options = {}) => h('button', { type: 'button', onClick, ...options }, label)
    const sameValues = (a, b) => !!a && !!b && ['deviceName', 'syncEnabled', 'discoverable', 'intervalSeconds'].every(key => a[key] === b[key])
    const time = stamp => stamp ? new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

    function apply(ctx) {
      let view = { status: null, library: null, error: null, info: null, connectionError: null, busy: null, menu: null }
      let disposed = false, refreshing = null, lastLibraryAt = 0
      const subscribers = new Set(), controller = new AbortController()
      const update = patch => { if (!disposed) { view = { ...view, ...patch }; subscribers.forEach(fn => fn()) } }
      const useView = () => useSyncExternalStore(fn => { subscribers.add(fn); return () => subscribers.delete(fn) }, () => view)
      const openSettings = peerId => { update({ menu: null, settingsPeer: typeof peerId === 'string' ? peerId : null }); ctx.layout.selectPanel(settingsPanelId) }
      async function api(path, input) {
        const response = await fetch(`/api/thetwo/${path}`, {
          signal: controller.signal, cache: 'no-store',
          ...(input ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-thetwo': '1' }, body: JSON.stringify(input) } : {}),
        })
        let body
        try { body = await response.json() }
        catch { throw new Error(response.status === 404 ? 'TheTwo 正在加载，请稍候…' : '暂时无法读取 TheTwo 响应，稍后会自动重试。') }
        if (!response.ok || !body.ok) throw new Error(body.error || '暂时无法连接 TheTwo')
        return body.value
      }
      function refresh(force = false) {
        if (disposed) return Promise.resolve()
        if (refreshing) return force ? refreshing.then(() => refresh(true)) : refreshing
        refreshing = (async () => {
          try {
            const status = await api('status'); update({ status })
            if (force || Date.now() - lastLibraryAt > 5000) {
              const library = await api('library'); lastLibraryAt = Date.now(); update({ library })
            }
            update({ connectionError: null })
          } catch (e) { if (!disposed) update({ connectionError: e.message }) }
          finally { refreshing = null }
        })()
        return refreshing
      }
      async function act(action, fields = {}) {
        if (view.busy) return
        update({ busy: `${action}:${fields.id ?? ''}`, error: null, info: null })
        try { const value = await api('action', { action, ...fields }); await refresh(true); return value }
        catch (e) { if (!disposed) update({ error: e.message }) }
        finally { update({ busy: null }) }
      }
      async function openSession(id, unarchive = false) {
        try {
          const target = await act('open', { id })
          if (!target) return
          if (target.archived && !unarchive) throw new Error('此会话已归档，请选择「取消归档并打开」。')
          if (target.archived) await ctx.workspaces.unarchiveSession(target.id)
          await ctx.sessions.refresh(); ctx.uiWorkspace.openSession(target.id)
        }
        catch (e) { update({ error: e.message }) }
      }
      function ErrorNotice() {
        const state = useView(), error = state.error ?? state.connectionError
        return error && h('div', { className: 'thetwo-notice thetwo-error', role: 'alert' }, h('span', null, error), button('关闭', () => update({ error: null, connectionError: null }), { className: 'thetwo-quiet' }))
      }
      function InfoNotice() {
        const { info } = useView()
        return info && h('div', { className: 'thetwo-notice thetwo-info', role: 'status' }, h('span', null, info), button('知道了', () => update({ info: null }), { className: 'thetwo-quiet' }))
      }

      function RequestDialog() {
        const { status, busy } = useView(), request = status?.requests[0], box = useRef(null)
        useEffect(() => {
          if (!request) return
          const previous = document.activeElement; box.current?.querySelector('button')?.focus()
          return () => previous?.focus?.()
        }, [request?.id])
        if (!request) return null
        return h('div', { className: 'thetwo thetwo-overlay' }, h('div', {
          className: 'thetwo-dialog', ref: box, role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'thetwo-pair-title',
          onKeyDown: e => {
            if (e.key === 'Escape' && !busy) void act('decline', { id: request.id })
            if (e.key === 'Tab') {
              const nodes = [...box.current.querySelectorAll('button:not(:disabled)')]
              if (!nodes.length) { e.preventDefault(); return }
              if ((e.shiftKey && document.activeElement === nodes[0]) || (!e.shiftKey && document.activeElement === nodes.at(-1))) { e.preventDefault(); nodes[e.shiftKey ? nodes.length - 1 : 0].focus() }
            }
          },
        }, h('div', { className: 'thetwo-dialog-brand' }, mark(32), wordmark()),
          h('h2', { id: 'thetwo-pair-title' }, `与「${request.name}」同步会话？`),
          h('p', null, '允许后，共享会话会保存在本机，连通时自动同步。'),
          h('div', { className: 'thetwo-pair-detail' }, icon('device', 16), h('span', null, request.url)),
          h('small', null, 'API 密钥和插件共享默认关闭，可在此设备的设置中选择。'), h(ErrorNotice),
          h('div', { className: 'thetwo-actions' }, button('暂不', () => act('decline', { id: request.id }), { disabled: !!busy }), button('允许同步', () => act('allow', { id: request.id }), { className: 'thetwo-primary', disabled: !!busy }))))
      }
      function ContextMenu() {
        const { menu } = useView(), element = useRef(null)
        useEffect(() => {
          if (!menu) return
          const close = e => { if (!element.current?.contains(e.target)) update({ menu: null }) }
          const key = e => { if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); update({ menu: null }); menu.trigger?.focus() } }
          const dismiss = () => update({ menu: null })
          document.addEventListener('pointerdown', close, true); document.addEventListener('keydown', key, true)
          window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss)
          element.current?.querySelector('button:not(:disabled)')?.focus()
          return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss) }
        }, [menu])
        return menu && h('div', { ref: element, className: 'thetwo thetwo-context-menu', role: 'menu', 'aria-label': menu.title ?? 'TheTwo', style: { left: menu.x, top: menu.y } },
          menu.title && h('div', { className: 'thetwo-menu-head' }, h('strong', null, menu.title), h('small', null, menu.note)),
          ...(menu.items ?? [[h(React.Fragment, null, icon('settings', 16), '设置'), openSettings]]).map(([label, run, disabled], i) => button(label, () => { update({ menu: null }); run() }, { key: i, role: 'menuitem', disabled: !!disabled })))
      }
      function SidebarEntry({ size }) {
        const marker = useRef(null), { status } = useView(), wide = size === 16
        useEffect(() => {
          const target = marker.current?.closest('button'); if (!target) return
          const show = (x, y) => update({ menu: { trigger: target, x: Math.max(8, Math.min(x, window.innerWidth - 180)), y: Math.max(8, Math.min(y, window.innerHeight - 64)) } })
          const context = e => { e.preventDefault(); e.stopPropagation(); show(e.clientX, e.clientY) }
          const key = e => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const bounds = target.getBoundingClientRect(); show(bounds.left, bounds.bottom) } }
          target.addEventListener('contextmenu', context); target.addEventListener('keydown', key)
          return () => { target.removeEventListener('contextmenu', context); target.removeEventListener('keydown', key) }
        }, [wide])
        // The device cells hang under the card. Pressing one shows its name, what it is doing and what can be done with it.
        const cluster = useRef(null)
        useEffect(() => {
          const target = marker.current?.closest('button'); if (!target) return
          const mounted = cluster.current = mountCluster({ button: target, rail: !wide, read: () => view, pick: ({ g, peer, discovered, label }, box) => {
            const enabled = view.status?.settings.values.syncEnabled !== false
            update({ menu: { trigger: g, title: peer.name, note: label, x: Math.max(8, Math.min(box.left, window.innerWidth - 232)), y: Math.max(8, Math.min(box.bottom + 6, window.innerHeight - 150)),
              items: discovered ? [[peer.requested ? '已发送' : '同步', () => act('pair', { id: peer.id }), peer.requested]]
                : [[h(React.Fragment, null, icon('settings', 16), '设备设置'), () => openSettings(peer.id)], [peer.paused ? '继续同步' : '暂停同步', () => act('pause', { id: peer.id, paused: !peer.paused }), !enabled]] } })
          } })
          return () => { mounted.destroy(); cluster.current = null }
        }, [])
        useEffect(() => { cluster.current?.setRail(!wide) }, [wide])
        return h('span', { ref: marker, className: 'thetwo-nav', 'data-wide': wide, translate: 'no' },
          h('span', { className: 'thetwo-symbol-wrap' }, mark(24, motion(status))), wide && h('span', { className: 'thetwo-entry-copy' },
            h('span', { className: 'thetwo-entry-title' }, wordmark(), h('span', { className: 'thetwo-entry-label' }, '会话同步')),
            h('span', { className: 'thetwo-entry-sub' }, '同一份会话')))
      }
      function PeerCard({ peer, discovered, busy, enabled, syncing }) {
        const { state, cell, label } = peerState(peer, discovered, enabled, syncing)
        return h('div', { className: 'thetwo-device', 'data-state': state, 'data-discovered': !!discovered },
          h('div', { className: 'thetwo-device-icon' }, cellGlyph(cell)),
          h('div', { className: 'thetwo-grow' }, h('strong', { title: peer.name }, peer.name), h('p', { className: 'thetwo-device-status' }, h('i', { className: 'thetwo-status-dot', 'data-state': state }), label,
            cell === 'synced' && peer.lastSync && h('span', null, ` · ${time(peer.lastSync)} 检查`),
            peer.route && peer.route !== 'lan' && h('span', null, ` · ${{ inbound: '由对方连入', overlay: `经组网地址 ${peer.via}`, forward: `经本机转发 ${peer.via}` }[peer.route]}`)),
            peer.hardware && h('small', null, [peer.hardware.cpu || peer.hardware.arch, `${peer.hardware.cores} 线程`, `${peer.hardware.memoryGiB} GiB`, peer.hardware.gpu].filter(Boolean).join(' · ')),
            peer.error && peer.error !== 'sync paused' && h('small', { title: peer.error }, peer.error),
            peer.blocked && !['sync paused', 'not paired'].includes(peer.blocked) && h('small', { title: peer.blocked }, peer.blocked),
            peer.blocked === 'not paired' && !peer.requested && h('small', null, '对方可能已解除配对，或上次配对没有完成。重新配对会保留这台设备的名称和设置。'),
            peer.blocked === 'not paired' && !peer.requested && button('重新配对', () => act('pair', { id: peer.id }), { disabled: !!busy }),
            peer.environment?.keyError && h('small', null, peer.environment.keyError),
            peer.environment?.pluginError && h('small', null, peer.environment.pluginError),
            peer.environment?.apiKeys && h('small', null, `本轮 API 密钥：补入 ${peer.environment.apiKeys.added} 项，保留本机 ${peer.environment.apiKeys.kept} 项`),
            !!peer.environment?.plugins?.length && h('details', { className: 'thetwo-disclosure' }, h('summary', null, '对端共享的插件'),
              ...peer.environment.plugins.map(row => h('p', { key: row.spec }, `${row.spec} · ${row.status === 'missing' ? '本机缺少' : row.status === 'version-differs' ? `保留本机 ${row.localVersion}` : '已安装'}`)),
              peer.environment.plugins.some(row => row.status === 'missing') && button('安装缺少的插件', () => act('install-plugins', { id: peer.id, specs: peer.environment.plugins.filter(row => row.status === 'missing').map(row => row.spec) }), { disabled: !!busy || !enabled || peer.paused })),
            ...(peer.pluginInstallResults ?? []).map(row => h('small', { key: row.spec }, `${row.spec}：${({ applied: '已安装', 'restart-required': '已安装，需要重启 DSH', kept: '保留已有版本', failed: '安装失败，请在 DSH 插件管理中查看', cancelled: '已取消', overridden: '被本机配置覆盖' })[row.application] ?? row.application}`)),
            !!peer.issues?.length && h('details', { className: 'thetwo-disclosure' }, h('summary', null, `${peer.issues.length} 项传输待重试`), ...peer.issues.map((row, i) => h('p', { key: i }, `${row.id}：${row.reason}`)))),
          discovered ? button(peer.requested ? '已发送' : '同步', () => act('pair', { id: peer.id }), { className: 'thetwo-primary', disabled: !!busy || peer.requested }) :
            button(h(React.Fragment, null, icon('settings', 16), '设置'), () => openSettings(peer.id), { className: 'thetwo-device-settings thetwo-quiet', 'aria-label': `${peer.name} 的设备设置` }))
      }
      function TaskHandoffs({ rows, busy }) {
        if (!rows?.length) return null
        return h('section', { className: 'thetwo-section' }, h('div', { className: 'thetwo-section-heading' }, h('h2', null, '任务交接')),
          ...[...rows].reverse().map(row => {
            const incoming = row.direction === 'in', pending = row.state === 'waiting' || row.state === 'submitting'
            const state = row.state === 'submitted' ? '已提交给 DSH' : row.state === 'declined' ? '已谢绝'
              : row.confirmed ? '已确认，等待接手' : incoming ? '待本机接手' : '等待确认'
            return h('div', { className: 'thetwo-notice thetwo-info thetwo-task', key: row.id }, h('div', { className: 'thetwo-grow' },
              h('strong', null, `${incoming ? '来自' : '交给'}「${row.name}」 · ${state}`), h('p', null, row.task),
              row.error && h('small', { className: 'thetwo-error' }, row.error)),
              h('div', { className: 'thetwo-actions' },
                incoming && pending && button('在本机执行', () => act('handoff-run', { id: row.id }), { disabled: !!busy, className: 'thetwo-primary' }),
                incoming && row.state === 'waiting' && button('谢绝', () => act('handoff-decline', { id: row.id }), { disabled: !!busy }),
                !incoming && pending && row.canConfirm && !row.confirmed && button(`在「${row.name}」执行`, () => act('handoff-confirm', { id: row.id }), { disabled: !!busy, className: 'thetwo-primary' }),
                row.state === 'submitted' && button('查看会话', () => openSession(row.session), { disabled: !!busy })))
          }))
      }
      function ManualAddress() {
        const { status, busy } = useView(), [address, setAddress] = useState('')
        const find = async () => {
          const found = await act('probe', { address }); if (!found) return
          const paired = view.status?.peers.some(peer => peer.id === found.id)
          update({ info: paired ? `已找到「${found.name}」，正在用这个地址连接。之后会记住它。` : `已找到「${found.name}」，在上方点「同步」即可配对。` })
        }
        return h('details', { className: 'thetwo-disclosure' }, h('summary', null, '找不到设备？'),
          h('p', null, '确认另一台电脑已开启 TheTwo。不同 Wi-Fi 需要网络互通，也可以直接输入对方的局域网地址。'),
          h('p', null, '通过 Tailscale 等组网工具或端口转发连接时，输入对方在隧道里的地址，例如 100.x.x.x:48792 或 127.0.0.1:转发端口。只要有一端能连到另一端就可以，在能连过去的那一端输入。'),
          h('form', { onSubmit: e => { e.preventDefault(); void find() } },
            h('input', { value: address, onInput: e => setAddress(e.target.value), placeholder: '192.168.1.20:48792', 'aria-label': '另一台电脑的局域网地址' }),
            button('查找', undefined, { type: 'submit', disabled: !!busy || !address.trim() })),
          h('small', null, `本机端口 ${status?.self.port ?? '…'} · 请允许 DSH 通过专用网络防火墙。`))
      }
      function Panel() {
        const { status, library, busy } = useView(), [query, setQuery] = useState('')
        const enabled = status?.settings.values.syncEnabled !== false
        const pending = new Set(status?.library.pending.map(s => s.id) ?? [])
        const rows = (library?.sessions ?? []).filter(s => s.title.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt)
        return h('main', { className: 'thetwo thetwo-page', translate: 'no' }, h('div', { className: 'thetwo-page-inner' },
          h('header', { className: 'thetwo-header' }, h('div', { className: 'thetwo-heading' }, h('div', null,
            h('h1', null, '会话同步'),
            h('p', null, '同一份会话'))),
            button(h(React.Fragment, null, icon('settings', 16), '设置'), openSettings, { className: 'thetwo-icon-button thetwo-quiet', 'aria-label': 'TheTwo 设置' })),
          h(ErrorNotice), h(InfoNotice),
          // Allowed here, but this computer cannot reach the device that asked (a one-way tunnel, its firewall): it collects the answer itself.
          ...(status?.approved ?? []).map(row => h('div', { className: 'thetwo-notice thetwo-info', key: row.id, role: 'status' }, h('div', null, h('strong', null, `已允许「${row.name}」`),
            h('p', null, '这台电脑连不到对方，正在等对方取回确认，通常只需几秒。')), button('取消', () => act('decline', { id: row.id }), { disabled: !!busy }))),
          status?.lastError && h('p', { className: 'thetwo-error' }, status.lastError),
          status?.library.lastPendingError && h('p', { className: 'thetwo-error' }, `待应用记录：${status.library.lastPendingError}`),
          !enabled && h('div', { className: 'thetwo-notice' }, h('div', null, h('strong', null, '自动同步已暂停'), h('p', null, '本机会话仍可使用，已配对设备会保留。')), button('前往设置', openSettings)),
          h('section', { className: 'thetwo-section' }, h('div', { className: 'thetwo-section-heading' }, h('h2', null, '连接设备'),
            h('span', { className: 'thetwo-local' }, icon('device', 14), h('span', null, `本机 · ${status?.self.name ?? '正在读取'}`))),
            !status ? h('p', { className: 'thetwo-empty' }, '正在连接 TheTwo…') : h(React.Fragment, null,
              !!status.peers.length && h('div', { className: 'thetwo-device-grid' }, ...status.peers.map(peer => h(PeerCard, { key: peer.id, peer, busy, enabled, syncing: status.syncing }))),
              !!status.devices.length && h('div', { className: 'thetwo-nearby' },
                h('h3', null, '附近的设备', h('span', { className: 'thetwo-count' }, status.devices.length)),
                h('div', { className: 'thetwo-device-grid' }, ...status.devices.map(peer => h(PeerCard, { key: peer.id, peer, discovered: true, busy, enabled })))),
              !status.peers.length && !status.devices.length && h('div', { className: 'thetwo-device-empty' },
                h('div', { className: 'thetwo-empty-symbol' }, mark(32)), h('div', null,
                  h('strong', null, status.settings.values.discoverable ? '连接设备' : '自动发现已关闭'),
                  h('p', null, status.settings.values.discoverable ? '在设备上开启 TheTwo，找到后点一下「同步」。' : '在设置中开启自动发现，或通过局域网地址连接。'),
                  h('small', null, '首次连接由对方确认，之后连通时自动同步。'))),
              status.discoveryError && h('p', { className: 'thetwo-error' }, '自动发现暂不可用，可使用下方地址连接。')),
            h(ManualAddress)),
          h(TaskHandoffs, { rows: status?.handoffs, busy }),
          !!pending.size && h('div', { className: 'thetwo-notice' }, h('div', null, h('strong', null, `${pending.size} 条会话等待应用更新`),
            h('p', null, '收到的记录已保存。点「打开最新」即可接着聊，无需重启；旧标签页保留原记录。'))),
          ...(status?.library.conflicts ?? []).map(c => h('div', { className: 'thetwo-notice', key: c.id }, h('div', { className: 'thetwo-grow' },
            h('strong', null, c.title), h('p', null, `不同设备分别续写，已保留 ${c.copyCount ?? 1} 份对端副本。这条会话已暂停合并。`)),
            button('查看其他版本', async () => { const result = await act('recover', { id: c.id }); if (result?.ids[0]) await openSession(result.ids[0]) }, { disabled: !!busy }))),
          h('section', { className: 'thetwo-section' }, h('div', { className: 'thetwo-section-heading' },
            h('h2', null, '会话库', h('span', { className: 'thetwo-count' }, library?.sessions.length ?? 0)),
            h('div', { className: 'thetwo-library-tools' },
              h('label', { className: 'thetwo-search' }, icon('search', 15), h('input', { type: 'search', value: query, onInput: e => setQuery(e.target.value), placeholder: '搜索会话', 'aria-label': '搜索会话' })),
              button(h(React.Fragment, null, icon('refresh', 15), status?.syncing ? '正在检查' : '检查更新'), () => act('sync'), { className: 'thetwo-icon-button thetwo-quiet', disabled: !!busy || status?.syncing || !enabled }))),
            rows.length ? h('ul', { className: 'thetwo-list' }, ...rows.map(row => h('li', { className: 'thetwo-conversation', key: row.id },
              h('span', { className: 'thetwo-conversation-icon' }, icon('chat', 19)),
              h('div', { className: 'thetwo-grow' }, h('strong', { title: row.title }, row.title), h('small', null, row.archived ? '本机已归档' : pending.has(row.id) ? '更新待应用' : row.conflict ? '不同版本已保留' : new Date(row.updatedAt).toLocaleString())),
              button(row.archived ? '取消归档并打开' : pending.has(row.id) ? '打开最新' : '打开', () => openSession(row.id, row.archived), { className: 'thetwo-open', 'aria-label': `${row.archived ? '取消归档并打开' : '打开会话'}：${row.title}`, disabled: !!busy })))) : h('div', { className: 'thetwo-empty' },
                icon(query ? 'search' : 'chat', 24), h('p', null, query ? '没有匹配的会话' : '聊过的事，在这里接着聊'),
                h('small', null, query ? '换一个关键词试试。' : '完整回复结束后，可同步的会话会出现在这里。')),
            !!library?.waiting.length && h('details', { className: 'thetwo-disclosure' }, h('summary', null, `${library.waiting.length} 条会话暂未同步`), ...library.waiting.map(s => h('p', { key: s.id }, `${s.id.slice(-12)}：${s.reason === 'unfinished turn' ? '正在回复，完成后再同步' : s.reason}`)))),
          h('footer', { className: 'thetwo-page-footer' }, h('span', null, icon('shield', 14), '会话与附件同步 · 每台设备独立设置'), h('span', { className: 'thetwo-release' }, `TheTwo · ${version}`))))
      }
      function PeerSettings({ peer }) {
        const { busy, settingsPeer, status } = useView(), element = useRef(null), snapshot = peer.settings?.values ? peer.settings : { revision: 0, values: { deviceName: '', syncApiKeys: false, syncPlugins: false } }
        const [base, setBase] = useState(snapshot), [draft, setDraft] = useState(snapshot.values), [message, setMessage] = useState('')
        const dirty = ['deviceName', 'syncApiKeys', 'syncPlugins', 'acceptConfirmedTasks'].some(key => base.values[key] !== draft[key])
        useEffect(() => { if (!dirty) { setBase(snapshot); setDraft({ ...snapshot.values }) } }, [snapshot.revision])
        useEffect(() => {
          if (settingsPeer !== peer.id || !element.current) return
          element.current.open = true
          element.current.querySelector('summary')?.focus({ preventScroll: true })
          element.current.scrollIntoView?.({ block: 'nearest' })
          update({ settingsPeer: null })
        }, [settingsPeer, peer.id])
        const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setMessage('') }
        const row = (title, help, control, className = '') => h('div', { className: `thetwo-settings-row ${className}`, key: title }, h('dt', null, h('strong', null, title), h('p', null, help)), h('dd', null, control))
        const toggle = (key, label) => button(h('span', { className: 'thetwo-switch-thumb' }), () => change(key, !draft[key]), { role: 'switch', className: 'thetwo-switch', 'aria-checked': !!draft[key], 'aria-label': label, disabled: !!busy })
        const reset = () => { setBase(snapshot); setDraft({ ...snapshot.values }); setMessage(''); update({ error: null }) }
        async function save(e) {
          e.preventDefault(); if (!dirty || busy) return
          setMessage('')
          const result = await act('peer-settings', { id: peer.id, values: draft, revision: base.revision })
          if (result) { setBase(result); setDraft({ ...result.values }); setMessage('此设备设置已保存。') }
        }
        const enabled = status?.settings.values.syncEnabled !== false, state = !enabled || peer.paused ? '已暂停' : peer.online ? '已连接' : '离线'
        return h('details', { ref: element, className: 'thetwo-peer-settings', 'data-peer-id': peer.id },
          h('summary', null, h('span', { className: 'thetwo-peer-icon' }, cellGlyph(peerState(peer, false, enabled, status?.syncing).cell, 32)), h('span', { className: 'thetwo-peer-name' }, peer.name),
            h('small', { className: 'thetwo-peer-state' }, h('i', { className: 'thetwo-status-dot', 'data-state': state === '已连接' ? 'online' : 'idle' }), state), h('i', { className: 'thetwo-chevron', 'aria-hidden': true })),
          h('form', { onSubmit: save }, h('dl', null,
            row('设备名称', '仅在本机显示；留空使用设备原名。', h('input', { 'aria-label': '设备名称', placeholder: peer.remoteName, value: draft.deviceName, maxLength: 64, disabled: !!busy, onInput: e => change('deviceName', e.target.value) }), 'thetwo-name-row'),
            row('会话与附件', enabled ? '完整回复结束后自动同步。' : '本机自动同步已关闭，可在下方重新开启。', button(peer.paused ? '继续同步' : '暂停同步', () => act('pause', { id: peer.id, paused: !peer.paused }), { disabled: !!busy || !enabled })),
            row('允许对方确认任务', '开启后，你可以在这台配对设备上确认单项交接，由本机 DSH 接手。关闭时逐项在本机接手。', toggle('acceptConfirmedTasks', '允许对方确认任务'))),
            h('h3', { className: 'thetwo-options-title' }, '可选同步'), h('dl', null,
            row('同步 API 密钥', '默认关闭。双方针对彼此开启后，只补入缺失的模型密钥。', toggle('syncApiKeys', '同步 API 密钥')),
            row('共享插件列表', '默认关闭。双方针对彼此开启后查看插件；安装仍由本机选择。', toggle('syncPlugins', '共享插件列表'))),
            (dirty || message || base.revision !== snapshot.revision) && h('div', { className: 'thetwo-peer-footer' },
              h('p', { role: 'status', className: 'thetwo-peer-message' }, message || (base.revision !== snapshot.revision ? '此设备设置已在另一处更新，请重新载入。' : '有尚未保存的修改')),
              h('div', { className: 'thetwo-actions' }, button(base.revision !== snapshot.revision ? '重新载入' : '恢复修改', reset, { disabled: !!busy || (!dirty && base.revision === snapshot.revision) }),
                button('保存设备设置', undefined, { type: 'submit', className: 'thetwo-primary', disabled: !!busy || !dirty })))),
          h('details', { className: 'thetwo-disclosure thetwo-connection-options' }, h('summary', null, '连接管理'),
            h('div', { className: 'thetwo-disconnect' }, h('p', null, '解除配对后停止与此设备同步，已保存的会话仍保留。'), button('解除配对', () => act('forget', { id: peer.id }), { disabled: !!busy, className: 'thetwo-quiet' }))))
      }
      function SettingsPanel({ close } = {}) {
        const { status, busy, error } = useView(), snapshot = status?.settings
        const [base, setBase] = useState(snapshot), [draft, setDraft] = useState(snapshot?.values), [message, setMessage] = useState('')
        const dirty = !!base && !!draft && !sameValues(base.values, draft)
        useEffect(() => { if (snapshot && (!base || !dirty)) { setBase(snapshot); setDraft({ ...snapshot.values }) } }, [snapshot?.revision])
        const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setMessage('') }
        const toggle = (key, label) => button(h('span', { className: 'thetwo-switch-thumb' }), () => change(key, !draft[key]),
          { role: 'switch', className: 'thetwo-switch', 'aria-checked': !!draft[key], 'aria-label': label, disabled: !!busy })
        const row = (title, help, control, className = '') => h('div', { className: `thetwo-settings-row ${className}`, key: title },
          h('dt', null, h('strong', null, title), help && h('p', null, help)), h('dd', null, control))
        const group = (title, children) => h('section', { className: 'thetwo-settings-group' }, h('h2', null, title), h('dl', null, ...children))
        async function save(e) {
          e.preventDefault(); if (!dirty || busy) return
          setMessage('')
          const result = await act('settings', { values: draft, revision: base.revision })
          if (result) { setBase(result); setDraft({ ...result.values }); setMessage('已保存，即刻生效。') }
        }
        return h('section', { className: 'thetwo thetwo-settings', translate: 'no', 'aria-label': 'TheTwo 设置' },
          h('div', { className: 'thetwo-settings-intro' }, h('div', { className: 'thetwo-brand' }, mark(28), wordmark()), h('span', { className: 'thetwo-badge' }, version)),
          h('p', { className: 'thetwo-settings-lead' }, '同一份会话'),
          status && h('section', { className: 'thetwo-settings-group' }, h('h2', null, '已连接设备'),
            status.peers.length ? status.peers.map(peer => h(PeerSettings, { key: peer.id, peer })) : h('p', { className: 'thetwo-peer-message' }, '连接设备后，可在这里分别命名和设置同步内容。')),
          !draft ? h('p', { role: 'status' }, '正在读取设置…') : h('form', { onSubmit: save },
            group('本机与连接', [row('本机设备名称', '附近的设备会看到这个名称。', h('input', { 'aria-label': '本机设备名称', value: draft.deviceName, onInput: e => change('deviceName', e.target.value), maxLength: 64, required: true, disabled: !!busy }), 'thetwo-name-row'),
              row('自动同步', '关闭后暂停收发会话，保留现有配对。', toggle('syncEnabled', '自动同步')),
              row('自动发现', '在可互通的局域网内发现彼此，无需输入配对码。', toggle('discoverable', '自动发现'))]),
            h('details', { className: 'thetwo-settings-group thetwo-advanced' }, h('summary', null, h('h2', null, '高级')), h('dl', null,
              row('检查间隔', '连通时自动检查是否有新会话。', h('select', { 'aria-label': '检查间隔', value: draft.intervalSeconds, disabled: !!busy, onChange: e => change('intervalSeconds', Number(e.target.value)) }, ...[5, 10, 30, 60].map(value => h('option', { key: value, value }, `${value} 秒`)))),
              row('连接端口', '自动发现不可用时，可通过局域网地址连接。', h('span', { className: 'thetwo-setting-value' }, status.self.port)),
              row('已打开的会话', '收到更新后可打开最新记录继续。旧标签页保留原记录；分别续写时保留各个版本。', h('span', { className: 'thetwo-setting-value' }, '无需重启')))),
            error && h('p', { className: 'thetwo-error', role: 'alert' }, error),
            (dirty || message || base.revision !== snapshot.revision) && h('footer', { className: 'thetwo-settings-footer' }, h('p', { role: 'status' }, message || (base.revision !== snapshot.revision ? '设置已在另一处更新，请重新载入。' : '有尚未保存的修改')),
              button(base.revision !== snapshot.revision ? '重新载入' : '恢复修改', () => { setBase(snapshot); setDraft({ ...snapshot.values }); setMessage(''); update({ error: null }) }, { disabled: !!busy || (!dirty && base.revision === snapshot.revision) }),
              button(busy?.startsWith('settings:') ? '保存中…' : '保存设置', undefined, { type: 'submit', className: 'thetwo-primary', disabled: !!busy || !dirty }))))
      }
      function SettingsPage() {
        return h('main', { className: 'thetwo thetwo-page' }, h('div', { className: 'thetwo-settings-page' },
          h('header', { className: 'thetwo-settings-page-header' }, h('h1', { className: 'thetwo-settings-title' }, '设置'),
            button(h(React.Fragment, null, icon('back', 17), '返回会话库'), () => ctx.layout.selectPanel(panelId), { className: 'thetwo-icon-button thetwo-back thetwo-quiet' })), h(SettingsPanel)))
      }
      const style = document.createElement('style'); style.textContent = css; document.head.append(style)
      const portal = document.createElement('div'); document.body.append(portal)
      const root = createRoot(portal); root.render(h(React.Fragment, null, h(RequestDialog), h(ContextMenu)))
      const timer = setInterval(() => { void refresh() }, 2500)
      ctx.effect(() => () => { disposed = true; controller.abort(); clearInterval(timer); root.unmount(); portal.remove(); style.remove(); subscribers.clear() }, 'thetwo.client')
      ctx.slots.inject('main', () => [ctx.slots.register({ name: 'main', key: panelId }, Panel), ctx.slots.register({ name: 'main', key: settingsPanelId }, SettingsPage)])
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: -997, label: () => 'TheTwo' }, SidebarEntry))
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: panelId, order: 1001, label: () => h('span', { className: 'thetwo-settings-nav' }, mark(18), 'TheTwo') }, SettingsPanel))
      void refresh(true)
    }

    // Share TheOne's palette and DSH primitives; keep a compact, device-first workspace.
    const css = `
.thetwo {
  --two-accent:#a75b1e; --two-tint:#fff5ec; --two-line:#eed3bb; --two-soft:#a75b1e14; --two-halo:#ff780018;
  --two-bg:var(--dsw-alias-bg-base,#fff);
  --two-text:var(--dsw-alias-label-primary,#18181b);
  --two-muted:var(--dsw-alias-label-secondary,#5c6370);
  --two-subtle:var(--dsw-alias-label-tertiary,var(--two-muted));
  --two-caption:var(--dsw-alias-label-caption,#818792);
  --two-border:var(--dsw-alias-border-l2,#0000001a);
  --two-edge:var(--dsw-alias-border-l3,#00000026);
  --two-card:var(--dsw-alias-settings-card-fill,var(--two-bg));
  --two-control:var(--dsw-alias-bg-module-platform,#f2f3f5);
  --two-hover:var(--dsw-alias-interactive-bg-hover,#2631480b);
  --two-warning:var(--dsw-alias-state-warning-primary,#946321);
  --two-error:var(--dsw-alias-state-error-primary,#c33f29);
  box-sizing:border-box;color:var(--two-text);font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:22px;
}
[data-ds-dark-theme] .thetwo {
  --two-accent:#93c8f3; --two-tint:#1d2a37; --two-line:#344d64; --two-soft:#93c8f31a; --two-halo:#80bae918;
  --two-bg:var(--dsw-alias-bg-base,#1b1b1d); --two-text:var(--dsw-alias-label-primary,#e8e8ea);
  --two-muted:var(--dsw-alias-label-secondary,#afb1b8); --two-subtle:var(--dsw-alias-label-tertiary,#999da7);
  --two-caption:var(--dsw-alias-label-caption,#9096a0); --two-border:var(--dsw-alias-border-l2,#ffffff1a);
  --two-edge:var(--dsw-alias-border-l3,#ffffff26); --two-control:var(--dsw-alias-bg-module-platform,#28282b);
  --two-hover:var(--dsw-alias-interactive-bg-hover,#ffffff09);
  --two-warning:var(--dsw-alias-state-warning-primary,#d4ab6a); --two-error:var(--dsw-alias-state-error-primary,#f39b89);
}
.thetwo *{box-sizing:border-box}
.thetwo p{margin:0;color:var(--two-muted)}
.thetwo small{display:block;font-size:12px;line-height:19px;color:var(--two-subtle)}
.thetwo strong{font-weight:500;overflow-wrap:anywhere}
.thetwo-mark,.thetwo-icon{display:block;flex:none;overflow:visible}
.thetwo-mark{color:var(--two-accent)}
.thetwo-wordmark{display:inline-flex;align-items:baseline;gap:1px;white-space:nowrap;color:var(--two-accent)}
.thetwo-wordmark>span{font-size:12px;line-height:18px;font-weight:400;letter-spacing:-.25px;color:var(--dsw-alias-label-secondary,#85858d)}
.thetwo-wordmark b{position:relative;font-family:ui-rounded,'SF Pro Rounded','Avenir Next',sans-serif;font-size:19px;line-height:1.15;font-weight:500;letter-spacing:-1px;transform:rotate(-4deg);padding-right:7px}
.thetwo-wordmark i{position:absolute;right:0;top:2px;width:4px;height:4px;border-radius:50%;corner-shape:round;background:currentColor}
.thetwo button,.thetwo input,.thetwo select{font:inherit;font-size:13px;line-height:20px;color:var(--two-text);height:36px;border:1px solid var(--two-border);border-radius:var(--dsw-radius-md,10px);padding:0 12px;background:transparent}
.thetwo button{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;cursor:pointer;transition:background 140ms ease,border-color 140ms ease,color 140ms ease}
.thetwo button:hover:not(:disabled),.thetwo select:hover:not(:disabled){background:var(--two-hover)}
.thetwo :is(button,input,select,summary):focus-visible{outline:2px solid var(--two-accent);outline-offset:3px}
.thetwo :is(button,input,select):disabled{opacity:.4;cursor:default}
.thetwo input{min-width:0}
.thetwo input::placeholder{color:var(--two-caption)}
.thetwo button.thetwo-primary{color:var(--two-accent);background:var(--two-tint);border-color:var(--two-line);font-weight:500}
.thetwo button.thetwo-primary:hover:not(:disabled){background:var(--two-tint);border-color:color-mix(in srgb,var(--two-accent) 40%,var(--two-line))}
.thetwo button.thetwo-quiet{background:transparent;border-color:transparent;color:var(--two-muted)}
.thetwo button.thetwo-quiet:hover:not(:disabled){background:var(--two-hover);color:var(--two-text)}
.thetwo-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.thetwo-grow{flex:1;min-width:0}
.thetwo-page{container:thetwo-page/inline-size;width:100%;height:100%;overflow:auto;scrollbar-gutter:stable;padding:0 clamp(20px,4vw,48px) 32px;background:var(--two-bg)}
.thetwo-page-inner{max-width:920px;margin:0 auto}
.thetwo-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:32px 0 24px;margin-bottom:28px;border-bottom:1px solid var(--two-border)}
.thetwo-heading{display:flex;align-items:flex-start;gap:12px;min-width:0}
.thetwo-header h1{margin:0;font-size:24px;line-height:32px;font-weight:500;letter-spacing:-.3px}
.thetwo-header p{margin-top:4px;font-size:13px;line-height:20px}
.thetwo-brand{display:flex;align-items:center;gap:10px;margin:0}
.thetwo-badge{display:inline-flex;align-items:center;font-size:11px;line-height:18px;padding:1px 7px;border:.5px solid var(--two-border);border-radius:6px;color:var(--two-subtle);font-weight:400;white-space:nowrap}
.thetwo-section{margin-bottom:36px}
.thetwo-section-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;min-height:32px;margin-bottom:12px}
.thetwo-section-heading h2{display:flex;align-items:center;gap:8px;font-size:15px;line-height:24px;font-weight:500;margin:0}
.thetwo-count{font-size:12px;font-weight:400;color:var(--two-caption);font-variant-numeric:tabular-nums}
.thetwo-local{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--two-subtle);max-width:65%;min-width:0}
.thetwo-local>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.thetwo-device-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.thetwo-nearby{margin-top:20px}
.thetwo-nearby>h3{display:flex;align-items:center;gap:8px;font-size:12px;line-height:20px;font-weight:400;color:var(--two-muted);margin:0 0 10px}
.thetwo-device{display:flex;align-items:center;gap:12px;min-width:0;padding:16px;border:1px solid var(--two-border);border-radius:var(--dsw-radius-lg,12px);background:var(--two-card)}
.thetwo-device[data-discovered=true]{background:var(--two-bg)}
.thetwo-device:focus-within{border-color:var(--two-line)}
.thetwo-device>.thetwo-grow>strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.thetwo-device>.thetwo-grow>small{overflow-wrap:anywhere}
.thetwo-device>.thetwo-primary,.thetwo-device>.thetwo-device-settings{flex:none;padding:0 10px}
.thetwo-device-icon{display:grid;place-items:center;flex:none;width:36px;height:36px}
.thetwo-device strong{font-size:14px;line-height:22px}
.thetwo-device-status{display:flex;align-items:center;gap:6px;font-size:12px;line-height:19px;margin-top:3px!important;flex-wrap:wrap}
.thetwo-device-status>span{font-variant-numeric:tabular-nums}
.thetwo-status-dot{flex:none;width:5px;height:5px;border-radius:50%;corner-shape:round;background:var(--two-caption)}
.thetwo-status-dot[data-state=online],.thetwo-status-dot[data-state=new]{background:var(--two-accent)}
.thetwo-status-dot[data-state=waiting]{background:var(--two-warning)}
.thetwo-device small{margin-top:4px}
.thetwo-device-empty{display:flex;align-items:center;gap:18px;border:.5px solid var(--two-line);border-radius:var(--dsw-radius-xl,20px);padding:24px;background:radial-gradient(ellipse at 0% 0%,var(--two-tint),var(--two-card) 85%);box-shadow:0 6px 32px -12px var(--two-halo)}
.thetwo-empty-symbol{display:grid;place-items:center;flex:none;width:48px;height:48px;border:.5px solid var(--two-line);border-radius:14px;background:var(--two-soft)}
.thetwo-device-empty strong{font-size:15px;line-height:24px}
.thetwo-device-empty p{margin-top:4px;font-size:13px;line-height:20px}
.thetwo-device-empty small{margin-top:8px}
.thetwo-disclosure{font-size:12px;line-height:20px;color:var(--two-subtle);margin-top:12px}
.thetwo-disclosure summary{cursor:pointer;width:fit-content;min-height:32px;padding:6px 0;border-radius:4px}
.thetwo-disclosure>p{margin:10px 0}
.thetwo-disclosure form{display:flex;gap:8px;margin:12px 0}
.thetwo-disclosure input{flex:1;max-width:360px}
.thetwo-library-tools{display:flex;align-items:center;gap:8px;max-width:100%;margin-left:auto}
.thetwo-search{display:flex;align-items:center;gap:8px;background:var(--two-control);border:1px solid transparent;border-radius:var(--dsw-radius-md,10px);height:36px;padding:0 12px;color:var(--two-muted);width:240px;min-width:100px;cursor:text}
.thetwo-search input{flex:1;width:100%;height:100%;min-height:0;background:transparent;padding:0;border:0;border-radius:0;box-shadow:none}
.thetwo-search input:focus-visible{outline:none}
.thetwo-search:focus-within{outline:2px solid var(--two-accent);outline-offset:2px}
.thetwo-list{list-style:none;margin:0;padding:0;border-top:.5px solid var(--two-border)}
.thetwo-conversation{display:flex;align-items:center;gap:14px;min-height:76px;padding:14px 12px;margin:0;border-bottom:1px solid var(--two-border);transition:background 140ms ease}
.thetwo-conversation:hover,.thetwo-conversation:focus-within{background:var(--two-hover)}
.thetwo-conversation-icon{display:grid;place-items:center;flex:none;width:32px;height:36px;color:var(--two-muted)}
.thetwo-conversation-icon .thetwo-icon{width:17px;height:17px}
.thetwo-conversation strong{display:block;font-size:14px;line-height:22px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.thetwo-conversation small{margin-top:3px;font-variant-numeric:tabular-nums}
.thetwo-conversation .thetwo-open{flex:none;min-width:60px;background:transparent;border-color:transparent;color:var(--two-muted)}
.thetwo-conversation:hover .thetwo-open,.thetwo-conversation:focus-within .thetwo-open{color:var(--two-accent);background:var(--two-soft)}
.thetwo-empty{display:flex;align-items:center;flex-direction:column;text-align:center;gap:6px;padding:44px 16px 48px;border-top:.5px solid var(--two-border)}
.thetwo-empty>.thetwo-icon{color:var(--two-caption);margin-bottom:8px}
.thetwo-empty p{font-size:14px;line-height:22px;color:var(--two-text)}
.thetwo-empty small{max-width:400px}
.thetwo-page-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 16px;padding:8px 0 0;font-size:12px;line-height:18px;color:var(--two-subtle)}
.thetwo-page-footer>span{display:inline-flex;align-items:center;gap:6px}
.thetwo-release{color:var(--two-caption)}
.thetwo-notice{display:flex;align-items:center;gap:16px;border:.5px solid color-mix(in srgb,var(--two-warning) 35%,transparent);border-radius:12px;background:color-mix(in srgb,var(--two-warning) 5%,transparent);padding:12px 16px;margin-bottom:20px}
.thetwo-notice p{font-size:12px;line-height:19px;margin-top:4px}
.thetwo-error{color:var(--two-error)!important}
.thetwo-notice.thetwo-info{justify-content:space-between;border-color:var(--two-line);background:var(--two-tint)}
.thetwo-notice.thetwo-error{justify-content:space-between;border-color:color-mix(in srgb,var(--two-error) 35%,transparent);background:color-mix(in srgb,var(--two-error) 5%,transparent)}
.thetwo-settings{container:thetwo-settings/inline-size;background:transparent;font-size:14px;line-height:22px}
.thetwo-settings-intro{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.thetwo-settings-lead{font-size:13px;line-height:20px;margin-bottom:28px!important;color:var(--two-muted)!important}
.thetwo-peer-settings{margin-top:12px;border:1px solid var(--two-border);border-radius:12px;background:var(--two-card);overflow:clip;scroll-margin-block:20px}
.thetwo-settings-page .thetwo-peer-settings{scroll-margin-top:104px}
.thetwo-peer-settings>summary{display:flex;align-items:center;gap:12px;min-height:68px;cursor:pointer;padding:14px 20px;font-weight:500;list-style:none;border-radius:11px}
.thetwo-peer-settings>summary::-webkit-details-marker{display:none}
.thetwo-peer-settings>summary:hover{background:var(--two-hover)}
.thetwo-peer-settings>summary:focus-visible{outline-offset:-3px}
.thetwo-peer-settings[open]>summary{border-bottom:1px solid var(--two-border);border-radius:11px 11px 0 0}
.thetwo-peer-icon{display:grid;place-items:center;flex:none;width:32px;height:32px}
.thetwo-peer-name{flex:1;min-width:0;overflow-wrap:anywhere}
.thetwo-peer-settings>summary .thetwo-peer-state{display:flex;align-items:center;gap:6px;flex:none;color:var(--two-muted);font-size:12px;font-weight:400}
.thetwo-chevron{width:6px;height:6px;margin:0 2px 0 6px;flex:none;border-right:1.5px solid var(--two-muted);border-bottom:1.5px solid var(--two-muted);transform:rotate(-45deg);transition:transform 150ms ease}
.thetwo-peer-settings[open]>summary .thetwo-chevron{transform:rotate(45deg) translate(-2px,-1px)}
.thetwo-peer-settings>form{padding:4px 20px 0}
.thetwo-peer-message{font-size:12px!important;line-height:20px!important;color:var(--two-muted)!important;margin:0!important}
.thetwo-peer-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px 0;border-top:1px solid var(--two-border)}
.thetwo-peer-footer>.thetwo-actions{margin-left:auto;justify-content:flex-end}
.thetwo-options-title{margin:0;padding:16px 0 0;border-top:1px solid var(--two-border);font-size:12px;line-height:20px;font-weight:500;color:var(--two-muted)}
.thetwo-connection-options{margin:0 20px;padding:8px 0;border-top:1px solid var(--two-border)}
.thetwo-disconnect{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 0}
.thetwo-disconnect>p{flex:1;min-width:0;line-height:20px}
.thetwo-disconnect>button{flex:none}
.thetwo-settings h2{margin:0 0 12px;font-size:14px;line-height:22px;font-weight:500;color:var(--two-text)}
.thetwo-settings-group{display:block;margin:0 0 28px}
.thetwo-settings-group>dl{border:1px solid var(--two-border);border-radius:12px;padding:0 20px;background:var(--two-card)}
.thetwo-settings dl,.thetwo-settings dt,.thetwo-settings dd{margin:0}
.thetwo-settings-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:24px;padding:18px 0;border-bottom:1px solid var(--two-border)}
.thetwo-settings-row:last-child{border-bottom:0}
.thetwo-settings-row>dt{min-width:0;display:flex;flex-direction:column;gap:4px}
.thetwo-settings-row>dd{min-width:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px;overflow-wrap:anywhere}
.thetwo-settings-row strong{font-size:14px;line-height:22px;font-weight:400}
.thetwo-settings-row p{font-size:13px;line-height:21px;color:var(--two-muted);max-width:54ch}
.thetwo-settings button,.thetwo-settings input,.thetwo-settings select{height:38px;padding:0 14px;border:1px solid var(--two-border);background:var(--two-control);font-size:13px;line-height:22px}
.thetwo-settings input{width:240px;max-width:100%;background:var(--two-bg)}
.thetwo-settings select{min-width:112px;cursor:pointer}
.thetwo-setting-value,.thetwo-setting-local{font-size:12px;color:var(--two-subtle)}
.thetwo-setting-local{display:inline-flex;align-items:center;gap:6px}
.thetwo-settings .thetwo-primary:not(:disabled){box-shadow:inset 0 0 0 .5px var(--two-line)}
.thetwo-settings .thetwo-switch{position:relative;flex:none;width:44px;height:40px;padding:0;display:flex;align-items:center;justify-content:flex-start;border:0;border-radius:10px;background:transparent}
.thetwo-settings .thetwo-switch:hover:not(:disabled){background:var(--two-hover)}
.thetwo-switch::before{content:'';position:absolute;left:2px;top:9px;width:40px;height:22px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3,#b8bec7);box-shadow:inset 0 0 0 1px var(--two-border)}
.thetwo-switch[aria-checked=true]::before{background:var(--dsw-alias-brand-primary,var(--two-accent))}
.thetwo-switch-thumb{position:relative;display:block;margin-left:4px;width:18px;height:18px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 3px #0002;transition:transform 120ms ease}
.thetwo-switch[aria-checked=true] .thetwo-switch-thumb{background:var(--dsw-alias-label-primary-foreground,#fff);transform:translateX(18px)}
.thetwo-advanced>summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;width:fit-content;min-height:36px;border-radius:4px}
.thetwo-advanced>summary h2{margin:0;color:var(--two-muted);font-size:13px}
.thetwo-advanced[open]>summary{margin-bottom:12px}
.thetwo-advanced>summary::-webkit-details-marker{display:none}
.thetwo-advanced>summary::before{content:'';width:5px;height:5px;margin:0 2px;border-right:1.5px solid var(--two-subtle);border-bottom:1.5px solid var(--two-subtle);transform:rotate(-45deg);transition:transform 150ms ease}
.thetwo-advanced[open]>summary::before{transform:rotate(45deg) translate(-2px,-1px)}
.thetwo-settings-footer{position:sticky;bottom:0;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:14px 0;border-top:1px solid var(--two-border);background:var(--dsw-alias-bg-layer-2,var(--two-bg));box-shadow:0 24px 0 var(--dsw-alias-bg-layer-2,var(--two-bg));z-index:2}
.thetwo-settings-footer p{flex:1;min-width:160px;font-size:12px;line-height:18px}
.thetwo-settings-page{max-width:920px;margin:0 auto}
.thetwo-settings-page-header{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:24px 0 20px;margin-bottom:24px;border-bottom:1px solid var(--two-border);background:var(--two-bg)}
.thetwo-settings-title{font-size:24px;line-height:32px;font-weight:500;margin:0}
.thetwo-back{padding-left:0!important}
.thetwo-settings-page .thetwo-settings-footer{background:var(--two-bg);box-shadow:0 24px 0 var(--two-bg)}

/* Match TheOne's entry silhouette and palette; TheTwo's mark is TheOne's cell budding a second one. */
button:has(.thetwo-nav){--two-accent:#a75b1e;--two-tint:#fff5ec;--two-line:#eed3bb;border:1px solid var(--two-line);background:var(--two-tint);box-shadow:0 0 22px 4px #ff6b0018,0 4px 32px 6px #ff760009;overflow:visible;border-radius:12px;flex:none;position:relative}
[data-ds-dark-theme] button:has(.thetwo-nav){--two-accent:#93c8f3;--two-tint:#1d2a37;--two-line:#344d64;box-shadow:0 0 22px 4px #80bae91a}
button:has(.thetwo-nav):hover,button[aria-current=page]:has(.thetwo-nav){background:var(--two-tint);border-color:color-mix(in srgb,var(--two-accent) 40%,var(--two-line))}
button:has(.thetwo-nav[data-wide=true]){padding:12px 10px;min-height:64px;margin-top:4px;margin-bottom:18px}
button:has(.thetwo-nav[data-wide=true])>span:not(:has(.thetwo-nav)){display:none}
button:has(.thetwo-nav[data-wide=true])>span:has(.thetwo-nav){flex:1;min-width:0}
.thetwo-nav{display:flex;align-items:center;gap:10px;color:var(--two-accent);font:inherit;width:100%}
.thetwo-nav .thetwo-mark{width:20px;height:20px}
.thetwo-nav[data-wide=true] .thetwo-symbol-wrap{margin:0 2px}
.thetwo-entry-copy{display:flex;flex-direction:column;min-width:0;gap:2px;text-align:left}
.thetwo-entry-title{display:flex;align-items:center;gap:7px}
.thetwo-entry-label{font-size:12px;line-height:18px;font-weight:400;white-space:nowrap}
.thetwo-entry-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#85858d)}
.thetwo-symbol-wrap{display:inline-flex;flex:none}
.thetwo-settings-nav{display:inline-flex;align-items:center;gap:8px;vertical-align:top}
.thetwo-settings-nav .thetwo-mark{color:inherit;display:block;width:16px;height:16px}
button:has(.thetwo-settings-nav)>svg:first-child{display:none}
.thetwo-overlay{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:16px;background:#0008}
.thetwo-dialog{width:min(440px,100%);max-height:calc(100dvh - 32px);overflow:auto;padding:22px 22px 18px;border:1px solid var(--two-border);border-radius:16px;background:var(--dsw-specific-sidebar-fill,var(--two-bg));box-shadow:0 16px 48px #0005}
.thetwo-dialog-brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.thetwo-dialog-brand .thetwo-mark{width:24px;height:24px}
.thetwo-dialog h2{font-size:17px;line-height:26px;font-weight:500;margin:0 0 10px;overflow-wrap:anywhere}
.thetwo-dialog p{font-size:13px;line-height:21px}
.thetwo-dialog .thetwo-actions{justify-content:flex-end;margin-top:22px}
.thetwo-dialog .thetwo-actions button{height:36px;padding:0 14px}
.thetwo-dialog .thetwo-notice{margin-top:12px;margin-bottom:0}
.thetwo-pair-detail{display:flex;align-items:center;gap:8px;margin:14px 0 10px;padding:10px 12px;border:.5px solid var(--two-border);border-radius:10px;color:var(--two-muted);font-size:12px;overflow-wrap:anywhere}
.thetwo-context-menu{position:fixed;z-index:10000;min-width:160px;padding:5px;border:.5px solid var(--two-edge);border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-specific-sidebar-fill,var(--two-bg)));box-shadow:0 8px 30px #0002;backdrop-filter:blur(24px) saturate(1.4)}
.thetwo-context-menu button{justify-content:flex-start;width:100%;padding:9px 14px;height:auto;border:0;border-radius:8px;background:transparent;text-align:left}
.thetwo-menu-head{display:flex;flex-direction:column;gap:2px;max-width:216px;padding:8px 14px 6px}
.thetwo-menu-head strong{font-size:13.5px;line-height:1.4;font-weight:600}
.thetwo-menu-head small{line-height:1.4;color:var(--two-muted)}

/* The device cells under the card, and the same cell on the page: TheOne's cell states and colours. */
.thetwo-foam,.thetwo{--foam-bg:transparent;--foam-tint:#fff5ec;--foam-accent:#a75b1e;--foam-line:#c99267;--foam-idle-line:#d8d3ca;--foam-idle-dot:#cdb8a3;--foam-queue-line:#c4c1b8;--foam-queue-ink:#9a988f;--foam-text:var(--dsw-alias-label-primary,#2b2b2b);--foam-muted:var(--dsw-alias-label-secondary,#8a8a86)}
[data-ds-dark-theme] :is(.thetwo-foam,.thetwo){--foam-tint:#1d2a37;--foam-accent:#93c8f3;--foam-line:#5d87ab;--foam-idle-line:#4a515a;--foam-idle-dot:#5a7086;--foam-queue-line:#4d555e;--foam-queue-ink:#7f8a94}
.thetwo-foam{position:fixed;left:0;top:0;width:0;height:0;z-index:20;pointer-events:none;font-family:var(--dsw-font-family,inherit);--foam-bg:var(--dsw-specific-sidebar-fill,#f7f7f5)}
[data-ds-dark-theme] .thetwo-foam{--foam-bg:var(--dsw-specific-sidebar-fill,#1f1f22)}
.thetwo-foam>svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.thetwo-glyph{display:block;overflow:visible}
.thetwo-cell{cursor:pointer;pointer-events:auto;outline:none}
.thetwo-glyph .thetwo-cell{cursor:inherit;pointer-events:none}
.thetwo-cell [data-part=body]{stroke:none;fill:var(--foam-bg);transition:fill .8s ease}
.thetwo-cell [data-part=membrane]{fill:none;stroke:var(--foam-idle-line);stroke-width:1.2;stroke-linejoin:round;stroke-linecap:round;transition:stroke .8s ease,stroke-width .4s ease}
.thetwo-cell [data-part=nucleus]{fill:var(--foam-idle-dot);transition:fill .6s ease,stroke .6s ease}
.thetwo-cell text{fill:var(--foam-muted);text-anchor:middle;dominant-baseline:middle;pointer-events:none;user-select:none;letter-spacing:.02em;transition:fill .6s ease}
.thetwo-cell:is(.synced,.syncing,.wait,.paused) [data-part=body]{fill:var(--foam-tint)}
.thetwo-cell.synced [data-part=membrane]{stroke:var(--foam-line);stroke-width:1.3}
.thetwo-cell:is(.synced,.syncing) [data-part=nucleus]{fill:var(--foam-accent)}
.thetwo-cell:is(.synced,.wait) text{fill:var(--foam-text)}
.thetwo-cell:is(.syncing,.wait) [data-part=membrane]{stroke:var(--foam-accent);stroke-width:1.4}
.thetwo-cell.syncing text{fill:var(--foam-accent)}
.thetwo-cell.wait [data-part=nucleus]{fill:transparent;stroke:var(--foam-accent);stroke-width:1.4}
.thetwo-cell.paused [data-part=membrane]{stroke:var(--foam-queue-line)}
.thetwo-cell.paused [data-part=nucleus]{fill:transparent;stroke:var(--foam-queue-ink);stroke-width:1}
.thetwo-cell.paused text{fill:var(--foam-queue-ink)}
.thetwo-cell.offer [data-part=membrane]{stroke:var(--foam-line);stroke-dasharray:1.2 3}
.thetwo-cell:is(.offer,.pending) [data-part=nucleus]{fill:var(--foam-accent)}
.thetwo-cell.pending [data-part=membrane]{stroke:var(--foam-accent);stroke-dasharray:2 3;animation:thetwo-foam-march 1s linear infinite}
@keyframes thetwo-foam-march{to{stroke-dashoffset:-10}}
.thetwo-foam .thetwo-cell:is(:hover,:focus-visible,.lit) [data-part=membrane]{stroke:var(--foam-accent);stroke-width:1.6;transition-duration:.15s}
.thetwo-foam .thetwo-cell:is(:hover,:focus-visible).offline [data-part=nucleus]{fill:var(--foam-accent);transition-duration:.15s}
.thetwo-foam .thetwo-cell:is(:hover,:focus-visible):is(.offline,.paused) text{fill:var(--foam-text);transition-duration:.15s}
.thetwo-vesicle{pointer-events:none}
.thetwo-vesicle [data-part=membrane]{fill:var(--foam-tint);stroke:var(--foam-accent);stroke-width:1.1}
.thetwo-vesicle [data-part=nucleus]{fill:var(--foam-accent)}
.thetwo-foam-tip{position:fixed;z-index:1000;padding:4px 8px;border-radius:7px;background:var(--dsw-alias-label-primary,#2e2d2a);color:var(--dsw-alias-bg-base,#f4f3ef);font-family:var(--dsw-font-family,inherit);font-size:11.5px;line-height:1.5;max-width:min(240px,calc(100vw - 16px));box-sizing:border-box;white-space:normal;overflow-wrap:anywhere;pointer-events:none;opacity:0;transform:translateY(-3px);transition:opacity .12s,transform .12s}
.thetwo-foam-tip.on{opacity:1;transform:none}
@container thetwo-settings (max-width:560px){
  .thetwo-settings-row{gap:16px;padding:16px 0}.thetwo-settings-row p{font-size:12px;line-height:20px}
  .thetwo-name-row{grid-template-columns:minmax(0,1fr);gap:10px}.thetwo-name-row>dd{align-items:stretch}.thetwo-name-row input{width:100%}
  .thetwo-peer-settings>summary{padding:14px 16px;gap:10px}.thetwo-peer-settings>form{padding-left:16px;padding-right:16px}
  .thetwo-settings-group>dl{padding:0 16px}.thetwo-connection-options{margin-left:16px;margin-right:16px}
  .thetwo-peer-footer{align-items:flex-start}.thetwo-peer-footer>.thetwo-peer-message{flex-basis:100%}
  .thetwo-disconnect{flex-wrap:wrap}.thetwo-disconnect>p{flex-basis:100%}.thetwo-disconnect>button{margin-left:auto}
}
.thetwo-task p{white-space:pre-wrap;overflow-wrap:anywhere}
@container thetwo-page (max-width:720px){
  .thetwo-device-grid{grid-template-columns:minmax(0,1fr)}
}
@container thetwo-page (max-width:600px){
  .thetwo-library-tools{width:100%;margin-left:0}.thetwo-search{flex:1;width:auto}
  .thetwo-device{padding:14px;gap:12px}.thetwo-local{max-width:100%}
  .thetwo-device-empty{padding:20px;gap:14px;align-items:flex-start}.thetwo-empty-symbol{width:40px;height:40px}
  .thetwo-notice{flex-wrap:wrap}.thetwo-page-footer{justify-content:flex-start}.thetwo-conversation{gap:10px;padding-left:0;padding-right:0}
  .thetwo-conversation-icon{width:24px}.thetwo-conversation:has(.thetwo-open[aria-label^="取消归档"]){flex-wrap:wrap}.thetwo-conversation .thetwo-open[aria-label^="取消归档"]{margin-left:auto}
}
@media(max-width:600px){.thetwo-page{padding-left:18px;padding-right:18px}.thetwo-header{padding-top:24px}.thetwo-header>.thetwo-icon-button{flex:none}.thetwo-header h1,.thetwo-settings-title{font-size:22px;line-height:30px}}
@media(pointer:coarse){.thetwo button,.thetwo summary{min-height:44px}.thetwo-settings .thetwo-switch{height:44px}.thetwo-switch::before{top:11px}}
@media(prefers-reduced-motion:reduce){.thetwo button,.thetwo-conversation,.thetwo-switch-thumb,.thetwo-chevron,.thetwo-advanced>summary::before,.thetwo-cell *,.thetwo-foam-tip{transition:none}.thetwo-cell.pending [data-part=membrane]{animation:none}}
`
    return { name: 'thetwo', inject: ['slots', 'layout', 'sessions', 'workspaces', 'uiWorkspace'], apply }
  },
})
