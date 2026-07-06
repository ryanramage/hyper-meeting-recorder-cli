// Live transcription via the QVAC SDK's bidirectional streaming session: feed
// it mono s16le PCM with write(), iterate it for TranscribeSegment objects as
// the model's VAD detects complete utterances.
import { plugins, WHISPER_TINY, VAD_SILERO_5_1_2, PARAKEET_EOU_120M_V1_Q8_0 } from '@qvac/sdk'
import { whisperPlugin } from '@qvac/sdk/whispercpp-transcription/plugin'
import { parakeetPlugin } from '@qvac/sdk/parakeet-transcription/plugin'

const DEFAULT_CONFIG = {
  vadModelSrc: VAD_SILERO_5_1_2,
  audio_format: 's16le', // matches what the mic produces
  strategy: 'greedy',
  n_threads: 4,
  language: 'en',
  no_timestamps: true,
  suppress_blank: true,
  suppress_nst: true,
  temperature: 0.0,
  vad_params: {
    threshold: 0.6,
    min_speech_duration_ms: 250,
    min_silence_duration_ms: 500,
    max_speech_duration_s: 15.0,
    speech_pad_ms: 200
  }
}

export class QvacTranscriber {
  constructor ({ modelSrc = WHISPER_TINY, modelConfig = DEFAULT_CONFIG } = {}) {
    this.api = plugins([whisperPlugin]) // registers the plugin, returns host API
    this.modelSrc = modelSrc
    this.modelConfig = modelConfig
    this.modelId = null
    this.session = null
  }

  async load () {
    this.modelId = await this.api.loadModel({
      modelType: 'whispercpp-transcription',
      modelSrc: this.modelSrc,
      modelConfig: this.modelConfig
    })
  }

  // Open a live session. Returns an async-iterable of TranscribeSegment.
  async openSession () {
    this.session = await this.api.transcribeStream({ modelId: this.modelId, metadata: true })
    return this.session
  }

  write (chunk) {
    if (this.session) this.session.write(chunk)
  }

  end () {
    if (this.session) this.session.end()
  }

  async unload () {
    if (this.modelId) await this.api.unloadModel({ modelId: this.modelId })
    this.modelId = null
  }
}

const DEFAULT_PARAKEET_MODEL_CONFIG = {
  streaming: true,
  streamingChunkMs: 1000,
  streamingEmitPartials: true
}

const DEFAULT_PARAKEET_STREAMING_CONFIG = {
  chunkMs: 1000,
  emitPartials: true
}

// Parakeet's transcribeStream doesn't support `metadata: true` (whisper-only)
// and its wire events are `{type: 'text'}` / `{type: 'endOfTurn'}`, not
// TranscribeSegment objects. Buffer text between endOfTurn boundaries and
// re-shape each utterance into the {text, startMs, endMs, id, append} segment
// shape session.js already consumes, timed off our own clock since Parakeet's
// events carry no timestamps of their own.
async function * toSegments (session) {
  const startedAt = Date.now()
  let buffer = ''
  let uttStartMs = null
  let id = 0

  for await (const event of session) {
    if (event.type === 'text') {
      if (!event.text) continue
      if (uttStartMs === null) uttStartMs = Date.now() - startedAt
      buffer += event.text
      continue
    }
    if (event.type === 'endOfTurn') {
      const text = buffer.trim()
      buffer = ''
      const endMs = Date.now() - startedAt
      const startMs = uttStartMs === null ? endMs : uttStartMs
      uttStartMs = null
      if (text) yield { text, startMs, endMs, id: id++, append: false }
    }
  }

  const text = buffer.trim()
  if (text) {
    const endMs = Date.now() - startedAt
    yield { text, startMs: uttStartMs === null ? endMs : uttStartMs, endMs, id: id++, append: false }
  }
}

export class ParakeetTranscriber {
  constructor ({
    modelSrc = PARAKEET_EOU_120M_V1_Q8_0,
    modelConfig = DEFAULT_PARAKEET_MODEL_CONFIG,
    streamingConfig = DEFAULT_PARAKEET_STREAMING_CONFIG
  } = {}) {
    this.api = plugins([parakeetPlugin])
    this.modelSrc = modelSrc
    this.modelConfig = modelConfig
    this.streamingConfig = streamingConfig
    this.modelId = null
    this.session = null
  }

  async load () {
    this.modelId = await this.api.loadModel({
      modelType: 'parakeet-transcription',
      modelSrc: this.modelSrc,
      modelConfig: this.modelConfig
    })
  }

  // Open a live session. Returns an async-iterable of TranscribeSegment.
  async openSession () {
    this.session = await this.api.transcribeStream({
      modelId: this.modelId,
      parakeetStreamingConfig: this.streamingConfig
    })
    return toSegments(this.session)
  }

  write (chunk) {
    if (this.session) this.session.write(chunk)
  }

  end () {
    if (this.session) this.session.end()
  }

  async unload () {
    if (this.modelId) await this.api.unloadModel({ modelId: this.modelId })
    this.modelId = null
  }
}

// A canned transcriber for tests: yields the given segments, no model/audio.
export class MockTranscriber {
  constructor ({ segments = [] } = {}) {
    this.segments = segments
    this.written = []
    this._ended = false
  }

  async load () {}

  async openSession () {
    const segs = this.segments
    const self = this
    this.session = {
      write (chunk) { self.written.push(chunk) },
      end () { self._ended = true },
      destroy () {},
      async * [Symbol.asyncIterator] () {
        for (const s of segs) yield s
      }
    }
    return this.session
  }

  write (chunk) { this.written.push(chunk) }
  end () { this._ended = true }
  async unload () {}
}
