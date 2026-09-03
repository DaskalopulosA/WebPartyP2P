import {defaultRelayUrls, getRelaySockets, joinRoom, selfId} from 'trystero'

const APP_ID = 'io.github.daskalopulosa.webpartyp2p.signal-sprint.v1'
const SOCKET_STATES = ['connecting', 'open', 'closing', 'closed']

/**
 * The deliberately small networking boundary for the POC.
 * Game code sends named JSON events and never touches Trystero directly.
 */
export function connectPeerRoom(roomId, handlers = {}) {
  let closed = false
  const log = (level, message, details) =>
    handlers.onLog?.({level, message, details})

  log('info', `Joining room ${roomId}`, {
    strategy: 'Nostr signaling → WebRTC data channels',
    peerId: selfId
  })

  const room = joinRoom(
    {
      appId: APP_ID,
      relayConfig: {
        redundancy: 3,
        warnOnRelayFailure: false
      }
    },
    roomId,
    {
      onJoinError({peerId, error}) {
        log('error', `Could not establish WebRTC with ${shortId(peerId)}`, error)
        handlers.onError?.({peerId, error})
      }
    }
  )

  const eventAction = room.makeAction('party-event-v1')

  eventAction.onMessage = (event, {peerId}) => {
    if (!isPartyEvent(event)) {
      log('warn', `Ignored malformed event from ${shortId(peerId)}`)
      return
    }

    log('receive', `Received ${event.type} from ${shortId(peerId)}`)
    handlers.onEvent?.(event, peerId)
  }

  room.onPeerJoin = peerId => {
    log('success', `WebRTC peer connected: ${shortId(peerId)}`)
    handlers.onPeerJoin?.(peerId)
    reportDiagnostics()
  }

  room.onPeerLeave = peerId => {
    log('warn', `Peer disconnected: ${shortId(peerId)}`)
    handlers.onPeerLeave?.(peerId)
    reportDiagnostics()
  }

  async function send(type, payload, target) {
    if (closed) return

    const peerCount = Object.keys(room.getPeers()).length
    log('send', `${target ? 'Sent' : 'Broadcast'} ${type}`, {
      recipients: target ? shortId(target) : peerCount
    })

    try {
      await eventAction.send(
        {type, payload},
        target ? {target} : undefined
      )
    } catch (error) {
      log('error', `Failed to send ${type}`, errorMessage(error))
    }
  }

  function getDiagnostics() {
    const peers = room.getPeers()
    const relays = Object.entries(getRelaySockets()).map(([url, socket]) => ({
      url,
      state: SOCKET_STATES[socket.readyState] ?? 'unknown'
    }))

    return {
      roomId,
      selfId,
      peerIds: Object.keys(peers),
      relays,
      relayPoolSize: defaultRelayUrls.length,
      online: navigator.onLine
    }
  }

  function reportDiagnostics() {
    if (!closed) handlers.onDiagnostics?.(getDiagnostics())
  }

  const diagnosticsTimer = window.setInterval(reportDiagnostics, 1000)
  const onOnline = () => {
    log('success', 'Browser is back online')
    reportDiagnostics()
  }
  const onOffline = () => {
    log('error', 'Browser went offline')
    reportDiagnostics()
  }

  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  reportDiagnostics()

  return {
    peerId: selfId,
    send,
    getDiagnostics,
    async leave() {
      if (closed) return
      closed = true
      window.clearInterval(diagnosticsTimer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      await room.leave()
      log('info', `Left room ${roomId}`)
    }
  }
}

function isPartyEvent(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.type === 'string' &&
    Object.hasOwn(value, 'payload')
  )
}

function shortId(id) {
  return `${id.slice(0, 5)}…${id.slice(-4)}`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
