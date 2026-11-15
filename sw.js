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
// v7 (app v1.04): native.js y features.js, pantallas nuevas y ajustes reorganizados; renueva la copia guardada.
// v8 (revisión v1.04): las rutas /_pulsar_* de Android no pasan por el service worker.
// v9 (app v1.05): pantalla completa real, Atrás con ruta Reproductor → Biblioteca → Inicio; renueva la copia guardada.
// v10 (app v1.05): letras — estrellas de espera, versos superpuestos y voces de fondo [bg:]; renueva la copia guardada.
// v12 (app v1.05): letras — grupos de versos (el principal no se apaga antes que sus mini versos), desplazamiento con resorte y fragmentos rápidos compactos; renueva la copia guardada.
// v13 (app v1.05): estrellas de espera — 3 estrellas grandes y bold que crecen una tras otra; renueva la copia guardada.
// v14: Temas y Color de portada excluyentes, Intensidad solo cambia la fuerza del color y letras más legibles sobre Portada (Blur); renueva la copia guardada.
// v15 (Nova Intelligence, etapa 1): nova-core.js, nova-store.js, nova-net.js, nova-ui.js y nova.css se guardan para uso sin conexión; renueva la copia guardada.
// v16 (Nova Intelligence, etapa 2): sección «Nova Intelligence ✨» en Ajustes (index.html, nova-core.js, nova-ui.js, nova.css); renueva la copia guardada.
// v18: estrellas de espera — restauradas las 3 estrellas independientes; crecen una a una, luego giran y levitan y al acabar la pausa se alejan en espiral (escala y opacidad graduales); renueva la copia guardada.
// v19: letras — espacios dinámicos (versos secundarios, [bg:] y estrellas solo ocupan lugar mientras se muestran) y salida en espiral de las estrellas justo antes de la frase siguiente (script.js, style.css); renueva la copia guardada.
// v20: barra de progreso rediseñada (línea fina, pista sutil, indicador discreto; solo estilo, script.js y style.css); renueva la copia guardada.
// v21: barra de progreso más gruesa, sin indicador circular y con extremos redondeados (solo style.css); renueva la copia guardada.
// v22: controles del reproductor — play/pausa y anterior/siguiente más gruesos, tiempos debajo de la barra; renueva la copia guardada.
// v23: portada del reproductor — cambia de tamaño con play/pausa y bordes limpios (sin marco ni fondo detrás de la imagen); renueva la copia guardada.
// v24: animaciones de letras — Fluida, Palabra por palabra y Escala (se quita «Fluida con glow»), con efectos especiales para palabras prolongadas (script.js, style.css, index.html); renueva la copia guardada.
const CACHE_NAME = "pulsar-rm-shell-v24";

const APP_SHELL = [
  "./",
  "index.html",
  "style.css",
  "native.js",
  "script.js",
  "features.js",
  "nova-core.js",
  "nova-store.js",
  "nova-net.js",
  "nova-ui.js",
  "nova.css",
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
  if (url.pathname.startsWith("/_pulsar_")) return; // audio y portadas que sirve Android: no se cachean

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
