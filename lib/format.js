// Pure rendering/format helpers (style.stripAnsi makes them easy to unit-test).
import tui from 'bare-tui'

const { style } = tui

const TRACK_COLORS = ['39', '208', '170', '113', '220', '75', '141', '210']

export function trackColor (index) {
  return TRACK_COLORS[index % TRACK_COLORS.length]
}

// ms -> "m:ss" (or "h:mm:ss").
export function fmtClock (ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const total = Math.floor(ms / 1000)
  const s = String(total % 60).padStart(2, '0')
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}:${s}`
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}`
}

export function speaker (track) {
  return track.replace(/^track-/, '')
}

export function truncate (str, width) {
  if (width <= 0) return ''
  if (str.length <= width) return str
  if (width === 1) return '…'
  return str.slice(0, width - 1) + '…'
}

export function pad (str, width) {
  const t = truncate(str, width)
  return t.length < width ? t + ' '.repeat(width - t.length) : t
}

// Greedy word wrap -> array of lines no wider than `width` (long words are
// hard-broken). Preserves paragraph breaks; blank input yields [''].
export function wrap (str, width) {
  if (width <= 0) return ['']
  const out = []
  for (const para of String(str).split('\n')) {
    let line = ''
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) { out.push(line); line = '' }
        out.push(word.slice(0, width))
        word = word.slice(width)
      }
      if (!word) continue
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ' ' + word
      else { out.push(line); line = word }
    }
    out.push(line)
  }
  return out
}

// RMS level (0..1) of a mono s16le buffer — drives the mic level meter.
export function rmsS16 (buf) {
  const n = buf.length >> 1
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

// A small horizontal level meter: "▮▮▮▮▮▱▱▱▱▱".
export function levelBar (level, width = 10) {
  const lit = Math.max(0, Math.min(width, Math.round(level * width * 3))) // *3: speech rarely hits 1.0
  return '▮'.repeat(lit) + '▱'.repeat(width - lit)
}
