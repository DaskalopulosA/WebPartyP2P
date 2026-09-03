export const PLAYER_COLORS = ['#ff5c4d', '#c7f36b', '#6e8cff', '#f6bb5c', '#d78cff', '#54d6c5']

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function hashString(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function shortId(id) {
  return `${id.slice(0, 5)}…${id.slice(-4)}`
}

export function initials(name) {
  return name.split(' ').slice(0, 2).map(part => part[0]).join('').toUpperCase()
}

export function normalizeName(value) {
  const name = String(value ?? '').replace(/[<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 20)
  return name || 'Mystery Player'
}

export function normalizeRound(value) {
  const version = Number(value?.version)
  const origin = typeof value?.origin === 'string' ? value.origin.slice(0, 64) : ''
  return {
    version: Number.isSafeInteger(version) && version >= 0 ? version : 0,
    origin: origin || 'seed'
  }
}

export function compareRounds(a, b) {
  return a.version === b.version ? a.origin.localeCompare(b.origin) : a.version - b.version
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

