package com.pulsarrm.app;

import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Pantalla principal de Pulsar RM (Capacitor).
 * v1.03: icono Light/Dark, colores de las barras del sistema, barra de estado oculta.
 * v1.04: puente PulsarNative ampliado (PulsarBridge), rutas /_pulsar_media y /_pulsar_cover (MediaWebClient) y
 *        reproducción en segundo plano (el WebView no se duerme mientras suena música).
 */
public class MainActivity extends BridgeActivity {
    private PulsarBridge bridge;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView web = getBridge().getWebView();
        bridge = new PulsarBridge(this, web);
        web.addJavascriptInterface(bridge, "PulsarNative");
        PulsarEvents.attach(web);

        // Canciones de carpetas: el cliente de Capacitor sigue haciendo todo; solo se añaden las dos rutas propias.
        if (Build.VERSION.SDK_INT >= 26) {
            WebViewClient original = web.getWebViewClient();
            web.setWebViewClient(new MediaWebClient(original, this));
        }

        // Al abrir, ya se usan los colores guardados (sin franja negra ni destello)
        SharedPreferences p = prefs();
        applyBars(p.getString("barStatus", "#080B16"), p.getString("barNav", "#0D1321"), p.getBoolean("barDarkIcons", false));
        applyStatusHidden(p.getBoolean("statusHidden", false));
    }

    /* ---------- Reproducción en segundo plano ---------- */

    // Capacitor pausa el WebView al ocultar la app; mientras suena música se vuelve a activar para que el audio,
    // los botones de la notificación y el temporizador sigan funcionando con la pantalla apagada.
    @Override
    public void onPause() {
        super.onPause();
        keepWebAlive();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebAlive();
        // El icono (Light/Dark) se cambia al salir de la app
        boolean light = "light".equals(prefs().getString("icon", "dark"));
        setAlias("IconLight", light);
        setAlias("IconDark", !light);
    }

    private void keepWebAlive() {
        if (!PulsarMediaService.keepAlive) return;
        try {
            WebView web = getBridge().getWebView();
            web.onResume();
            web.resumeTimers();
        } catch (Exception ignored) { /* no debe cerrar la app */ }
    }

    @Override
    protected void onDestroy() {
        PulsarEvents.attach(null);
        super.onDestroy();
    }

    /* ---------- Resultados de pantallas del sistema ---------- */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (bridge != null) bridge.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (bridge != null) bridge.onPermissionResult(requestCode);
    }

    /* ---------- Barras del sistema e icono (v1.03) ---------- */

    SharedPreferences prefs() {
        return getSharedPreferences("pulsar", MODE_PRIVATE);
    }

    void savePendingIcon(boolean light) {
        prefs().edit().putString("icon", light ? "light" : "dark").apply();
    }

    void setBars(final String statusHex, final String navHex, final boolean darkIcons) {
        prefs().edit().putString("barStatus", statusHex).putString("barNav", navHex).putBoolean("barDarkIcons", darkIcons).apply();
        runOnUiThread(new Runnable() { @Override public void run() { applyBars(statusHex, navHex, darkIcons); } });
    }

    void setStatusHidden(final boolean hidden) {
        prefs().edit().putBoolean("statusHidden", hidden).apply();
        runOnUiThread(new Runnable() { @Override public void run() { applyStatusHidden(hidden); } });
    }

    private void applyStatusHidden(boolean hidden) {
        try {
            Window w = getWindow();
            if (Build.VERSION.SDK_INT >= 28) {
                // Sin esto, en teléfonos con notch queda una franja negra arriba
                WindowManager.LayoutParams lp = w.getAttributes();
                lp.layoutInDisplayCutoutMode = hidden
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
                w.setAttributes(lp);
            }
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            if (hidden) c.hide(WindowInsetsCompat.Type.statusBars());
            else c.show(WindowInsetsCompat.Type.statusBars());
        } catch (Exception ignored) {
            // no debe cerrar la app
        }
    }

    /** Al volver a la app (por ejemplo tras deslizar la barra) se mantiene el ajuste elegido. */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyStatusHidden(prefs().getBoolean("statusHidden", false));
    }

    private void applyBars(String statusHex, String navHex, boolean darkIcons) {
        try {
            int status = Color.parseColor(statusHex);
            int nav = Color.parseColor(navHex);
            Window w = getWindow();
            w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            w.setStatusBarColor(status);
            w.setNavigationBarColor(nav);
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
            c.setAppearanceLightStatusBars(darkIcons);
            c.setAppearanceLightNavigationBars(darkIcons);
            getBridge().getWebView().setBackgroundColor(status);
        } catch (Exception ignored) {
            // un color inválido no debe cerrar la app
        }
    }

    private void setAlias(String name, boolean enabled) {
        getPackageManager().setComponentEnabledSetting(
            new ComponentName(getPackageName(), "com.pulsarrm.app." + name),
            enabled ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP);
    }
}
