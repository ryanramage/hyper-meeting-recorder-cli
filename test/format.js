import test from 'brittle'
import * as fmt from '../lib/format.js'

test('fmtClock', function (t) {
  t.is(fmt.fmtClock(0), '0:00')
  t.is(fmt.fmtClock(65000), '1:05')
  t.is(fmt.fmtClock(-5), '0:00')
})

test('speaker / truncate / pad', function (t) {
  t.is(fmt.speaker('track-alice'), 'alice')
  t.is(fmt.truncate('hello world', 5), 'hell…')
  t.is(fmt.pad('hi', 4), 'hi  ')
})

test('wrap: greedy word wrap, hard-breaks long words, keeps paragraphs', function (t) {
  t.alike(fmt.wrap('one two three', 7), ['one two', 'three'])
  t.alike(fmt.wrap('', 10), [''])
  t.alike(fmt.wrap('a\nb', 10), ['a', 'b'])
  t.alike(fmt.wrap('abcdefgh', 3), ['abc', 'def', 'gh'])
  for (const line of fmt.wrap('the quick brown fox jumps over the lazy dog', 10)) {
    t.ok(line.length <= 10, `"${line}" fits`)
  }
})

test('rmsS16: silence is 0, full-scale is ~1', function (t) {
  t.is(fmt.rmsS16(Buffer.alloc(8)), 0)
  const loud = Buffer.alloc(8)
  for (let i = 0; i < 4; i++) loud.writeInt16LE(32767, i * 2)
  t.ok(fmt.rmsS16(loud) > 0.9, 'near full scale')
})

test('levelBar fills proportionally', function (t) {
  t.is(fmt.levelBar(0, 10), '▱'.repeat(10))
  t.is(fmt.levelBar(1, 10), '▮'.repeat(10))
  t.is(fmt.levelBar(0.5, 10).length, 10)
})
