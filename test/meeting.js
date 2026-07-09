import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Corestore from 'corestore'
import HyperMeeting from 'hyper-meeting'

// The improve-transcriptions flow relies on this: re-adding a segment with the
// same track + start OVERWRITES the stored entry (the autobee key is
// transcript/<track>/<start>), so corrections replace text in place.
test('re-adding a transcript with the same track+start overwrites it', async function (t) {
  const dir = path.join(os.tmpdir(), 'hmr-test-' + Date.now().toString(36))
  const store = new Corestore(dir)
  const meeting = new HyperMeeting(null, store)
  await meeting.ready()

  await meeting.addTranscript({ track: 'track-me', start: 1000, end: 2000, id: 0, text: 'we shud ship hyper korr' })
  await meeting.addTranscript({ track: 'track-me', start: 1000, end: 2000, id: 0, text: 'we should ship hypercore' })

  const segs = await meeting.transcript()
  t.is(segs.length, 1, 'still a single segment')
  t.is(segs[0].text, 'we should ship hypercore', 'text replaced in place')
  t.is(segs[0].start, 1000)

  await meeting.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
