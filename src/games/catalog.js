export const games = [
  {
    id: 'cloud-hop',
    title: 'Cloud Hop',
    kicker: 'Live P2P platform race',
    description: 'Auto-bounce through a shared sky. See every rival climbing beside you in real time.',
    controls: 'Arrow keys, A/D, or touch',
    accent: 'lime',
    badge: 'New',
    glyph: '↟',
    load: () => import('./cloud-hop.js')
  },
  {
    id: 'signal-sprint',
    title: 'Signal Sprint',
    kicker: 'The original wire test',
    description: 'A deliberately tiny race to 25 taps. Simple, fast, and useful for checking a connection.',
    controls: 'Click, tap, or space',
    accent: 'signal',
    badge: 'Demo',
    glyph: '◉',
    load: () => import('./signal-sprint.js')
  }
]

export const defaultGame = games[0]

export function findGame(gameId) {
  return games.find(game => game.id === gameId) ?? defaultGame
}

