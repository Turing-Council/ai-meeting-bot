# Incident: live transcription stopped after 2 h (2026-11-25)

Deployment: Dokploy (self-hosted) → project "Turing Council" → `voice-bot-live`
(branch `feat/live-transcription`, commit `49c0855`, 1 CPU / 1 GiB),
STT `whisper` (speaches 0.9.0-rc.3-cpu, 6 CPU / 8 GiB).

Session: `20261125-164607-p49m`, channel "Lounge", times UTC.

## Timeline (from logs)

| Time (UTC) | Source | Event |
|---|---|---|
| 16:46:08 | bot | `New speaker` (the organiser). The only `New speaker` line for the whole session. |
| 16:46:17 | bot | `Recording started` (manual). Notion not set up (warning). |
| 16:46:11 → 18:46:01 | whisper | 751 live requests to `/v1/audio/transcriptions` with `faster-whisper-base.en`, all `200 OK`, about 6.3 per minute, clips 8.1 s on average, each decoded in about 1.5 s. |
| **18:46:01** | whisper | **Last live request.** 2 h 0 min after the start. No request reaches Whisper after this until the post-meeting job. |
| 18:46 → 19:28 | bot | **Nothing logged**: no warning, no error, no reconnect, no "lagging" or "skipped" line. |
| 19:28:04 | bot | `Recording stopped` by the user, `durationMs` 9 714 948 (2 h 41 m 55 s), status `recorded`. |
| 19:28 → 19:31 | bot | Mix step, 219 s. |
| 19:32 → 19:48 | bot + whisper | Post-meeting transcription with `faster-whisper-small.en`: **1 track**, 16 chunks, **speechMs 7 126 455 (1 h 58 m 46 s)**, 71 turns written. |
| 19:48:21 | bot | Publish step fails: Notion is not set up. This is expected and separate from the incident. |

The Whisper `ERROR … Unexpected streaming transcription response type: TranscriptionVerbose` lines
appear on all 767 requests (751 live and 16 post-meeting). They are speaches noise for `verbose_json`, every response is `200 OK`,
and they are **not** the cause.

## What the code says

The live path, from Discord to Whisper:

1. `@discordjs/voice` `VoiceReceiver.onUdpMessage` → `AudioReceiveStream` (one per user).
2. `MeetingRecorder` `stream.on('data')` writes the packet to the track, then calls `onPacket`
   (`src/recorder/recorder.ts:114-127`).
3. `LiveTranscription.push` → `UtteranceSegmenter` → `enqueue` → `pump` → `stt.transcribe`
   (`src/live/transcription.ts`, `src/live/segmenter.ts`).

Every failure in step 3 is logged at `warn`, which goes to stderr. Dokploy captures stderr, as the publish
error line shows. A failed request logs `Live transcription request failed` after retries. Live STT
uses a 15 s timeout with 2 attempts (`src/config.ts:192-194`), so the worst case is about 32 s. A backed-up queue logs
`lagging`/`skipped` when the next item is pulled. **None of these lines were logged.** So, after
18:46, either no utterance reached `enqueue`, or the queue was pulled and stayed empty. In
both cases, **packets stopped arriving at `onPacket`**.

`onPacket` is called only after `track.pushPacket`. So if packets stopped there, the recording
stopped getting audio at the same moment. The recording files confirm it (see below).

**Main hypothesis: at about 18:46 Discord audio receive stopped silently. The recording kept running but
from then on only stored silence.** Live transcription was a symptom, not the cause.

### How `@discordjs/voice` 0.19.2 can drop audio without any error

From `dist/index.js` (receiver and DAVE session):

- `onUdpMessage`: `if (!userData) return;` A packet whose SSRC is not in `ssrcMap` is dropped with
  no event. This happens if the SSRC changes after a voice reconnect or resume and the new mapping is
  never received.
- `parsePacket` → `daveSession.decrypt(...)` returns `null` on a decrypt failure while a
  transition is pending or the session is reinitialising, and `if (packet) stream.push(packet)`
  drops it. Those failures emit only `debug` events on the DAVE session, and this bot does not
  listen for them. If a DAVE (E2EE) epoch transition never completes, every packet is dropped
  from then on, silently.
- A real decrypt throw calls `stream.destroy(error)`. The recorder would log
  `Audio stream error; will resubscribe`, and that line is **absent**, so the stream was not destroyed.

The bot also does not log voice connection state changes. `watchConnection`
(`src/sessions/manager.ts:506-529`) ignores a `Disconnected` → `Signalling`/`Connecting` within 5 s
without logging it. A Discord voice-server move or resume at 18:46 would leave no trace.
The cut at exactly 2 h 0 m fits a periodic event on Discord's side, such as a voice-server
rotation, a session resume or an MLS/DAVE re-key. It does not fit load: Whisper was answering in about 1.5 s and was idle.

### Ruled out

- **Whisper overload or crash.** Every request returned 200, each took about 1.5 s, and the server kept running and
  handled the full post-meeting job 45 min later.
- **Live queue stuck on a hung request.** A hung request times out after about 32 s and logs a warning. A backed-up queue logs `lagging`/`skipped`. No such lines were logged.
- **Bot crash or restart.** The same process logged the stop and the processing. There are no startup lines.
- **Recording loss.** The session finished as `recorded`, then mixed and transcribed (71 turns).
  The files are on the `data` volume at `/app/data/…/20261125-164607-p49m`.

### Checked against the recording files

The session was downloaded to `recordings/20261125-164607-p49m/`. That folder is git-excluded and not committed.

- **The recording is saved.** It has `mixed.ogg` (59 MB), `tracks/<user>.ogg` (49 MB), `transcript.md/json`,
  `live-transcript.jsonl` and `manifest.json`.
- **The audio really stops at about 1 h 59 m 52 s, for the recording too.** The last live line ends at
  7 191.2 s. The last turn of the *post-meeting* transcript ends at 7 191.9 s, and no turn starts after
  7 200 s. `ffmpeg silencedetect` on `mixed.ogg` finds one unbroken silence from **7 191.6 s to the
  end (9 714.9 s), 2 523 s long**. That is padded digital silence. `live-transcript.jsonl` was last modified at
  18:46 UTC.
- `pauses` is empty, so a pause is ruled out. You added a bookmark, **"dead?"**, at 2 h 35 m (9 315 s),
  so you noticed the stop live.

### ~~Second finding~~: not a bug, it was an in-person meeting

**Update:** this was an in-person meeting recorded through one room mic, a Meeting Owl Pro on the
organiser's MacBook. A single track is the expected result, and the other three Discord participants were
not the speakers. The original analysis is kept below for reference.

This also makes a **sending-side cause** about as likely as a bot-side one for the 2 h stop. Only one
Discord client (the MacBook) was sending audio. If the Owl dropped off the USB-C adapter, the Mac slept,
or Discord switched input device, the bot would get exactly what it got: no packets and no error. Step 1
of the plan (logging unknown SSRCs and connection state) tells the two apart next time. A cheap check on
the Mac side is Discord's input device and the macOS log around 19:46 local time.

`manifest.participants` lists four people in the channel: Rishi, Alessandro, alt_zancudo and Belém.
There is **one track** (Alessandro, who started the recording), and only one `New speaker` line appears in 2 h 42 m.
`MeetingRecorder` opens a track only on the receiver's `speaking` `start` event. That event fires only
for SSRCs in `ssrcMap` (`onUdpMessage`: `if (!userData) return;` comes *before*
`speaking.onPacket`). So the bot either never learned the other users' SSRCs, or it got no packets
from them. In both cases their audio was dropped without a trace for the whole meeting. This is
separate from the 2 h stop, possibly with the same root cause (voice gateway SSRC or DAVE handling).
Unless all three stayed muted the entire meeting, this is the larger data-loss bug.

## Contributing problems found on the way

1. **No observability on the voice side.** There is no log for connection state changes, networking
   state changes, DAVE `debug`/`invalidateTransition` events, or a speaker's packets stopping.
   This incident had no log trace at all.
2. **No watchdog.** Nothing notices that a speaking user, or the whole session, has received no packets for
   N minutes while humans are still in the channel.
3. **Pause/resume is not logged** (`src/sessions/manager.ts:227-246`).
4. **Live-message edit failures are logged at `debug`** (`src/live/message.ts:52`). So if Discord
   rejected the edits, the channel would show a frozen message with nothing in the logs. This did not happen
   here, because Whisper stopped getting requests, but it is the same kind of silent failure.
5. **The `data` volume name is generic.** Dokploy mounts a volume named simply `data`, so any other
   app on that host that mounts `data` shares it.

## How `@discordjs/voice` maps SSRCs (checked by a separate reviewer)

- `ssrcMap` is filled **only** by voice-gateway op 5 (SPEAKING) and cleared by op 13. Op 11
  (ClientsConnect) carries only user ids. `ssrcMap`, `subscriptions` and `speaking` live on
  the `VoiceReceiver`, which survives a networking re-creation. Only the ws/udp bindings are swapped.
- After a voice-server move or a reconnect, the SSRCs change, so each user needs a fresh op 5. Until it
  arrives, every packet is dropped at `if (!userData) return`, while our `AudioReceiveStream` stays open
  and quiet. That fits a total cut with no logs and no stream error.
- A networking close with any code except 4014 goes **Ready → Signalling directly**, with no
  `Disconnected`, so `watchConnection` never sees it. Nothing checks that the connection gets back to
  `Ready` either.
- For issue 2, `speaking.start` fires **before** decryption, so DAVE is ruled out. The other users
  had no `ssrcMap` entry (no op 5 for people already in the channel when the bot joined), or sent no UDP
  at all, or never unmuted.
- The 2 h timing is consistent with a Discord-side reconnect, but it is **unproven**: no connection state was logged.

## Fix plan (by value)

1. **Make it visible** (`src/sessions/manager.ts` `watchConnection`):
   - Log `connection` `stateChange` at info.
   - On each networking change, log the networking state codes, `ws` op 5/11/13 packets (user id and SSRC),
     DAVE `invalidateTransition` (warn) and DAVE `debug` (debug).
   - Count UDP packets whose SSRC is missing from `receiver.ssrcMap`, and warn once per unknown SSRC.
     That one signal tells apart "no mapping" from "no audio" for both issues.
   - Log pause and resume.
   - Raise live-edit failures to warn.
2. **Watchdog and recovery:**
   - The recorder exposes `lastPacketAt`.
   - A manager interval of about 30 s checks two conditions: the connection not `Ready` for more than 20 s, or
     humans in the channel and no packet for more than 3 min (or unknown-SSRC packets arriving). Then it warns
     and calls `connection.rejoin()`, capped at 3 per 10 min.
   - Keep the same `MeetingRecorder`: re-creating it reopens the tracks with `flags:'w'` and **wipes them**.
     `TimelineTrack` pads by wall clock, so the timeline stays aligned.
   - Fallback, only if logs show `rejoin()` does not restore op 5: destroy, then `joinVoiceChannel`, then
     `recorder.attach(newReceiver)`, keeping the speakers.
3. **Recorder hardening.** When `speaking.start` fires for a user whose stream exists but has had no data for
   N seconds, destroy and resubscribe it.
4. **Tests** (vitest, existing fakes):
   - connection state logging;
   - `lastPacketAt` updates;
   - the manager rejoins on a stall (fake timers) and keeps the track files;
   - stale-stream resubscribe.

Still open: did the other three actually speak? Does Discord send op 5 for users already in the
channel? Does `rejoin()` restore the mappings? Only step 1, running in a real meeting, can answer these.
