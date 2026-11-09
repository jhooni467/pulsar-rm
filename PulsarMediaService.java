package com.pulsarrm.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;

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
 */
public class PulsarMediaService extends Service {
    static final String ACTION_UPDATE = "com.pulsarrm.app.UPDATE";
    static final String ACTION_STOP_ALL = "com.pulsarrm.app.STOP_ALL";
    static final String ACTION_PLAY = "com.pulsarrm.app.PLAY";
    static final String ACTION_PAUSE = "com.pulsarrm.app.PAUSE";
    static final String ACTION_NEXT = "com.pulsarrm.app.NEXT";
    static final String ACTION_PREV = "com.pulsarrm.app.PREV";
    static final String ACTION_SLEEP = "com.pulsarrm.app.SLEEP";
    private static final String CHANNEL = "pulsar_playback";
    private static final int NOTIF_ID = 4104;

    // Ajustes que manda la web (setAudioOptions)
    static volatile boolean pauseOnNoisy = true;
    static volatile String focusMode = "duck";
    static volatile boolean bgPlayback = true;
    /** true mientras suena música y se permite seguir en segundo plano: MainActivity no deja dormir el WebView. */
    static volatile boolean keepAlive = false;

    private MediaSession session;
    private AudioManager audio;
    private PowerManager.WakeLock wake;
    private AudioFocusRequest focusRequest;
    private boolean hasFocus = false;
    private boolean receiverOn = false;
    private boolean foreground = false;

    private String title = "", artist = "", album = "", coverKey = "";
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

    private final AudioManager.OnAudioFocusChangeListener focusListener = new AudioManager.OnAudioFocusChangeListener() {
        @Override public void onAudioFocusChange(int change) {
            switch (change) {
                case AudioManager.AUDIOFOCUS_GAIN:
                    hasFocus = true;
                    PulsarBridge.focus("resume");
                    break;
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                    PulsarBridge.focus("pause".equals(focusMode) ? "pause" : "duck");
                    break;
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                    PulsarBridge.focus("pause");
                    break;
                case AudioManager.AUDIOFOCUS_LOSS:
                    hasFocus = false;
                    PulsarBridge.focus("loss");
                    break;
                default: break;
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
            @Override public void onPlay() { PulsarBridge.action("play", null); }
            @Override public void onPause() { PulsarBridge.action("pause", null); }
            @Override public void onSkipToNext() { PulsarBridge.action("next", null); }
            @Override public void onSkipToPrevious() { PulsarBridge.action("previous", null); }
            @Override public void onStop() { PulsarBridge.action("stop", null); }
            @Override public void onSeekTo(long pos) { PulsarBridge.action("seek", String.valueOf(pos)); }
        });
        session.setActive(true);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null || ACTION_UPDATE.equals(action)) {
            if (intent != null && intent.hasExtra("json")) apply(intent.getStringExtra("json"));
            else if (!foreground) { stopSelf(); } // reinicio sin datos: no hay nada que mostrar
        } else if (ACTION_STOP_ALL.equals(action)) {
            shutdown();
        } else if (ACTION_PLAY.equals(action)) { PulsarBridge.action("play", null); }
        else if (ACTION_PAUSE.equals(action)) { PulsarBridge.action("pause", null); }
        else if (ACTION_NEXT.equals(action)) { PulsarBridge.action("next", null); }
        else if (ACTION_PREV.equals(action)) { PulsarBridge.action("previous", null); }
        else if (ACTION_SLEEP.equals(action)) {
            PulsarBridge.event("sleep");
            releaseFocus();
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
            keepAlive = bgPlayback && playing;
            publish();
            if (playing && !was) { acquireFocus(); acquireWake(); registerNoisy(); }
            if (!playing && was) { releaseWake(); }
        } catch (Exception e) {
            // datos incompletos: se ignoran
        }
    }

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
            .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (cover != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, cover);
        session.setMetadata(md.build());

        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_STOP | PlaybackState.ACTION_SEEK_TO;
        if (canNext) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        if (canPrev) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(actions)
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, positionMs, playing ? 1f : 0f)
            .build());

        Notification n = buildNotification();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (playing) {
            if (!foreground) {
                try {
                    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                    else startForeground(NOTIF_ID, n);
                    foreground = true;
                } catch (Exception e) {
                    // Android no permitió el primer plano (sin permiso de notificaciones, por ejemplo): la música sigue en la app
                    nm.notify(NOTIF_ID, n);
                }
            } else nm.notify(NOTIF_ID, n);
        } else {
            if (foreground) { stopForeground(false); foreground = false; } // pausada: la notificación se puede descartar
            nm.notify(NOTIF_ID, n);
        }
    }

    private PendingIntent service(String action, int code) {
        Intent i = new Intent(this, PulsarMediaService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getService(this, code, i, flags);
    }

    private Notification buildNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent content = null;
        if (open != null) {
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
        }
        b.setSmallIcon(getResources().getIdentifier("ic_stat_pulsar", "drawable", getPackageName()) != 0
                ? getResources().getIdentifier("ic_stat_pulsar", "drawable", getPackageName()) : android.R.drawable.ic_media_play)
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album.isEmpty() ? null : album)
            .setLargeIcon(cover)
            .setContentIntent(content)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
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

    private void acquireFocus() {
        if (hasFocus) return;
        int result;
        if (Build.VERSION.SDK_INT >= 26) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setOnAudioFocusChangeListener(focusListener)
                .setWillPauseWhenDucked(false)
                .build();
            result = audio.requestAudioFocus(focusRequest);
        } else {
            result = audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        hasFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void releaseFocus() {
        if (!hasFocus) return;
        if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) audio.abandonAudioFocusRequest(focusRequest);
        else audio.abandonAudioFocus(focusListener);
        hasFocus = false;
    }

    private void acquireWake() {
        if (!bgPlayback) return;
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PulsarRM:playback");
            wake.setReferenceCounted(false);
        }
        if (!wake.isHeld()) wake.acquire(6 * 60 * 60 * 1000L); // tope de seguridad: 6 h
    }

    private void releaseWake() { if (wake != null && wake.isHeld()) wake.release(); }

    private void registerNoisy() {
        if (receiverOn) return;
        registerReceiver(noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        receiverOn = true;
    }

    private void shutdown() {
        playing = false;
        keepAlive = false;
        releaseWake();
        releaseFocus();
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
        keepAlive = false;
        releaseWake();
        releaseFocus();
        if (receiverOn) { try { unregisterReceiver(noisy); } catch (Exception ignored) {} receiverOn = false; }
        if (session != null) { session.setActive(false); session.release(); session = null; }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

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
        Intent i = new Intent(ctx, PulsarMediaService.class).setAction(ACTION_SLEEP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getService(ctx, 9, i, flags);
    }
}
