package com.pulsarrm.app;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.view.Display;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Puente web ↔ Android (v1.04): window.PulsarNative.
 * Mantiene los métodos de la v1.03 (icono, barras, versión) y suma los de reproducción, carpetas, pantalla y temporizador.
 * Todo método devuelve texto (JSON) o nada; los avisos hacia la web salen por PulsarEvents.
 * Contrato completo en docs/NATIVE_API.md.
 */
final class PulsarBridge {
    static final int REQ_FOLDER = 7101;
    static final int REQ_NOTIF = 7102;

    private static PulsarBridge current;
    /** Audio que otra app pidió abrir con Pulsar RM (JSON {uri,name,mime}); la web lo recoge con takePendingOpen(). */
    private static volatile String pendingOpen = null;
    private final MainActivity activity;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private AtomicBoolean scanCancel = new AtomicBoolean(false);
    private volatile boolean scanning = false;

    PulsarBridge(MainActivity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        current = this;
    }

    /* ---------- Avisos que salen de los servicios ---------- */

    static void event(String type) { PulsarEvents.emit(type, "{}"); }
    static void event(String type, String json) { PulsarEvents.emit(type, json); }

    static void action(String name, String value) {
        try {
            JSONObject o = new JSONObject().put("name", name);
            if (value != null) o.put("value", Long.parseLong(value));
            PulsarEvents.emit("action", o.toString());
        } catch (Exception ignored) { /* no crítico */ }
    }

    static void focus(String action) {
        try { PulsarEvents.emit("focus", new JSONObject().put("action", action).toString()); } catch (Exception ignored) { /* no crítico */ }
    }

    static void setPendingOpen(String json) { pendingOpen = json; }

    /* ---------- Resultados de pantallas del sistema ---------- */

    void onActivityResult(int request, int result, Intent data) {
        if (request != REQ_FOLDER) return;
        if (result != Activity.RESULT_OK || data == null || data.getData() == null) { event("folderCancelled"); return; }
        Uri uri = data.getData();
        try {
            activity.getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception e) {
            event("folderCancelled");
            return;
        }
        try {
            event("folderPicked", new JSONObject().put("uri", uri.toString()).put("name", folderName(uri)).toString());
        } catch (Exception ignored) { event("folderCancelled"); }
    }

    void onPermissionResult(int request) {
        if (request == REQ_NOTIF) event("permission");
    }

    private String folderName(Uri tree) {
        try {
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            Cursor c = activity.getContentResolver().query(doc, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            if (c != null) {
                try { if (c.moveToFirst() && c.getString(0) != null) return c.getString(0); } finally { c.close(); }
            }
        } catch (Exception ignored) { /* se usa el nombre de respaldo */ }
        String id = tree.getLastPathSegment();
        if (id != null) { int i = id.lastIndexOf('/'); int j = id.lastIndexOf(':'); return id.substring(Math.max(i, j) + 1); }
        return "Carpeta";
    }

    /* ---------- Métodos que ve la web ---------- */

    @JavascriptInterface public String getVersion() {
        try { return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
    }

    @JavascriptInterface public void setPendingIcon(String variant) { activity.savePendingIcon("light".equals(variant)); }
    @JavascriptInterface public void setBars(final String statusHex, final String navHex, final boolean darkIcons) { activity.setBars(statusHex, navHex, darkIcons); }
    @JavascriptInterface public void setStatusBarHidden(final boolean hidden) { activity.setStatusHidden(hidden); }

    /** Qué sabe hacer esta app y este dispositivo. La web la llama una vez al iniciar. */
    @JavascriptInterface public String getInfo() {
        try {
            JSONObject o = new JSONObject();
            o.put("api", 2);
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("notifications", notificationsAllowed());
            // Las carpetas necesitan WebView.getWebViewClient() (Android 8+)
            o.put("folders", Build.VERSION.SDK_INT >= 26);
            o.put("display", displayInfo());
            return o.toString();
        } catch (Exception e) {
            return "{\"api\":2}";
        }
    }

    private boolean notificationsAllowed() {
        if (Build.VERSION.SDK_INT < 33) return true;
        return activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
    }

    @JavascriptInterface public void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33 || notificationsAllowed()) return;
        main.post(new Runnable() { @Override public void run() { activity.requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF); } });
    }

    /** Devuelve (una sola vez) el audio que se abrió desde el administrador de archivos u otra app, o "" si no hay. */
    @JavascriptInterface public String takePendingOpen() {
        String value = pendingOpen;
        pendingOpen = null;
        return value == null ? "" : value;
    }

    /* ----- Reproducción ----- */

    @JavascriptInterface public void mediaUpdate(String json) {
        Context ctx = activity.getApplicationContext();
        Intent i = PulsarMediaService.internal(ctx, PulsarMediaService.ACTION_UPDATE).putExtra("json", json);
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
        } catch (Exception e) {
            // Android no dejó iniciar el servicio (restricciones en segundo plano): la música sigue sonando en la app
        }
    }

    @JavascriptInterface public void mediaStop() {
        PulsarMediaService.keepAlive = false;
        Context ctx = activity.getApplicationContext();
        try { ctx.startService(PulsarMediaService.internal(ctx, PulsarMediaService.ACTION_STOP_ALL)); } catch (Exception ignored) { /* ya estaba detenido */ }
    }

    @JavascriptInterface public void setAudioOptions(boolean pauseOnNoisy, String focusMode, boolean bgPlayback) {
        PulsarMediaService.pauseOnNoisy = pauseOnNoisy;
        PulsarMediaService.focusMode = focusMode == null ? "duck" : focusMode;
        PulsarMediaService.bgPlayback = bgPlayback;
    }

    @JavascriptInterface public void setSleepTimer(String endAtMs) {
        try { PulsarMediaService.scheduleSleep(activity.getApplicationContext(), Long.parseLong(endAtMs)); } catch (Exception ignored) { /* hora inválida */ }
    }

    @JavascriptInterface public void cancelSleepTimer() { PulsarMediaService.cancelSleep(activity.getApplicationContext()); }

    @JavascriptInterface public void setKeepScreenOn(final boolean on) {
        main.post(new Runnable() { @Override public void run() { web.setKeepScreenOn(on); } });
    }

    /* ----- Pantalla (Hz) ----- */

    private Display display() {
        return Build.VERSION.SDK_INT >= 30 ? activity.getDisplay() : activity.getWindowManager().getDefaultDisplay();
    }

    private JSONObject displayInfo() throws Exception {
        Display d = display();
        JSONObject o = new JSONObject();
        int current = d == null ? 60 : Math.round(d.getRefreshRate());
        TreeSet<Integer> rates = new TreeSet<>();
        if (d != null && Build.VERSION.SDK_INT >= 23) {
            Display.Mode now = d.getMode();
            for (Display.Mode m : d.getSupportedModes()) {
                if (m.getPhysicalWidth() == now.getPhysicalWidth() && m.getPhysicalHeight() == now.getPhysicalHeight()) rates.add(Math.round(m.getRefreshRate()));
            }
        }
        if (rates.isEmpty()) rates.add(current);
        JSONArray list = new JSONArray();
        for (int r : rates) list.put(r);
        o.put("currentHz", current).put("maxHz", rates.last()).put("rates", list).put("switchable", Build.VERSION.SDK_INT >= 23 && rates.size() > 1);
        return o;
    }

    /** hz = 0 → automático (lo decide el sistema). Devuelve { ok, hz, display }. */
    @JavascriptInterface public String setRefreshRate(final int hz) {
        try {
            JSONObject info = displayInfo();
            JSONObject out = new JSONObject().put("display", info).put("hz", hz);
            if (Build.VERSION.SDK_INT < 23 || !info.getBoolean("switchable")) return out.put("ok", hz == 0).toString();
            final int rounded = hz;
            boolean supported = hz == 0;
            JSONArray rates = info.getJSONArray("rates");
            for (int i = 0; i < rates.length(); i++) if (rates.getInt(i) == hz) supported = true;
            if (!supported) return out.put("ok", false).toString();
            main.post(new Runnable() {
                @Override public void run() { applyRefresh(rounded); }
            });
            // Android tarda un instante en cambiar el modo: se avisa a la web con la tasa real
            main.postDelayed(new Runnable() {
                @Override public void run() { try { PulsarEvents.emit("display", displayInfo().toString()); } catch (Exception ignored) { /* no crítico */ } }
            }, 900);
            return out.put("ok", true).toString();
        } catch (Exception e) {
            return "{\"ok\":false}";
        }
    }

    private void applyRefresh(int hz) {
        if (Build.VERSION.SDK_INT < 23) return;
        Window w = activity.getWindow();
        WindowManager.LayoutParams lp = w.getAttributes();
        if (hz == 0) {
            lp.preferredDisplayModeId = 0;
            lp.preferredRefreshRate = 0f;
        } else {
            Display d = display();
            Display.Mode now = d.getMode();
            int best = 0;
            for (Display.Mode m : d.getSupportedModes()) {
                if (m.getPhysicalWidth() == now.getPhysicalWidth() && m.getPhysicalHeight() == now.getPhysicalHeight() && Math.round(m.getRefreshRate()) == hz) { best = m.getModeId(); break; }
            }
            lp.preferredDisplayModeId = best;
            lp.preferredRefreshRate = best == 0 ? (float) hz : 0f;
        }
        w.setAttributes(lp);
    }

    /* ----- Carpetas y biblioteca ----- */

    @JavascriptInterface public void pickFolder() {
        main.post(new Runnable() {
            @Override public void run() {
                try {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                    activity.startActivityForResult(i, REQ_FOLDER);
                } catch (Exception e) {
                    event("folderCancelled"); // este dispositivo no tiene selector de carpetas
                }
            }
        });
    }

    @JavascriptInterface public String getPersistedFolders() {
        JSONArray list = new JSONArray();
        try {
            List<UriPermission> perms = activity.getContentResolver().getPersistedUriPermissions();
            for (UriPermission p : perms) if (p.isReadPermission()) list.put(p.getUri().toString());
            return new JSONObject().put("folders", list).toString();
        } catch (Exception e) {
            return "{\"folders\":[]}";
        }
    }

    @JavascriptInterface public void releaseFolder(String uri) {
        try { activity.getContentResolver().releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { /* ya no estaba */ }
    }

    @JavascriptInterface public boolean scanLibrary(final String optionsJson) {
        if (scanning) return false;
        final JSONObject options;
        try { options = new JSONObject(optionsJson); } catch (Exception e) { return false; }
        scanning = true;
        scanCancel = new AtomicBoolean(false);
        final AtomicBoolean cancel = scanCancel;
        worker.execute(new Runnable() {
            @Override public void run() {
                try { new LibraryScanner(activity, cancel).run(options); } finally { scanning = false; }
            }
        });
        return true;
    }

    @JavascriptInterface public void cancelScan() { scanCancel.set(true); }

    @JavascriptInterface public String readLyrics(String requestJson) {
        try { return LibraryScanner.readLyrics(activity, new JSONObject(requestJson)); } catch (Exception e) { return "{\"ok\":false}"; }
    }

    @JavascriptInterface public String getTrackInfo(String uri) { return LibraryScanner.trackInfo(activity, uri); }
}
