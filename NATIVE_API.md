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
| v1.03: `setPendingIcon`, `setBars`, `setStatusBarHidden`, `getVersion` | | Sin cambios |

## Android → Web: `window.PulsarBridge.onNative(tipo, json)`
`action {name: play|pause|next|previous|stop|seek|interrupt, value}` · `focus {action: duck|unduck|pause|resume|loss}` ·
`sleep` · `permission` · `display {…}` · `folderPicked {uri,name}` · `folderCancelled` ·
`scanProgress {phase,done,total,found}` · `scanBatch {items[]}` · `scanDone {ok,cancelled,errors[]}`.

Elemento de `scanBatch`: `{docKey, uri, folderUri, fileName, size, lastModified, mime, unchanged?, meta?:{title,artist,album,albumArtist,genre,year,track,disc,duration,bitrate,coverFile,lyricsHint,lrcUri}}`.

## Archivos servidos al WebView (mismo origen, `MediaWebClient.java`)
- `https://localhost/_pulsar_media/<uri en base64url>` — audio de carpetas con `Range`.
- `https://localhost/_pulsar_cover/<archivo>` — portadas guardadas en `files/covers/`.
Requiere `WebView.getWebViewClient()` (Android 8+); en versiones anteriores `getInfo().folders = false`.
