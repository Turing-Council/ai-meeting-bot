# Using the bot

How to set up and use Turing Voice Bot. The quick setup gets a working bot in about 15 minutes;
everything after it is reference. Developer notes are in [`developing.md`](developing.md).

## Quick setup

You need: a Discord server where you can manage the server, and a VPS with
[Dokploy](https://dokploy.com) (or any machine with Docker or Node.js ≥ 22.12 and ffmpeg).

1. **Create the Discord app.** Go to <https://discord.com/developers/applications> → *New
   Application*. From *General Information*, copy the **Application ID**.
2. **Create the bot token.** *Bot* tab → *Reset Token* → copy the token. Keep it secret.
3. **Deploy on Dokploy.**
   1. *Create Application* → connect this Git repository → *Build Type*: **Dockerfile**.
   2. *Environment*: add
      ```env
      DISCORD_TOKEN=<bot token>
      DISCORD_CLIENT_ID=<application id>
      DISCORD_GUILD_ID=<your server id>   # optional: makes commands appear instantly
      TZ=Europe/Rome                     # optional: time zone for default meeting titles
      ```
      To get the server ID, turn on *Developer Mode* in Discord (*Settings → Advanced*), then
      right-click the server → *Copy Server ID*.
   3. *Advanced → Volumes/Mounts*: add a **volume** mounted at `/app/data`. Without it, every
      redeploy deletes your recordings.
   4. **Deploy**.
4. **Register the slash commands.** In the app's *Terminal* in Dokploy, run:
   ```bash
   node dist/scripts/register-commands.js
   ```
   It prints an **invite link**.
5. **Invite the bot.** Open the link and pick your server. The bot asks for the permissions it
   needs: View Channels, Send Messages, Embed Links, Attach Files, Read Message History,
   Connect, Change Nickname.
6. **Record a meeting.** Join a voice channel and run `/meeting start`. Talk, then run
   `/meeting stop`. The recording is saved and the panel in the channel's chat shows the result.
7. **Optional: transcripts and summaries.** To try the whole flow for free, add
   `STT_PROVIDER=mock` and `LLM_PROVIDER=mock` (placeholder text, no API calls), then redeploy.
   For real results, see [Choosing providers](#choosing-providers).
8. **Optional: Notion.** Not available yet (milestone M3, in progress).

Running it on your own machine instead (needs Node.js ≥ 22.12 and `ffmpeg`):

```bash
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
npm run register       # prints the invite link
npm run dev
```

---

## Commands and the control panel

| Command | What it does |
|---|---|
| `/meeting start [title] [type]` | Joins your voice channel and starts recording. Without a title: `<channel> — <date>`. `type` is free text, e.g. *Standup* |
| `/meeting note <text>` | Adds a timestamped bookmark. Bookmarks are shown in the transcript and given to the summarizer as important moments |
| `/meeting stop` | Stops recording, leaves the channel and starts processing |
| `/meeting status` | Shows the current recording, or the last meeting with its processing state and summary (only you see the reply) |

When a recording starts, the bot posts a **control panel** in the voice channel's text chat (or
in the channel where you ran the command, if it can't post there). It shows the timer,
participants and bookmarks, with these buttons:

- **⏸ Pause / ▶ Resume:** nothing is recorded while paused.
- **📝 Bookmark:** same as `/meeting note`, through a small form.
- **⏹ Stop:** same as `/meeting stop`.
- **🔁 Retry processing:** appears after the meeting if a processing step failed.

While recording, the bot's nickname starts with 🔴. If everyone leaves the voice channel, the
bot stops after 2 minutes (`EMPTY_CHANNEL_TIMEOUT_MIN`).

**Who can control recordings:** everyone, unless `RECORDER_ROLE_ID` is set. Then only members
with that role, or with *Manage Server*, can start, stop, pause and retry. Anyone can add
bookmarks.

**Limits:** one recording at a time per server (Discord allows a bot in only one voice channel
per server). Only audio and chat are captured, not video or screen share.

## What happens after a meeting

Processing runs automatically after `/meeting stop`, one meeting at a time. The panel shows
each step's progress (🕓 waiting · ⏳ running · ✅ done · ⚠️ failed):

1. **Audio:** all speakers are mixed into one file, `mixed.ogg`. Always runs.
2. **Transcript** (needs a speech-to-text provider): each person's audio is transcribed
   separately, so every line has the right name and time. Only the parts where someone talks
   are sent to the provider.
3. **Summary** (also needs an LLM): TL;DR, key points, decisions, action items (with owner and
   due date when mentioned) and open questions.

When it's done, the panel shows the TL;DR, decisions, action items and open questions, with
`transcript.md` attached.

**If a step fails** (e.g. a wrong API key), the panel shows ⚠️, the error and **Retry
processing**. Fix the cause (for config changes, redeploy first), then press Retry. Only the
failed step and the steps that depend on it run again, and work that already finished isn't
paid for twice. Rate limits and temporary provider errors are retried automatically before a
step counts as failed.

**If the bot restarts** (redeploy, crash) during a meeting, the recording up to that moment is
kept, finished on the next start and then processed. A processing job cut off by a restart
continues where it stopped.

## Configuration reference

Set these as environment variables (Dokploy *Environment*, or `.env` locally; see
[`.env.example`](../.env.example)). Changes need a redeploy or restart.

**Discord and recording**

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | | Bot token |
| `DISCORD_CLIENT_ID` | ✅ | | Application ID |
| `DISCORD_GUILD_ID` | | | Register commands in this server only (appear instantly). Empty = all servers (can take up to an hour) |
| `RECORDER_ROLE_ID` | | | Only this role (or Manage Server) can control recordings. Right-click the role → *Copy Role ID* |
| `EMPTY_CHANNEL_TIMEOUT_MIN` | | `2` | Stop after the voice channel has been empty this long |
| `DATA_DIR` | | `./data` | Where recordings are stored; `/app/data` in Docker |
| `FFMPEG_PATH` | | `ffmpeg` | Already included in the Docker image |
| `TZ` | | system | Time zone for default meeting titles, e.g. `Europe/Rome` |
| `LOG_LEVEL` | | `info` | `debug` · `info` · `warn` · `error` |

**Speech-to-text**

| Variable | Required | Default | Notes |
|---|---|---|---|
| `STT_PROVIDER` | | `none` | `none` (no transcripts) · `mock` · `openai-compatible` |
| `STT_BASE_URL` | for `openai-compatible` | | The server's base URL, usually ending in `/v1` |
| `STT_API_KEY` | | | Leave empty for servers without authentication |
| `STT_MODEL` | for `openai-compatible` | | Model name as the server expects it |
| `STT_LANGUAGE` | | `en` | Language spoken in meetings (ISO 639-1) |
| `STT_RESPONSE_FORMAT` | | `verbose_json` | Use `json` if the model doesn't support `verbose_json` |

**Summaries**

| Variable | Required | Default | Notes |
|---|---|---|---|
| `LLM_PROVIDER` | | `none` | `none` (no summaries) · `mock` · `openai-compatible` |
| `LLM_BASE_URL` | for `openai-compatible` | | The server's base URL, usually ending in `/v1` |
| `LLM_API_KEY` | | | Leave empty for servers without authentication |
| `LLM_MODEL` | for `openai-compatible` | | Model name as the server expects it |
| `LLM_JSON_MODE` | | `json_object` | Use `none` if the server rejects `response_format` |
| `LLM_TEMPERATURE` | | model default | Leave empty unless you need it; some models accept only their default |
| `LLM_CHUNK_CHARS` | | `48000` | Transcript size per call; longer meetings are summarized in parts. Lower it for models with a small context window |

## Choosing providers

Both settings work with any service that offers an **OpenAI-compatible API**. Most hosted AI
services and self-hosted servers do. Speech-to-text and the LLM are independent: they can come
from different providers, and either can be hosted or self-hosted.

**Hosted** (no hardware needed, pay per use): take the OpenAI-compatible base URL, an API key
and a model name from the provider's docs.

```env
STT_PROVIDER=openai-compatible
STT_BASE_URL=https://<provider>/v1
STT_API_KEY=<key>
STT_MODEL=<speech-to-text model>

LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://<provider>/v1
LLM_API_KEY=<key>
LLM_MODEL=<chat model>
```

**Self-hosted next to the bot in Dokploy** (no per-use cost, but it needs CPU/GPU and RAM on the
VPS): run a Whisper server with an OpenAI-compatible API (such as faster-whisper-based servers
or whisper.cpp's server) and an LLM server (such as Ollama or vLLM) as Dokploy services. Point
the bot at their internal addresses:

```env
STT_PROVIDER=openai-compatible
STT_BASE_URL=http://<whisper service>:<port>/v1
STT_MODEL=<model the server has loaded>

LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://<ollama service>:11434/v1
LLM_MODEL=<model you pulled>
```

Tips:
- Transcription on CPU only is slow for long meetings. Try one real meeting before relying on it.
- If transcripts come back without timestamps, or the server rejects the request, set
  `STT_RESPONSE_FORMAT=json`. Lines then get the time of the stretch of speech they belong to.
- If the LLM server returns an error about `response_format`, set `LLM_JSON_MODE=none`.
- Smaller local models may return summaries that don't match the expected format. The bot asks
  once more and otherwise marks the step as failed, so you can switch models and press Retry.

## Notion

Not available yet. Milestone M3 adds it: a Meetings and an Action Items database, a page per
meeting with the summary, transcript, recording and chat materials, and an *Open in Notion*
button on the panel.

## Files and data

Everything lives in `DATA_DIR` (the `/app/data` volume in Docker), one folder per meeting:

```
sessions/<YYYYMMDD-HHMMSS-xxxx>/
  manifest.json      # meeting details, participants, bookmarks, processing state
  tracks/<id>.ogg    # one audio file per speaker
  mixed.ogg          # everyone, mixed
  transcript.md      # readable transcript
  transcript.json    # the same, for programs
  summary.json       # the structured summary
  work/              # caches used by retries; safe to delete once processing is done
```

**Back up** the whole volume to keep recordings. The folder names start with the date and time
(UTC) the meeting started.

**Reprocess a meeting** (e.g. after switching providers, or for a meeting recorded before
processing was turned on), from the Dokploy terminal:

```bash
node dist/scripts/process-session.js --list               # meetings and their processing state
node dist/scripts/process-session.js <session-id>         # finish it, retrying failed steps
node dist/scripts/process-session.js <session-id> --force # start over from the recording
```

Locally, use `npm run process -- <arguments>`. If the bot is processing the same meeting at that
moment, the script stops and tells you.

## Troubleshooting

Logs are in Dokploy (*Logs* tab), one JSON line per event. Set `LOG_LEVEL=debug` for more detail.

| Problem | What to check |
|---|---|
| Slash commands don't appear | Run the register command again. Without `DISCORD_GUILD_ID`, commands can take up to an hour to appear |
| "I couldn't connect to the voice channel" | The bot needs *View Channel* and *Connect* in that channel (check channel-specific permissions) |
| The bot joins but tracks are empty | Make sure the bot isn't server-deafened. Keep the bot updated: Discord's voice encryption changes occasionally |
| No panel in the voice channel's chat | The bot needs *Send Messages* and *Embed Links* there; otherwise it posts in the channel where you ran the command |
| ⚠️ on Audio or Transcript: "Could not start ffmpeg" | Running outside Docker without ffmpeg installed. Install it, then press Retry |
| ⚠️ with `401` / `403` | Wrong or missing API key (`STT_API_KEY` / `LLM_API_KEY`) |
| ⚠️ with `404` | Wrong base URL (most need `/v1` at the end) or model name |
| ⚠️ with `429` after retries | The provider's rate limit or quota; wait, or raise the limit, then Retry |
| Summary step fails with "did not return a valid summary" | The model ignored the format. Try `LLM_JSON_MODE=none`, or a stronger model |
| The panel stopped updating | The panel message may have been deleted. `/meeting status` still shows the meeting |
| `transcript.md` isn't attached to the panel | The bot lacks *Attach Files*: re-invite it with the link from the register command, or add the permission to its role |
| Recordings disappeared after a redeploy | No volume on `/app/data` (Quick setup, step 3) |
