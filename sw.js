/* Pulsar RM — Service Worker
   Estrategia: "red primero, caché de respaldo".
   - Con internet: siempre carga la versión más nueva y la guarda.
   - Sin internet (o si la red tarda más de 3 s): usa la copia guardada.
   Las canciones NO pasan por aquí: viven en IndexedDB y se reproducen con URLs blob:.
*/

// v2 incorpora equalizer.js al conjunto de archivos guardados para uso sin conexión.
// v3 (app v1.01): corrección de navegación hacia atrás; renueva la copia guardada.
// v4 (app v1.02): iconos nuevos, barra inferior fija y sin rebote; renueva la copia guardada.
// v5: se quita equalizer.js (código viejo que ya no se usa; el ecualizador vive en script.js).
// v6 (app v1.03): colores animados, letras estilo Apple Music y ajustes nuevos; renueva la copia guardada.
// v7 (app v1.04): pantallas completas de Letras y Cola de reproducción; renueva la copia guardada.
const CACHE_NAME = "pulsar-rm-shell-v7";

const APP_SHELL = [
  "./",
  "index.html",
  "style.css",
  "script.js",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "icon-light-192.png",
  "icon-dark-192.png",
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
  if (url.origin !== self.location.origin) return;
  if (!url.protocol.startsWith("http")) return;
  if (request.headers.has("range")) return;

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
    const cached = await matchCached(cache, request);
    return cached || network;
  } catch (error) {
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
