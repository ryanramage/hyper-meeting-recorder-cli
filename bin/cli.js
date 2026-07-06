// hyper-meeting-recorder — capture your mic, transcribe live, and contribute to
// a shared hyper-meeting that others can join and the player can replay.
//
//   bare bin/cli.js                 # host a new meeting (shows a key to share)
//   bare bin/cli.js <meeting key>   # join a meeting by its key (copy-pasted)
//
// Peers discover each other on the public DHT — no setup, works across machines.
import paparam from 'paparam'
import tui from 'bare-tui'
import Recorder from '../lib/recorder.js'
import { RecorderSession } from '../lib/session.js'
import { FfmpegMic } from '../lib/mic.js'
import { QvacTranscriber, ParakeetTranscriber } from '../lib/transcriber.js'
import { Meeting } from '../lib/meeting.js'

const { command, flag, arg, summary } = paparam
const { Program } = tui
const RATE = 16000

const cmd = command(
  'hyper-meeting-recorder',
  summary('Record your mic + transcribe live into a shared meeting. Omit the key to host; pass a key to join.'),
  arg('[key]', 'meeting key to join (omit to host a new meeting)'),
  flag('--track|-t <name>', 'your participant name (default "me")'),
  flag('--file <path>', 'transcribe a file as if it were a live mic (no microphone needed)'),
  flag('--device <dev>', 'ffmpeg input device (else the platform default mic)'),
  flag('--bootstrap <host:port>', 'custom DHT bootstrap (advanced; default is the public DHT)'),
  flag('--engine <name>', 'transcription engine: parakeet (default) or whisper'),
  () => run(cmd)
)

try {
  cmd.parse(Bare.argv.slice(2))
} catch {
  console.error(cmd.usage())
  Bare.exit(1)
}
if (cmd.running) await cmd.running
Bare.exit(0)

async function run (cmd) {
  const key = cmd.args.key || null
  const isHost = !key
  const name = cmd.flags.track || 'me'
  const track = name.startsWith('track-') ? name : 'track-' + name
  const bootstrap = cmd.flags.bootstrap ? cmd.flags.bootstrap.split(',') : null

  // One corestore per meeting. The host can't know its key before the store
  // exists, so it gets a fresh dir each run (a new meeting); joiners key off it.
  const storageDir = isHost
    ? `.hmr-store/host-${Date.now().toString(36)}`
    : `.hmr-store/${key.slice(0, 16)}`

  const mic = new FfmpegMic({
    file: cmd.flags.file || null,
    device: cmd.flags.device || null,
    rate: RATE
  })
  const engine = cmd.flags.engine || 'parakeet'
  const transcriber = engine === 'whisper' ? new QvacTranscriber() : new ParakeetTranscriber()
  const meeting = new Meeting({ storageDir, track, isHost, key, bootstrap })
  const session = new RecorderSession({ mic, transcriber, meeting, track, rate: RATE })

  await session.start()

  const program = new Program(new Recorder({ session, track }))
  try {
    await program.run()
  } catch (err) {
    console.error('✖', err)
  } finally {
    // idempotent backstops in case of a crash: save audio, then tear down.
    await session.finishRecording().catch(() => {})
    await session.teardown().catch(() => {})
  }
}
