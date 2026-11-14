<!-- ================================= --><!--          PULSAR RM               --><!--         README.md                --><!-- ================================= --><div align="center"><h1>🪐 PULSAR RM</h1><p><strong>Your music. Your universe.</strong></p><p>
  Local Music Player for Android
</p><p>
  <img src="https://img.shields.io/badge/VERSION-v1.05-8275E8?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/PLATFORM-ANDROID-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Android">
  <img src="https://img.shields.io/badge/STATUS-IN_DEVELOPMENT-4788C7?style=for-the-badge" alt="Development">
</p><p>
  <i>A personal space for your music.</i>
</p></div>---

🎧 About Pulsar RM

Pulsar RM (Pulsar Reproductor de Música) is an independent local music player developed for Android.

Its purpose is to offer a modern, comfortable and customizable musical experience.

More than just a music player, Pulsar RM aims to become a personal space where every user can create their own musical universe.

🌌 Our Vision

«Your music. Your universe.»

Personalization is at the heart of Pulsar RM.

The project aims to give users the freedom to transform their listening experience through different visual styles, colors, interfaces and customization possibilities.

Every detail should contribute to creating something unique.

✨ Project Highlights

- 🎵 Local music playback.
- 🎨 A customizable interface.
- 🪐 A modern and minimal visual identity.
- 🎧 An experience centered around music.
- 📱 Designed for Android.

Pulsar RM is an evolving project. Features and customization possibilities are continuously being developed.

---

📱 Platform & Technologies

Category| Technology
Platform| Android
Application| APK
Frontend| HTML, CSS, JavaScript
Android integration| Capacitor
Repository| GitHub

---

📦 Download

<div align="center">Pulsar RM v1.05

Latest published version

<a href="../../releases">
  <img src="https://img.shields.io/badge/GET_PULSAR_RM-Download_APK-8275E8?style=for-the-badge" alt="Download Pulsar RM">
</a><p><sub>Visit the Releases section to find available versions.</sub></p></div>«[!NOTE]
Pulsar RM is distributed as an Android APK.»

---

📁 Repository structure

Path| Purpose
.github/workflows/build-apk.yml| Builds the signed APK (Actions → "Build APK" → Run workflow)
android-native/java/| Native Android code copied into the Capacitor project by the workflow
docs/| NATIVE_API.md and CHANGELOG-1.04.md
index.html, script.js, native.js, features.js, style.css| The app (web)
sw.js, manifest.json| Web/PWA only (the APK does not use the service worker)
pulsar-debug.keystore| Fixed signing key — keep it, it lets every APK update over the previous one

🎵 Music app integration

On Android, Pulsar RM registers as a music player: media notification and lock-screen controls (MediaSession), Bluetooth / car / assistant support (MediaBrowserService), "Open with" for audio files, and the music-app launcher category.

---

🛠️ Development


Pulsar RM is an independent project currently under development.

Development focuses on improving stability, refining the interface and expanding the possibilities of customization.

Current version

v1.05 — Full-height screen & back navigation fix

The app now uses the whole screen height (no empty strip above the top tabs) and the Android Back button / gesture follows the screens (Player → Library → Home → leave the app).

Previous version

v1.04 — Screens, queue, library & performance update

This version adds independent Lyrics, Queue, Timer, Song info and Equalizer screens, gapless playback and crossfade, background playback with Android media controls, a folder-based library with manual updates, a Hz/FPS performance section and a reorganized Settings screen. See docs/NATIVE_API.md and docs/CHANGELOG-1.04.md.

Upcoming — v2.00

The next major update is planned to include:

- Animated startup screen featuring the Pulsar RM logo.
- Minimum audio duration filter, configurable from 30 to 45 seconds.

«These features are planned and are not presented as currently available.»

---

📚 Version History

<details>
<summary><strong>v1.05 — Full-height screen & back navigation fix</strong></summary>

- Screen: removed the gray strip above the top tabs. The Android window is now truly edge-to-edge and the WebView sits exactly inside the safe areas (status bar when visible, camera cutout, navigation bar, keyboard). Hiding the status bar keeps working.
- Back button / gesture: Player → Library → Home → leave the app. The Android Back is now handled by the app itself, so it no longer exits from the full-screen player.
- Settings → Diagnostics now also shows the safe-area values to help with display issues.
- Lyrics · waiting indicator: a Pulsar RM signature of three softly twinkling four-point stars replaces dots/notes during intros, instrumental parts and long pauses between verses. The stars light up one by one as the pause goes by.
- Lyrics · simultaneous verses: every line keeps its own start and end time, so overlapping verses (backing vocals, choirs, echoes) are shown together and each one fades out on its own end time. Lyrics without end times behave exactly as before.
- Lyrics · background vocals: `[bg:text]` annotations (also `[bg:<mm:ss.xx>word<mm:ss.xx>]`, `[mm:ss.xx][bg:text]` and a trailing `[bg:text]` on a verse) are shown smaller and dimmer under the main verse, with their own soft enter/exit.
- Lyrics · look: smoother depth between the active verse and the previous/next ones (size, opacity and optional blur by distance).
</details>

<details>
<summary><strong>v1.04 — Screens, queue, library & performance update</strong></summary>

- Independent screens: Lyrics (synced and plain text, customization), Queue (reorder, remove, shuffle, mix options, timer, song info), Sleep timer, Song info, Equalizer.
- Real playback engine: two audio decks for gapless playback and configurable crossfade; 10-band equalizer, limiter, mono and balance through Web Audio.
- Android: foreground service, media notification, lock-screen / Bluetooth controls, audio focus and headphone-unplug handling, background playback (needs the v1.04 APK).
- Library: choose folders (persistent permission), manual "Update library" with a clear result (new, updated, missing, duplicates), embedded covers and tags, albums / artists / genres views.
- Settings reorganized into 6 categories with a quick-jump bar; new "Performance & display" with Hz profiles (only those the device supports) and an FPS cap.
- See docs/CHANGELOG-1.04.md for files, limitations and pending items.
</details>

<details>
<summary><strong>v1.03 — Cover color & lyrics update</strong></summary>Improvements and corrections

- Cover color: the whole app can take its colors from the album cover of the song that is playing, in real time, with Low, Medium and Strong intensity (Settings).
- Status bar: it can be hidden from Settings (swipe down from the top edge to see it for a moment).
- Smooth color changes: themes, modes and cover colors now fade instead of jumping.
- Softer animations: cover and title changes, play/pause icon, tab panels, notifications and selectors.
- Lyrics support: Apple Music style duets (V1:, V2:, V1000:, M:, F:, D:, <v Name>), background vocals in parentheses and speaker-only lines.
- Duet layout: main singer on the left, secondary singer on the right, both together in the center.
- Lyrics settings: three animations (Fluid, Fluid with glow, Letter by letter) with live preview, font (including importing your own .ttf/.otf/.woff/.woff2), size, duet layout and blur of distant lines.
- Fixes: removed the duplicated root workflow and the unused equalizer.js.

</details><details>
<summary><strong>v1.02 — App feel update</strong></summary>Improvements and corrections

- System bars: the status and navigation bars take the color of the app and adapt to Light, Dark and Amoled modes.
- In-app dialogs: confirmations use the app's own dialogs instead of the browser ones.
- Layout: fixed bottom bar without bounce, new icons and an adaptive design.

</details><details>
<summary><strong>v1.01 — Mini Update</strong></summary>Improvements and corrections

- Iconography: Improved consistency and proportions of interface icons.
- Text selection: Corrected the accidental web-style text selection behavior in the Android application.
- Android navigation: Improved back navigation through system buttons and lateral gestures.

</details><details>
<summary><strong>v1.00 — First Official Release</strong></summary>The first official version of Pulsar RM.

This release marked the beginning of the project and its development as an Android music player.

</details>---

🪐 Project Information

Detail| Information
Project| Pulsar RM
Full name| Pulsar Reproductor de Música
Current version| v1.04
Project type| Independent
Main platform| Android
Development| Active

---

<div align="center">🌌 PULSAR RM

Your music. Your universe.

<sub>Independently developed with a passion for music and customization.</sub>

</div><!-- End of Pulsar RM README -->
