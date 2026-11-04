/* Pulsar RM — Service Worker
   Estrategia: "red primero, caché de respaldo".
   - Con internet: siempre carga la versión más nueva y la guarda.
   - Sin internet (o si la red tarda más de 3 s): usa la copia guardada.
   Las canciones NO pasan por aquí: viven en IndexedDB y se reproducen con URLs blob:. */

const CACHE_NAME = "pulsar-rm-shell-v1";

const APP_SHELL = [
  "./",
  "index.html",
  "style.css",
  "script.js",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png"
];

const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Se añade archivo por archivo: si uno falla, los demás se guardan igual.
      Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // no tocar recursos externos
  if (!url.protocol.startsWith("http")) return;
  if (request.headers.has("range")) return;             // el audio nunca pasa por la caché

  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  const network = fetch(request, { cache: "no-cache" })
    .then((response) => {
      if (response && response.ok && response.type === "basic") {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    });

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));

  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    // La red tardó demasiado: se usa la copia guardada si existe.
    const cached = await matchCached(cache, request);
    return cached || network;
  } catch (error) {
    // Sin conexión
    const cached = await matchCached(cache, request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const home = await cache.match("index.html", { ignoreSearch: true });
      if (home) return home;
    }
    return new Response("Sin conexión", { status: 503, statusText: "Sin conexión" });
  }
}

function matchCached(cache, request) {
  return cache.match(request, { ignoreSearch: true });
}
