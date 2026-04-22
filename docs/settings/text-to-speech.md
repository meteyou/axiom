# Text-to-Speech

Let the agent talk back in an actual human-sounding voice — in the web chat "play this message" button and as Telegram voice replies.

**URL:** `/settings?tab=tts`

## Enabled

Master toggle. When off, no voice output is synthesized and the "speaker" icons disappear from the UI.

## Provider

Which backend generates the audio.

| Value | Notes |
|---|---|
| `openai` | OpenAI TTS (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`). Requires `OPENAI_API_KEY` in [Secrets](./secrets). |
| `mistral` | Mistral's Voxtral voices. Requires `MISTRAL_API_KEY`. |

Options lacking their secret appear `disabled` in the dropdown.

## OpenAI settings

Shown when provider is `openai`.

### Model

| Value | Quality / cost |
|---|---|
| `gpt-4o-mini-tts` | Newer, supports tone/style instructions. Recommended default. |
| `tts-1` | Classic, fast, cheap. |
| `tts-1-hd` | Higher-fidelity version of `tts-1`. |

### Voice

One of OpenAI's preset voices (`alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, ...). The list is loaded live from the OpenAI catalog so the options stay in sync if OpenAI ships new voices.

### Instructions

_Only shown for `gpt-4o-mini-tts`._ Free-form tone/style guidance for the voice model, e.g.:

```
Speak calmly, with a slight Viennese accent, medium pace.
```

Leave empty for the neutral default.

## Mistral (Voxtral) settings

Shown when provider is `mistral`. Two side-by-side dropdowns:

- **Speaker** — one of the available Voxtral speakers, annotated with language (e.g. `Nadia (German)`, `Theo (English)`).
- **Mood** — emotional color (`neutral`, `happy`, `serious`, ...).

The voice list is fetched live from the Voxtral catalog when you open the panel.

## Voice preview

A text field + play button at the bottom of each provider block. Enter any text, click the speaker icon, hear the current settings applied immediately — no need to save first. Stop playback by clicking the same button again.

## Audio format

Output container format used for both web chat and Telegram voice messages.

| Value | Notes |
|---|---|
| `mp3` | Universal default. |
| `wav` | Uncompressed, large. |
| `opus` | Small, great for Telegram voice notes. |
| `flac` | Lossless. |

## Full `settings.json` block

```json
{
  "tts": {
    "enabled": false,
    "provider": "openai",
    "openaiModel": "gpt-4o-mini-tts",
    "openaiVoice": "alloy",
    "openaiInstructions": "",
    "mistralSpeaker": "",
    "mistralMood": "neutral",
    "responseFormat": "mp3"
  }
}
```
