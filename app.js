    (() => {
      "use strict";

      const API_URL = "https://openrouter.ai/api/v1/audio/speech";
      const RESPONSE_FORMAT = "pcm";
      const DEFAULT_PCM_SAMPLE_RATE = 24000;
      const DEFAULT_CHUNK_SIZE = 4000;
      const MAX_TTS_SEGMENTS = 20;
      const MIN_CHUNK_SIZE = 1000;
      const MAX_CHUNK_SIZE = 8000;
      const SETTINGS_DB_NAME = "simple-tts-settings";
      const SETTINGS_DB_VERSION = 1;
      const SETTINGS_STORE_NAME = "settings";
      const SETTINGS_RECORD_ID = "user-settings";

      const modelEl = document.getElementById("model");
      const apiKeyEl = document.getElementById("apiKey");
      const toggleKeyEl = document.getElementById("toggleKey");
      const rememberSettingsEl = document.getElementById("rememberSettings");
      const forgetSettingsEl = document.getElementById("forgetSettings");
      const settingsStatusEl = document.getElementById("settingsStatus");
      const voiceEl = document.getElementById("voice");
      const chunkSizeEl = document.getElementById("chunkSize");
      const textEl = document.getElementById("text");
      const counterEl = document.getElementById("counter");
      const clearBtn = document.getElementById("clearBtn");
      const generateBtn = document.getElementById("generateBtn");
      const statusEl = document.getElementById("status");
      const resultEl = document.getElementById("result");
      const resultBadgeEl = document.getElementById("resultBadge");
      const audioEl = document.getElementById("audio");
      const downloadEl = document.getElementById("download");
      const resultVoiceEl = document.getElementById("resultVoice");
      const resultFileEl = document.getElementById("resultFile");
      const generationIdEl = document.getElementById("generationId");
      const offlineNoticeEl = document.getElementById("offlineNotice");
      const pwaStatusNoticeEl = document.getElementById("pwaStatusNotice");
      const updateNoticeEl = document.getElementById("updateNotice");
      const updateTitleEl = document.getElementById("updateTitle");
      const updateButtonEl = document.getElementById("updateButton");
      const installNoticeEl = document.getElementById("installNotice");
      const installButtonEl = document.getElementById("installButton");
      const updateOverlayEl = document.getElementById("updateOverlay");
      const updateProgressEl = document.getElementById("updateProgress");
      const scrollTopButtonEl = document.getElementById("scrollTopButton");

      let currentObjectUrl = null;
      let isGenerating = false;
      let updateInProgress = false;
      let updateCheckInProgress = false;
      let updateTimeoutId = null;
      let serviceWorkerRegistration = null;
      let deferredInstallPrompt = null;
      let settingsDbPromise = null;
      let settingsOperationQueue = Promise.resolve();
      let settingsSaveTimer = null;
      let settingsControlsTouched = false;

      function updateCounter() {
        const text = textEl.value.trim();
        const characterCount = text.length;
        const wordCount = text ? text.split(/\s+/u).length : 0;
        counterEl.textContent = `${wordCount.toLocaleString()} words · ${characterCount.toLocaleString()} characters`;
      }

      function setStatus(message = "", type = "info") {
        statusEl.textContent = message;
        statusEl.className = message ? `status show ${type}` : "status";
      }

      function setLoading(loading) {
        isGenerating = loading;
        generateBtn.disabled = loading || navigator.onLine === false;
        clearBtn.disabled = loading;
        voiceEl.disabled = loading;
        textEl.disabled = loading;

        generateBtn.innerHTML = loading
          ? '<span class="spinner" aria-hidden="true"></span>Generating…'
          : "Generate Speech";
      }

      function humanBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      }

      function safeFilename(ext) {
        const safePart = (value, fallback) =>
          value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 40) || fallback;
        const model = safePart(modelEl.value.split("/").pop(), "tts");
        const voice = safePart(voiceEl.value, "default-voice");
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace("T", "_")
          .replace("Z", "");
        return `${model}_${voice}_${stamp}.${ext}`;
      }

      function parsePcmMeta(contentType) {
        const rateMatch = contentType.match(/(?:rate|sample_rate)\s*=\s*(\d+)/i);
        const channelsMatch = contentType.match(/channels\s*=\s*(\d+)/i);
        return {
          sampleRate: rateMatch ? Number(rateMatch[1]) : DEFAULT_PCM_SAMPLE_RATE,
          channels: channelsMatch ? Number(channelsMatch[1]) : 1
        };
      }

      function isRawPcmResponse(contentType) {
        return (
          contentType.includes("audio/pcm") ||
          contentType.includes("application/octet-stream") ||
          !contentType
        );
      }

      function pcm16LeToWav(pcmBuffer, sampleRate = DEFAULT_PCM_SAMPLE_RATE, channels = 1) {
        return pcmBuffersToWav([pcmBuffer], sampleRate, channels);
      }

      function pcmBuffersToWav(pcmBuffers, sampleRate, channels) {
        const headerSize = 44;
        const dataSize = pcmBuffers.reduce((total, buffer) => total + buffer.byteLength, 0);
        if (dataSize > 0xffffffff - 36) {
          throw new Error("The generated audio is too large for a standard WAV file.");
        }
        if (
          !Number.isInteger(sampleRate) || sampleRate <= 0 ||
          !Number.isInteger(channels) || channels <= 0 ||
          dataSize % (channels * 2) !== 0
        ) {
          throw new Error("The model returned invalid PCM format metadata.");
        }

        const headerBuffer = new ArrayBuffer(headerSize);
        const view = new DataView(headerBuffer);

        function writeAscii(offset, text) {
          for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
          }
        }

        writeAscii(0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        writeAscii(8, "WAVE");
        writeAscii(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * channels * 2, true);
        view.setUint16(32, channels * 2, true);
        view.setUint16(34, 16, true);
        writeAscii(36, "data");
        view.setUint32(40, dataSize, true);

        return new Blob([headerBuffer, ...pcmBuffers], { type: "audio/wav" });
      }

      function requestHeaders(apiKey) {
        const headers = {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Simple TTS BYOK"
        };

        if (window.location.protocol.startsWith("http")) {
          headers["HTTP-Referer"] = window.location.href;
        }

        return headers;
      }

      function decodeAudioResponse(rawBuffer, contentType) {
        if (
          contentType.includes("audio/pcm") ||
          contentType.includes("application/octet-stream") ||
          !contentType
        ) {
          const meta = parsePcmMeta(contentType);
          return {
            blob: pcm16LeToWav(rawBuffer, meta.sampleRate, meta.channels),
            extension: "wav"
          };
        }

        if (
          contentType.includes("audio/wav") ||
          contentType.includes("audio/x-wav") ||
          contentType.includes("wave")
        ) {
          return {
            blob: new Blob([rawBuffer], { type: "audio/wav" }),
            extension: "wav"
          };
        }

        if (contentType.includes("audio/mpeg") || contentType.includes("audio/mp3")) {
          return {
            blob: new Blob([rawBuffer], { type: "audio/mpeg" }),
            extension: "mp3"
          };
        }

        const preview = new TextDecoder().decode(rawBuffer.slice(0, 500));
        throw new Error(
          `Unexpected response type "${contentType || "unknown"}". ` +
          (preview ? `Response: ${preview}` : "")
        );
      }

      function splitTextIntoChunks(text, maxChars) {
        const chunks = [];
        let remaining = text.trim();
        const minimumPreferredBoundary = Math.floor(maxChars * 0.5);

        while (remaining.length > maxChars) {
          const window = remaining.slice(0, maxChars);
          let splitAt = remaining.lastIndexOf("\n\n", maxChars);

          if (splitAt < minimumPreferredBoundary) {
            const sentenceEnds = [...window.matchAll(/[.!?。！？](?:["'”’)}\]]*)\s+/gu)];
            const lastSentenceEnd = sentenceEnds.at(-1);
            splitAt = lastSentenceEnd
              ? lastSentenceEnd.index + lastSentenceEnd[0].length
              : -1;
          }

          if (splitAt < minimumPreferredBoundary) {
            splitAt = Math.max(remaining.lastIndexOf(" ", maxChars), remaining.lastIndexOf("\n", maxChars));
          }
          if (splitAt <= 0) splitAt = maxChars;

          const previousCodeUnit = remaining.charCodeAt(splitAt - 1);
          const nextCodeUnit = remaining.charCodeAt(splitAt);
          if (
            previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff &&
            nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff
          ) {
            splitAt -= 1;
          }

          const chunk = remaining.slice(0, splitAt).trim();
          if (chunk) chunks.push(chunk);
          remaining = remaining.slice(splitAt).trim();
        }

        if (remaining) chunks.push(remaining);
        return chunks;
      }

      function mergePcmChunks(chunks) {
        const metadata = parsePcmMeta(chunks[0].contentType);
        let totalBytes = 0;

        for (const chunk of chunks) {
          const contentType = chunk.contentType;
          if (!isRawPcmResponse(contentType)) {
            throw new Error(
              `This model returned ${contentType || "an unknown audio format"} for split input. ` +
              "Long-text merging currently requires PCM output. Increase the request size or choose a PCM-compatible TTS model."
            );
          }

          const chunkMetadata = parsePcmMeta(contentType);
          if (
            chunkMetadata.sampleRate !== metadata.sampleRate ||
            chunkMetadata.channels !== metadata.channels
          ) {
            throw new Error("The model changed PCM format between segments, so the audio cannot be merged safely.");
          }

          const audioBytes = new Uint8Array(chunk.rawBuffer);
          if (audioBytes.byteLength % (metadata.channels * 2) !== 0) {
            throw new Error("A PCM segment ended on an incomplete audio sample; the segments cannot be merged safely.");
          }
          totalBytes += audioBytes.byteLength;
        }

        if (metadata.sampleRate <= 0 || metadata.channels <= 0 || totalBytes === 0) {
          throw new Error("The model returned invalid PCM format metadata.");
        }

        return {
          blob: pcmBuffersToWav(
            chunks.map((chunk) => chunk.rawBuffer),
            metadata.sampleRate,
            metadata.channels
          ),
          extension: "wav"
        };
      }

      async function readApiError(response) {
        const raw = await response.text();
        if (!raw) return `HTTP ${response.status} ${response.statusText}`;

        try {
          const data = JSON.parse(raw);
          return (
            data?.error?.message ||
            data?.error ||
            data?.message ||
            raw
          );
        } catch {
          return raw;
        }
      }

      function openSettingsDb() {
        if (!("indexedDB" in window)) {
          return Promise.reject(new Error("IndexedDB is not available in this browser."));
        }

        if (!settingsDbPromise) {
          const requestPromise = new Promise((resolve, reject) => {
            const request = window.indexedDB.open(SETTINGS_DB_NAME, SETTINGS_DB_VERSION);

            request.onupgradeneeded = () => {
              const database = request.result;
              if (!database.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
                database.createObjectStore(SETTINGS_STORE_NAME, { keyPath: "id" });
              }
            };
            request.onsuccess = () => {
              const database = request.result;
              database.onversionchange = () => {
                database.close();
                settingsDbPromise = null;
              };
              resolve(database);
            };
            request.onerror = () => reject(request.error || new Error("Could not open IndexedDB."));
            request.onblocked = () => reject(new Error("The settings database is blocked by another tab."));
          });

          settingsDbPromise = requestPromise;
          requestPromise.catch(() => {
            if (settingsDbPromise === requestPromise) settingsDbPromise = null;
          });
        }

        return settingsDbPromise;
      }

      async function readSavedSettings() {
        const database = await openSettingsDb();
        return new Promise((resolve, reject) => {
          const transaction = database.transaction(SETTINGS_STORE_NAME, "readonly");
          const request = transaction.objectStore(SETTINGS_STORE_NAME).get(SETTINGS_RECORD_ID);
          let savedSettings = null;

          request.onsuccess = () => {
            savedSettings = request.result || null;
          };
          transaction.oncomplete = () => resolve(savedSettings);
          transaction.onerror = () => reject(transaction.error || new Error("Could not read saved settings."));
          transaction.onabort = () => reject(transaction.error || new Error("Reading saved settings was aborted."));
        });
      }

      async function writeSavedSettings(settings) {
        const database = await openSettingsDb();
        return new Promise((resolve, reject) => {
          const transaction = database.transaction(SETTINGS_STORE_NAME, "readwrite");
          transaction.objectStore(SETTINGS_STORE_NAME).put({
            id: SETTINGS_RECORD_ID,
            ...settings
          });
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error || new Error("Could not save settings."));
          transaction.onabort = () => reject(transaction.error || new Error("Saving settings was aborted."));
        });
      }

      async function deleteSavedSettings() {
        const database = await openSettingsDb();
        return new Promise((resolve, reject) => {
          const transaction = database.transaction(SETTINGS_STORE_NAME, "readwrite");
          transaction.objectStore(SETTINGS_STORE_NAME).delete(SETTINGS_RECORD_ID);
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error || new Error("Could not remove saved settings."));
          transaction.onabort = () => reject(transaction.error || new Error("Removing saved settings was aborted."));
        });
      }

      function queueSettingsOperation(operation) {
        settingsOperationQueue = settingsOperationQueue.catch(() => {}).then(operation);
        return settingsOperationQueue;
      }

      function currentSettingsSnapshot() {
        const chunkSize = Number(chunkSizeEl.value);
        return {
          model: modelEl.value.trim(),
          apiKey: apiKeyEl.value.trim(),
          voice: voiceEl.value.trim(),
          chunkSize: Number.isInteger(chunkSize) && chunkSize >= MIN_CHUNK_SIZE && chunkSize <= MAX_CHUNK_SIZE
            ? chunkSize
            : DEFAULT_CHUNK_SIZE
        };
      }

      function setSettingsStatus(message) {
        settingsStatusEl.textContent = message;
        settingsStatusEl.classList.toggle("settings-error", /could not|failed|unavailable/i.test(message));
      }

      function scheduleSettingsSave() {
        settingsControlsTouched = true;
        if (!rememberSettingsEl.checked) return;

        window.clearTimeout(settingsSaveTimer);
        setSettingsStatus("Saving settings…");
        const snapshot = currentSettingsSnapshot();
        settingsSaveTimer = window.setTimeout(() => {
          queueSettingsOperation(() => writeSavedSettings(snapshot))
            .then(() => {
              forgetSettingsEl.disabled = false;
              setSettingsStatus("Settings saved on this device.");
            })
            .catch(() => {
              setSettingsStatus("Could not save settings to IndexedDB. They remain in this page only.");
            });
        }, 350);
      }

      async function forgetSettings() {
        window.clearTimeout(settingsSaveTimer);
        try {
          await queueSettingsOperation(deleteSavedSettings);
          rememberSettingsEl.checked = false;
          forgetSettingsEl.disabled = true;
          setSettingsStatus("Saved settings removed. Current fields stay available until this page closes.");
        } catch {
          rememberSettingsEl.checked = true;
          setSettingsStatus("Could not remove saved settings from IndexedDB.");
        }
      }

      async function loadSavedSettings() {
        if (!("indexedDB" in window)) {
          rememberSettingsEl.disabled = true;
          setSettingsStatus("IndexedDB is unavailable; settings will not persist.");
          return;
        }

        try {
          const saved = await readSavedSettings();
          if (!saved || settingsControlsTouched) return;

          modelEl.value = saved.model || "";
          apiKeyEl.value = saved.apiKey || "";
          voiceEl.value = saved.voice || "";
          const savedChunkSize = Number(saved.chunkSize);
          chunkSizeEl.value = String(
            Number.isInteger(savedChunkSize) && savedChunkSize >= MIN_CHUNK_SIZE && savedChunkSize <= MAX_CHUNK_SIZE
              ? savedChunkSize
              : DEFAULT_CHUNK_SIZE
          );
          rememberSettingsEl.checked = true;
          forgetSettingsEl.disabled = false;
          setSettingsStatus("Saved settings loaded from this device.");
        } catch {
          setSettingsStatus("Could not read saved settings from IndexedDB.");
        }
      }

      function updateScrollTopVisibility() {
        const longPage = document.documentElement.scrollHeight > window.innerHeight * 1.8;
        const scrollThreshold = Math.min(240, window.innerHeight * 0.5);
        scrollTopButtonEl.hidden = !longPage || window.scrollY <= scrollThreshold;
      }

      function updateConnectivity() {
        const offline = navigator.onLine === false;
        offlineNoticeEl.hidden = !offline;
        generateBtn.disabled = isGenerating || offline;
      }

      function showPwaStatus(message) {
        pwaStatusNoticeEl.textContent = message;
        pwaStatusNoticeEl.hidden = !message;
      }

      function setInstallNoticeVisible(visible) {
        installNoticeEl.hidden = !visible;
      }

      function requestWorkerVersion(worker) {
        return new Promise((resolve) => {
          if (typeof MessageChannel === "undefined") {
            resolve(null);
            return;
          }

          const channel = new MessageChannel();
          let settled = false;
          const finish = (version) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeoutId);
            channel.port1.close();
            resolve(version);
          };
          const timeoutId = window.setTimeout(() => finish(null), 1500);

          channel.port1.onmessage = ({ data }) => {
            const version = data?.type === "VERSION" ? data.version : null;
            finish(typeof version === "string" && /^[a-zA-Z0-9._-]{1,32}$/.test(version) ? version : null);
          };

          try {
            worker.postMessage({ type: "GET_VERSION" }, [channel.port2]);
          } catch {
            finish(null);
          }
        });
      }

      function resetUpdateCheckButton() {
        const version = updateNoticeEl.dataset.version;
        updateButtonEl.textContent = version ? `Check updates · ${version}` : "Check updates";
        updateButtonEl.disabled = false;
      }

      async function showAvailableUpdate(registration) {
        const waitingWorker = registration.waiting;
        if (!waitingWorker || !navigator.serviceWorker.controller) return false;

        updateNoticeEl.hidden = false;
        const version = await requestWorkerVersion(waitingWorker);
        if (registration.waiting !== waitingWorker || updateNoticeEl.hidden) return false;

        const displayVersion = version || updateNoticeEl.dataset.version;
        if (!displayVersion) return false;

        updateTitleEl.textContent = `Update available: ${displayVersion}`;
        updateButtonEl.textContent = `Update to ${displayVersion}`;
        updateButtonEl.disabled = updateCheckInProgress;
        return true;
      }

      function checkForWaitingUpdate(registration) {
        void showAvailableUpdate(registration);
      }

      function watchForWorkerUpdate(registration) {
        registration.addEventListener("updatefound", () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;

          const handleWorkerStateChange = () => {
            if (installingWorker.state === "redundant") {
              updateNoticeEl.hidden = true;
              resetUpdateCheckButton();
              showPwaStatus(
                navigator.serviceWorker.controller
                  ? "The new app version could not be installed. The current version remains available."
                  : "The offline app shell could not be installed. Try again when online."
              );
              return;
            }

            if (
              installingWorker.state === "installed" &&
              navigator.serviceWorker.controller &&
              registration.waiting
            ) {
              void showAvailableUpdate(registration);
              showPwaStatus("");
            }
          };

          installingWorker.addEventListener("statechange", handleWorkerStateChange);
          handleWorkerStateChange();
        });
      }

      async function registerServiceWorker() {
        if (!("serviceWorker" in navigator)) {
          showPwaStatus("Offline app support is unavailable in this browser. Speech generation still works online.");
          return;
        }

        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (!updateInProgress) return;
          window.clearTimeout(updateTimeoutId);
          updateProgressEl.textContent = "Update installed. Reloading the app…";
          window.requestAnimationFrame(() => window.location.reload());
        });

        try {
          serviceWorkerRegistration = await navigator.serviceWorker.register(
            "./service-worker.js",
            { updateViaCache: "none" }
          );
          checkForWaitingUpdate(serviceWorkerRegistration);
          watchForWorkerUpdate(serviceWorkerRegistration);

          if (navigator.onLine) {
            // The browser checks the worker on page load; ignore transient offline/update-check failures.
            serviceWorkerRegistration.update().catch(() => {});
          }
        } catch {
          showPwaStatus("Offline caching and update notifications could not start. Use HTTPS or localhost in a Service Worker-capable browser.");
        }
      }

      async function checkForAvailableUpdate() {
        if (updateInProgress || updateCheckInProgress) return;

        const registration = serviceWorkerRegistration;
        if (!registration) {
          showPwaStatus("Update checking is unavailable until the Service Worker is ready.");
          return;
        }

        if (registration.waiting) {
          applyAvailableUpdate();
          return;
        }

        updateCheckInProgress = true;
        updateButtonEl.disabled = true;
        updateButtonEl.textContent = `Checking · ${updateNoticeEl.dataset.version}`;
        updateNoticeEl.hidden = true;
        showPwaStatus("");

        try {
          await registration.update();
          if (registration.waiting) {
            await showAvailableUpdate(registration);
            showPwaStatus("A new version is ready. Select the version button again to install it.");
          } else {
            showPwaStatus(`You're using ${updateNoticeEl.dataset.version}; no update is available.`);
          }
        } catch {
          showPwaStatus("Could not check for updates. Check your connection and try again.");
        } finally {
          updateCheckInProgress = false;
          if (registration.waiting) {
            updateButtonEl.disabled = false;
          } else {
            resetUpdateCheckButton();
          }
        }
      }

      function applyAvailableUpdate() {
        if (updateInProgress) return;

        const waitingWorker = serviceWorkerRegistration?.waiting;
        if (!waitingWorker) {
          updateNoticeEl.hidden = true;
          resetUpdateCheckButton();
          showPwaStatus("No update is waiting. Select Check updates to check again.");
          return;
        }

        updateInProgress = true;
        updateButtonEl.disabled = true;
        updateProgressEl.textContent = "Installing the latest version…";
        updateOverlayEl.hidden = false;
        showPwaStatus("");

        updateTimeoutId = window.setTimeout(() => {
          updateInProgress = false;
          updateButtonEl.disabled = false;
          updateOverlayEl.hidden = true;
          showPwaStatus("The update did not finish. Check your connection and try again.");
        }, 15000);

        waitingWorker.postMessage({ type: "SKIP_WAITING" });
      }

      async function promptInstall() {
        if (!deferredInstallPrompt) return;

        const installPrompt = deferredInstallPrompt;
        deferredInstallPrompt = null;
        installButtonEl.disabled = true;

        try {
          await installPrompt.prompt();
          await installPrompt.userChoice;
          setInstallNoticeVisible(false);
        } catch {
          setInstallNoticeVisible(false);
          showPwaStatus("The install prompt could not be opened. Use your browser's install option instead.");
        } finally {
          installButtonEl.disabled = false;
        }
      }

      async function generate() {
        const apiKey = apiKeyEl.value.trim();
        const model = modelEl.value.trim();
        const text = textEl.value.trim();
        const voice = voiceEl.value.trim();
        const maxChars = Number(chunkSizeEl.value);

        if (!model) {
          setStatus("Enter an OpenRouter TTS model ID first.", "error");
          modelEl.focus();
          return;
        }

        if (!apiKey) {
          setStatus("Enter your OpenRouter API key first.", "error");
          apiKeyEl.focus();
          return;
        }

        if (!text) {
          setStatus("Enter some text to generate speech.", "error");
          textEl.focus();
          return;
        }

        if (!Number.isInteger(maxChars) || maxChars < MIN_CHUNK_SIZE || maxChars > MAX_CHUNK_SIZE) {
          setStatus(`Set the request size between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE} characters.`, "error");
          chunkSizeEl.focus();
          return;
        }

        const textChunks = splitTextIntoChunks(text, maxChars);
        if (textChunks.length > MAX_TTS_SEGMENTS) {
          setStatus(`This text needs ${textChunks.length} requests. Reduce the text or increase the request size; the limit is ${MAX_TTS_SEGMENTS} segments.`, "error");
          return;
        }
        if (textChunks.length > 1 && !window.confirm(
          `This text will be sent as ${textChunks.length} sequential OpenRouter requests. Each request may be billed separately. Continue?`
        )) {
          return;
        }

        setLoading(true);
        const audioResponses = [];
        const generationIds = [];

        try {
          for (let index = 0; index < textChunks.length; index++) {
            setStatus(
              textChunks.length > 1
                ? `Generating segment ${index + 1} of ${textChunks.length}…`
                : "Sending TTS request to OpenRouter…",
              "info"
            );

            const payload = {
              model,
              input: textChunks[index],
              response_format: RESPONSE_FORMAT
            };
            if (voice) payload.voice = voice;

            const response = await fetch(API_URL, {
              method: "POST",
              headers: requestHeaders(apiKey),
              body: JSON.stringify(payload)
            });

            if (!response.ok) {
              const details = await readApiError(response);
              const segment = textChunks.length > 1 ? `Segment ${index + 1}/${textChunks.length} failed: ` : "";
              throw new Error(`${segment}${details}`);
            }

            const contentType = (response.headers.get("content-type") || "")
              .toLowerCase()
              .split(",")[0]
              .trim();

            if (textChunks.length > 1) {
              if (!isRawPcmResponse(contentType)) {
                throw new Error(
                  `Segment ${index + 1}/${textChunks.length} returned ${contentType || "an unknown audio format"}. ` +
                  "Split-text merging currently requires PCM output."
                );
              }
              if (audioResponses.length > 0) {
                const previousFormat = parsePcmMeta(audioResponses[0].contentType);
                const currentFormat = parsePcmMeta(contentType);
                if (
                  previousFormat.sampleRate !== currentFormat.sampleRate ||
                  previousFormat.channels !== currentFormat.channels
                ) {
                  throw new Error("The model changed PCM format between segments; generation stopped to avoid a corrupt audio file.");
                }
              }
            }

            const rawBuffer = await response.arrayBuffer();

            if (!rawBuffer.byteLength) {
              throw new Error(`OpenRouter returned an empty audio response for segment ${index + 1}.`);
            }

            audioResponses.push({ rawBuffer, contentType });
            const generationId = response.headers.get("x-generation-id");
            if (generationId) generationIds.push(generationId);
          }

          const { blob: audioBlob, extension } = audioResponses.length === 1
            ? decodeAudioResponse(audioResponses[0].rawBuffer, audioResponses[0].contentType)
            : mergePcmChunks(audioResponses);

          if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
          }

          currentObjectUrl = URL.createObjectURL(audioBlob);
          const filename = safeFilename(extension);
          const generationId = generationIds.length === 0
            ? "Not provided"
            : generationIds.length === 1
              ? generationIds[0]
              : `${generationIds.length} segment IDs; first: ${generationIds[0]}`;

          audioEl.src = currentObjectUrl;
          downloadEl.href = currentObjectUrl;
          downloadEl.download = filename;
          downloadEl.textContent = `Download ${extension.toUpperCase()}`;

          resultVoiceEl.textContent = voice || "Model default";
          resultFileEl.textContent = `${filename} · ${humanBytes(audioBlob.size)}`;
          generationIdEl.textContent = generationId;
          resultBadgeEl.textContent = extension.toUpperCase();
          resultEl.classList.add("show");
          updateScrollTopVisibility();

          setStatus(
            textChunks.length > 1
              ? `Speech generated successfully from ${textChunks.length} segments.`
              : "Speech generated successfully.",
            "success"
          );

          try {
            await audioEl.play();
          } catch {
            // Autoplay can be blocked by browser policy; controls remain available.
          }
        } catch (error) {
          console.error(error);
          setStatus(
            error instanceof Error
              ? error.message
              : "Unable to generate speech.",
            "error"
          );
        } finally {
          setLoading(false);
        }
      }

      toggleKeyEl.addEventListener("click", () => {
        const hidden = apiKeyEl.type === "password";
        apiKeyEl.type = hidden ? "text" : "password";
        toggleKeyEl.textContent = hidden ? "Hide" : "Show";
        toggleKeyEl.setAttribute(
          "aria-label",
          hidden ? "Hide API key" : "Show API key"
        );
      });

      window.addEventListener("online", () => {
        updateConnectivity();
        serviceWorkerRegistration?.update().catch(() => {});
      });
      window.addEventListener("offline", updateConnectivity);

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && navigator.onLine) {
          serviceWorkerRegistration?.update().catch(() => {});
        }
      });

      window.addEventListener("beforeinstallprompt", (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        setInstallNoticeVisible(true);
      });

      window.addEventListener("appinstalled", () => {
        deferredInstallPrompt = null;
        setInstallNoticeVisible(false);
      });

      updateButtonEl.addEventListener("click", checkForAvailableUpdate);
      installButtonEl.addEventListener("click", promptInstall);
      forgetSettingsEl.addEventListener("click", () => {
        settingsControlsTouched = true;
        forgetSettings();
      });
      rememberSettingsEl.addEventListener("change", () => {
        settingsControlsTouched = true;
        if (rememberSettingsEl.checked) {
          scheduleSettingsSave();
        } else {
          forgetSettings();
        }
      });
      for (const settingsInput of [modelEl, apiKeyEl, voiceEl, chunkSizeEl]) {
        settingsInput.addEventListener("input", scheduleSettingsSave);
      }
      scrollTopButtonEl.addEventListener("click", () => {
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
      });
      window.addEventListener("scroll", updateScrollTopVisibility, { passive: true });
      window.addEventListener("resize", updateScrollTopVisibility);
      textEl.addEventListener("input", updateCounter);

      clearBtn.addEventListener("click", () => {
        textEl.value = "";
        updateCounter();
        setStatus("");
        textEl.focus();
      });

      generateBtn.addEventListener("click", generate);

      textEl.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          generate();
        }
      });

      window.addEventListener("beforeunload", () => {
        if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      });

      chunkSizeEl.value = String(DEFAULT_CHUNK_SIZE);
      updateCounter();
      updateConnectivity();
      updateScrollTopVisibility();
      loadSavedSettings();
      registerServiceWorker();
    })();
