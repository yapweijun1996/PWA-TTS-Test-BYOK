# OpenRouter TTS BYOK

A small static text-to-speech app for `google/gemini-3.8-flash-lite-tts` through the OpenRouter API.

## Features

- Bring your own OpenRouter API key (BYOK).
- Uses the model's 30 prebuilt voices.
- Requests raw PCM audio and converts it in the browser to a WAV file.
- Plays and downloads generated audio.
- Keeps the API key in page memory only; it is never written to `localStorage`.
- Uses a restrictive same-origin CSP for the static assets.

## Run locally

No build step or dependency installation is required. Serve the directory over HTTP so the browser loads the external JavaScript and CSS correctly:

```bash
python -m http.server 8080
```

Open <http://localhost:8080> and enter an OpenRouter API key when prompted.

## OpenRouter request

The app sends a browser-side `POST` request to:

```text
https://openrouter.ai/api/v1/audio/speech
```

with:

```json
{
  "model": "google/gemini-3.8-flash-lite-tts",
  "input": "Text to speak",
  "voice": "Kore",
  "response_format": "pcm"
}
```

OpenRouter returns raw audio bytes. The app reads the optional PCM sample-rate and channel metadata from `Content-Type`, creates a WAV container locally, and exposes it through the audio player and download link. The `X-Generation-Id` response header is shown when available.

Reference: <https://openrouter.ai/google/gemini-3.8-flash-lite-tts>

## BYOK security notes

- The API key is sent only to OpenRouter for a generation request.
- The key is not persisted, embedded in source, or sent to a project backend.
- Do not publish a private key in the repository or hard-code one into a public deployment.
- For production use, consider OpenRouter key restrictions and a server-side proxy if the key must not be exposed to the browser.

## Project files

- `index.html` — accessible page structure and CSP.
- `styles.css` — page styling.
- `app.js` — OpenRouter request, PCM-to-WAV conversion, and UI behavior.
