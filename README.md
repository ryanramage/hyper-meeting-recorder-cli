# hyper-meeting-recorder-cli

A personal meeting recorder: capture **your** microphone, transcribe it **live**
with Whisper (QVAC SDK), and contribute it to a shared
[hyper-meeting](https://github.com/holepunchto/hyper-meeting) — one participant
per recorder. Run it alongside other people running it and you collaboratively
build one meeting doc; the
[player](https://github.com/holepunchto/hyper-meeting-player-cli) replays it
afterward.

It's the **live produce** side of the system:

| Project | Role |
| ------- | ---- |
| **hyper-meeting-recorder-cli** (this) | capture + live-transcribe + contribute (one per participant) |
| `hyper-meeting` | the multiwriter container |
| `hyper-meeting-player-cli` | replay it |
| qvac-examples | a file-based produce harness + integration tests |

## Usage

```sh
# host a meeting — no key means you're the host; the UI shows a key to share
bare bin/cli.js --track alice

# others join by pasting that key
bare bin/cli.js --track bob <key-shown-by-the-host>

# no microphone? feed a file as if it were a live mic
bare bin/cli.js --track alice --file some.wav
```

**No key = you host; pass a key = you join.** The key is shared **out of band by
copy-paste** — the host displays it (on the recording and seeding screens) and
others pass it as the argument. Nothing is shared through a file/dir.

**Admitting a guest is an explicit, visible step** (see below): a guest shows
its own *writer key*, and the host presses `a` to paste it in and admit them.

**Discovery:** peers find each other on the **public DHT**, so it works across
machines with no setup. (For offline/custom setups, `--bootstrap host:port`
points at your own bootstrap node.)

You see a live, time-ordered transcript of **everyone** in the meeting, a `● REC`
indicator with a mic level meter, and your elapsed time.

Two-step exit (press `enter` to activate the highlighted menu item; `ctrl+c`
force-quits):

1. **Exit meeting** — stops your recording and saves your audio, but keeps the
   meeting **seeding**. You land on a screen showing the meeting key + the player
   command, so someone can replay it while you keep serving the data.
2. **Exit** — tears down the swarm/connections and quits.

### Arguments & flags

- `[key]` — the meeting key to join. **Omit it to host a new meeting.**
- `--track <name>` — your participant name (default `me`).
- `--file <wav>` — transcribe a file in real time instead of the mic (great for
  testing without hardware).
- `--device <dev>` — a specific ffmpeg input device (else the platform default).
- `--bootstrap host:port` — a custom DHT bootstrap node (advanced; default is the
  public DHT).

### Writer admission (the copy-paste handshake)

A meeting is a multiwriter [autobee](https://github.com/holepunchto/hyper-meeting):
each participant writes from their **own** writer key, and the host must admit
each one. This CLI makes that step **explicit and visible** rather than hiding it:

1. A guest joins with the meeting key. It's not writable yet, so it shows a
   **"Waiting to be admitted"** screen with **its own writer key**.
2. The guest sends that writer key to the host (out of band — chat, etc.).
3. The host presses **`a`**, pastes the writer key, and hits enter. The guest
   becomes writable and the recorder starts capturing automatically.

> **This is a deliberately insecure prototype.** Anyone who learns a writer key
> can be admitted, and the exchange is manual. In real software, replace it with
> a pairing flow (e.g. [`blind-pairing`](https://github.com/holepunchto/blind-pairing)) —
> but keep admission as a first-class, visible step in your UI, exactly where the
> `a`-to-admit prompt is here.

## How it works

```
mic ──s16le PCM──▶ transcriber.write()  ── live Whisper (VAD) ──▶ segments
                                                                    │
       └─ accumulate PCM ────────────────────────────▶ meeting.addAudio() on stop
                                                                    ▼
                                                       meeting.addTranscript()  (live)
```

- **Capture** (`lib/mic.js`): an ffmpeg subprocess handles every platform's audio
  device and emits mono s16le. We learned from `bare-ffmpeg` that device I/O is
  cleanest via a subprocess (bare-ffmpeg has no audio-device *output*, and device
  *input* would block the TUI loop); bare-ffmpeg is used on the **playback** side
  to decode what we record here.
- **Live transcription** (`lib/transcriber.js`): the QVAC SDK's bidirectional
  `transcribeStream` session — write PCM, async-iterate `TranscribeSegment`s as
  the VAD finalizes utterances.
- **The meeting** (`lib/meeting.js`): join as a writer, append segments as they
  arrive, store the recording on stop. Segments are aligned to a shared zero
  (`meta.startedAt`, set by the host) so everyone's timeline lines up.
- **`RecorderSession`** (`lib/session.js`) ties those together behind a
  `snapshot()` / `stop()` interface — the same seam the player uses — so the TUI
  (`lib/recorder.js`) only polls and renders.

## Tips for a real implementation (React/Electron)

The structure is the same as the player's (see its README for the full
React/Electron guide): the **`session` is the seam**. The TUI polls
`session.snapshot()`; in Electron, run capture + Whisper + the meeting in the
**main process** and push snapshots to the renderer.

- **Don't capture on the UI thread.** A blocking device read or heavy decode
  starves everything. Capture in a subprocess (or worker); keep the feed
  event-driven.
- **Align participants to one clock.** Each recorder offsets its segments by
  `myStart - meta.startedAt`, so independently-started recorders share a timeline.
- **Partials vs finals.** The streaming session emits a segment, then a refined
  final at the same start; keying transcript entries by start means the final
  cleanly replaces the partial — no dedupe needed.
- **Audio is stored as s16 mono WAV** (what the player's bare-ffmpeg decoder
  expects). For long meetings, push in chunks rather than one blob at stop.

## Integration testing — a part at a time

Each layer is testable without the one below it:

1. **Pure + model** (`test/format.js`, `test/recorder.js`) — formatting, level
   meter, and the TUI model driven by a fake session (no mic, no SDK, no p2p).
2. **The pipeline** (`test/session.js`) — `RecorderSession` with a `MockMic` +
   `MockTranscriber` + a fake meeting: asserts mic chunks reach the transcriber,
   segments get appended, and audio is stored on stop. Deterministic, offline.
3. **Live transcription** — point a `FfmpegMic({ file })` at a WAV (real-time via
   `-re`) through the real `QvacTranscriber` into a meeting; confirms live Whisper
   under Bare without a microphone. (This is how this repo was verified.)
4. **A real meeting** — run `--track alice` (host), copy the invite key it shows,
   run `--track bob <key>` (bob shows a *writer key* and waits), back on alice
   press `a` and paste bob's writer key. Bob starts recording; watch both
   transcripts converge, then replay with the player using the meeting key.

```sh
npm test   # brittle-bare test/all.js — layers 1–2, no mic/SDK/network
```

## License

Apache-2.0
