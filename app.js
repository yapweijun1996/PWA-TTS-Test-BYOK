    (() => {
      "use strict";

      const API_URL = "https://openrouter.ai/api/v1/audio/speech";
      const MODEL = "google/gemini-3.8-flash-lite-tts";
      const RESPONSE_FORMAT = "pcm";
      const DEFAULT_PCM_SAMPLE_RATE = 24000;

      const VOICES = [
        "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda",
        "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus",
        "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
        "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima",
        "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"
      ];

      const apiKeyEl = document.getElementById("apiKey");
      const toggleKeyEl = document.getElementById("toggleKey");
      const voiceEl = document.getElementById("voice");
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

      let currentObjectUrl = null;

      function initVoices() {
        for (const voice of VOICES) {
          const option = document.createElement("option");
          option.value = voice;
          option.textContent = voice;
          if (voice === "Kore") option.selected = true;
          voiceEl.appendChild(option);
        }
      }

      function updateCounter() {
        const count = textEl.value.length;
        counterEl.textContent = `${count.toLocaleString()} character${count === 1 ? "" : "s"}`;
      }

      function setStatus(message = "", type = "info") {
        statusEl.textContent = message;
        statusEl.className = message ? `status show ${type}` : "status";
      }

      function setLoading(loading) {
        generateBtn.disabled = loading;
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
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace("T", "_")
          .replace("Z", "");
        return `gemini-3.8-flash-lite-tts_${voiceEl.value}_${stamp}.${ext}`;
      }

      function parsePcmMeta(contentType) {
        const rateMatch = contentType.match(/(?:rate|sample_rate)\s*=\s*(\d+)/i);
        const channelsMatch = contentType.match(/channels\s*=\s*(\d+)/i);
        return {
          sampleRate: rateMatch ? Number(rateMatch[1]) : DEFAULT_PCM_SAMPLE_RATE,
          channels: channelsMatch ? Number(channelsMatch[1]) : 1
        };
      }

      function pcm16LeToWav(pcmBuffer, sampleRate = DEFAULT_PCM_SAMPLE_RATE, channels = 1) {
        const pcm = new Uint8Array(pcmBuffer);
        const headerSize = 44;
        const out = new ArrayBuffer(headerSize + pcm.byteLength);
        const view = new DataView(out);
        const bytes = new Uint8Array(out);

        function writeAscii(offset, text) {
          for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
          }
        }

        writeAscii(0, "RIFF");
        view.setUint32(4, 36 + pcm.byteLength, true);
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
        view.setUint32(40, pcm.byteLength, true);
        bytes.set(pcm, headerSize);

        return new Blob([out], { type: "audio/wav" });
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

      async function generate() {
        const apiKey = apiKeyEl.value.trim();
        const text = textEl.value.trim();
        const voice = voiceEl.value;

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

        setLoading(true);
        setStatus("Sending TTS request to OpenRouter…", "info");

        try {
          const response = await fetch(API_URL, {
            method: "POST",
            headers: requestHeaders(apiKey),
            body: JSON.stringify({
              model: MODEL,
              input: text,
              voice,
              response_format: RESPONSE_FORMAT
            })
          });

          if (!response.ok) {
            throw new Error(await readApiError(response));
          }

          const contentType = (response.headers.get("content-type") || "")
            .toLowerCase()
            .split(",")[0]
            .trim();

          const rawBuffer = await response.arrayBuffer();

          if (!rawBuffer.byteLength) {
            throw new Error("OpenRouter returned an empty audio response.");
          }

          const { blob: audioBlob, extension } = decodeAudioResponse(
            rawBuffer,
            contentType
          );

          if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
          }

          currentObjectUrl = URL.createObjectURL(audioBlob);
          const filename = safeFilename(extension);
          const generationId =
            response.headers.get("x-generation-id") ||
            response.headers.get("X-Generation-Id") ||
            "Not provided";

          audioEl.src = currentObjectUrl;
          downloadEl.href = currentObjectUrl;
          downloadEl.download = filename;
          downloadEl.textContent = `Download ${extension.toUpperCase()}`;

          resultVoiceEl.textContent = voice;
          resultFileEl.textContent = `${filename} · ${humanBytes(audioBlob.size)}`;
          generationIdEl.textContent = generationId;
          resultBadgeEl.textContent = extension.toUpperCase();
          resultEl.classList.add("show");

          setStatus("Speech generated successfully.", "success");

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

      initVoices();
      updateCounter();
    })();
