# Contrato nativo — `window.PulsarNative` (v1.04)

La web (native.js / features.js) solo usa estos métodos si existen (`getInfo` marca el APK v1.04+).
Sin ellos la app funciona como PWA: lo que depende de Android se desactiva y se explica en Ajustes.

## Web → Android (métodos, `@JavascriptInterface` en `PulsarBridge.java`)
| Método | Devuelve | Qué hace |
|---|---|---|
| `getInfo()` | JSON `{api:2, sdk, notifications, folders, display:{currentHz,maxHz,rates[],switchable}}` | Capacidades del dispositivo |
| `mediaUpdate(json)` | – | Título, artista, álbum, portada (`coverFile` o `coverB64`), duración, posición, `playing`, `canPrev/canNext`. Inicia/actualiza el servicio, notificación y MediaSession |
| `mediaStop()` | – | Quita notificación y servicio |
| `setAudioOptions(pauseOnNoisy, focusMode, bgPlayback)` | – | Auriculares desconectados, foco de audio (`duck`/`pause`), segundo plano |
| `setSleepTimer(endAtMs)` / `cancelSleepTimer()` | – | Alarma de respaldo del temporizador |
| `requestNotificationPermission()` | – | Android 13+ |
| `setKeepScreenOn(bool)` | – | Pantalla encendida en Letras |
| `setRefreshRate(hz)` | JSON `{ok,hz,display}` | Pide el modo de pantalla con esos Hz (0 = automático) |
| `pickFolder()` | – | Selector del sistema; responde con `folderPicked`/`folderCancelled` |
| `getPersistedFolders()` | JSON `{folders:[uri]}` | Permisos persistentes vigentes |
| `releaseFolder(uri)` | – | Libera el permiso |
| `scanLibrary(optionsJson)` | bool | `{folders:[uri], known:{docKey:"modificado:tamaño"}}`; solo lee lo nuevo/cambiado |
| `cancelScan()` | – | Cancela |
| `readLyrics(json)` | JSON `{ok,b64}` | Lee el `.lrc/.srt/.vtt/.txt` junto a la canción |
| `getTrackInfo(uri)` | JSON `{sampleRate,channels,bitrate}` | Detalle técnico |
| `takePendingOpen()` | JSON `{uri,name,mime}` o `""` | Audio que otra app abrió con «Abrir con Pulsar RM». Se entrega una sola vez |
| v1.03: `setPendingIcon`, `setBars`, `setStatusBarHidden`, `getVersion` | | Sin cambios |

## Android → Web: `window.PulsarBridge.onNative(tipo, json)`
`action {name: play|pause|next|previous|stop|seek|interrupt, value}` · `focus {action: duck|unduck|pause|resume|loss}` ·
`sleep` · `permission` · `display {…}` · `folderPicked {uri,name}` · `folderCancelled` ·
`scanProgress {phase,done,total,found}` · `scanBatch {items[]}` · `scanDone {ok,cancelled,errors[]}` · `openAudio` (hay un audio pendiente: la web llama a `takePendingOpen()`).

Elemento de `scanBatch`: `{docKey, uri, folderUri, fileName, size, lastModified, mime, unchanged?, meta?:{title,artist,album,albumArtist,genre,year,track,disc,duration,bitrate,coverFile,lyricsHint,lrcUri}}`.

## Archivos servidos al WebView (mismo origen, `MediaWebClient.java`)
- `https://localhost/_pulsar_media/<uri en base64url>` — audio de carpetas con `Range`.
- `https://localhost/_pulsar_cover/<archivo>` — portadas guardadas en `files/covers/`.
`<uri>` también puede ser un `content://` recibido de otra app (Abrir con…), válido mientras la pantalla esté abierta.
Requiere `WebView.getWebViewClient()` (Android 8+); en versiones anteriores `getInfo().folders = false`.

## Integración como app de música (revisión v1.04)
Lo que hace que Android trate Pulsar RM como un reproductor de música (lo añade `.github/workflows/build-apk.yml` al manifest):
- **MediaSession + notificación `MediaStyle`** (categoría transporte): controles en pantalla de bloqueo, panel de ajustes rápidos, Bluetooth y auriculares.
- **`PulsarMediaService` es un `MediaBrowserService`** (exportado): lo ven Bluetooth, Android Auto (`automotive_app_desc.xml` → `media`) y los asistentes. Las órdenes internas (extra `k`) llevan una clave privada guardada en las preferencias de la app; las órdenes externas sin ella se ignoran.
- **Filtros de intent en `MainActivity`:** `VIEW` con `audio/*` (aparece en «Abrir con…»), `MAIN` + `APP_MUSIC`, `MUSIC_PLAYER` y `MEDIA_PLAY_FROM_SEARCH`.
- Límite conocido: el árbol de canciones no se expone aún a otras apps (la biblioteca vive en la web); `onLoadChildren` devuelve una lista vacía. Si se cierra la app deslizándola, la reproducción se detiene.
