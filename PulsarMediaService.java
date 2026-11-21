package com.pulsarrm.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaDescription;
import android.media.MediaMetadata;
import android.media.browse.MediaBrowser;
import android.media.session.MediaSession;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.Process;
import android.service.media.MediaBrowserService;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Servicio de reproducción (v1.04).
 * El audio sigue sonando DENTRO del WebView de la app; este servicio solo le da a Android lo que necesita para
 * tratarla como reproductor de música:
 *   · servicio en primer plano + notificación multimedia (anterior / pausa / siguiente, título, artista, portada)
 *   · MediaSession (pantalla de bloqueo, Bluetooth, botones de auriculares, barra de progreso del sistema)
 *   · foco de audio (llamadas y otras apps) y aviso de auriculares desconectados
 *   · bloqueo de CPU parcial mientras suena (la música no se corta con la pantalla apagada)
 *   · alarma de respaldo del temporizador
 * Las órdenes de los controles se envían a la web como avisos ("action", "focus", "sleep").
 *
 * v1.04.2: el servicio es un MediaBrowserService (la forma oficial de Android de decir «esta app es un reproductor de
 * música»): así Bluetooth, Android Auto, el Asistente y los controles multimedia del sistema la reconocen.
 * Al estar exportado (el sistema necesita conectarse), las órdenes internas llevan una clave privada de la app
 * (extra "k"); cualquier orden externa sin esa clave se ignora.
 *
 * v1.06 — integración nativa ampliada:
 *   · Android Auto / Bluetooth / Asistente: árbol de exploración real (Canciones, Álbumes, Artistas, Listas) construido
 *     con la copia de la biblioteca que manda la web (PulsarLibrary), búsqueda por voz (onPlayFromSearch) y portadas por
 *     PulsarCoverProvider. Solo se muestra a Android Auto, al sistema y a apps de confianza.
 *   · Cola de reproducción visible en el sistema, «aleatorio» y «repetir» como acciones personalizadas, metadatos completos.
 *   · Foco de audio: el dueño es el WebView (ver más abajo); este servicio ya no lleva código de foco inactivo.
 */
public class PulsarMediaService extends MediaBrowserService {
    static final String ACTION_UPDATE = "com.pulsarrm.app.UPDATE";
    static final String ACTION_STOP_ALL = "com.pulsarrm.app.STOP_ALL";
    static final String ACTION_PLAY = "com.pulsarrm.app.PLAY";
    static final String ACTION_PAUSE = "com.pulsarrm.app.PAUSE";
    static final String ACTION_NEXT = "com.pulsarrm.app.NEXT";
    static final String ACTION_PREV = "com.pulsarrm.app.PREV";
    static final String ACTION_SLEEP = "com.pulsarrm.app.SLEEP";
    private static final String CHANNEL = "pulsar_playback";
    private static final int NOTIF_ID = 4104;
    private static final String ROOT_ID = "pulsar_root";
    private static final String EMPTY_ID = "empty";
    /** Apps de confianza que pueden explorar la biblioteca (además de la propia, del sistema y de las firmadas como él). */
    private static final String[] TRUSTED_PACKAGES = {
        "com.google.android.projection.gearhead",        // Android Auto
        "com.google.android.apps.automotive.templates.host",
        "com.google.android.gms",                        // servicios de Google (Auto, Asistente)
        "com.google.android.googlequicksearchbox",       // Asistente de Google
        "com.google.android.carassistant",
        "com.google.android.autosimulator",              // simulador de Android Auto (desarrollo)
        "com.android.systemui", "com.android.bluetooth", "android"
    };
    static final String EXTRA_KEY = "k";

    // Ajustes que manda la web (setAudioOptions)
    static volatile boolean pauseOnNoisy = true;
    static volatile String focusMode = "duck";
    static volatile boolean bgPlayback = true;
    /** true mientras suena música y se permite seguir en segundo plano: MainActivity no deja dormir el WebView. */
    static volatile boolean keepAlive = false;

    /** Clave privada de la app (se crea una vez). Solo las órdenes que la llevan son atendidas por onStartCommand. */
    static synchronized String key(Context ctx) {
        SharedPreferences p = ctx.getApplicationContext().getSharedPreferences("pulsar", Context.MODE_PRIVATE);
        String k = p.getString("svcKey", null);
        if (k == null || k.isEmpty()) {
            k = UUID.randomUUID().toString();
            p.edit().putString("svcKey", k).apply();
        }
        return k;
    }

    /** Intent interno hacia este servicio, ya firmado con la clave. */
    static Intent internal(Context ctx, String action) {
        return new Intent(ctx, PulsarMediaService.class).setAction(action).putExtra(EXTRA_KEY, key(ctx));
    }

    /** Margen tras una pausa antes de soltar el primer plano y el bloqueo de CPU (cubre el cambio automático de canción). */
    private static final long PAUSE_GRACE_MS = 30_000L;
    /** Instancia viva: las actualizaciones de la web se le entregan directo, sin pasar por startForegroundService. */
    private static volatile PulsarMediaService live;

    /** Entrega una actualización de la web al servicio si ya está en marcha. false = no hay servicio vivo (hay que iniciarlo). */
    static boolean deliver(final String json) {
        final PulsarMediaService svc = live;
        if (svc == null || svc.closing) return false;
        svc.handler.post(new Runnable() {
            @Override public void run() { if (!svc.closing) svc.apply(json); }
        });
        return true;
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private volatile boolean closing = false;
    /** true mientras suena y durante el margen que sigue a una pausa. */
    private boolean holding = false;
    private final Runnable endHoldTask = new Runnable() { @Override public void run() { endHold(); } };

    private MediaSession session;
    private AudioManager audio;
    private PowerManager.WakeLock wake;
    private boolean receiverOn = false;
    /** Hilo para leer la biblioteca y armar listas sin bloquear la pantalla ni el sistema. */
    private final ExecutorService browseWorker = Executors.newSingleThreadExecutor();
    private boolean foreground = false;

    private String title = "", artist = "", album = "", coverKey = "";
    private String albumArtist = "", genre = "", mediaId = "", coverFileName = "", repeatMode = "off", queueSig = "";
    private int year = 0, track = 0;
    private boolean shuffleOn = false;
    private long currentId = -1;
    private final Set<Long> queueIds = new HashSet<>();
    private long durationMs = 0, positionMs = 0;
    private boolean playing = false, canPrev = true, canNext = true;
    private Bitmap cover;

    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction()) && pauseOnNoisy && playing) {
                PulsarBridge.action("interrupt", null);
            }
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        audio = (AudioManager) getSystemService(AUDIO_SERVICE);
        createChannel();
        session = new MediaSession(this, "PulsarRM");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() {
                // Reanudar desde la pantalla de bloqueo / Bluetooth: si ya se había soltado el primer plano, se recupera ahora
                if (!title.isEmpty()) ensureForeground();
                PulsarBridge.action("play", null);
            }
            @Override public void onPause() { PulsarBridge.action("pause", null); }
            @Override public void onSkipToNext() { PulsarBridge.action("next", null); }
            @Override public void onSkipToPrevious() { PulsarBridge.action("previous", null); }
            @Override public void onStop() { PulsarBridge.action("stop", null); }
            @Override public void onSeekTo(long pos) { PulsarBridge.action("seek", String.valueOf(pos)); }
            // v1.06: Android Auto, Bluetooth y el Asistente
            @Override public void onPlayFromMediaId(String id, Bundle extras) { if (!title.isEmpty()) ensureForeground(); playMediaId(id); }
            @Override public void onPlayFromSearch(String query, Bundle extras) {
                if (!title.isEmpty()) ensureForeground();
                playSearch(query, extras);
            }
            @Override public void onSkipToQueueItem(long id) { PulsarBridge.action("playId", String.valueOf(id)); }
            @Override public void onCustomAction(String action, Bundle extras) {
                if ("shuffle".equals(action) || "repeat".equals(action)) PulsarBridge.action(action, null);
            }
        });
        // Qué volumen controlan las teclas y Bluetooth cuando la app no está al frente: el de música
        session.setPlaybackToLocal(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build());
        session.setActive(true);
        live = this;
        // El sistema (Bluetooth, coche, Asistente, controles multimedia) se conecta a la sesión por aquí
        setSessionToken(session.getSessionToken());
        PendingIntent open = openAppIntent();
        if (open != null) session.setSessionActivity(open);
        // Deja lista la biblioteca para cuando el coche la pida (así la primera lista no espera a leer el archivo)
        browseWorker.execute(new Runnable() { @Override public void run() { PulsarLibrary.get(getApplicationContext()); } });
    }

    /** La web actualizó la copia de la biblioteca: se avisa a quien esté explorándola (Android Auto) para que se refresque. */
    static void libraryChanged() {
        final PulsarMediaService svc = live;
        if (svc == null || svc.closing) return;
        svc.handler.post(new Runnable() {
            @Override public void run() {
                if (svc.closing) return;
                String[] ids = {ROOT_ID, "songs", "albums", "artists", "lists"};
                for (String id : ids) { try { svc.notifyChildrenChanged(id); } catch (Exception ignored) { /* sin clientes */ } }
            }
        });
    }

    /* ---------- MediaBrowserService: Android reconoce la app como reproductor de música ---------- */

    @Override public BrowserRoot onGetRoot(String clientPackageName, int clientUid, Bundle rootHints) {
        // Pistas de presentación que entienden Android Auto y los coches: listas para todo (canciones, álbumes, artistas)
        Bundle extras = new Bundle();
        extras.putBoolean("android.media.browse.CONTENT_STYLE_SUPPORTED", true);
        extras.putInt("android.media.browse.CONTENT_STYLE_BROWSABLE_HINT", 1); // 1 = lista, 2 = cuadrícula
        extras.putInt("android.media.browse.CONTENT_STYLE_PLAYABLE_HINT", 1);
        return new BrowserRoot(ROOT_ID, extras);
    }

    /** ¿Puede esta app ver la biblioteca? La propia, el sistema, Android Auto / Asistente de Google y apps firmadas como el sistema. */
    private boolean isTrustedCaller(String pkg, int uid) {
        if (pkg == null) return false;
        if (pkg.equals(getPackageName()) || uid == Process.myUid() || uid == Process.SYSTEM_UID) return true;
        for (String p : TRUSTED_PACKAGES) if (p.equals(pkg)) return true;
        try {
            if (getPackageManager().checkSignatures(uid, Process.SYSTEM_UID) == PackageManager.SIGNATURE_MATCH) return true;
            ApplicationInfo ai = getPackageManager().getApplicationInfo(pkg, 0);
            return (ai.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
        } catch (Exception e) {
            return false;
        }
    }

    /** Quién está pidiendo ahora mismo (solo Android 9+; antes no se puede saber y se atiende como siempre). */
    private boolean currentCallerTrusted() {
        if (Build.VERSION.SDK_INT < 28) return true;
        try {
            MediaSessionManager.RemoteUserInfo info = getCurrentBrowserInfo();
            return info == null || isTrustedCaller(info.getPackageName(), info.getUid());
        } catch (Exception e) {
            return true;
        }
    }

    @Override public void onLoadChildren(String parentId, Result<List<MediaBrowser.MediaItem>> result) {
        loadChildren(parentId, result, -1, -1);
    }

    @Override public void onLoadChildren(String parentId, Result<List<MediaBrowser.MediaItem>> result, Bundle options) {
        int page = options == null ? -1 : options.getInt(MediaBrowser.EXTRA_PAGE, -1);
        int size = options == null ? -1 : options.getInt(MediaBrowser.EXTRA_PAGE_SIZE, -1);
        loadChildren(parentId, result, page, size);
    }

    private void loadChildren(final String parentId, final Result<List<MediaBrowser.MediaItem>> result, final int page, final int pageSize) {
        final boolean trusted = currentCallerTrusted();
        result.detach();
        browseWorker.execute(new Runnable() {
            @Override public void run() {
                List<MediaBrowser.MediaItem> out = new ArrayList<>();
                try {
                    List<PulsarLibrary.Entry> entries = new ArrayList<>();
                    if (trusted) {
                        PulsarLibrary.Snapshot snap = PulsarLibrary.get(getApplicationContext());
                        entries = PulsarLibrary.children(snap, parentId);
                        if (entries.isEmpty() && snap.isEmpty() && (ROOT_ID.equals(parentId) || "root".equals(parentId))) {
                            entries.add(new PulsarLibrary.Entry(EMPTY_ID, "Abre Pulsar RM en el teléfono", "para cargar tu biblioteca aquí", null, true, 0));
                        }
                    }
                    int from = 0, to = entries.size();
                    if (page >= 0 && pageSize > 0) { from = Math.min(entries.size(), page * pageSize); to = Math.min(entries.size(), from + pageSize); }
                    else if (to > 1000) to = 1000; // tope de seguridad sin paginación
                    for (int i = from; i < to; i++) out.add(toItem(entries.get(i)));
                } catch (Exception ignored) { /* se entrega lo que se pudo */ }
                result.sendResult(out);
            }
        });
    }

    private MediaDescription describe(PulsarLibrary.Entry e) {
        MediaDescription.Builder d = new MediaDescription.Builder().setMediaId(e.id).setTitle(e.title);
        if (e.subtitle != null) d.setSubtitle(e.subtitle);
        if (e.cover != null) {
            Uri u = PulsarCoverProvider.uriFor(this, e.cover);
            if (u != null) d.setIconUri(u);
        }
        if (e.durationMs > 0) {
            Bundle ex = new Bundle();
            ex.putLong(MediaMetadata.METADATA_KEY_DURATION, e.durationMs);
            d.setExtras(ex);
        }
        return d.build();
    }

    private MediaBrowser.MediaItem toItem(PulsarLibrary.Entry e) {
        return new MediaBrowser.MediaItem(describe(e), e.browsable ? MediaBrowser.MediaItem.FLAG_BROWSABLE : MediaBrowser.MediaItem.FLAG_PLAYABLE);
    }

    /** Tocar una canción (o un álbum, artista, lista) en el coche / Bluetooth: se reproduce la lista completa desde ahí. */
    private void playMediaId(final String id) {
        final Context ctx = getApplicationContext();
        browseWorker.execute(new Runnable() {
            @Override public void run() {
                try {
                    PulsarLibrary.Snapshot snap = PulsarLibrary.get(ctx);
                    String[] song = PulsarLibrary.parseSongId(id);
                    if (song != null) {
                        long sid = Long.parseLong(song[0]);
                        List<Long> ids = PulsarLibrary.idsOf(snap, song[1]);
                        if (!ids.contains(sid)) { ids = new ArrayList<>(); ids.add(sid); }
                        PulsarBridge.requestPlayIds(ctx, ids, sid);
                    } else {
                        List<Long> ids = PulsarLibrary.idsOf(snap, id);
                        if (!ids.isEmpty()) PulsarBridge.requestPlayIds(ctx, ids, ids.get(0));
                    }
                } catch (Exception ignored) { /* id no válido */ }
            }
        });
    }

    /** «Ok Google, pon X en Pulsar RM» / orden de voz del coche. */
    private void playSearch(final String query, Bundle extras) {
        final Context ctx = getApplicationContext();
        final String artist = extras == null ? null : extras.getString("android.intent.extra.artist");
        final String album = extras == null ? null : extras.getString("android.intent.extra.album");
        final String song = extras == null ? null : extras.getString("android.intent.extra.title");
        final String genre = extras == null ? null : extras.getString("android.intent.extra.genre");
        browseWorker.execute(new Runnable() {
            @Override public void run() { PulsarBridge.playFromSearch(ctx, query, artist, album, song, genre); }
        });
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        boolean trusted = intent != null && key(this).equals(intent.getStringExtra(EXTRA_KEY));
        if (!trusted) {
            // Orden externa (o sin datos): se ignora. Si Android exigió startForeground(), se cumple y se cierra.
            if (!foreground) { ensureForeground(); shutdown(); }
            return START_NOT_STICKY;
        }
        closing = false;
        live = this;
        String action = intent.getAction();
        if (action == null || ACTION_UPDATE.equals(action)) {
            // Android exige llamar a startForeground() pocos segundos después de startForegroundService():
            // se hace SIEMPRE primero (aunque la canción esté en pausa), si no la app se cierra.
            ensureForeground();
            if (intent.hasExtra("json")) apply(intent.getStringExtra("json"));
            else { shutdown(); } // sin datos: no hay nada que mostrar
        } else if (ACTION_STOP_ALL.equals(action)) {
            shutdown();
        } else if (ACTION_PLAY.equals(action)) {
            // El botón de la notificación permite volver a primer plano aunque la app esté oculta
            if (!title.isEmpty()) ensureForeground();
            PulsarBridge.action("play", null);
        }
        else if (ACTION_PAUSE.equals(action)) { PulsarBridge.action("pause", null); }
        else if (ACTION_NEXT.equals(action)) { PulsarBridge.action("next", null); }
        else if (ACTION_PREV.equals(action)) { PulsarBridge.action("previous", null); }
        else if (ACTION_SLEEP.equals(action)) {
            PulsarBridge.event("sleep");
            if (!foreground) stopSelf(); // no había música sonando: solo se avisa a la web
        }
        return START_NOT_STICKY;
    }

    /* ---------- Datos que manda la web ---------- */

    private void apply(String json) {
        try {
            JSONObject o = new JSONObject(json);
            title = o.optString("title", "Sin título");
            artist = o.optString("artist", "");
            album = o.optString("album", "");
            durationMs = o.optLong("durationMs", 0);
            positionMs = o.optLong("positionMs", 0);
            canPrev = o.optBoolean("canPrev", true);
            canNext = o.optBoolean("canNext", true);
            albumArtist = o.optString("albumArtist", "");
            genre = o.optString("genre", "");
            year = o.optInt("year", 0);
            track = o.optInt("track", 0);
            shuffleOn = o.optBoolean("shuffle", false);
            repeatMode = o.optString("repeat", "off");
            String songId = o.optString("id", "");
            mediaId = songId.isEmpty() ? "" : "s:" + songId;
            try { currentId = songId.isEmpty() ? -1 : Long.parseLong(songId); } catch (NumberFormatException e) { currentId = -1; }
            coverFileName = PulsarLibrary.safeFile(o.optString("coverFile", ""));
            updateQueue(o.optJSONArray("queue"));
            boolean was = playing;
            playing = o.optBoolean("playing", false);

            String key = o.optString("id", "") + "|" + o.optString("coverFile", "");
            if (o.has("coverB64")) {
                byte[] bytes = Base64.decode(o.getString("coverB64"), Base64.DEFAULT);
                cover = scaled(BitmapFactory.decodeByteArray(bytes, 0, bytes.length));
                coverKey = key;
            } else if (!key.equals(coverKey)) {
                coverKey = key;
                String file = o.optString("coverFile", "");
                cover = null;
                if (!file.isEmpty() && !file.contains("/") && !file.contains("..")) {
                    cover = scaled(BitmapFactory.decodeFile(new File(new File(getFilesDir(), "covers"), file).getPath()));
                }
            }
            // Una pausa NO suelta de inmediato el primer plano ni el bloqueo de CPU: entre canción y canción el audio
            // se detiene un instante (evento «ended») y, con la pantalla apagada, Android no deja volver a pedir el
            // primer plano desde segundo plano. Solo se sueltan si la pausa dura más de PAUSE_GRACE_MS.
            // (Una actualización en pausa que llega DENTRO del margen no lo reinicia ni lo cancela.)
            if (playing) { handler.removeCallbacks(endHoldTask); holding = true; }
            else if (was) { handler.removeCallbacks(endHoldTask); holding = true; handler.postDelayed(endHoldTask, PAUSE_GRACE_MS); }
            keepAlive = bgPlayback && holding;
            publish();
            if (playing) {
                if (!was) { registerNoisy(); PulsarEvents.keepWebAlive(); }
                acquireWake(); // en cada canción: renueva el tope de seguridad, así no caduca en sesiones largas
            }
        } catch (Exception e) {
            // datos incompletos: se ignoran
        }
    }

    /** Cola que se ve en el sistema (Android 13+, Android Auto): se arma con la copia de la biblioteca y solo si cambió. */
    private void updateQueue(JSONArray q) {
        String sig = q == null ? "" : q.toString();
        if (sig.equals(queueSig)) return;
        queueSig = sig;
        queueIds.clear();
        if (session == null) return;
        if (q == null || q.length() == 0) { session.setQueue(null); return; }
        PulsarLibrary.Snapshot snap = PulsarLibrary.get(this);
        List<MediaSession.QueueItem> items = new ArrayList<>();
        for (int i = 0; i < q.length(); i++) {
            long id = q.optLong(i, -1);
            PulsarLibrary.Song s = snap.byId.get(id);
            if (s == null || id < 0 || queueIds.contains(id)) continue; // los ids de la cola del sistema no pueden repetirse
            queueIds.add(id);
            items.add(new MediaSession.QueueItem(describe(PulsarLibrary.songEntry(s, "queue")), id));
        }
        if (items.isEmpty()) { session.setQueue(null); return; }
        session.setQueue(items);
        session.setQueueTitle("Cola de reproducción");
    }

    private int drawable(String name) { return getResources().getIdentifier(name, "drawable", getPackageName()); }

    private Bitmap scaled(Bitmap b) {
        if (b == null) return null;
        int max = 512;
        if (b.getWidth() <= max && b.getHeight() <= max) return b;
        float f = Math.min((float) max / b.getWidth(), (float) max / b.getHeight());
        return Bitmap.createScaledBitmap(b, Math.max(1, Math.round(b.getWidth() * f)), Math.max(1, Math.round(b.getHeight() * f)), true);
    }

    private void publish() {
        MediaMetadata.Builder md = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, artist);
        if (durationMs > 0) md.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs); // sin duración conocida, Android no muestra una barra falsa
        if (!mediaId.isEmpty()) md.putString(MediaMetadata.METADATA_KEY_MEDIA_ID, mediaId);
        if (!albumArtist.isEmpty()) md.putString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST, albumArtist);
        if (!genre.isEmpty()) md.putString(MediaMetadata.METADATA_KEY_GENRE, genre);
        if (year > 0) md.putLong(MediaMetadata.METADATA_KEY_YEAR, year);
        if (track > 0) md.putLong(MediaMetadata.METADATA_KEY_TRACK_NUMBER, track);
        if (cover != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, cover);
        if (!coverFileName.isEmpty()) { // Android Auto y algunos controles prefieren la imagen por dirección
            Uri u = PulsarCoverProvider.uriFor(this, coverFileName);
            if (u != null) md.putString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI, u.toString());
        }
        session.setMetadata(md.build());

        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_STOP | PlaybackState.ACTION_SEEK_TO
            | PlaybackState.ACTION_PLAY_FROM_MEDIA_ID | PlaybackState.ACTION_PLAY_FROM_SEARCH;
        if (canNext) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        if (canPrev) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        if (!queueIds.isEmpty()) actions |= PlaybackState.ACTION_SKIP_TO_QUEUE_ITEM;
        PlaybackState.Builder ps = new PlaybackState.Builder()
            .setActions(actions)
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, positionMs, playing ? 1f : 0f);
        if (queueIds.contains(currentId)) ps.setActiveQueueItemId(currentId);
        // Aleatorio y repetir como botones del sistema (pantalla de bloqueo de Android 13+, Android Auto, relojes)
        int shuffleIcon = drawable(shuffleOn ? "ic_pulsar_shuffle_on" : "ic_pulsar_shuffle_off");
        if (shuffleIcon != 0) ps.addCustomAction(new PlaybackState.CustomAction.Builder("shuffle", shuffleOn ? "Aleatorio: activado" : "Aleatorio: desactivado", shuffleIcon).build());
        int repeatIcon = drawable("one".equals(repeatMode) ? "ic_pulsar_repeat_one" : ("all".equals(repeatMode) ? "ic_pulsar_repeat_all" : "ic_pulsar_repeat_off"));
        if (repeatIcon != 0) ps.addCustomAction(new PlaybackState.CustomAction.Builder("repeat",
            "one".equals(repeatMode) ? "Repetir: una canción" : ("all".equals(repeatMode) ? "Repetir: todas" : "Repetir: desactivado"), repeatIcon).build());
        session.setPlaybackState(ps.build());

        Notification n = buildNotification();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (playing) {
            ensureForeground();
            nm.notify(NOTIF_ID, n);
        } else {
            if (foreground && !holding) { stopForeground(false); foreground = false; } // pausada de verdad: la notificación se puede descartar
            nm.notify(NOTIF_ID, n);
        }
    }

    /** Pone el servicio en primer plano con la notificación actual. Nunca lanza: si Android no lo permite, la música sigue en la app. */
    private void ensureForeground() {
        if (foreground) return;
        try {
            Notification n = buildNotification();
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTIF_ID, n);
            foreground = true;
        } catch (Exception e) {
            foreground = false;
        }
    }

    private PendingIntent openAppIntent() {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open == null) return null;
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
    }

    private PendingIntent service(String action, int code) {
        Intent i = internal(this, action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getService(this, code, i, flags);
    }

    private Notification buildNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        PendingIntent content = openAppIntent();
        b.setSmallIcon(getResources().getIdentifier("ic_stat_pulsar", "drawable", getPackageName()) != 0
                ? getResources().getIdentifier("ic_stat_pulsar", "drawable", getPackageName()) : android.R.drawable.ic_media_play)
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album.isEmpty() ? null : album)
            .setLargeIcon(cover)
            .setContentIntent(content)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing || holding)
            .addAction(android.R.drawable.ic_media_previous, "Anterior", service(ACTION_PREV, 1))
            .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                       playing ? "Pausa" : "Reproducir", service(playing ? ACTION_PAUSE : ACTION_PLAY, 2))
            .addAction(android.R.drawable.ic_media_next, "Siguiente", service(ACTION_NEXT, 3))
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel c = new NotificationChannel(CHANNEL, "Reproducción", NotificationManager.IMPORTANCE_LOW);
        c.setDescription("Controles de la música que suena");
        c.setShowBadge(false);
        c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(c);
    }

    /* ---------- Foco de audio, CPU y auriculares ---------- */

    /*
     * FOCO DE AUDIO — a propósito, este servicio NO lo pide (v1.04.3, confirmado en v1.06).
     * El audio suena dentro del WebView, y Chromium ya pide y gestiona su propio foco: pausa en llamadas y alarmas,
     * baja el volumen con avisos cortos, y reanuda solo cuando el sistema se lo devuelve. Android reparte el foco por
     * solicitud: si este servicio pidiera otro, la solicitud del WebView recibiría «pérdida» y la canción se pausaría sola
     * justo al empezar (era el fallo de la v1.04.2). Con un único dueño no hay conflicto ni interrupciones propias.
     * Lo que sí hace el servicio alrededor del foco: avisar al sistema del tipo de audio (USAGE_MEDIA, para volumen y
     * Bluetooth), pausar al desconectar auriculares, despertar la web al recibir órdenes y no soltar el primer plano
     * entre canciones. Los eventos «focus» de la web siguen aceptándose por compatibilidad, pero ya no se generan.
     */

    private void acquireWake() {
        if (!bgPlayback) return;
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PulsarRM:playback");
            wake.setReferenceCounted(false);
        }
        wake.acquire(6 * 60 * 60 * 1000L); // tope de seguridad: 6 h (cada llamada lo renueva)
    }

    private void releaseWake() { if (wake != null && wake.isHeld()) wake.release(); }

    private void registerNoisy() {
        if (receiverOn) return;
        registerReceiver(noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        receiverOn = true;
    }

    /** Terminó el margen tras una pausa: ahora sí se suelta el primer plano y el bloqueo de CPU. */
    private void endHold() {
        if (playing) return;
        holding = false;
        keepAlive = false;
        releaseWake();
        if (session != null) publish(); // vuelve a dibujar la notificación ya descartable y sale de primer plano
    }

    private void shutdown() {
        closing = true;
        if (live == this) live = null;
        handler.removeCallbacks(endHoldTask);
        holding = false;
        playing = false;
        keepAlive = false;
        releaseWake();
        if (receiverOn) { try { unregisterReceiver(noisy); } catch (Exception ignored) {} receiverOn = false; }
        stopForeground(true);
        foreground = false;
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancel(NOTIF_ID);
        stopSelf();
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        // La persona cerró la app deslizándola: sin pantalla no hay quien reciba los controles, se detiene todo.
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override public void onDestroy() {
        closing = true;
        if (live == this) live = null;
        handler.removeCallbacks(endHoldTask);
        holding = false;
        keepAlive = false;
        releaseWake();
        if (receiverOn) { try { unregisterReceiver(noisy); } catch (Exception ignored) {} receiverOn = false; }
        if (session != null) { session.setActive(false); session.release(); session = null; }
        browseWorker.shutdown();
        super.onDestroy();
    }

    /* ---------- Alarma de respaldo del temporizador ---------- */

    static void scheduleSleep(Context ctx, long endAtMs) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = sleepIntent(ctx);
        am.cancel(pi);
        if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endAtMs, pi);
        else am.set(AlarmManager.RTC_WAKEUP, endAtMs, pi);
    }

    static void cancelSleep(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(ALARM_SERVICE);
        if (am != null) am.cancel(sleepIntent(ctx));
    }

    private static PendingIntent sleepIntent(Context ctx) {
        Intent i = internal(ctx, ACTION_SLEEP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getService(ctx, 9, i, flags);
    }
}
