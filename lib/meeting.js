// Thin wrapper that opens a hyper-meeting as a writer.
//
// Everything that crosses between participants is shared OUT OF BAND by
// COPY-PASTE — nothing goes through a shared file/dir:
//
//   - the MEETING KEY: the host shows it; guests pass it as the argument.
//   - each guest's WRITER KEY: the guest shows it on screen; the host pastes it
//     into its "add writer" prompt to admit them (admit() -> base.addWriter).
//
// This is a deliberately insecure prototype stand-in for a real pairing flow
// (e.g. blind-pairing). We make the admission step VISIBLE in the UI rather than
// hiding it behind local file IPC — anyone implementing this for real needs to
// see that admitting a writer is an explicit, per-guest step.
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import HyperMeeting from 'hyper-meeting'
import b4a from 'b4a'

export class Meeting {
  // bootstrap: null/undefined => public DHT (mainnet). Pass a list for a local
  // or custom bootstrap (same-machine/offline testing).
  constructor ({ storageDir, track, isHost = false, key = null, bootstrap = null } = {}) {
    if (!isHost && !key) throw new Error('joining a meeting requires a key (copy it from the host)')
    this.storageDir = storageDir
    this.track = track
    this.isHost = isHost
    this.key = key
    this.bootstrap = bootstrap
    this.swarm = null
    this.store = null
    this.meeting = null
  }

  get writable () { return this.meeting.writable }
  get id () { return this.meeting.id }

  // This peer's writer key (hex). A guest shows this so the host can admit it.
  get localWriterKey () { return b4a.toString(this.meeting.localKey, 'hex') }

  async open () {
    this.swarm = new Hyperswarm({ bootstrap: this.bootstrap })
    this.store = new Corestore(this.storageDir)
    this.meeting = new HyperMeeting(this.swarm, this.store, { key: this.isHost ? null : this.key })
    await this.meeting.ready()
    if (this.isHost) this.key = this.meeting.id // the key to copy-paste/share

    // No blocking, no handshake dir. The host starts writable; a guest becomes
    // writable once the host admits its writer key (see admit()). The session
    // polls writable and begins capturing the moment it flips true.
  }

  // Host-only: admit a guest by the writer key shown on their screen (hex).
  admit (writerKey) { return this.meeting.addWriter(String(writerKey).trim()) }

  addTranscript (segment) { return this.meeting.addTranscript(segment) }
  addAudio (chunk) { return this.meeting.addAudio(chunk) }
  setMeta (patch) { return this.meeting.setMeta(patch) }
  transcript () { return this.meeting.transcript() }
  meta () { return this.meeting.meta() }
  update () { return this.meeting.update() }

  async close () {
    if (this.meeting) await this.meeting.close()
    if (this.swarm) await this.swarm.destroy()
  }
}

// Wrap mono s16le PCM in a WAV container (what hyper-meeting stores; the player
// decodes it with bare-ffmpeg).
export function encodeWav (pcm, rate) {
  const dataLen = pcm.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataLen, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataLen, 40)
  return Buffer.concat([header, pcm])
}
