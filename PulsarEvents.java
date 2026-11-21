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

    /** true si la pantalla de la app (y su web) existe ahora mismo. */
    static boolean hasWeb() { return web.get() != null; }

    /**
     * v1.06 — Despierta el WebView sin condiciones. Se usa cuando Android (notificación, auriculares, Android Auto, Asistente)
     * manda una orden: tras una pausa larga con la pantalla apagada el WebView puede estar dormido (sus temporizadores
     * detenidos) y la orden se perdía o tardaba. Es seguro: si ya estaba activo no hace nada.
     */
    static void wake() {
        MAIN.post(new Runnable() {
            @Override public void run() {
                WebView view = web.get();
                if (view == null) return;
                try { view.onResume(); view.resumeTimers(); } catch (Exception ignored) { /* el WebView se está cerrando */ }
            }
        });
    }

    /**
     * Si suena música y se permite segundo plano, vuelve a activar el WebView aunque la pantalla esté oculta o apagada.
     * MainActivity ya lo hace al ocultarse; esto cubre que la música EMPIECE (o se reanude) cuando la pantalla ya estaba apagada.
     */
    static void keepWebAlive() {
        MAIN.post(new Runnable() {
            @Override public void run() {
                WebView view = web.get();
                if (view == null || !PulsarMediaService.keepAlive) return;
                try { view.onResume(); view.resumeTimers(); } catch (Exception ignored) { /* el WebView se está cerrando */ }
            }
        });
    }
}
