import test from 'brittle'
import { renderTranscript, fitTranscript, filterSuggestions } from '../lib/summarizer.js'

const SEGS = [
  { track: 'track-me', start: 0, end: 1000, text: 'hello everyone' },
  { track: 'track-bob', start: 61000, end: 62000, text: 'we shud ship hyper korr' }
]

test('renderTranscript: "[m:ss] speaker: text" lines', function (t) {
  t.alike(renderTranscript(SEGS), [
    '[0:00] me: hello everyone',
    '[1:01] bob: we shud ship hyper korr'
  ])
})

test('fitTranscript: under budget passes through, over budget keeps the tail', function (t) {
  const lines = ['aaaa', 'bbbb', 'cccc', 'dddd']
  t.alike(fitTranscript(lines, 1000), lines, 'untouched when it fits')

  const fitted = fitTranscript(lines, 11) // room for ~2 lines
  t.is(fitted[0], '(transcript truncated — earlier part omitted)')
  t.alike(fitted.slice(1), ['cccc', 'dddd'], 'oldest lines dropped, newest kept in order')
})

test('filterSuggestions: keeps real corrections, drops junk', function (t) {
  const raw = [
    { i: 1, text: 'we should ship hypercore' }, // good
    { i: 1, text: 'duplicate for same index' }, // dup index
    { i: 0, text: 'hello everyone' }, // identical to original
    { i: 5, text: 'not selected / out of range' },
    { i: 1.5, text: 'non-integer index' },
    { i: 1, text: '' }, // empty
    null
  ]
  const out = filterSuggestions(raw, SEGS, [0, 1])
  t.alike(out, [{ i: 1, text: 'we should ship hypercore' }])
})

test('filterSuggestions: rejects rewrites outside the 0.5–2.0 length ratio', function (t) {
  const long = 'this is a completely different much longer sentence that the model invented from thin air'
  t.alike(filterSuggestions([{ i: 1, text: long }], SEGS, [1]), [], 'too long')
  t.alike(filterSuggestions([{ i: 1, text: 'no' }], SEGS, [1]), [], 'too short')
})

test('filterSuggestions: strips echoed "[m:ss] speaker:" framing from the prompt', function (t) {
  const out = filterSuggestions([{ i: 1, text: '[1:01] bob: we should ship hypercore' }], SEGS, [1])
  t.alike(out, [{ i: 1, text: 'we should ship hypercore' }])
})

test('filterSuggestions: non-array input yields no suggestions', function (t) {
  t.alike(filterSuggestions(undefined, SEGS, [0]), [])
})
