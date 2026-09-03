import {clamp, compareRounds, escapeHtml, normalizeRound} from '../utils.js'

const WORLD_WIDTH = 420
const VIEW_HEIGHT = 700
const PLAYER_WIDTH = 30
const PLAYER_HEIGHT = 38
const GRAVITY = 1_550
const JUMP_SPEED = 670
const MOVE_ACCELERATION = 1_300
const MAX_MOVE_SPEED = 260
const GOAL_HEIGHT = 1_500
const BROADCAST_INTERVAL = 80

export function mountGame(root, {session, addLog}) {
  let round = {version: 0, origin: 'seed'}
  let platforms = createPlatforms(session.roomId, round)
  let local = createLocalPlayer()
  let cameraY = 0
  let remoteStates = new Map()
  let finishers = new Map()
  let frameId = 0
  let lastFrameTime = performance.now()
  let lastBroadcastTime = 0
  let lastHudTime = 0
  let sendInFlight = false
  const heldKeys = new Set()
  const heldPointers = new Map()

  root.innerHTML = `
    <div class="hop-header">
      <div>
        <p class="eyebrow">Shared-sky platform race</p>
        <h1>Cloud Hop</h1>
        <p>Auto-bounce to the 1,500m beacon. Rivals are live WebRTC ghosts—not server replays.</p>
      </div>
      <button class="round-button" data-hop-round type="button">New sky</button>
    </div>

    <div class="hop-race-status" data-hop-status aria-live="polite">
      <div><span>Altitude</span><strong data-hop-height>0m</strong></div>
      <div><span>Best</span><strong data-hop-best>0m</strong></div>
      <div><span>Goal</span><strong>${GOAL_HEIGHT.toLocaleString()}m</strong></div>
      <div class="hop-progress"><i data-hop-progress></i></div>
    </div>

    <div class="hop-stage">
      <div class="hop-canvas-wrap">
        <canvas class="hop-canvas" data-hop-canvas aria-label="Cloud Hop game. Move left and right to land on platforms and climb."></canvas>
        <div class="hop-finish" data-hop-finish></div>
        <div class="hop-waiting" data-hop-waiting>Playing solo · share the room to add a rival</div>
      </div>
      <aside class="hop-leaderboard" aria-label="Height leaderboard">
        <div><span>Live race</span><b data-hop-player-count>1 player</b></div>
        <ol data-hop-leaders></ol>
        <p>Everyone runs the same room-seeded course. Physics stay local; positions and milestones are shared.</p>
      </aside>
    </div>

    <div class="hop-controls" aria-label="Movement controls">
      <button type="button" data-hop-direction="-1" aria-label="Move left"><span>←</span><small>Left / A</small></button>
      <div><strong>Steer in the air</strong><span>Hold a side · bouncing is automatic</span></div>
      <button type="button" data-hop-direction="1" aria-label="Move right"><span>→</span><small>Right / D</small></button>
    </div>
  `

  const canvas = root.querySelector('[data-hop-canvas]')
  const context = canvas.getContext('2d')
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = WORLD_WIDTH * pixelRatio
  canvas.height = VIEW_HEIGHT * pixelRatio
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

  const offGame = session.onGameEvent(({type, data, peerId}) => {
    if (type === 'hop-state') acceptRemoteState(data, peerId)
    if (type === 'hop-reset') acceptReset(data, peerId)
    if (type === 'hop-finish') acceptFinish(data, peerId)
    if (type === 'hop-snapshot') acceptSnapshot(data, peerId)
    if (type === 'hop-sync-request') sendSnapshot(peerId)
  })

  const offPeer = session.onPeerEvent(({type, peerId}) => {
    if (type === 'join') sendSnapshot(peerId)
    if (type === 'leave') renderHud()
  })

  const startNewRound = () => {
    const nextRound = {version: round.version + 1, origin: session.selfPlayer.id}
    applyRound(nextRound)
    session.sendGame('hop-reset', {round: nextRound})
    addLog({level: 'info', message: 'Started a new Cloud Hop sky'})
  }

  const handleKeyDown = event => {
    const direction = keyDirection(event.code)
    if (!direction || event.target instanceof HTMLInputElement) return
    event.preventDefault()
    heldKeys.add(direction)
  }

  const handleKeyUp = event => {
    const direction = keyDirection(event.code)
    if (!direction) return
    heldKeys.delete(direction)
  }

  const handlePointerDown = event => {
    event.preventDefault()
    const direction = Number(event.currentTarget.dataset.hopDirection)
    heldPointers.set(event.pointerId, direction)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handleCanvasPointerDown = event => {
    event.preventDefault()
    const bounds = canvas.getBoundingClientRect()
    const direction = event.clientX - bounds.left < bounds.width / 2 ? -1 : 1
    heldPointers.set(event.pointerId, direction)
    canvas.setPointerCapture?.(event.pointerId)
  }

  const releasePointer = event => heldPointers.delete(event.pointerId)
  const handleVisibility = () => {
    heldKeys.clear()
    heldPointers.clear()
    lastFrameTime = performance.now()
  }

  root.querySelector('[data-hop-round]').addEventListener('click', startNewRound)
  root.querySelectorAll('[data-hop-direction]').forEach(button => {
    button.addEventListener('pointerdown', handlePointerDown)
  })
  canvas.addEventListener('pointerdown', handleCanvasPointerDown)
  window.addEventListener('pointerup', releasePointer)
  window.addEventListener('pointercancel', releasePointer)
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  document.addEventListener('visibilitychange', handleVisibility)

  session.sendGame('hop-sync-request', {})
  renderHud()
  frameId = requestAnimationFrame(tick)

  function tick(now) {
    const deltaTime = Math.min((now - lastFrameTime) / 1000, 0.033)
    lastFrameTime = now
    updatePhysics(deltaTime)
    drawScene(now)

    if (now - lastBroadcastTime >= BROADCAST_INTERVAL) {
      lastBroadcastTime = now
      broadcastState()
    }
    if (now - lastHudTime >= 100) {
      lastHudTime = now
      renderHud()
    }
    frameId = requestAnimationFrame(tick)
  }

  function updatePhysics(deltaTime) {
    const direction = inputDirection()
    if (direction) {
      local.vx += direction * MOVE_ACCELERATION * deltaTime
    } else {
      local.vx *= Math.pow(0.035, deltaTime)
    }
    local.vx = clamp(local.vx, -MAX_MOVE_SPEED, MAX_MOVE_SPEED)

    const previousY = local.y
    local.vy -= GRAVITY * deltaTime
    local.x += local.vx * deltaTime
    local.y += local.vy * deltaTime

    if (local.x + PLAYER_WIDTH < 0) local.x = WORLD_WIDTH
    if (local.x > WORLD_WIDTH) local.x = -PLAYER_WIDTH

    if (local.vy <= 0) {
      const landing = platforms
        .filter(platform =>
          previousY >= platform.y &&
          local.y <= platform.y &&
          local.x + PLAYER_WIDTH - 4 > platform.x &&
          local.x + 4 < platform.x + platform.width
        )
        .sort((a, b) => b.y - a.y)[0]
      if (landing) {
        local.y = landing.y
        local.vy = JUMP_SPEED
      }
    }

    local.best = Math.max(local.best, local.y)
    cameraY = Math.max(cameraY, local.y - VIEW_HEIGHT * 0.44)

    if (local.y < cameraY - 90) respawn()
    if (local.best >= GOAL_HEIGHT && !finishers.has(session.selfPlayer.id)) {
      const finish = {round, finishedAt: Date.now(), height: local.best}
      finishers.set(session.selfPlayer.id, finish)
      session.sendGame('hop-finish', finish)
      addLog({level: 'success', message: 'You reached the Cloud Hop beacon'})
      renderHud()
    }
  }

  function respawn() {
    const safeTop = cameraY + VIEW_HEIGHT * 0.34
    const platform = platforms
      .filter(candidate => candidate.y <= safeTop && candidate.y >= cameraY - 25)
      .sort((a, b) => b.y - a.y)[0] ?? platforms[0]
    local.x = platform.x + platform.width / 2 - PLAYER_WIDTH / 2
    local.y = platform.y + 3
    local.vx = 0
    local.vy = JUMP_SPEED
    local.falls += 1
  }

  function inputDirection() {
    let direction = 0
    for (const key of heldKeys) direction += key
    for (const pointer of heldPointers.values()) direction += pointer
    return Math.sign(direction)
  }

  function broadcastState() {
    if (sendInFlight || document.hidden) return
    sendInFlight = true
    Promise.resolve(session.sendGame('hop-state', serializeLocal(), undefined, {frequent: true}))
      .finally(() => { sendInFlight = false })
  }

  function serializeLocal() {
    return {
      round,
      x: roundNumber(local.x),
      y: roundNumber(local.y),
      vx: roundNumber(local.vx),
      vy: roundNumber(local.vy),
      best: roundNumber(local.best),
      falls: local.falls
    }
  }

  function acceptRemoteState(state, peerId) {
    if (!isRemoteState(state) || compareRounds(normalizeRound(state.round), round) !== 0) return
    const previous = remoteStates.get(peerId)
    remoteStates.set(peerId, {
      ...state,
      drawX: previous?.drawX ?? state.x,
      drawY: previous?.drawY ?? state.y,
      updatedAt: performance.now()
    })
  }

  function acceptReset(payload, peerId) {
    const incomingRound = normalizeRound(payload?.round)
    if (compareRounds(incomingRound, round) <= 0) return
    applyRound(incomingRound)
    const player = session.getPlayers().get(peerId)
    addLog({level: 'info', message: `${player?.name ?? 'A peer'} opened a new sky`})
  }

  function acceptFinish(data, peerId) {
    if (!isFinish(data) || compareRounds(normalizeRound(data.round), round) !== 0) return
    finishers.set(peerId, {...data, round: normalizeRound(data.round)})
    renderHud()
  }

  function acceptSnapshot(snapshot, peerId) {
    if (!snapshot || typeof snapshot !== 'object') return
    const incomingRound = normalizeRound(snapshot.round)
    const order = compareRounds(incomingRound, round)
    if (order < 0) return
    if (order > 0) applyRound(incomingRound)
    acceptRemoteState(snapshot.state, peerId)
    if (Array.isArray(snapshot.finishers)) {
      for (const [finisherId, finish] of snapshot.finishers) {
        if (typeof finisherId === 'string' && isFinish(finish)) {
          finishers.set(finisherId, {...finish, round: normalizeRound(finish.round)})
        }
      }
    }
  }

  function sendSnapshot(peerId) {
    session.sendGame('hop-snapshot', {
      round,
      state: serializeLocal(),
      finishers: [...finishers.entries()]
    }, peerId)
  }

  function applyRound(nextRound) {
    round = normalizeRound(nextRound)
    platforms = createPlatforms(session.roomId, round)
    local = createLocalPlayer()
    remoteStates = new Map()
    finishers = new Map()
    cameraY = 0
    lastFrameTime = performance.now()
    renderHud()
  }

  function renderHud() {
    if (!root.isConnected) return
    const connected = session.getConnectedPeerIds()
    const players = session.getPlayers()
    const height = Math.max(0, Math.floor(local.y))
    const best = Math.max(0, Math.floor(local.best))
    root.querySelector('[data-hop-height]').textContent = `${height.toLocaleString()}m`
    root.querySelector('[data-hop-best]').textContent = `${best.toLocaleString()}m`
    root.querySelector('[data-hop-progress]').style.width = `${clamp(local.best / GOAL_HEIGHT * 100, 0, 100)}%`
    root.querySelector('[data-hop-waiting]').classList.toggle('is-hidden', connected.size > 0)
    root.querySelector('[data-hop-player-count]').textContent = `${connected.size + 1} player${connected.size ? 's' : ''}`

    const standings = [...players.values()].map(player => {
      const isSelf = player.id === session.selfPlayer.id
      const bestHeight = isSelf ? local.best : remoteStates.get(player.id)?.best ?? 0
      return {player, bestHeight, isSelf, connected: isSelf || connected.has(player.id)}
    }).sort((a, b) => b.bestHeight - a.bestHeight || a.player.name.localeCompare(b.player.name))

    root.querySelector('[data-hop-leaders]').innerHTML = standings.map((entry, index) => `
      <li class="${entry.isSelf ? 'is-self' : ''} ${entry.connected ? '' : 'is-away'}">
        <span>${index + 1}</span>
        <i style="--player-color:${escapeHtml(entry.player.color)}"></i>
        <strong>${escapeHtml(entry.player.name)}${entry.isSelf ? ' <small>You</small>' : ''}</strong>
        <b>${Math.floor(entry.bestHeight).toLocaleString()}m</b>
      </li>
    `).join('')

    const winner = currentWinner()
    const finish = root.querySelector('[data-hop-finish]')
    finish.classList.toggle('is-visible', Boolean(winner))
    finish.innerHTML = winner
      ? `<span>Beacon reached</span><strong>${winner.id === session.selfPlayer.id ? 'You made it!' : `${escapeHtml(winner.name)} made it!`}</strong>`
      : ''
  }

  function currentWinner() {
    const first = [...finishers.entries()].sort(([, a], [, b]) =>
      a.finishedAt - b.finishedAt || String(a.peerId ?? '').localeCompare(String(b.peerId ?? ''))
    )[0]
    if (!first) return null
    return session.getPlayers().get(first[0]) ?? {id: first[0], name: 'A player'}
  }

  function drawScene(now) {
    context.save()
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    const sky = context.createLinearGradient(0, 0, 0, VIEW_HEIGHT)
    sky.addColorStop(0, '#5268b9')
    sky.addColorStop(0.55, '#283a78')
    sky.addColorStop(1, '#121a38')
    context.fillStyle = sky
    context.fillRect(0, 0, WORLD_WIDTH, VIEW_HEIGHT)

    drawAtmosphere(now)
    drawGoal()
    drawPlatforms()
    drawRemotePlayers(now)
    drawCharacter(local.x, toScreenY(local.y) - PLAYER_HEIGHT, session.selfPlayer, 1, true)
    context.restore()
  }

  function drawAtmosphere(now) {
    context.strokeStyle = 'rgba(255,255,255,.055)'
    context.lineWidth = 1
    for (let y = 0; y < VIEW_HEIGHT; y += 70) {
      context.beginPath()
      context.moveTo(0, y + ((-cameraY * 0.12) % 70))
      context.lineTo(WORLD_WIDTH, y + ((-cameraY * 0.12) % 70))
      context.stroke()
    }
    for (let index = 0; index < 7; index += 1) {
      const x = (index * 97 + Math.sin(now / 3400 + index) * 18) % (WORLD_WIDTH + 80) - 40
      const y = modulo(index * 137 - cameraY * 0.18, VIEW_HEIGHT + 120) - 60
      context.fillStyle = 'rgba(255,255,255,.075)'
      context.beginPath()
      context.ellipse(x, y, 30, 11, 0, 0, Math.PI * 2)
      context.ellipse(x + 23, y + 1, 23, 8, 0, 0, Math.PI * 2)
      context.fill()
    }
  }

  function drawGoal() {
    const screenY = toScreenY(GOAL_HEIGHT)
    if (screenY < -50 || screenY > VIEW_HEIGHT + 50) return
    context.save()
    context.setLineDash([8, 7])
    context.strokeStyle = '#f6bb5c'
    context.lineWidth = 3
    context.beginPath()
    context.moveTo(0, screenY)
    context.lineTo(WORLD_WIDTH, screenY)
    context.stroke()
    context.setLineDash([])
    context.fillStyle = '#f6bb5c'
    context.font = '700 11px ui-monospace, monospace'
    context.fillText('1,500M BEACON', 14, screenY - 10)
    context.restore()
  }

  function drawPlatforms() {
    for (const platform of platforms) {
      const y = toScreenY(platform.y)
      if (y < -18 || y > VIEW_HEIGHT + 18) continue
      context.fillStyle = platform.goal ? '#f6bb5c' : '#1b244a'
      roundedRect(context, platform.x, y, platform.width, 12, 6)
      context.fill()
      context.fillStyle = platform.goal ? '#ffe098' : '#c7f36b'
      roundedRect(context, platform.x, y, platform.width, 5, 3)
      context.fill()
    }
  }

  function drawRemotePlayers(now) {
    const players = session.getPlayers()
    for (const [peerId, state] of remoteStates) {
      const player = players.get(peerId)
      if (!player) continue
      state.drawX += wrappedDifference(state.drawX, state.x) * 0.22
      state.drawY += (state.y - state.drawY) * 0.22
      const screenY = toScreenY(state.drawY)
      const staleOpacity = now - state.updatedAt > 4_000 ? 0.28 : 0.68
      if (screenY < -PLAYER_HEIGHT || screenY > VIEW_HEIGHT + PLAYER_HEIGHT) {
        drawEdgeMarker(state, player, screenY < 0)
      } else {
        drawCharacter(state.drawX, screenY - PLAYER_HEIGHT, player, staleOpacity, false)
      }
    }
  }

  function drawCharacter(x, y, player, opacity, self) {
    context.save()
    context.globalAlpha = opacity
    context.translate(x, y)
    context.fillStyle = 'rgba(4,7,18,.24)'
    context.beginPath()
    context.ellipse(PLAYER_WIDTH / 2, PLAYER_HEIGHT + 5, 13, 4, 0, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = player.color
    roundedRect(context, 1, 3, PLAYER_WIDTH - 2, PLAYER_HEIGHT - 5, 11)
    context.fill()
    context.strokeStyle = self ? '#ffffff' : 'rgba(255,255,255,.55)'
    context.lineWidth = self ? 2.5 : 1.5
    context.stroke()
    context.fillStyle = '#11172e'
    roundedRect(context, 6, 10, 18, 10, 5)
    context.fill()
    context.fillStyle = '#ffffff'
    context.beginPath()
    context.arc(12, 15, 2.2, 0, Math.PI * 2)
    context.arc(19, 15, 2.2, 0, Math.PI * 2)
    context.fill()
    context.strokeStyle = player.color
    context.lineWidth = 3
    context.beginPath()
    context.moveTo(10, PLAYER_HEIGHT - 3)
    context.lineTo(7, PLAYER_HEIGHT + 3)
    context.moveTo(20, PLAYER_HEIGHT - 3)
    context.lineTo(23, PLAYER_HEIGHT + 3)
    context.stroke()
    context.fillStyle = 'rgba(9,13,31,.78)'
    context.font = '700 10px ui-sans-serif, system-ui'
    const label = self ? 'YOU' : player.name.slice(0, 12)
    const width = context.measureText(label).width + 10
    roundedRect(context, PLAYER_WIDTH / 2 - width / 2, -16, width, 13, 6)
    context.fill()
    context.fillStyle = '#ffffff'
    context.textAlign = 'center'
    context.fillText(label, PLAYER_WIDTH / 2, -6)
    context.restore()
  }

  function drawEdgeMarker(state, player, above) {
    const x = clamp(state.x + PLAYER_WIDTH / 2, 42, WORLD_WIDTH - 42)
    const y = above ? 24 : VIEW_HEIGHT - 24
    context.save()
    context.globalAlpha = 0.72
    context.fillStyle = player.color
    context.beginPath()
    context.moveTo(x, above ? 8 : VIEW_HEIGHT - 8)
    context.lineTo(x - 7, y)
    context.lineTo(x + 7, y)
    context.closePath()
    context.fill()
    context.fillStyle = '#f7f1df'
    context.font = '700 9px ui-monospace, monospace'
    context.textAlign = 'center'
    context.fillText(`${player.name.slice(0, 9)} · ${Math.floor(state.best)}m`, x, above ? 39 : VIEW_HEIGHT - 35)
    context.restore()
  }

  function toScreenY(worldY) {
    return VIEW_HEIGHT - (worldY - cameraY)
  }

  return {
    onSessionChange: renderHud,
    destroy() {
      cancelAnimationFrame(frameId)
      offGame()
      offPeer()
      window.removeEventListener('pointerup', releasePointer)
      window.removeEventListener('pointercancel', releasePointer)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }
}

function createLocalPlayer() {
  return {x: WORLD_WIDTH / 2 - PLAYER_WIDTH / 2, y: 24, vx: 0, vy: JUMP_SPEED, best: 24, falls: 0}
}

function createPlatforms(roomId, round) {
  const random = mulberry32(hashSeed(`${roomId}:${round.version}:${round.origin}`))
  const platforms = [{x: 110, y: 20, width: 200}]
  let y = 82
  let center = WORLD_WIDTH / 2
  while (y < GOAL_HEIGHT + VIEW_HEIGHT) {
    const width = 82 + random() * 52
    center = clamp(center + (random() - 0.5) * 190, width / 2 + 8, WORLD_WIDTH - width / 2 - 8)
    const isGoal = y >= GOAL_HEIGHT && platforms.every(platform => !platform.goal)
    platforms.push({
      x: isGoal ? 85 : center - width / 2,
      y: isGoal ? GOAL_HEIGHT : y,
      width: isGoal ? 250 : width,
      goal: isGoal
    })
    y += 70 + random() * 27
  }
  return platforms
}

function keyDirection(code) {
  if (code === 'ArrowLeft' || code === 'KeyA') return -1
  if (code === 'ArrowRight' || code === 'KeyD') return 1
  return 0
}

function isRemoteState(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    isFiniteNumber(value.x, -100, WORLD_WIDTH + 100) &&
    isFiniteNumber(value.y, -500, 100_000) &&
    isFiniteNumber(value.vx, -2_000, 2_000) &&
    isFiniteNumber(value.vy, -2_000, 2_000) &&
    isFiniteNumber(value.best, 0, 100_000) &&
    Number.isSafeInteger(value.falls) && value.falls >= 0 && value.falls < 1_000_000
  )
}

function isFinish(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isFinite(Number(value.finishedAt)) &&
    Number(value.finishedAt) > 0 &&
    isFiniteNumber(value.height, GOAL_HEIGHT, 100_000)
  )
}

function isFiniteNumber(value, minimum, maximum) {
  return Number.isFinite(value) && value >= minimum && value <= maximum
}

function roundNumber(value) {
  return Math.round(value * 10) / 10
}

function hashSeed(value) {
  let hash = 1779033703 ^ value.length
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353)
    hash = hash << 13 | hash >>> 19
  }
  return hash >>> 0
}

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = seed + 0x6D2B79F5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor
}

function wrappedDifference(from, to) {
  const direct = to - from
  if (Math.abs(direct) <= WORLD_WIDTH / 2) return direct
  return direct > 0 ? direct - WORLD_WIDTH : direct + WORLD_WIDTH
}

function roundedRect(context, x, y, width, height, radius) {
  const size = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + size, y)
  context.arcTo(x + width, y, x + width, y + height, size)
  context.arcTo(x + width, y + height, x, y + height, size)
  context.arcTo(x, y + height, x, y, size)
  context.arcTo(x, y, x + width, y, size)
  context.closePath()
}

