import './styles.css'
import {games, findGame} from './games/catalog.js'
import {createPartySession} from './session.js'
import {escapeHtml, normalizeName, shortId} from './utils.js'

const ROOM_PATTERN = /^[A-Z0-9]{4,8}$/
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const NAME_FIRST = ['Neon', 'Turbo', 'Lucky', 'Cosmic', 'Disco', 'Pixel', 'Rapid', 'Velvet']
const NAME_LAST = ['Fox', 'Moth', 'Otter', 'Panda', 'Gecko', 'Raven', 'Tiger', 'Koala']

const app = document.querySelector('#app')
let selectedGame = findGame(new URL(window.location.href).searchParams.get('game'))
let session = null
let activeGame = null
let roomId = ''
let logs = []
let loadVersion = 0

const initialRoom = normalizeRoom(new URL(window.location.href).searchParams.get('room'))
renderLobby(initialRoom)
if (initialRoom) startRoom(initialRoom, getSessionName())

function renderLobby(invitedRoom = '') {
  app.innerHTML = `
    <div class="app-shell lobby-shell">
      ${headerTemplate()}
      <main class="lobby-main">
        <section class="intro" aria-labelledby="page-title">
          <p class="eyebrow">Zero-server game shelf</p>
          <h1 id="page-title">Pick a game.<br /><em>Skip the backend.</em></h1>
          <p class="lede">Choose a minigame, share one room link, and play directly between browsers over WebRTC.</p>
        </section>

        <section class="room-card" aria-labelledby="room-heading">
          <div class="card-heading">
            <div>
              <p class="step-label">Room setup</p>
              <h2 id="room-heading">${invitedRoom ? `Join ${escapeHtml(invitedRoom)} in ${escapeHtml(selectedGame.title)}` : `Play ${escapeHtml(selectedGame.title)}`}</h2>
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
            <button class="button button-primary" id="create-room" type="button">Create a ${escapeHtml(selectedGame.title)} room <span aria-hidden="true">＋</span></button>
          </form>
        </section>

        <section class="game-picker" aria-labelledby="game-picker-title">
          <div class="shelf-heading">
            <div><p class="step-label">Game shelf</p><h2 id="game-picker-title">Choose your experiment</h2></div>
            <span class="tiny-note">Two games · one room layer</span>
          </div>
          <div class="game-grid">
            ${games.map(gameCardTemplate).join('')}
          </div>
        </section>

        <section class="how-it-works" aria-label="How peer-to-peer play works">
          <article><span>01</span><h3>Share a link</h3><p>The game and room code travel together in the URL.</p></article>
          <article><span>02</span><h3>Find peers</h3><p>Public Nostr relays exchange encrypted handshakes.</p></article>
          <article><span>03</span><h3>Play direct</h3><p>Minigame events use browser-to-browser WebRTC.</p></article>
        </section>
      </main>
      ${footerTemplate()}
    </div>
  `

  const form = document.querySelector('#join-form')
  const nameInput = document.querySelector('#name-input')
  const roomInput = document.querySelector('#room-input')
  const error = document.querySelector('#form-error')

  document.querySelectorAll('[data-game-id]').forEach(button => {
    button.addEventListener('click', () => {
      selectedGame = findGame(button.dataset.gameId)
      const url = new URL(window.location.href)
      url.searchParams.set('game', selectedGame.id)
      history.replaceState(null, '', url)
      renderLobby(invitedRoom)
    })
  })

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

function gameCardTemplate(game) {
  const isSelected = game.id === selectedGame.id
  return `
    <button class="game-choice ${isSelected ? 'is-selected' : ''}" type="button" data-game-id="${escapeHtml(game.id)}" style="--game-accent:var(--${escapeHtml(game.accent)})">
      <span class="game-choice-art" aria-hidden="true">${escapeHtml(game.glyph)}</span>
      <span class="game-choice-copy">
        <span class="game-choice-meta"><span>${escapeHtml(game.kicker)}</span><b>${escapeHtml(game.badge)}</b></span>
        <strong>${escapeHtml(game.title)}</strong>
        <small>${escapeHtml(game.description)}</small>
        <em>${escapeHtml(game.controls)}</em>
      </span>
      <i aria-hidden="true">${isSelected ? 'Selected' : 'Choose'} →</i>
    </button>
  `
}

async function startRoom(nextRoomId, enteredName) {
  if (session) return
  roomId = normalizeRoom(nextRoomId)
  const name = normalizeName(enteredName)
  sessionStorage.setItem('webparty-player-name', name)
  const url = new URL(window.location.href)
  url.searchParams.set('game', selectedGame.id)
  url.searchParams.set('room', roomId)
  history.replaceState(null, '', url)

  logs = []
  renderArena()
  const thisLoad = ++loadVersion
  session = createPartySession({
    roomId,
    gameId: selectedGame.id,
    name,
    onChange: updateArena,
    onLog: addLog
  })
  updateArena()

  try {
    const gameModule = await selectedGame.load()
    if (!session || thisLoad !== loadVersion) return
    const root = document.querySelector('#game-root')
    root.className = `game-card game-${selectedGame.id}`
    activeGame = gameModule.mountGame(root, {session, addLog})
    updateArena()
  } catch (error) {
    addLog({level: 'error', message: `Could not load ${selectedGame.title}`, details: error instanceof Error ? error.message : String(error)})
    const root = document.querySelector('#game-root')
    if (root) root.innerHTML = '<div class="game-load-error"><strong>The game could not start.</strong><span>Open the event log for details, then try refreshing.</span></div>'
  }
}

function renderArena() {
  app.innerHTML = `
    <div class="app-shell arena-shell">
      ${headerTemplate()}
      <main class="arena-main">
        <section class="room-toolbar" aria-label="Room controls">
          <div class="room-identity">
            <button class="back-button" id="leave-room" type="button" aria-label="Leave room and return to games">←</button>
            <div><span class="toolbar-label">${escapeHtml(selectedGame.title)} room</span><strong>${escapeHtml(roomId)}</strong></div>
          </div>
          <div class="toolbar-actions">
            <span class="connection-badge" id="connection-badge"><i></i><span>Finding peers</span></span>
            <button class="text-button" id="copy-link" type="button">Copy invite link</button>
            <button class="text-button muted" id="leave-room-text" type="button">Games</button>
          </div>
        </section>

        <div class="game-layout">
          <section class="game-card game-loading" id="game-root" aria-label="${escapeHtml(selectedGame.title)}">
            <div class="loading-game"><i></i><strong>Opening ${escapeHtml(selectedGame.title)}</strong></div>
          </section>
          ${debugTemplate()}
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

  document.querySelector('#copy-link').addEventListener('click', copyInviteLink)
  document.querySelector('#clear-logs').addEventListener('click', () => {
    logs = []
    renderLogs()
  })
  document.querySelector('#leave-room').addEventListener('click', leaveRoom)
  document.querySelector('#leave-room-text').addEventListener('click', leaveRoom)
  renderLogs()
}

function debugTemplate() {
  return `
    <aside class="debug-card" aria-labelledby="debug-title">
      <div class="debug-heading">
        <div><p class="step-label">Wire check</p><h2 id="debug-title">Connection details</h2></div>
        <button class="clear-button" id="clear-logs" type="button">Clear log</button>
      </div>
      <dl class="diagnostic-list" id="diagnostics"></dl>
      <div class="log-heading"><span>Event log</span><span>Newest first</span></div>
      <ol class="event-log" id="event-log" aria-live="polite"></ol>
    </aside>
  `
}

async function leaveRoom() {
  const closingSession = session
  session = null
  loadVersion += 1
  activeGame?.destroy()
  activeGame = null
  await closingSession?.destroy()
  const url = new URL(window.location.href)
  url.searchParams.delete('room')
  url.searchParams.set('game', selectedGame.id)
  history.replaceState(null, '', url)
  renderLobby()
}

function updateArena() {
  if (!session || !document.querySelector('.arena-shell')) return
  const diagnostics = session.diagnostics
  const peerCount = session.getConnectedPeerIds().size
  const relays = diagnostics?.relays ?? []
  const openRelays = relays.filter(relay => relay.state === 'open').length
  const connectionLabel = peerCount > 0
    ? `${peerCount + 1} players connected`
    : openRelays > 0
      ? 'Ready · waiting for peers'
      : navigator.onLine
        ? 'Connecting to discovery'
        : 'Browser offline'

  const badge = document.querySelector('#connection-badge')
  badge.className = `connection-badge ${peerCount > 0 ? 'is-connected' : ''}`
  badge.querySelector('span').textContent = connectionLabel
  renderDiagnostics(openRelays, relays)
  renderLogs()
  activeGame?.onSessionChange?.()
}

function renderDiagnostics(openRelays, relays) {
  const element = document.querySelector('#diagnostics')
  if (!element || !session) return
  const diagnostics = session.diagnostics
  const rawPeerIds = diagnostics?.peerIds ?? []
  const sameGamePeers = session.getConnectedPeerIds()
  const relayText = relays.length ? `${openRelays}/${relays.length} open` : 'Connecting…'
  element.innerHTML = `
    <div><dt>Status</dt><dd><span class="status-value ${sameGamePeers.size ? 'good' : ''}">${sameGamePeers.size ? 'P2P connected' : 'Discovering'}</span></dd></div>
    <div><dt>Game</dt><dd>${escapeHtml(selectedGame.title)} <small>Protocol: ${escapeHtml(selectedGame.id)}</small></dd></div>
    <div><dt>Room ID</dt><dd>${escapeHtml(roomId)}</dd></div>
    <div><dt>My peer ID</dt><dd title="${escapeHtml(session.selfPlayer.id)}">${escapeHtml(session.selfPlayer.id)}</dd></div>
    <div><dt>Remote peers</dt><dd>${rawPeerIds.length ? rawPeerIds.map(id => escapeHtml(shortId(id))).join('<br>') : 'None yet'}</dd></div>
    <div><dt>Nostr relays</dt><dd>${escapeHtml(relayText)} <small>from a public pool of ${diagnostics?.relayPoolSize ?? '—'}</small></dd></div>
    <div><dt>Game transport</dt><dd>${sameGamePeers.size ? 'WebRTC DataChannel' : 'Pending'}</dd></div>
  `
}

function renderLogs() {
  const element = document.querySelector('#event-log')
  if (!element) return
  element.innerHTML = logs.length
    ? logs.map(entry => `
        <li class="log-${escapeHtml(entry.level)}">
          <time>${escapeHtml(entry.time)}</time>
          <span>${escapeHtml(entry.message)}</span>
        </li>
      `).join('')
    : '<li class="empty-log">No events yet.</li>'
}

function addLog({level = 'info', message, details}) {
  const detailText = typeof details === 'string' && details ? ` · ${details}` : ''
  logs.unshift({
    level,
    message: `${message}${detailText}`,
    time: new Date().toLocaleTimeString([], {hour12: false})
  })
  logs = logs.slice(0, 60)
  renderLogs()
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
    if (button?.isConnected) button.textContent = 'Copy invite link'
  }, 1_800)
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

function headerTemplate() {
  return `
    <header class="topbar">
      <a class="brand" href="./" aria-label="WebParty P2P home">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>WebParty <b>P2P</b></span>
      </a>
      <div class="proof-pill"><span></span> Static site · live peers</div>
    </header>
  `
}

function footerTemplate() {
  return '<footer><span>Tiny games. Direct connections. No game server.</span><span>WebRTC / Trystero / GitHub Pages</span></footer>'
}

function createRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map(byte => ROOM_CHARS[byte % ROOM_CHARS.length]).join('')
}

function getSessionName() {
  const savedName = sessionStorage.getItem('webparty-player-name') ?? sessionStorage.getItem('signal-sprint-name')
  if (savedName) return normalizeName(savedName)
  const bytes = crypto.getRandomValues(new Uint8Array(2))
  return `${NAME_FIRST[bytes[0] % NAME_FIRST.length]} ${NAME_LAST[bytes[1] % NAME_LAST.length]}`
}

function normalizeRoom(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}
