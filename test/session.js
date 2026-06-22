import test from 'brittle'
import { RecorderSession } from '../lib/session.js'
import { MockMic } from '../lib/mic.js'
import { MockTranscriber } from '../lib/transcriber.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A fake meeting that records what the session writes.
function fakeMeeting (overrides = {}) {
  return {
    isHost: true,
    writable: true, // host starts writable; a guest flips this once admitted
    localWriterKey: 'ab'.repeat(32),
    id: 'abcd1234' + 'x'.repeat(44),
    metaObj: {},
    appended: [],
    audios: [],
    admitted: [],
    async open () {},
    async setMeta (p) { this.metaObj = { ...this.metaObj, ...p } },
    async meta () { return this.metaObj },
    async transcript () { return this.appended.slice() },
    async addTranscript (s) { this.appended.push(s) },
    async addAudio (c) { this.audios.push(c) },
    admit (k) { this.admitted.push(k); return Promise.resolve() },
    async update () {},
    closed: false,
    async close () { this.closed = true },
    ...overrides
  }
}

test('RecorderSession: mic -> transcriber -> meeting, then stores audio on stop', async function (t) {
  const meeting = fakeMeeting()
  const mic = new MockMic({ chunks: [Buffer.alloc(64), Buffer.alloc(64)], intervalMs: 1 })
  const transcriber = new MockTranscriber({
    segments: [
      { text: 'hello', startMs: 0, endMs: 1000, id: 0, append: false },
      { text: 'there', startMs: 1000, endMs: 2000, id: 1, append: false }
    ]
  })
  const session = new RecorderSession({ mic, transcriber, meeting, track: 'track-me', rate: 16000 })

  await session.start()
  await sleep(30) // let mic chunks + segment consumption settle

  t.is(meeting.appended.length, 2, 'both segments appended to the meeting')
  t.is(meeting.appended[0].track, 'track-me')
  t.is(meeting.appended[0].text, 'hello')
  t.ok(transcriber.written.length >= 2, 'mic chunks were written to the transcriber')

  const snap = await session.snapshot()
  t.is(snap.recording, true)
  t.is(snap.track, 'track-me')
  t.is(snap.segments.length, 2)

  await session.finishRecording()
  t.is(session.recording, false)
  t.is(meeting.audios.length, 1, 'audio pushed on finish')
  t.ok(meeting.audios[0].data.length > 44, 'WAV header + PCM data')
  t.ok(Number.isFinite(meeting.metaObj.duration), 'host set duration on finish')
  t.is(meeting.closed, false, 'meeting stays open (still seeding) after finishRecording')

  await session.teardown()
  t.is(meeting.closed, true, 'teardown closes the meeting')
})

test('guest: capture is deferred until the host admits it (writable flips)', async function (t) {
  const meeting = fakeMeeting({ isHost: false, writable: false, localWriterKey: 'cd'.repeat(32) })
  const mic = new MockMic({ chunks: [Buffer.alloc(64)], intervalMs: 1 })
  const transcriber = new MockTranscriber({ segments: [{ text: 'hi', startMs: 0, endMs: 500, id: 0 }] })
  const session = new RecorderSession({ mic, transcriber, meeting, track: 'track-bob', rate: 16000 })

  await session.start()
  let snap = await session.snapshot()
  t.is(snap.capturing, false, 'not capturing while waiting to be admitted')
  t.is(snap.writerKey, 'cd'.repeat(32), 'exposes our writer key for the host')
  t.is(meeting.appended.length, 0, 'nothing recorded yet')

  // Host admits us -> writable flips; the next snapshot starts capture.
  meeting.writable = true
  snap = await session.snapshot()
  await sleep(30)
  t.is(snap.capturing, true, 'capture began once admitted')
  t.ok(meeting.appended.length >= 1, 'segments flow after admission')

  await session.finishRecording()
  await session.teardown()
})

test('host: admit() forwards the pasted writer key to the meeting', async function (t) {
  const meeting = fakeMeeting()
  const session = new RecorderSession({
    mic: new MockMic({ chunks: [], intervalMs: 1 }),
    transcriber: new MockTranscriber({ segments: [] }),
    meeting,
    track: 'track-me'
  })
  await session.start()
  await session.admit('ef'.repeat(32))
  t.alike(meeting.admitted, ['ef'.repeat(32)], 'writer key handed to the meeting')
  await session.teardown()
})
