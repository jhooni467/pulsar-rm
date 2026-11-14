# Pulsar RM v1.04 — informe final

## Archivos modificados / nuevos
**Web:** `index.html` (reorganizado: pantallas Letras, Cola, Temporizador, Información, Colección, Ecualizador; Ajustes en 6 categorías), `script.js` (Settings, Lyrics, Queue, AudioGraph, Equalizer, Player de dos decks, Router, UI, Store por lotes), `style.css` (+bloque v1.04), `sw.js` (caché v7), **nuevos** `native.js`, `features.js`.
**Android:** `android-native/java/` (`MainActivity`, `PulsarBridge`, `PulsarMediaService`, `LibraryScanner`, `MediaWebClient`, `PulsarEvents`), `.github/workflows/build-apk.yml` (copia el código nativo, permisos, servicio, icono de notificación), `docs/`.

## Funciones implementadas
- Pantallas independientes con navegación coherente (Atrás vuelve a la pantalla de origen).
- Letras: sincronizada y texto, autoscroll con recentrado, animaciones v1.03, vista/espaciado/fondo con portada, retardo, editor; lee `.lrc/.srt/.vtt/.txt` junto a canciones de carpetas.
- Cola real: canción actual, pendientes, ya reproducidas, arrastrar/teclado para reordenar, quitar, añadir, aleatorio, repetir, mezclar pendientes, vaciar, tiempo restante.
- Temporizador (minutos o fin de canción) con bajada suave de volumen y alarma de respaldo en Android.
- Reproducción continua (gapless) y crossfade configurable con dos decks; ecualizador de 10 bandas real, limitador, mono, balance.
- Android: servicio en primer plano, notificación multimedia, MediaSession, foco de audio, auriculares, wake lock, reproducción con pantalla apagada.
- Biblioteca: carpetas con permiso persistente, actualización **manual** (nuevas / actualizadas / recuperadas / no disponibles / duplicadas / ignoradas, progreso y resultado), respeta lo editado a mano, álbumes/artistas/géneros, información de canción.
- Rendimiento y pantalla: perfiles 60/90/120 Hz solo si el dispositivo los admite, Automático, límite de FPS, animaciones completas/reducidas/off, efectos, modo ligero automático en equipos con pocos recursos.

## Limitaciones técnicas (documentadas, sin simular)
- **No se pudo compilar ni probar en un dispositivo Android** en este entorno (sin Android SDK ni red). El código Java pasó una revisión de sintaxis; la web se probó con Playwright y un puente nativo simulado. Hay que compilar con el workflow y probar en un teléfono.
- El audio suena en el WebView; el segundo plano depende de mantenerlo activo (servicio + wake lock + `onResume/resumeTimers`). Algunos fabricantes con ahorro de batería agresivo pueden pausarlo.
- Los Hz solo los puede cambiar Android (modo de pantalla); en navegador o si el sistema lo rechaza, el perfil limita los FPS de las animaciones de la app (se explica en Ajustes). El sistema puede bajar la tasa por su cuenta.
- Letras incrustadas en las etiquetas (USLT/SYLT) no se leen aún; se detectan archivos de letra junto a la canción.
- Las rutas de carpetas requieren Android 8+. Un segundo escaneo no lee de nuevo etiquetas de archivos sin cambios.
- Si se cierra la app deslizándola, la reproducción se detiene.

## Pendiente
- Pruebas en dispositivos reales (90/120 Hz, Bluetooth, llamadas), letras incrustadas, escaneo de miles de archivos medido.

## Corrección posterior (v1.04, 2.ª entrega)
Informe: en el teléfono los botones dejaban de responder y no abría el reproductor grande.
- **Servicio de notificación**: se iniciaba con `startForegroundService()` pero, si la canción estaba en pausa, no llamaba a `startForeground()`; Android cierra la app a los ~5 s. Ahora se llama siempre primero.
- **Arranque a prueba de fallos**: cada módulo (letras, cola, temporizador, carpetas, rendimiento…) arranca por separado; si uno falla, el resto de la app, la navegación y los botones siguen funcionando.
- **Diagnóstico** (Ajustes → Acerca de): registra los últimos errores (incluidos los de arranque) con botón «Copiar».
- El workflow ya **no copia `sw.js`** a la app Android (la v1.03 tampoco lo hacía; un service worker podía interferir con el audio de carpetas).
- `versionCode` = versión × 1000 + número de ejecución: cada APK nuevo se instala encima del anterior.

## Revisión de empaquetado y app de música (v1.04, 3.ª entrega)
Informe: el APK/instalable no funcionaba y muchos botones y funciones nuevas no respondían.
**Causa:** el repositorio quedó «aplanado» y desordenado.
- `.github/workflows/build-apk.yml` era la versión **1.02**: solo copiaba 4 archivos web, así que el APK salía **sin `native.js` ni `features.js`** (`Features is not defined`) y sin código nativo.
- El workflow nuevo estaba suelto en la raíz (GitHub no lo ejecuta) y buscaba los `.java` en `android-native/java/`, carpeta que no existía: el código nativo nunca entraba al APK.

**Corregido**
- Un único workflow en `.github/workflows/`, con las rutas correctas; `.java` en `android-native/java/`; documentos en `docs/`; se eliminaron la copia duplicada del workflow y `android-icono.md` (instrucciones Kotlin ya obsoletas).
- `versionCode` = minutos desde 1970: siempre crece y cada APK se instala encima del anterior, incluso si se recrea el repositorio. `pulsar-debug.keystore` se conserva: es la firma que permite actualizar sin desinstalar.
- **App de música para Android:** `PulsarMediaService` ahora es `MediaBrowserService`; filtros `APP_MUSIC`, `MUSIC_PLAYER`, `MEDIA_PLAY_FROM_SEARCH` y `VIEW audio/*`; metadatos de Android Auto; categoría de transporte y actividad de sesión (tocar los controles abre la app).
- **Abrir con Pulsar RM:** un audio abierto desde el administrador de archivos se añade a la biblioteca y se reproduce (`ExternalOpen` en `features.js`).
- Servicio protegido con clave interna (al estar exportado, otras apps no pueden controlarlo).
- El icono Light/Dark solo se cambia cuando de verdad cambió; la reproducción sin gesto del usuario se fuerza explícitamente en el WebView.
- `sw.js` (solo versión web/PWA): las rutas `/_pulsar_*` ya no pasan por el service worker; caché v8.

**Verificación y límites (sin simular)**
- La web se probó en Chromium sin pantalla con un puente Android simulado: 144 controles, flujo de carpetas, avisos nativos y «Abrir con», sin errores de JavaScript.
- El script de personalización del workflow se ejecutó contra un proyecto Capacitor simulado: manifest válido y con todos los filtros.
- **El código Java no se pudo compilar ni probar en un teléfono** (sin Android SDK ni red): solo se revisó su sintaxis. Hay que compilar con el workflow y probar en un dispositivo real (notificación, Bluetooth, «Abrir con…»).
