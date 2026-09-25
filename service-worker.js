"use strict";

const CACHE_PREFIX = "simple-tts-shell-";
const CACHE_VERSION = "v10";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./icons/app-192.png",
  "./icons/app-512.png",
  "./icons/app-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

const scopeUrl = new URL(self.registration.scope);
const appEntryUrl = new URL("./", scopeUrl).href;
const indexUrl = new URL("./index.html", scopeUrl).href;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map((path) => new URL(path, scopeUrl).href));

    // Activate the first installation immediately; later versions wait for user consent.
    if (!self.registration.active) {
      await self.skipWaiting();
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);

  // Never intercept writes or third-party requests such as OpenRouter TTS calls.
  if (request.method !== "GET" || requestUrl.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    const isAppEntry =
      requestUrl.pathname === scopeUrl.pathname ||
      requestUrl.pathname === new URL(indexUrl).pathname;

    if (!isAppEntry) return;

    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-cache" });
        if (response.ok && new URL(response.url).origin === self.location.origin) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(indexUrl, response.clone());
        }
        return response;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(request)) || (await cache.match(indexUrl)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(request);
    if (cachedResponse) return cachedResponse;

    // Do not persist arbitrary or user-generated responses in the app-shell cache.
    return fetch(request);
  })());
});
