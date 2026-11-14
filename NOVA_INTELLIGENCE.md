# Nova Intelligence

Sistema inteligente e independiente de Pulsar RM. Su finalidad: ampliar las capacidades musicales de la app mediante internet y proveedores externos (letras, portadas, metadatos…), **sin dejar de ser un reproductor local que funciona sin conexión**.

- **Versión:** 0.2.0 · **Etapa:** 2 (configuración y activación)
- **Estado:** hay sección en Ajustes, interruptor y consentimiento. Siguen sin existir búsquedas, proveedores reales ni conexiones a internet. La red está **bloqueada por diseño** (`LOCKED = true` en `nova-net.js`).
- **Apagado por defecto:** Nova solo se enciende si la persona lo activa en Ajustes y acepta expresamente el consentimiento.

---

## 1. Arquitectura

```
                    ┌──────────────────────── Nova (nova-core.js) ────────────────────────┐
 Pulsar RM          │  errores aislados · eventos · configuración · registros · arranque  │
 (features.js) ───► │                                                                     │
  Nova.init()       │   Módulos (qué hace)            Proveedores (de dónde sale)         │
  Nova.afterLoad()  │   Lyrics / Cover / Metadata…    LRCLIB / …                          │
                    │        │  pide una capacidad          │  ofrece capacidades          │
                    │        └──────────────┬───────────────┘                             │
                    │                       ▼                                             │
                    │   Piezas:  store (datos propios) · net (red) · ui (interfaz)         │
                    └─────────────────────────────────────────────────────────────────────┘
```

Ideas clave:

- **Un módulo** es una función de Nova (por ejemplo *Lyrics Intelligence*). Declara **una capacidad** (`lyrics`, `cover`, `metadata`, `artist`, `library`).
- **Un proveedor** es una fuente de datos externa (por ejemplo LRCLIB). Declara **qué capacidades ofrece** y **a qué dominios puede conectarse**.
- El módulo no conoce a los proveedores: pregunta `nova.providersFor("lyrics")` y recibe los activados, ordenados por prioridad. Así se añaden proveedores nuevos sin tocar los módulos, y módulos nuevos sin tocar el núcleo.
- Todo está **desactivado por defecto**: Nova apagado, ningún módulo ni proveedor activado, sin consentimiento.

## 2. Archivos y responsabilidad

| Archivo | Responsabilidad |
|---|---|
| `nova-core.js` | Define el objeto global `Nova`. Errores propios (`Nova.Error`) y aislamiento (`Nova.safe`), eventos (`Nova.on`/`emit`), configuración independiente (`Nova.config`), registro de módulos y proveedores, arranque (`Nova.init`) y autotest (`Nova.selfTest`). |
| `nova-store.js` | Almacenamiento propio: base IndexedDB **independiente** `pulsar-nova` (caché con caducidad, historial para deshacer, datos pequeños). Perezoso: no se crea hasta que algo la usa. Respaldo en memoria. |
| `nova-net.js` | Única puerta hacia internet. Reglas de seguridad ya implementadas, pero **bloqueada** (`LOCKED = true`). |
| `nova-ui.js` | Interfaz: contenedor oculto `#nova-root`, avisos con el estilo de la app, registro de secciones de Ajustes y (etapa 2) la sección «Nova Intelligence ✨» con interruptor, explicación y hoja de consentimiento. |
| `nova.css` | Estilos, todo con prefijo `nova-` / `--nova-`. Toma los colores de la app. No toca `style.css`. |
| `NOVA_INTELLIGENCE.md` | Este documento. |

Los archivos se cargan en este orden (en `index.html`): `nova-core.js` → `nova-store.js` → `nova-net.js` → `nova-ui.js`. Cada pieza se engancha con `Nova.use("nombre", pieza)`. Si una no carga, Nova sigue funcionando sin ella (`Nova.status().missing` lo indica) y la app no se entera.

## 3. Cómo se integra con Pulsar RM (cambios en archivos existentes)

| Archivo | Cambio |
|---|---|
| `index.html` | `<link>` a `nova.css` y 4 `<script>` de Nova **después** de `features.js`. Etapa 2: el botón «Nova ✨» de la barra de Ajustes y el hueco `<section id="set-nova" hidden>` que dibuja `nova-ui.js` (ambos ocultos si `nova-ui.js` no carga). |
| `features.js` | 2 líneas: `Features.init` llama a `Nova.init()` y `Features.afterLoad` a `Nova.afterLoad()`, ambas dentro de `this.safe(...)` y protegidas con `typeof Nova !== "undefined"`. |
| `sw.js` | Los archivos de Nova en `APP_SHELL` y `CACHE_NAME` sube a `v15` (etapa 1) y a `v16` (etapa 2). Solo versión web. |
| `.github/workflows/build-apk.yml` | `cp nova-*.js nova.css www/` para que el APK los incluya. |

No se tocó `script.js`, `native.js`, `style.css`, el reproductor, las letras, la cola ni los archivos Java. **No se modificó el esquema de IndexedDB de Pulsar RM** (`pulsar-rm` sigue en versión 1).

## 4. Seguridad y privacidad

- **Sin conexión por defecto.** En la etapa 1, `Nova.net.request()` rechaza siempre con `net_locked` y no llama a ningún transporte.
- **Consentimiento.** Cuando se desbloquee, nada saldrá si Nova está apagado o la persona no aceptó (`config.canUseNetwork()`).
- **Solo `https`** y solo hacia los `hosts` que el proveedor declaró. Rutas con `//`, `@` o `\` se rechazan.
- **Solo `GET`**, sin cookies (`credentials: "omit"`), sin `referer`, sin caché del navegador.
- **Una petición a la vez por proveedor**, con pausa mínima, tiempo límite (10 s por defecto), respuesta máxima de 2 MB.
- **`429` / `503`:** se respeta `Retry-After` con una variación aleatoria de hasta el 30 %; reintentos acotados; si el servidor pide esperar demasiado, se avisa en vez de insistir.
- **Sin claves en el código.** Un proveedor no puede llevar cabeceras que parezcan claves (`authorization`, `api-key`, `token`…); se rechaza al registrarlo. Si necesita identificarse usa `auth`: `"public-id"` (identificador público) o `"user-key"` (clave que pone la persona y se guarda en su configuración). Las claves privadas de servidor no deben llegar nunca a la app.
- **Se envía lo mínimo.** `Nova.describeSong(song)` devuelve exactamente lo que se compartiría con un proveedor: título, artista, álbum y duración. Los textos de relleno de la app («Archivo local», «Artista desconocido») se omiten.
- **Errores aislados.** Todo lo que falla en Nova se anota (Ajustes → Acerca de → Diagnóstico) y no se propaga al reproductor.

## 5. Configuración independiente

`Nova.config` se guarda en `localStorage`, clave `pulsar-nova-config`, sin tocar `Settings` ni IndexedDB de la app. Se escribe solo cuando la persona cambia algo (arrancar la app no crea la clave).

**Reglas de la etapa 2** (la configuración real se crea con `requireConsent: true`):

- `config.set("enabled", true)` devuelve `false` si `consent` no es `true`: Nova no se enciende sin consentimiento.
- `config.set("consent", true)` guarda también `consentAt` (fecha de aceptación, en ms).
- `config.set("consent", false)` (retirar el permiso) **apaga Nova** y borra `consentAt`.
- Al cargar, un dato guardado con `enabled: true` pero sin `consent` se corrige a apagado.
- `config.verify()` vuelve a leer `localStorage` y comprueba que coincide con lo que hay en memoria: `{ ok, status, detail }` con `status` = `saved` · `default` · `mismatch` · `unavailable`.
- Si `localStorage` no está disponible Nova funciona en memoria y Ajustes avisa de que no se guardará (`config.persistent === false`).

```js
Nova.config.get("enabled");                         // false — interruptor general (exige consent)
Nova.config.get("consent");                         // false — consentimiento para usar internet
Nova.config.set("wifiOnly", true);                  // solo Wi‑Fi (mejor esfuerzo)
Nova.config.set("cacheDays", 30);                   // caducidad de la caché (1–365)
Nova.config.get("consentAt");                       // 0 si no hay consentimiento; si no, cuándo se aceptó
Nova.config.verify();                               // ¿lo guardado coincide con lo que hay en memoria?
Nova.config.setEntry("modules", "lyrics", { enabled: true });
Nova.config.setEntry("providers", "lrclib", { enabled: true, appId: "…" });   // appId = identificador PÚBLICO
Nova.config.moduleActive("lyrics");                 // Nova encendido Y módulo encendido
Nova.config.reset();
```

Solo se admiten valores simples (booleanos, números, textos cortos).

## 6. Cómo registrar un módulo

```js
Nova.registerModule({
  id: "lyrics",                 // minúsculas, números y guiones (2–32)
  name: "Lyrics Intelligence",
  version: "0.1.0",
  capability: "lyrics",         // una de Nova.CAPABILITIES
  init(nova) { /* opcional: se llama cuando el módulo pasa a estar activo */ },
  stop()     { /* opcional: cuando se desactiva */ },
  async run(song, ctx) {        // ctx = { nova, options }
    const query = ctx.nova.describeSong(song);          // lo único que se enviaría
    for (const provider of ctx.nova.providersFor("lyrics")) {
      const found = await provider.handlers.lyrics.find(query, ctx);
      if (found && found.length) return found;
    }
    return [];
  }
});
```

- `registerModule` devuelve `true`/`false` y **nunca lanza**; un registro inválido se anota en el diagnóstico.
- Ejecutar: `Nova.runModule("lyrics", song)` → promesa; falla con `module_disabled`, `module_unknown` o `module_failed`.
- Un módulo solo está activo si Nova está encendido **y** el módulo también.

## 7. Cómo registrar un proveedor

```js
Nova.registerProvider({
  id: "ejemplo",
  name: "Proveedor de ejemplo",
  hosts: ["api.ejemplo.com"],            // solo dominios; vacío = proveedor local (sin red)
  headers: { "X-Cliente": "Pulsar RM" }, // fijos y NUNCA secretos
  auth: { type: "none" },                // o { type: "public-id", header: "X-App-Id" } / { type: "user-key", header: "X-Key" }
  rateLimit: { minIntervalMs: 400, maxRetries: 2 },
  transport: "auto",                     // "auto" | "fetch" | "native"
  priority: 50,                          // menor número = se consulta antes
  handlers: {
    lyrics: {
      async find(query, ctx) {
        const res = await Nova.net.request("ejemplo", { path: "/buscar", query: { q: query.title } });
        return normalizar(res.data);     // cada proveedor convierte su respuesta a un formato común
      }
    }
  }
});
```

`Nova.net.request(idProveedor, { path, query, headers, timeoutMs, signal, parse })` devuelve `{ status, data }` o lanza `Nova.Error` con `code`: `net_locked`, `net_disabled`, `no_consent`, `provider_disabled`, `offline`, `metered`, `host_not_allowed`, `bad_path`, `timeout`, `network`, `not_found`, `unauthorized`, `bad_request`, `rate_limited`, `busy`, `server`, `bad_response`…

## 8. Preparado para el primer proveedor: LRCLIB (NO conectado)

Datos de su documentación oficial (<https://lrclib.net/docs>), consultada al preparar esta etapa. Conviene volver a revisarla antes de implementar.

- **Base:** `https://lrclib.net`. Gratuito, sin clave. Responde con CORS abierto (`Access-Control-Allow-Origin: *`), por lo que se puede llamar desde la web; el WebView de Android se verificará en su etapa.
- **Identificación:** piden indicar la app. El navegador no permite cambiar `User-Agent`, así que se usa la cabecera `Lrclib-Client` (o `X-User-Agent`) con nombre, versión y enlace. Encaja en `headers` del proveedor.
- **Endpoints útiles:** `GET /api/get` (`track_name`, `artist_name` obligatorios; `album_name` y `duration` recomendados; coincide por duración ±2 s; `404` si no hay), `GET /api/get/{id}`, `GET /api/search` (`q` o `track_name`; máx. 20 resultados) y `GET /api/v2/search` (beta, sin letras).
- **Respuesta:** `plainLyrics`, `syncedLyrics` (formato LRC, el que ya entiende `LyricsParser`), `instrumental`, `hasWordSync` y `lyricsfile` (YAML con tiempos por palabra).
- **Límites aproximados por IP:** ~45 peticiones/min sin identificar, ~90 identificado, ~180 con `Lrclib-App-Id` registrado (identificador público). Piden esperar 200–500 ms entre peticiones y respetar `Retry-After` con variación aleatoria. Todo esto ya lo cubre `nova-net.js`.
- **No se usará:** `Lrclib-Api-Key` (secreto de servidor), `POST /api/publish` y `POST /api/flag` (requieren prueba de trabajo y no forman parte del plan).

Forma prevista (solo ilustrativa, **no existe todavía**):

```js
// nova-provider-lrclib.js (etapa posterior)
Nova.registerProvider({
  id: "lrclib", name: "LRCLIB", hosts: ["lrclib.net"],
  headers: { "Lrclib-Client": "Pulsar RM v1.05 (<URL del repositorio>)" },
  auth: { type: "public-id", header: "Lrclib-App-Id" },   // opcional
  rateLimit: { minIntervalMs: 400, maxRetries: 2 },
  handlers: { lyrics: { find: /* GET /api/get y, si no hay, /api/search */ } }
});
```

## 9. Cómo ampliar el sistema

**Nuevo módulo** (Cover, Metadata, Artist, Library Intelligence…):
1. Crear `nova-<nombre>.js` que llame a `Nova.registerModule({...})` (y empiece con `if (typeof Nova === "undefined") return;`).
2. Añadir su `<script>` en `index.html` después de `nova-ui.js`.
3. Añadir el archivo a `APP_SHELL` en `sw.js` y subir `CACHE_NAME`.
4. El workflow ya copia `nova-*.js` automáticamente.

**Nuevo proveedor:** igual, con `nova-provider-<nombre>.js` y `Nova.registerProvider({...})`.

**Nueva capacidad:** añadirla a `CAPABILITIES` en `nova-core.js`.

**Nueva pieza** (por ejemplo, un transporte nativo para Android): `Nova.use("nombre", pieza)`; los transportes se añaden con `Nova.net.registerTransport({ id, available(), send(req) })`.

## 10. Pruebas

- **Autotest:** abre la app web con `?nova=1` al final de la dirección (por ejemplo `https://…/index.html?nova=1`). Nova ejecuta su autotest y deja una línea en **Ajustes → Acerca de → Diagnóstico**, algo como: `[nova] Nova Intelligence 0.2.0 (etapa 2) · autotest 53/53 OK · red bloqueada · Nova apagado · consentimiento no · ajustes sin cambios guardados (valores por defecto)`. Tras activar Nova y recargar con `?nova=1` debe decir `Nova encendido · consentimiento aceptado · ajustes guardados OK`. Si algo no se guarda bien, la línea dice `ajustes NO SE GUARDAN BIEN (…)`. El autotest usa claves y bases de prueba aparte y no deja rastro.
- **Consola:** `Nova.status()`, `Nova.selfTest()`, `Nova.errors()`.
- **Sin conexión:** la app y Nova arrancan sin red; la reproducción local no depende de Nova.

## 11. Qué falta implementar

- [x] Sección «Nova Intelligence ✨» en Ajustes: icono, descripción, interruptor, explicación y consentimiento (etapa 2).
- [ ] Ajustes de módulos y proveedores dentro de esa sección (llegarán con cada módulo/proveedor).
- [ ] Desbloquear `nova-net.js` (`LOCKED`), con autorización, y verificar CORS en el WebView de Android; si hace falta, transporte nativo en `PulsarBridge.java`.
- [ ] Proveedor LRCLIB.
- [ ] Lyrics Intelligence (búsqueda manual por canción, sin pisar letras existentes, con opción de deshacer).
- [ ] Cover Intelligence, Metadata Intelligence, Artist Intelligence, Library Intelligence.
- [ ] Capa «aplicar cambios»: no pisar datos del usuario, registrar el origen y usar el historial para deshacer.
- [ ] Cola en segundo plano (opcional, con Wi‑Fi) y límites de caché.
- [ ] Actualizar `NATIVE_API.md` y `README.md` cuando Nova tenga funciones visibles.

## 12. Etapa 2 · Configuración y activación (resumen)

- **Dónde:** Ajustes → «Nova ✨» (nuevo acceso en la barra de categorías, entre *Rendimiento* y *Acerca de*).
- **Interruptor:** apagado por defecto. Al encenderlo por primera vez se muestra una hoja que explica que Nova podrá usar internet cuando sus módulos estén disponibles, qué datos compartiría (título, artista, álbum y duración) y que hoy no hay ningún servicio conectado. Solo **«Acepto y activar»** lo enciende; «Ahora no», tocar fuera o el botón Atrás de Android lo dejan apagado.
- **Permiso:** una vez aceptado no se vuelve a preguntar al apagar y encender. «Retirar mi permiso» apaga Nova y vuelve a exigir la aceptación.
- **Persistencia:** `localStorage` → `pulsar-nova-config` (independiente de `Settings`). Se conserva al cerrar y abrir la app.
- **Límites:** `nova-net.js` no se tocó (`LOCKED = true`); no hay proveedores, ni búsquedas, ni peticiones; reproductor, letras y biblioteca intactos.
