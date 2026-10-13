# Turing Voice Bot

A Discord bot that joins a voice channel, records the meeting (one track per speaker plus a mix),
and, in later milestones, transcribes it, summarizes it and logs it to Notion.

Spec: [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) · Status: **M0 Setup + M1 Record**

## What works now

- `/meeting start [title] [type]` joins your voice channel and starts recording.
- A **control panel** in the voice channel's chat shows a live timer and participants, with
  **Pause / Resume · Bookmark · Stop** buttons.
- `/meeting note <text>` (or the 📝 button) adds a timestamped bookmark.
- `/meeting stop` (or ⏹) saves the recording; `/meeting status` shows the current one.
- The bot leaves automatically when the channel has been empty for 2 minutes (configurable).
- While recording, the bot's nickname gets a 🔴 prefix.
- **Crash-safe:** audio reaches disk every ~2 s. If the bot crashes or is redeployed mid-meeting,
  the session is finished and mixed automatically on the next start.

> **One recording per server.** Discord lets a bot be in only one voice channel per server.

## How recording works

Discord sends each speaker's audio as a separate stream of Opus packets, only while they talk.
The bot writes those packets as-is (no re-encoding) into one Ogg Opus file per speaker and
fills the gaps with 3-byte silence frames. That keeps every track aligned to the meeting
clock, which matters later for speaker-labelled, timestamped transcripts. On stop, ffmpeg mixes
the tracks into `mixed.ogg`.

```
data/sessions/<session-id>/
  manifest.json        # title, participants, bookmarks, pauses, status…
  tracks/<userId>.ogg  # one aligned track per speaker
  mixed.ogg            # everyone, mixed
```

Session status: `recording ⇄ paused → finalizing → recorded` (or `failed` if mixing failed;
the per-speaker tracks are always kept).

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
| `LOG_LEVEL` | | `info` | `debug` · `info` · `warn` · `error` |
| `TZ` | | system | Time zone for default meeting titles, e.g. `Europe/Rome` |

## Run locally

Requires Node.js ≥ 22.12 and ffmpeg (`brew install ffmpeg`). Without ffmpeg, recording still
works but sessions end as `failed` with no `mixed.ogg`.

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
new container mixes any interrupted session when it starts.

## Tests

```bash
npm test                         # unit tests (ffmpeg tests are skipped if ffmpeg is missing)
npm run typecheck
docker build --target test .     # everything, including real-ffmpeg integration tests
```

The ffmpeg integration tests encode a real Opus tone, push it through the recorder at a known
time, and check with ffmpeg that the file decodes, the speech lands at the right timestamp, the
mix keeps both speakers in place, and a file cut off mid-write (a crash) still mixes.

### Manual check on a test server

Voice can't be fully unit-tested. Before relying on it, check on a test server with two accounts:

- [ ] `/meeting start` from a voice channel: the bot joins, 🔴 nickname, panel appears in the channel chat
- [ ] Both accounts talk → `/meeting stop` → one `tracks/<id>.ogg` per speaker + `mixed.ogg` that plays back correctly
- [ ] Pause → talk → Resume: the paused part is silent
- [ ] Bookmark button and `/meeting note` show up on the panel and in `manifest.json`
- [ ] Everyone leaves the channel → the bot stops after the timeout
- [ ] Kill the bot mid-meeting (`docker kill`, or Ctrl+C twice) and start it again → the session becomes `recorded` with `interrupted: true` and earlier audio is kept
- [ ] With `RECORDER_ROLE_ID` set, a member without the role can't start or stop

## Project layout

```
src/
  index.ts                 entry point: Discord client, events, graceful shutdown
  config.ts                env parsing (zod)
  bot/                     slash commands, buttons/modals, control panel
  recorder/                Opus/Ogg writer, time-aligned tracks, receiver → files, ffmpeg mixdown
  sessions/                session manifest, on-disk store, session lifecycle + crash recovery
  scripts/register-commands.ts
```

## Next milestones

- **M2 Transcribe & Summarize:** speech-to-text and LLM provider interfaces (any provider), job pipeline
- **M3 Notion:** Meetings and Action Items databases, meeting page, chat materials
- **M4 Polish:** auto-record, cleanup of old audio
