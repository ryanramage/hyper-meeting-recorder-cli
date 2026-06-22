// Live transcription via the QVAC SDK's bidirectional streaming session: feed
// it mono s16le PCM with write(), iterate it for TranscribeSegment objects as
// the model's VAD detects complete utterances.
import { plugins, WHISPER_TINY, VAD_SILERO_5_1_2 } from '@qvac/sdk'
import { whisperPlugin } from '@qvac/sdk/whispercpp-transcription/plugin'

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
