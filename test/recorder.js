import test from 'brittle'
import tui from 'bare-tui'
import Recorder from '../lib/recorder.js'

const { style, KeyMsg } = tui

const SNAP = {
  isHost: true,
  capturing: true,
  writable: true,
  writerKey: 'aa'.repeat(32),
  recording: true,
  elapsed: 5000,
  level: 0.3,
  track: 'track-me',
  key: 'meetingkey123',
  appended: 1,
  meta: { title: 'standup' },
  segments: [
    { track: 'track-me', start: 0, end: 1000, text: 'hello everyone' },
    { track: 'track-bob', start: 1000, end: 2000, text: 'hi there' }
  ],
  tracks: ['track-bob', 'track-me']
}

function fakeSession () {
  return {
    finished: false,
    toredown: false,
    admitted: [],
    async snapshot () { return SNAP },
    async admit (k) { this.admitted.push(k) },
    async finishRecording () { this.finished = true },
    async teardown () { this.toredown = true }
  }
}

function booted (session, snap = SNAP) {
  const r = new Recorder({ session, track: 'track-me' })
  r.update({ type: 'resize', width: 80, height: 20 })
  r.update({ type: 'snap', data: snap })
  return r
}

test('recording view shows REC, transcript, and the "Exit meeting" menu', function (t) {
  const out = style.stripAnsi(booted(fakeSession()).view())
  t.ok(out.includes('REC'))
  t.ok(out.includes('hello everyone') && out.includes('hi there'))
  t.ok(out.includes('Exit meeting'), 'recording menu item')
  t.ok(out.includes('meetingkey123'), 'meeting key is visible to copy/paste')
})

test('Exit meeting finishes recording, then shows the seeding screen with the key', async function (t) {
  const session = fakeSession()
  const r = booted(session)

  const [, cmd] = r.update(new KeyMsg({ name: 'return' })) // enter activates the menu
  t.is(r.busy, true)
  const msg = await cmd()
  t.alike(msg, { type: 'finished' })
  t.is(session.finished, true, 'recording stopped')
  t.is(session.toredown, false, 'still seeding (not torn down)')

  r.update(msg)
  t.is(r.phase, 'seeding')
  t.is(r.busy, false)

  const out = style.stripAnsi(r.view())
  t.ok(out.includes('seeding'), 'seeding screen')
  t.ok(out.includes('meetingkey123'), 'shows the meeting key')
  t.ok(out.includes('bin/cli.js meetingkey123'), 'shows the player command (positional key)')
  t.ok(out.includes('Exit'), 'exit menu item')
})

test('host recording view offers "add writer"', function (t) {
  const out = style.stripAnsi(booted(fakeSession()).view())
  t.ok(out.includes('add writer'), 'host sees the add-writer hint')
})

test('host: "a" opens a paste prompt; typing + enter admits the writer key', async function (t) {
  const session = fakeSession()
  const r = booted(session)

  r.update(new KeyMsg({ name: 'a' }))
  t.is(r.adding, true, 'add-writer prompt open')
  t.ok(style.stripAnsi(r.view()).includes('paste writer key'), 'prompt is shown')

  for (const ch of 'beef') r.update(new KeyMsg({ name: ch }))
  t.is(r.buffer, 'beef', 'keys accumulate into the buffer')

  const [, cmd] = r.update(new KeyMsg({ name: 'return' }))
  t.is(r.adding, false, 'prompt closes on enter')
  const msg = await cmd()
  t.alike(msg, { type: 'admitted', ok: true, key: 'beef' })
  t.alike(session.admitted, ['beef'], 'session.admit called with the typed key')
})

test('host: esc cancels the add-writer prompt without admitting', function (t) {
  const session = fakeSession()
  const r = booted(session)
  r.update(new KeyMsg({ name: 'a' }))
  r.update(new KeyMsg({ name: 'b' }))
  r.update(new KeyMsg({ name: 'escape' }))
  t.is(r.adding, false, 'prompt closed')
  t.is(r.buffer, '', 'buffer cleared')
  t.is(session.admitted.length, 0, 'nothing admitted')
})

test('guest waiting view shows our writer key and does not record yet', function (t) {
  const guestSnap = { ...SNAP, isHost: false, capturing: false, writable: false, writerKey: 'dd'.repeat(32) }
  const r = booted(fakeSession(), guestSnap)
  const out = style.stripAnsi(r.view())
  t.ok(out.includes('Waiting to be admitted'), 'waiting screen')
  t.ok(out.includes('dd'.repeat(32)), 'shows our writer key to give the host')
  t.absent(out.includes('REC'), 'not recording while waiting')
})

test('Exit on the seeding screen tears down and quits', async function (t) {
  const session = fakeSession()
  const r = booted(session)
  r.phase = 'seeding'

  const [, cmd] = r.update(new KeyMsg({ name: 'q' }))
  const msg = await cmd()
  t.alike(msg, { type: 'quit' })
  t.is(session.toredown, true, 'swarm/meeting torn down')
})

test('ctrl+c force-quits: finish + teardown', async function (t) {
  const session = fakeSession()
  const r = booted(session)

  const [, cmd] = r.update(new KeyMsg({ name: 'c', ctrl: true }))
  const msg = await cmd()
  t.alike(msg, { type: 'quit' })
  t.is(session.finished, true)
  t.is(session.toredown, true)
})
