import {connectPeerRoom} from './network.js'
import {PLAYER_COLORS, hashString, normalizeName} from './utils.js'

/**
 * Shared room/session layer.
 *
 * A minigame receives this object and only needs `sendGame`, `onGameEvent`,
 * `onPeerEvent`, and the read-only player helpers. Trystero stays below here.
 */
export function createPartySession({roomId, gameId, name, onChange, onLog}) {
  const players = new Map()
  const compatiblePeerIds = new Set()
  const gameListeners = new Set()
  const peerListeners = new Set()
  let diagnostics = null
  let destroyed = false

  const network = connectPeerRoom(roomId, {
    onLog,
    onDiagnostics(nextDiagnostics) {
      diagnostics = nextDiagnostics
      onChange?.()
    },
    onPeerJoin(peerId) {
      network.send('presence', {gameId, player: selfPlayer}, peerId)
      network.send('roster', {gameId, players: [...players.values()]}, peerId)
      emitPeer({type: 'join', peerId})
      onChange?.()
    },
    onPeerLeave(peerId) {
      compatiblePeerIds.delete(peerId)
      emitPeer({type: 'leave', peerId})
      onChange?.()
    },
    onEvent(event, peerId) {
      receive(event, peerId)
    },
    onError() {
      onChange?.()
    }
  })

  const selfPlayer = makePlayer(network.peerId, name)
  players.set(selfPlayer.id, selfPlayer)
  network.send('presence', {gameId, player: selfPlayer})

  function receive(event, peerId) {
    if (event.type === 'presence') {
      const payload = event.payload
      if (payload?.gameId !== gameId || !isPlayer(payload.player, peerId)) return
      players.set(peerId, {...payload.player, name: normalizeName(payload.player.name)})
      compatiblePeerIds.add(peerId)
      onChange?.()
      return
    }

    if (event.type === 'roster') {
      const payload = event.payload
      if (payload?.gameId !== gameId || !Array.isArray(payload.players)) return
      for (const player of payload.players) {
        if (isPlayer(player)) players.set(player.id, {...player, name: normalizeName(player.name)})
      }
      compatiblePeerIds.add(peerId)
      onChange?.()
      return
    }

    if (event.type !== 'game-event' && event.type !== 'game-state') return
    const payload = event.payload
    if (!payload || payload.gameId !== gameId || typeof payload.type !== 'string') return
    compatiblePeerIds.add(peerId)
    for (const listener of gameListeners) {
      listener({type: payload.type, data: payload.data, peerId})
    }
  }

  function emitPeer(event) {
    for (const listener of peerListeners) listener(event)
  }

  const session = {
    roomId,
    gameId,
    selfPlayer,
    get diagnostics() {
      return diagnostics
    },
    getPlayers() {
      return new Map(players)
    },
    getConnectedPeerIds() {
      return new Set(compatiblePeerIds)
    },
    sendGame(type, data, target, options = {}) {
      const envelopeType = options.frequent ? 'game-state' : 'game-event'
      return network.send(envelopeType, {gameId, type, data}, target)
    },
    onGameEvent(listener) {
      gameListeners.add(listener)
      return () => gameListeners.delete(listener)
    },
    onPeerEvent(listener) {
      peerListeners.add(listener)
      return () => peerListeners.delete(listener)
    },
    async destroy() {
      if (destroyed) return
      destroyed = true
      gameListeners.clear()
      peerListeners.clear()
      await network.leave()
    }
  }

  return session
}

function makePlayer(id, name) {
  return {
    id,
    name: normalizeName(name),
    color: PLAYER_COLORS[hashString(id) % PLAYER_COLORS.length]
  }
}

function isPlayer(player, expectedId) {
  return (
    player !== null &&
    typeof player === 'object' &&
    typeof player.id === 'string' &&
    player.id.length > 0 &&
    (!expectedId || player.id === expectedId) &&
    typeof player.name === 'string' &&
    typeof player.color === 'string' &&
    PLAYER_COLORS.includes(player.color)
  )
}

