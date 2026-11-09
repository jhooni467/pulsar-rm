package com.pulsarrm.app;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import org.json.JSONObject;

import java.lang.ref.WeakReference;

/**
 * Avisos de Android hacia la web (v1.04).
 * Se entregan llamando a window.PulsarBridge.onNative(tipo, jsonTexto) dentro del WebView.
 * Si la pantalla de la app ya no existe, el aviso se descarta (la web no está para recibirlo).
 */
final class PulsarEvents {
    private static WeakReference<WebView> web = new WeakReference<>(null);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private PulsarEvents() {}

    static void attach(WebView view) { web = new WeakReference<>(view); }

    static void emit(final String type, final String json) {
        MAIN.post(new Runnable() {
            @Override public void run() {
                WebView view = web.get();
                if (view == null) return;
                String js = "window.PulsarBridge&&window.PulsarBridge.onNative(" + JSONObject.quote(type) + "," + JSONObject.quote(json == null ? "{}" : json) + ");";
                try { view.evaluateJavascript(js, null); } catch (Exception ignored) { /* el WebView se está cerrando */ }
            }
        });
    }

    static void emit(String type) { emit(type, "{}"); }
}
