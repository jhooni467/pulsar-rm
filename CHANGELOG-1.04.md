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
