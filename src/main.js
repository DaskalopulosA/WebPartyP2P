import './styles.css'
import {connectPeerRoom} from './network.js'

const TARGET_SCORE = 25
const ROOM_PATTERN = /^[A-Z0-9]{4,8}$/
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const COLORS = ['#ff5c4d', '#c7f36b', '#6e8cff', '#f6bb5c', '#d78cff', '#54d6c5']
const NAME_FIRST = ['Neon', 'Turbo', 'Lucky', 'Cosmic', 'Disco', 'Pixel', 'Rapid', 'Velvet']
const NAME_LAST = ['Fox', 'Moth', 'Otter', 'Panda', 'Gecko', 'Raven', 'Tiger', 'Koala']

const app = document.querySelector('#app')
let network = null
let roomId = ''
let diagnostics = null
let connectedPeerIds = new Set()
let players = new Map()
let scores = new Map()
let logs = []
let round = {version: 0, origin: 'seed'}
let selfPlayer = null

const initialRoom = normalizeRoom(new URL(window.location.href).searchParams.get('room'))
renderLobby(initialRoom)

if (initialRoom) {
  startRoom(initialRoom, getSessionName())
}

function renderLobby(invitedRoom = '') {
  app.innerHTML = `
    <div class="app-shell lobby-shell">
      ${headerTemplate()}
      <main class="lobby-main">
        <section class="intro" aria-labelledby="page-title">
          <p class="eyebrow">Zero-server party trick</p>
          <h1 id="page-title">Race a friend.<br /><em>Skip the backend.</em></h1>
          <p class="lede">Open the same room in two browsers and race to ${TARGET_SCORE} taps. Every score travels directly between peers over WebRTC.</p>
        </section>

        <section class="room-card" aria-labelledby="room-heading">
          <div class="card-heading">
            <div>
              <p class="step-label">Step 01</p>
              <h2 id="room-heading">${invitedRoom ? `Join room ${escapeHtml(invitedRoom)}` : 'Meet in a room'}</h2>
            </div>
            <span class="tiny-note">No account needed</span>
          </div>

          <form class="join-form" id="join-form" novalidate>
            <label>
              <span>Your nickname</span>
              <input id="name-input" name="name" maxlength="20" autocomplete="nickname" value="${escapeHtml(getSessionName())}" />
            </label>
            <div class="room-code-field">
              <label>
                <span>Room code</span>
                <input id="room-input" name="room" maxlength="8" value="${escapeHtml(invitedRoom)}" placeholder="AB12CD" autocomplete="off" autocapitalize="characters" spellcheck="false" />
              </label>
              <button class="button button-secondary" type="submit">Join room <span aria-hidden="true">→</span></button>
            </div>
            <p class="form-error" id="form-error" role="alert"></p>
            <div class="or-row"><span>or start something new</span></div>
            <button class="button button-primary" id="create-room" type="button">Create a fresh room <span aria-hidden="true">＋</span></button>
          </form>
        </section>

        <section class="how-it-works" aria-label="How the proof works">
          <article><span>01</span><h3>Share a link</h3><p>The room code is carried in the URL.</p></article>
          <article><span>02</span><h3>Find peers</h3><p>Public Nostr relays exchange encrypted handshakes.</p></article>
          <article><span>03</span><h3>Play direct</h3><p>Game events use browser-to-browser WebRTC.</p></article>
        </section>
      </main>
      ${footerTemplate()}
    </div>
  `

  const form = document.querySelector('#join-form')
  const nameInput = document.querySelector('#name-input')
  const roomInput = document.querySelector('#room-input')
  const error = document.querySelector('#form-error')

  roomInput.addEventListener('input', () => {
    roomInput.value = normalizeRoom(roomInput.value)
    error.textContent = ''
  })

  form.addEventListener('submit', event => {
    event.preventDefault()
    const code = normalizeRoom(roomInput.value)
    if (!ROOM_PATTERN.test(code)) {
      error.textContent = 'Use a 4–8 character room code with letters and numbers.'
      roomInput.focus()
      return
    }
    startRoom(code, nameInput.value)
  })

  document.querySelector('#create-room').addEventListener('click', () => {
    startRoom(createRoomCode(), nameInput.value)
  })
}

function renderArena() {
  app.innerHTML = `
    <div class="app-shell arena-shell">
      ${headerTemplate()}
      <main class="arena-main">
        <section class="room-toolbar" aria-label="Room controls">
          <div>
            <span class="toolbar-label">Room</span>
            <strong id="room-code">${escapeHtml(roomId)}</strong>
          </div>
          <div class="toolbar-actions">
            <span class="connection-badge" id="connection-badge"><i></i><span>Finding peers</span></span>
            <button class="text-button" id="copy-link" type="button">Copy invite link</button>
            <button class="text-button muted" id="leave-room" type="button">Leave</button>
          </div>
        </section>

        <div class="game-layout">
          <section class="game-card" aria-labelledby="game-title">
            <div class="game-card-top">
              <div>
                <p class="eyebrow">Live P2P race</p>
                <h1 id="game-title">First to ${TARGET_SCORE}</h1>
              </div>
              <button class="round-button" id="new-round" type="button" title="Reset scores for everyone">New round</button>
            </div>

            <div class="winner-banner" id="winner-banner" aria-live="polite"></div>
            <div class="scoreboard" id="scoreboard"></div>

            <button class="smash-button" id="smash-button" type="button">
              <span class="smash-count" id="self-score">0</span>
              <span class="smash-label">Mash it</span>
              <span class="smash-hint">Click, tap, or press space</span>
            </button>
            <p class="game-note" id="game-note" aria-live="polite">Invite someone to this room, then start tapping.</p>
          </section>

          <aside class="debug-card" aria-labelledby="debug-title">
            <div class="debug-heading">
              <div><p class="step-label">Wire check</p><h2 id="debug-title">Connection details</h2></div>
              <button class="clear-button" id="clear-logs" type="button">Clear log</button>
            </div>
            <dl class="diagnostic-list" id="diagnostics"></dl>
            <div class="log-heading"><span>Event log</span><span>Newest first</span></div>
            <ol class="event-log" id="event-log" aria-live="polite"></ol>
          </aside>
        </div>

        <section class="proof-strip" aria-label="Network architecture">
          <div><span>Discovery</span><strong>Public Nostr relays</strong><small>Encrypted WebRTC handshakes only</small></div>
          <b aria-hidden="true">→</b>
          <div><span>Gameplay</span><strong>WebRTC DataChannels</strong><small>Direct, encrypted browser traffic</small></div>
          <b aria-hidden="true">→</b>
          <div><span>Hosting</span><strong>Static GitHub Pages</strong><small>No app server or database</small></div>
        </section>
      </main>
      ${footerTemplate()}
    </div>
  `

  document.querySelector('#smash-button').addEventListener('click', scorePoint)
  document.querySelector('#new-round').addEventListener('click', startNewRound)
  document.querySelector('#copy-link').addEventListener('click', copyInviteLink)
  document.querySelector('#clear-logs').addEventListener('click', () => {
    logs = []
    renderLogs()
  })
  document.querySelector('#leave-room').addEventListener('click', leaveRoom)
  window.addEventListener('keydown', handleGameKey)
  updateArena()
}

function startRoom(nextRoomId, enteredName) {
  if (network) return

  roomId = normalizeRoom(nextRoomId)
  const name = normalizeName(enteredName)
  sessionStorage.setItem('signal-sprint-name', name)
  const url = new URL(window.location.href)
  url.searchParams.set('room', roomId)
  history.replaceState(null, '', url)

  logs = []
  scores = new Map()
  players = new Map()
  connectedPeerIds = new Set()
  round = {version: 0, origin: 'seed'}
  diagnostics = null

  network = connectPeerRoom(roomId, {
    onLog: addLog,
    onDiagnostics(nextDiagnostics) {
      diagnostics = nextDiagnostics
      connectedPeerIds = new Set(nextDiagnostics.peerIds)
      updateArena()
    },
    onPeerJoin(peerId) {
      connectedPeerIds.add(peerId)
      network.send('presence', selfPlayer, peerId)
      network.send('snapshot', makeSnapshot(), peerId)
      updateArena()
    },
    onPeerLeave(peerId) {
      connectedPeerIds.delete(peerId)
      updateArena()
    },
    onEvent: receiveGameEvent,
    onError: updateArena
  })

  selfPlayer = makePlayer(network.peerId, name)
  players.set(network.peerId, selfPlayer)
  scores.set(network.peerId, 0)
  renderArena()
  network.send('presence', selfPlayer)
}

async function leaveRoom() {
  window.removeEventListener('keydown', handleGameKey)
  const currentNetwork = network
  network = null
  await currentNetwork?.leave()
  const url = new URL(window.location.href)
  url.searchParams.delete('room')
  history.replaceState(null, '', url)
  renderLobby()
}

function scorePoint() {
  if (!network || winner()) return
  const nextScore = (scores.get(network.peerId) ?? 0) + 1
  scores.set(network.peerId, nextScore)
  network.send('score', {round, player: selfPlayer, score: nextScore})
  updateArena()
}

function startNewRound() {
  if (!network) return
  round = {version: round.version + 1, origin: network.peerId}
  scores = new Map([...players.keys()].map(peerId => [peerId, 0]))
  network.send('reset', {round, player: selfPlayer})
  addLog({level: 'info', message: 'Started a new round'})
  updateArena()
}

function receiveGameEvent(event, peerId) {
  switch (event.type) {
    case 'presence':
      acceptPlayer(event.payload, peerId)
      connectedPeerIds.add(peerId)
      break
    case 'score':
      acceptScore(event.payload, peerId)
      break
    case 'reset':
      acceptReset(event.payload, peerId)
      break
    case 'snapshot':
      acceptSnapshot(event.payload)
      break
    default:
      addLog({level: 'warn', message: `Ignored unknown event “${event.type}”`})
  }
  updateArena()
}

function acceptPlayer(player, peerId) {
  if (!isPlayer(player) || player.id !== peerId) return
  players.set(peerId, {...player, name: normalizeName(player.name)})
  if (!scores.has(peerId)) scores.set(peerId, 0)
}

function acceptScore(payload, peerId) {
  if (!payload || !isPlayer(payload.player) || payload.player.id !== peerId) return
  const incomingRound = normalizeRound(payload.round)
  const order = compareRounds(incomingRound, round)
  if (order < 0) return
  if (order > 0) applyRound(incomingRound)

  const score = Number(payload.score)
  if (!Number.isSafeInteger(score) || score < 0 || score > 1_000_000) return
  acceptPlayer(payload.player, peerId)
  scores.set(peerId, Math.max(scores.get(peerId) ?? 0, score))
}

function acceptReset(payload, peerId) {
  if (!payload || !isPlayer(payload.player) || payload.player.id !== peerId) return
  const incomingRound = normalizeRound(payload.round)
  if (compareRounds(incomingRound, round) <= 0) return
  acceptPlayer(payload.player, peerId)
  applyRound(incomingRound)
  addLog({level: 'info', message: `${payload.player.name} started a new round`})
}

function acceptSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return
  const incomingRound = normalizeRound(snapshot.round)
  const order = compareRounds(incomingRound, round)
  if (order < 0) return
  if (order > 0) applyRound(incomingRound)

  if (Array.isArray(snapshot.players)) {
    for (const player of snapshot.players) {
      if (isPlayer(player)) players.set(player.id, {...player, name: normalizeName(player.name)})
    }
  }

  if (snapshot.scores && typeof snapshot.scores === 'object') {
    for (const [peerId, value] of Object.entries(snapshot.scores)) {
      const score = Number(value)
      if (Number.isSafeInteger(score) && score >= 0 && score <= 1_000_000) {
        scores.set(peerId, Math.max(scores.get(peerId) ?? 0, score))
      }
    }
  }
}

function applyRound(nextRound) {
  round = nextRound
  scores = new Map([...players.keys()].map(peerId => [peerId, 0]))
}

function makeSnapshot() {
  return {round, players: [...players.values()], scores: Object.fromEntries(scores)}
}

function updateArena() {
  if (!document.querySelector('.arena-shell') || !network) return
  const peerCount = diagnostics?.peerIds.length ?? 0
  const relays = diagnostics?.relays ?? []
  const openRelays = relays.filter(relay => relay.state === 'open').length
  const connectionBadge = document.querySelector('#connection-badge')
  const connectionLabel = peerCount > 0
    ? `${peerCount + 1} players connected`
    : openRelays > 0
      ? 'Ready · waiting for peers'
      : navigator.onLine
        ? 'Connecting to discovery'
        : 'Browser offline'

  connectionBadge.className = `connection-badge ${peerCount > 0 ? 'is-connected' : ''}`
  connectionBadge.querySelector('span').textContent = connectionLabel
  document.querySelector('#game-note').textContent = peerCount > 0
    ? 'Scores are moving directly over WebRTC. First to the line wins.'
    : 'Invite someone to this room, then start tapping.'

  const currentWinner = winner()
  const winnerBanner = document.querySelector('#winner-banner')
  winnerBanner.classList.toggle('is-visible', Boolean(currentWinner))
  winnerBanner.textContent = currentWinner
    ? `${currentWinner.id === network.peerId ? 'You win' : `${currentWinner.name} wins`} — new round?`
    : ''

  const sortedPlayers = [...players.values()].sort((a, b) => {
    const scoreDifference = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)
    return scoreDifference || a.name.localeCompare(b.name)
  })

  document.querySelector('#scoreboard').innerHTML = sortedPlayers.map(player => {
    const score = scores.get(player.id) ?? 0
    const isSelf = player.id === network.peerId
    const isConnected = isSelf || connectedPeerIds.has(player.id)
    return `
      <article class="player-row ${isSelf ? 'is-self' : ''}">
        <span class="player-avatar" style="--player-color:${escapeHtml(player.color)}">${escapeHtml(initials(player.name))}</span>
        <div class="player-meta">
          <strong>${escapeHtml(player.name)} ${isSelf ? '<small>You</small>' : ''}</strong>
          <span><i class="presence-dot ${isConnected ? 'online' : ''}"></i>${isConnected ? 'Connected' : 'Disconnected'} · ${escapeHtml(shortId(player.id))}</span>
        </div>
        <div class="player-progress"><i style="width:${Math.min(100, score / TARGET_SCORE * 100)}%;--player-color:${escapeHtml(player.color)}"></i></div>
        <b>${score}</b>
      </article>
    `
  }).join('')

  document.querySelector('#self-score').textContent = scores.get(network.peerId) ?? 0
  document.querySelector('#smash-button').disabled = Boolean(currentWinner)
  renderDiagnostics(openRelays, relays)
  renderLogs()
}

function renderDiagnostics(openRelays, relays) {
  const peerIds = diagnostics?.peerIds ?? []
  const relayText = relays.length ? `${openRelays}/${relays.length} open` : 'Connecting…'

  document.querySelector('#diagnostics').innerHTML = `
    <div><dt>Status</dt><dd><span class="status-value ${peerIds.length ? 'good' : ''}">${peerIds.length ? 'P2P connected' : 'Discovering'}</span></dd></div>
    <div><dt>Room ID</dt><dd>${escapeHtml(roomId)}</dd></div>
    <div><dt>My peer ID</dt><dd title="${escapeHtml(network.peerId)}">${escapeHtml(network.peerId)}</dd></div>
    <div><dt>Remote peers</dt><dd>${peerIds.length ? peerIds.map(escapeHtml).join('<br>') : 'None yet'}</dd></div>
    <div><dt>Nostr relays</dt><dd>${escapeHtml(relayText)} <small>from a public pool of ${diagnostics?.relayPoolSize ?? '—'}</small></dd></div>
    <div><dt>Game transport</dt><dd>${peerIds.length ? 'WebRTC DataChannel' : 'Pending'}</dd></div>
  `
}

function renderLogs() {
  const logElement = document.querySelector('#event-log')
  if (!logElement) return
  logElement.innerHTML = logs.length
    ? logs.map(entry => `
        <li class="log-${escapeHtml(entry.level)}">
          <time>${escapeHtml(entry.time)}</time>
          <span>${escapeHtml(entry.message)}</span>
        </li>
      `).join('')
    : '<li class="empty-log">No events yet.</li>'
}

function addLog({level = 'info', message, details}) {
  const detailText = details && typeof details === 'string' ? ` · ${details}` : ''
  logs.unshift({
    level,
    message: `${message}${detailText}`,
    time: new Date().toLocaleTimeString([], {hour12: false})
  })
  logs = logs.slice(0, 60)
  renderLogs()
}

function winner() {
  let winningPlayer = null
  let winningScore = -1
  for (const player of players.values()) {
    const score = scores.get(player.id) ?? 0
    if (score >= TARGET_SCORE && score > winningScore) {
      winningPlayer = player
      winningScore = score
    }
  }
  return winningPlayer
}

async function copyInviteLink() {
  const button = document.querySelector('#copy-link')
  try {
    await copyText(window.location.href)
    button.textContent = 'Link copied!'
  } catch {
    button.textContent = 'Could not copy'
  }
  window.setTimeout(() => {
    if (button.isConnected) button.textContent = 'Copy invite link'
  }, 1800)
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Copy command failed')
}

function handleGameKey(event) {
  if (event.code !== 'Space' || event.repeat) return
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return
  event.preventDefault()
  scorePoint()
}

function headerTemplate() {
  return `
    <header class="topbar">
      <a class="brand" href="./" aria-label="Signal Sprint home">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>Signal Sprint</span>
      </a>
      <div class="proof-pill"><span></span> Static site · live peers</div>
    </header>
  `
}

function footerTemplate() {
  return '<footer><span>Built to test the wire, not your reflexes.</span><span>WebRTC / Trystero</span></footer>'
}

function createRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map(byte => ROOM_CHARS[byte % ROOM_CHARS.length]).join('')
}

function getSessionName() {
  const savedName = sessionStorage.getItem('signal-sprint-name')
  if (savedName) return normalizeName(savedName)
  const bytes = crypto.getRandomValues(new Uint8Array(2))
  return `${NAME_FIRST[bytes[0] % NAME_FIRST.length]} ${NAME_LAST[bytes[1] % NAME_LAST.length]}`
}

function makePlayer(id, name) {
  return {id, name: normalizeName(name), color: COLORS[hashString(id) % COLORS.length]}
}

function normalizeRoom(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

function normalizeName(value) {
  const name = String(value ?? '').replace(/[<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 20)
  return name || 'Mystery Player'
}

function normalizeRound(value) {
  const version = Number(value?.version)
  const origin = typeof value?.origin === 'string' ? value.origin.slice(0, 24) : ''
  return {
    version: Number.isSafeInteger(version) && version >= 0 ? version : 0,
    origin: origin || 'seed'
  }
}

function compareRounds(a, b) {
  return a.version === b.version ? a.origin.localeCompare(b.origin) : a.version - b.version
}

function isPlayer(player) {
  return (
    player !== null &&
    typeof player === 'object' &&
    typeof player.id === 'string' &&
    player.id.length > 0 &&
    typeof player.name === 'string' &&
    typeof player.color === 'string' &&
    COLORS.includes(player.color)
  )
}

function hashString(value) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

function initials(name) {
  return name.split(' ').slice(0, 2).map(part => part[0]).join('').toUpperCase()
}

function shortId(id) {
  return `${id.slice(0, 5)}…${id.slice(-4)}`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}
