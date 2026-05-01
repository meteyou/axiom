# Voice (Deepgram)

Axiom can use [Deepgram](https://deepgram.com) as a hosted voice layer for Telegram:

- **STT** — incoming Telegram voice messages are auto-transcribed via Deepgram before being forwarded to the agent.
- **TTS** *(optional)* — the agent's text reply is synthesized via Deepgram and uploaded to Telegram as a voice / audio message.

A single Deepgram API key powers both directions. It is encrypted at rest in `settings.json` (`deepgramApiKey`).

## Get an API key

1. Sign up at [console.deepgram.com](https://console.deepgram.com) (free tier includes credits — enough to evaluate STT and TTS).
2. Create a project and a Deepgram API key.
3. Copy the key.

## Configure the key

1. Open the Axiom web UI as an admin.
2. Go to **Settings → Skills → Built-in tools** (the third tab).
3. Scroll to the **Voice (Deepgram)** card.
4. Paste the API key into **Deepgram API Key** and click **Save**.

The key is encrypted before being written to disk. The web UI only ever displays a masked preview (e.g. `dg_••••••abcd`).

## Enable STT for Telegram voice messages

1. Go to **Settings → Speech-to-Text**.
2. Toggle **Enable Speech-to-Text** on.
3. Pick **Deepgram** as the **STT Provider**.
4. *(optional)* Set **Deepgram Model** — `nova-3` is the current production default.
5. *(optional)* Set **Deepgram Language** — ISO 639-1 (`en`, `de`, ...) or `multi`. Empty = auto-detect.
6. Save.

Now any voice message sent to your Telegram bot is downloaded, posted to Deepgram's `/v1/listen` endpoint with `Authorization: Token <key>`, and the resulting transcript is fed to the agent as a regular text message (prefixed with `🎤 Voice:`).

If transcription fails (network error, invalid key, rate limit), Telegram receives a short error reply and the original message is dropped — the agent does not see partial / corrupted input.

## Enable TTS voice replies *(optional)*

1. Go to **Settings → Text-to-Speech**.
2. Toggle **Enable Text-to-Speech** on.
3. Pick **Deepgram Aura** as the **TTS Provider**.
4. Pick a **Deepgram Voice**. A few presets are exposed (`aura-2-thalia-en`, `aura-asteria-en`, `aura-2-ophelia-de`, ...). Any model id Deepgram supports can be set directly in `settings.json`.
5. Pick an **Audio Encoding**:
   - `opus` — sent via `sendVoice`, renders as a native Telegram voice message.
   - `mp3` — sent via `sendAudio`, renders as a regular audio attachment.
6. Toggle **Voice replies in Telegram** on.
7. Save.

After the agent produces its text reply for a Telegram message, Axiom also synthesizes that reply with Deepgram and uploads the resulting audio to the same chat. The text reply is always sent first — if synthesis fails for any reason (rate limit, network error, text >2000 chars), the user still receives the text and a warning is logged server-side.

## What the API calls look like

For self-hosters, here's the exact wire format Axiom uses so you can debug from the server side.

**STT:**
```text
POST https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&smart_format=true&language=de
Authorization: Token <deepgramApiKey>
Content-Type: audio/ogg

<raw OGG/Opus audio bytes from Telegram>
```

**TTS:**
```text
POST https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=opus
Authorization: Token <deepgramApiKey>
Content-Type: application/json

{ "text": "<agent reply, markdown stripped>" }
```

## Limits & caveats

- **Telegram voice replies skip messages longer than 2000 characters** — that's Deepgram `/v1/speak`'s payload limit. Long replies are still delivered as text.
- **Markdown is stripped** before synthesis so the TTS doesn't read code fences and bullet markers aloud.
- **STT is silently skipped** when the master toggle is off; Telegram voice messages are dropped without an error reply.
- The Deepgram key is shared between STT and TTS. Disabling Deepgram for one direction does not invalidate the other.

## Configuration reference

See [Settings → Speech-to-Text](../settings/speech-to-text) and [Settings → Text-to-Speech](../settings/text-to-speech) for the full list of settings keys and their JSON shape.
