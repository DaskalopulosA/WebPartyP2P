import {compareRounds, escapeHtml, initials, normalizeRound, shortId} from '../utils.js'

const TARGET_SCORE = 25

export function mountGame(root, {session, addLog}) {
  let scores = new Map([...session.getPlayers().keys()].map(peerId => [peerId, 0]))
  let round = {version: 0, origin: 'seed'}

  root.innerHTML = `
    <div class="game-card-top">
      <div><p class="eyebrow">Original wire test</p><h1>First to ${TARGET_SCORE}</h1></div>
      <button class="round-button" data-new-round type="button">New round</button>
    </div>
    <div class="winner-banner" data-winner aria-live="polite"></div>
    <div class="scoreboard" data-scoreboard></div>
    <button class="smash-button" data-smash type="button">
      <span class="smash-count" data-self-score>0</span>
      <span class="smash-label">Mash it</span>
      <span class="smash-hint">Click, tap, or press space</span>
    </button>
    <p class="game-note" data-game-note aria-live="polite"></p>
  `

  const smashButton = root.querySelector('[data-smash]')
  const scorePoint = () => {
    if (winner()) return
    const nextScore = (scores.get(session.selfPlayer.id) ?? 0) + 1
    scores.set(session.selfPlayer.id, nextScore)
    session.sendGame('score', {round, score: nextScore})
    render()
  }

  const startNewRound = () => {
    round = {version: round.version + 1, origin: session.selfPlayer.id}
    scores = freshScores()
    session.sendGame('reset', {round})
    addLog({level: 'info', message: 'Started a new Signal Sprint round'})
    render()
  }

  const handleKey = event => {
    if (event.code !== 'Space' || event.repeat || event.target instanceof HTMLInputElement) return
    event.preventDefault()
    scorePoint()
  }

  const offGame = session.onGameEvent(({type, data, peerId}) => {
    if (type === 'score') acceptScore(data, peerId)
    if (type === 'reset') acceptReset(data, peerId)
    if (type === 'sprint-snapshot') acceptSnapshot(data)
    render()
  })

  const offPeer = session.onPeerEvent(({type, peerId}) => {
    if (type === 'join') session.sendGame('sprint-snapshot', makeSnapshot(), peerId)
    render()
  })

  smashButton.addEventListener('click', scorePoint)
  root.querySelector('[data-new-round]').addEventListener('click', startNewRound)
  window.addEventListener('keydown', handleKey)
  render()

  function acceptScore(payload, peerId) {
    if (!payload) return
    const incomingRound = normalizeRound(payload.round)
    const order = compareRounds(incomingRound, round)
    if (order < 0) return
    if (order > 0) applyRound(incomingRound)
    const score = Number(payload.score)
    if (!Number.isSafeInteger(score) || score < 0 || score > 1_000_000) return
    scores.set(peerId, Math.max(scores.get(peerId) ?? 0, score))
  }

  function acceptReset(payload, peerId) {
    const incomingRound = normalizeRound(payload?.round)
    if (compareRounds(incomingRound, round) <= 0) return
    applyRound(incomingRound)
    const player = session.getPlayers().get(peerId)
    addLog({level: 'info', message: `${player?.name ?? 'A peer'} started a new round`})
  }

  function acceptSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return
    const incomingRound = normalizeRound(snapshot.round)
    const order = compareRounds(incomingRound, round)
    if (order < 0) return
    if (order > 0) applyRound(incomingRound)
    if (!snapshot.scores || typeof snapshot.scores !== 'object') return
    for (const [peerId, value] of Object.entries(snapshot.scores)) {
      const score = Number(value)
      if (Number.isSafeInteger(score) && score >= 0 && score <= 1_000_000) {
        scores.set(peerId, Math.max(scores.get(peerId) ?? 0, score))
      }
    }
  }

  function applyRound(nextRound) {
    round = nextRound
    scores = freshScores()
  }

  function freshScores() {
    return new Map([...session.getPlayers().keys()].map(peerId => [peerId, 0]))
  }

  function makeSnapshot() {
    return {round, scores: Object.fromEntries(scores)}
  }

  function winner() {
    let result = null
    let highScore = -1
    for (const player of session.getPlayers().values()) {
      const score = scores.get(player.id) ?? 0
      if (score >= TARGET_SCORE && score > highScore) {
        result = player
        highScore = score
      }
    }
    return result
  }

  function render() {
    if (!root.isConnected) return
    const players = session.getPlayers()
    const connected = session.getConnectedPeerIds()
    for (const peerId of players.keys()) {
      if (!scores.has(peerId)) scores.set(peerId, 0)
    }
    const sorted = [...players.values()].sort((a, b) =>
      (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || a.name.localeCompare(b.name)
    )
    root.querySelector('[data-scoreboard]').innerHTML = sorted.map(player => {
      const score = scores.get(player.id) ?? 0
      const isSelf = player.id === session.selfPlayer.id
      const isConnected = isSelf || connected.has(player.id)
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

    const currentWinner = winner()
    const banner = root.querySelector('[data-winner]')
    banner.classList.toggle('is-visible', Boolean(currentWinner))
    banner.textContent = currentWinner
      ? `${currentWinner.id === session.selfPlayer.id ? 'You win' : `${currentWinner.name} wins`} — new round?`
      : ''
    root.querySelector('[data-self-score]').textContent = scores.get(session.selfPlayer.id) ?? 0
    smashButton.disabled = Boolean(currentWinner)
    root.querySelector('[data-game-note]').textContent = connected.size
      ? 'Scores are moving directly over WebRTC. First to the line wins.'
      : 'Invite someone to this room, then start tapping.'
  }

  return {
    onSessionChange: render,
    destroy() {
      offGame()
      offPeer()
      window.removeEventListener('keydown', handleKey)
    }
  }
}

