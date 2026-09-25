# OpenRouter TTS BYOK

A small static text-to-speech app for user-selected TTS models through the OpenRouter API.

## Features

- Bring your own OpenRouter API key (BYOK) and use the model-ID combobox suggestion for Google: Gemini 3.8 Flash Lite TTS, or enter any compatible model ID.
- Choose from 30 prebuilt Gemini voice suggestions or enter a model-specific voice name; the voice is omitted when left blank for a model default.
- Requests raw PCM audio and converts it in the browser to a WAV file.
- Splits long text into sequential, sentence/paragraph-aware requests and merges compatible PCM responses into one WAV.
- Plays and downloads generated audio.
- Keeps settings in memory by default; an explicit opt-in can save the model, API key, voice, and request size in IndexedDB.
- Uses a restrictive same-origin CSP for the static assets.
- Installs as a standalone PWA with home-screen icons.
- Caches only the application shell for offline launch; OpenRouter generation remains online-only.
- Keeps a versioned update-check button visible in the header; it becomes an update action when a new Service Worker is waiting.

## PWA behavior

The Web App Manifest defines the app identity, standalone display mode, scope, colors, and icons. Serve this app over HTTPS in production; `localhost` is also a secure context for local development.

The versioned Service Worker caches the static app shell only. It does not cache API requests, generated audio, or IndexedDB settings. When the browser reports offline, the cached interface remains available and the app says speech generation needs an internet connection. Browser connectivity indicators are advisory; generation still requires a working internet connection.

The header always shows **Check updates · v14**. Selecting it checks for a newer Service Worker. If one is waiting, the app asks it for its release identifier, changes the button to **Update to v15**, and shows an update notice. The current version stays active until the user selects the update action; then a loader is shown, the waiting worker activates, and the page reloads. The first install activates automatically because there is no existing app version to interrupt.

For every release that changes the app shell, increment `CACHE_VERSION` in `service-worker.js` and synchronize `data-version`, the update heading, and the initial **Check updates · vN** button label in `index.html`. The release identifier is a cache/release identifier, not a semantic-versioning claim. This changes the worker bytes and cache name, precaches the new shell, and removes the previous app-shell cache after activation. Ensure the host does not indefinitely serve stale `index.html` or `service-worker.js` files. The service worker is registered relative to its own directory, so it can be hosted at a repository subpath.

On browsers that support `beforeinstallprompt`, the app exposes an install button. On iPhone or iPad, open the page in Safari and choose **Share → Add to Home Screen**. Settings are not retained between sessions unless the user explicitly enables IndexedDB saving.

This utility has no persistent app bar, so hide-on-scroll behavior is not applicable. A contextual scroll-to-top button appears only after the user scrolls down a long screen; it respects safe-area insets and reduced-motion preferences.

## Run locally

No build step or dependency installation is required. Serve the directory over HTTP so the browser loads the external JavaScript and CSS correctly:

```bash
python -m http.server 8080
```

Open <http://localhost:8080>, then enter an OpenRouter TTS model ID and API key. The key is used in memory unless you enable **Remember settings on this device**.

## GitHub Pages deployment

The `.github/workflows/deploy-pages.yml` workflow deploys the static app to GitHub Pages on pushes to `main`; it can also be run manually from the Actions tab. It stages only the app shell and install icons, not repository documentation or other files.

Before the first deployment, open **Settings → Pages → Build and deployment** and select **GitHub Actions** as the publishing source. No API key or deployment secret is needed: BYOK credentials stay in the user's browser and are never part of the Pages artifact.

## OpenRouter request

The app sends a browser-side `POST` request to:

```text
https://openrouter.ai/api/v1/audio/speech
```

with a model ID entered by the user:

```json
{
  "model": "provider/model-name",
  "input": "Text to speak",
  "voice": "model-specific-voice",
  "response_format": "pcm"
}
```

The `voice` property is omitted when left blank. A user-entered model ID must actually support OpenRouter's `/audio/speech` endpoint and PCM output; arbitrary OpenRouter models are not automatically TTS-compatible.

OpenRouter returns raw audio bytes. The app reads the optional PCM sample-rate and channel metadata from `Content-Type`, creates a WAV container locally, and exposes it through the audio player and download link. The `X-Generation-Id` response header is shown when available.

Reference: <https://openrouter.ai/google/gemini-3.8-flash-lite-tts>

## Long text and context

The app treats each generated segment as an independent TTS request; the model does not carry context from one segment into the next. By default, text is split at a target of 4,000 characters, preferring paragraph and sentence boundaries. The target can be adjusted from 1,000 to 8,000 characters; it is not a token limit, so check the selected model's own constraints. Up to 20 segments are sent sequentially, after a confirmation that each request may be billed separately.

For example, 3,000 English words often become roughly 4–6 requests at the default size, depending on spacing and punctuation. This makes failures easier to identify and keeps individual requests smaller, but each seam can slightly affect prosody. Multi-segment output is merged only when every response is compatible raw PCM with matching sample rate and channels. If the selected model returns another format or changes PCM metadata, generation stops with an explanation rather than producing a corrupt file. A failed run does not save partial segments for resume, so retrying may bill already completed segments again. Text and audio remain in page memory and are not written to persistent storage.

OpenRouter's current model page for Gemini 3.8 Flash Lite TTS lists an 8K-token context window; tokens are not characters, and this figure applies only to that model. The speech endpoint does not define one universal character limit for every model. Tokenization, audio output limits, and voice support vary, so neither 3,000 words nor a character count guarantees a request will fit. Confirm the selected model's current constraints; increase the character target only when appropriate. A 20-minute mono recording at 24 kHz/16-bit PCM is about 58 MB before browser playback memory, so low-memory phones may work better with shorter sections. Reference: <https://openrouter.ai/google/gemini-3.8-flash-lite-tts>.

## BYOK security notes

- The API key is sent only to OpenRouter for a generation request and is never sent to a project backend.
- Settings are memory-only by default. If the user explicitly opts in, the model, key, voice, and chunk size are stored in this browser's IndexedDB.
- IndexedDB is not encrypted by this app. Same-origin scripts and anyone with access to the browser profile may be able to read the saved key. Do not save it on a shared or untrusted device.
- **Forget saved settings** deletes the local IndexedDB record; it does not revoke the OpenRouter key. Revoke keys separately in OpenRouter if needed.
- The key is never written to `localStorage`, embedded in source, or cached by the Service Worker.
- Do not publish a private key in the repository or hard-code one into a public deployment. For stronger key isolation, use a trusted server-side proxy.

## Project files

- `index.html` — accessible page structure, PWA metadata, and CSP.
- `manifest.webmanifest` — standalone app identity, launch scope, colors, and icons.
- `service-worker.js` — versioned app-shell caching and update activation.
- `icons/` — install and iOS home-screen icons.
- `styles.css` — page styling, safe-area layout, and update/offline states.
- `app.js` — editable OpenRouter TTS requests, long-text chunking, IndexedDB settings, PCM-to-WAV conversion, and PWA lifecycle.
