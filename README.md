# Turing Voice Bot

A Discord bot that joins a voice channel, records the meeting (one track per speaker plus a mix),
transcribes and summarizes it, and, in a later milestone, logs it to Notion.

Spec: [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) · Status: **M0 Setup, M1 Record, M2 Transcribe & Summarize**

## What works now

- `/meeting start [title] [type]` joins your voice channel and starts recording.
- A **control panel** in the voice channel's chat shows a live timer and participants, with
  **Pause / Resume · Bookmark · Stop** buttons.
- `/meeting note <text>` (or the 📝 button) adds a timestamped bookmark.
- `/meeting stop` (or ⏹) saves the recording. `/meeting status` shows the current recording, or
  the last meeting with its processing state and summary.
- The bot leaves automatically when the channel has been empty for 2 minutes (configurable).
- While recording, the bot's nickname gets a 🔴 prefix.
- **Crash-safe:** audio reaches disk every ~2 s. If the bot crashes or is redeployed mid-meeting,
  the session is finished and processed automatically on the next start.
- **Mix, transcript and summary:** after the recording, the panel shows progress, then (when
  providers are configured) the TL;DR, decisions, action items and open questions, with
  `transcript.md` attached. If a step fails, a **Retry processing** button appears.
- **Any AI provider:** speech-to-text and the LLM are configured separately, against any server
  that speaks the common OpenAI-compatible API, hosted or self-hosted.

> **One recording per server.** Discord lets a bot be in only one voice channel per server.

## How recording works

Discord sends each speaker's audio as a separate stream of Opus packets, only while they talk.
The bot writes those packets as-is (no re-encoding) into one Ogg Opus file per speaker and
fills the gaps with 3-byte silence frames. That keeps every track aligned to the meeting
clock, which matters later for speaker-labelled, timestamped transcripts. After the recording,
processing mixes the tracks into `mixed.ogg` with ffmpeg.

```
data/sessions/<session-id>/
  manifest.json        # title, participants, bookmarks, pauses, status…
  tracks/<userId>.ogg  # one aligned track per speaker
  mixed.ogg            # everyone, mixed
```

Session status: `recording ⇄ paused → finalizing → recorded`. `recorded` means every track is
safely on disk; what happens next is processing.

## How processing works

Once a session is `recorded`, a job runs these steps, one session at a time:

1. **Mix.** ffmpeg mixes the tracks into `mixed.ogg`. Always runs.
2. **Transcribe** (when `STT_PROVIDER` is set). For each speaker's track, ffmpeg finds the stretches with speech
   (`silencedetect`) and cuts them into small mono chunks. Only those chunks are sent to the
   speech-to-text provider, never the silence (providers bill per audio minute, and silence makes
   Whisper-style models invent text). Each line keeps its speaker and its time on the meeting
   clock, and all speakers are merged into `transcript.json` and `transcript.md`
   (`**[00:12:31] Alice:** …`, with bookmarks shown where they were made).
3. **Summarize** (when `LLM_PROVIDER` is also set). The transcript, the participant list and the bookmarks go to the LLM, which
   returns JSON: TL;DR, key points, decisions, action items (task, owner, due date) and open
   questions. The JSON is validated; long meetings are summarized in parts and then combined.
   Result: `summary.json`.

Each step's state is kept in `manifest.json`. A failed step waits for **Retry processing** and
blocks only the steps that need its output: a failed mix doesn't stop the transcript. A job cut
short by a restart resumes on the next start, and results of each speech chunk and LLM call are
cached under `work/`, so a retry doesn't pay for the same audio twice. Network errors, rate
limits and 5xx responses are retried automatically. While a session is processed it holds a
`processing.lock` file, so the bot and the reprocess script never work on it at the same time.

```
data/sessions/<session-id>/
  transcript.json      # speaker turns with ms offsets (input for Notion)
  transcript.md        # readable transcript, attached to the panel
  summary.json         # tldr, keyPoints, decisions, actionItems, openQuestions
  work/                # per-chunk caches
```

### Choosing providers

Both settings take any OpenAI-compatible endpoint (`STT_BASE_URL`, `LLM_BASE_URL`):

- **Speech-to-text** (`POST /audio/transcriptions`): a hosted Whisper-style API, or a
  self-hosted server such as faster-whisper or whisper.cpp running next to the bot in Dokploy.
  Use `STT_RESPONSE_FORMAT=json` for models that don't return segment timestamps.
- **LLM** (`POST /chat/completions`): a hosted model, an LLM router, or a self-hosted server
  (Ollama, vLLM, LM Studio, llama.cpp). Set `LLM_JSON_MODE=none` if the server rejects
  `response_format`.

Without `STT_PROVIDER`, the bot only records (as in M1). Without `LLM_PROVIDER`, it transcribes
but doesn't summarize. `mock` runs everything offline with placeholder text, which is handy for
testing the flow on Discord without paying for API calls.

## Discord setup (once)

1. Create an application at <https://discord.com/developers/applications>.
2. **Bot** tab → *Reset Token* → copy it to `DISCORD_TOKEN`.
   No privileged intents are needed for this milestone.
3. **General Information** → copy *Application ID* to `DISCORD_CLIENT_ID`.
4. Run `npm run register` (below). It registers the slash commands and prints an invite link
   with the right permissions (View Channels, Send Messages, Embed Links, Read Message History,
   Connect, Change Nickname). Open it to add the bot to your server.

## Configuration

Copy `.env.example` to `.env` and fill it in.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | | Bot token |
| `DISCORD_CLIENT_ID` | ✅ | | Application ID |
| `DISCORD_GUILD_ID` | | | Register commands in this server only (instant). Empty = global |
| `DATA_DIR` | | `./data` | Where recordings are stored (`/app/data` in Docker) |
| `EMPTY_CHANNEL_TIMEOUT_MIN` | | `2` | Leave after the channel is empty this long |
| `RECORDER_ROLE_ID` | | | If set, only this role (or Manage Server) can start/stop/pause |
| `FFMPEG_PATH` | | `ffmpeg` | ffmpeg binary used for the mixdown |
| `STT_PROVIDER` | | `none` | `none` · `mock` · `openai-compatible` |
| `STT_BASE_URL` | for `openai-compatible` | | e.g. `http://whisper:8000/v1` |
| `STT_API_KEY` | | | Empty for servers without auth |
| `STT_MODEL` | for `openai-compatible` | | Model name as the server expects it |
| `STT_LANGUAGE` | | `en` | Spoken language (ISO 639-1) |
| `STT_RESPONSE_FORMAT` | | `verbose_json` | `json` for models without segment timestamps |
| `LLM_PROVIDER` | | `none` | `none` · `mock` · `openai-compatible` |
| `LLM_BASE_URL` | for `openai-compatible` | | e.g. `http://ollama:11434/v1` |
| `LLM_API_KEY` | | | Empty for servers without auth |
| `LLM_MODEL` | for `openai-compatible` | | Model name as the server expects it |
| `LLM_JSON_MODE` | | `json_object` | `none` if the server rejects `response_format` |
| `LLM_TEMPERATURE` | | model default | Some models only accept their default |
| `LLM_CHUNK_CHARS` | | `48000` | Transcript characters per call; longer meetings are split |
| `LOG_LEVEL` | | `info` | `debug` · `info` · `warn` · `error` |
| `TZ` | | system | Time zone for default meeting titles, e.g. `Europe/Rome` |

## Run locally

Requires Node.js ≥ 22.12 and ffmpeg (`brew install ffmpeg`). Without ffmpeg, recording still
works, but the mix and transcribe steps fail (and can be retried once ffmpeg is there).

```bash
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
npm run register       # once, and again whenever commands change
npm run dev            # starts with reload on change
```

## Deploy on Dokploy

1. **Create Application** → connect this Git repository → *Build Type*: **Dockerfile**.
2. **Environment**: set the variables above (`DATA_DIR` is already `/app/data` in the image).
3. **Advanced → Volumes/Mounts**: add a **volume** mounted at `/app/data`.
   Without it, recordings are lost on every redeploy.
4. **Deploy.** Logs are JSON lines, one per event.
5. Register commands once from the app's terminal: `node dist/scripts/register-commands.js`
   (or run `npm run register` from your machine with the same env).

On redeploy, Docker sends `SIGTERM`. The bot closes all audio files and leaves voice, and the
new container mixes any interrupted session when it starts, then resumes any processing job that
was running.

### Reprocessing a session

To run processing by hand (e.g. after changing providers, or for a meeting recorded before
processing was enabled), use the app's terminal:

```bash
node dist/scripts/process-session.js --list               # sessions and their processing state
node dist/scripts/process-session.js <session-id>         # resume, retrying failed steps
node dist/scripts/process-session.js <session-id> --force # start over, ignoring caches
```

Locally: `npm run process -- <session-id>`. If the bot is processing that session at the same
time, the script stops and says so (and vice versa).

## Tests

```bash
npm test           # all tests; the ffmpeg integration tests are skipped if ffmpeg is missing
npm run typecheck
```

The ffmpeg integration tests encode a real Opus tone, push it through the recorder at a known
time, and check with ffmpeg that the file decodes, the speech lands at the right timestamp, the
mix keeps both speakers in place, a file cut off mid-write (a crash) still mixes, and the full
processing pipeline puts each line at the right time and speaker.

**CI** (`.github/workflows/ci.yml`) runs the type check and every test, including the ffmpeg
ones, on pushes to `main` and on pull requests. To keep it cheap it only runs when code or its
config changes, caches `node_modules` and a static ffmpeg build, and cancels a run when a newer
push arrives.

### Manual check on a test server

Voice can't be fully unit-tested. Before relying on it, check on a test server with two accounts:

- [ ] `/meeting start` from a voice channel: the bot joins, 🔴 nickname, panel appears in the channel chat
- [ ] Both accounts talk → `/meeting stop` → one `tracks/<id>.ogg` per speaker + `mixed.ogg` that plays back correctly
- [ ] Pause → talk → Resume: the paused part is silent
- [ ] Bookmark button and `/meeting note` show up on the panel and in `manifest.json`
- [ ] Everyone leaves the channel → the bot stops after the timeout
- [ ] Kill the bot mid-meeting (`docker kill`, or Ctrl+C twice) and start it again → the session becomes `recorded` with `interrupted: true` and earlier audio is kept
- [ ] With `RECORDER_ROLE_ID` set, a member without the role can't start or stop
- [ ] With `STT_PROVIDER=mock` and `LLM_PROVIDER=mock`: after stop, the panel shows ⏳ → ✅ for Transcript and Summary, the mock TL;DR, and `transcript.md` attached
- [ ] With real providers: names and timestamps in `transcript.md` match who said what; the summary's action items make sense
- [ ] Wrong API key → the panel shows ⚠️ with the error and a **Retry processing** button; fix the key, redeploy, press Retry → it finishes
- [ ] Redeploy while "Transcribing" → after restart it resumes and finishes without re-sending chunks already done

## Project layout

```
src/
  index.ts                 entry point: Discord client, events, graceful shutdown
  config.ts                env parsing (zod)
  bot/                     slash commands, buttons/modals, control panel
  recorder/                Opus/Ogg writer, time-aligned tracks, receiver → files, ffmpeg mixdown
  sessions/                session manifest, on-disk store, session lifecycle + crash recovery
  pipeline/                job runner (mix, transcribe → summarize), steps, resume/retry, session lock
  stt/                     speech-to-text interface + adapters (mock, OpenAI-compatible)
  summarize/               LLM interface + adapters, prompt, summary schema, map-reduce
  transcript/              speech detection/chunking (ffmpeg), merging and rendering transcripts
  http.ts                  HTTP client for providers: timeouts, retries, Retry-After
  scripts/                 register-commands.ts, process-session.ts
```

## Next milestones

- **M3 Notion:** Meetings and Action Items databases, meeting page, chat materials
- **M4 Polish:** auto-record, cleanup of old audio
