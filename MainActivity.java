package com.pulsarrm.app;

import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.LayerDrawable;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.OnApplyWindowInsetsListener;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

/**
 * Pantalla principal de Pulsar RM (Capacitor).
 * v1.03: icono Light/Dark, colores de las barras del sistema, barra de estado oculta.
 * v1.04: puente PulsarNative ampliado (PulsarBridge), rutas /_pulsar_media y /_pulsar_cover (MediaWebClient) y
 *        reproducción en segundo plano (el WebView no se duerme mientras suena música).
 * v1.04.2: «Abrir con Pulsar RM» desde el administrador de archivos u otras apps (audio/*), sin reproducción automática
 *          bloqueada por el WebView, y el cambio de icono solo se aplica cuando realmente cambia.
 * v1.05: pantalla completa real (sin franja gris arriba: el WebView ocupa toda la altura y solo respeta las áreas seguras)
 *        y botón/gesto Atrás controlado por la app (Reproductor → Biblioteca → Inicio → salir).
 */
public class MainActivity extends BridgeActivity {
    private PulsarBridge bridge;
    private Intent lastIntent;
    // Últimas áreas seguras aplicadas al WebView (px): arriba, abajo, izquierda, derecha. Se muestran en Ajustes → Diagnóstico.
    private volatile int insTop, insBottom, insLeft, insRight;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Si Android recrea la pantalla, el audio que ya se abrió antes no se vuelve a abrir
        lastIntent = savedInstanceState != null ? getIntent() : null;
        super.onCreate(savedInstanceState);
        WebView web = getBridge().getWebView();
        // La música debe poder seguir con la siguiente canción, el temporizador o la notificación sin tocar la pantalla
        try { web.getSettings().setMediaPlaybackRequiresUserGesture(false); } catch (Exception ignored) { /* el valor por defecto de Capacitor ya lo permite */ }
        bridge = new PulsarBridge(this, web);
        web.addJavascriptInterface(bridge, "PulsarNative");
        setupEdgeToEdge(web);
        setupBackHandling(web);
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
        handleIncoming(getIntent());
    }


    /* ---------- Pantalla completa real y áreas seguras (v1.05) ---------- */

    // Origen de la franja gris de arriba: la ventana de Android dejaba una zona sin cubrir encima del WebView y se veía el
    // fondo de la ventana (gris oscuro). Ahora la ventana ocupa TODA la pantalla (borde a borde) y el WebView se coloca
    // exactamente dentro de las áreas seguras: barra de estado (si está visible), recorte de la cámara, barra de
    // navegación y teclado. Con la barra de estado oculta solo se respeta el recorte de la cámara.
    private void setupEdgeToEdge(final WebView web) {
        try {
            Window w = getWindow();
            WindowCompat.setDecorFitsSystemWindows(w, false);
            if (Build.VERSION.SDK_INT >= 28) {
                WindowManager.LayoutParams lp = w.getAttributes();
                lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= 30
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                w.setAttributes(lp);
            }
            // El teclado ya no redimensiona la ventana sola: llega como inset y se aplica abajo
            w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            ViewCompat.setOnApplyWindowInsetsListener(web, new OnApplyWindowInsetsListener() {
                @Override
                public WindowInsetsCompat onApplyWindowInsets(View v, WindowInsetsCompat insets) {
                    applySafeAreas(v, insets);
                    return WindowInsetsCompat.CONSUMED;
                }
            });
            ViewCompat.requestApplyInsets(web);
        } catch (Exception ignored) {
            // si algo falla, la app sigue con el diseño anterior
        }
    }

    private void applySafeAreas(View v, WindowInsetsCompat insets) {
        Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
        Insets cut = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
        // Barra de estado oculta: bars.top vale 0 y solo queda el recorte de la cámara (o nada si no hay).
        int top = Math.max(bars.top, cut.top);
        int left = Math.max(bars.left, cut.left);
        int right = Math.max(bars.right, cut.right);
        int bottom = Math.max(bars.bottom, cut.bottom);
        if (Build.VERSION.SDK_INT >= 30) bottom = Math.max(bottom, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom);
        else bottom = Math.max(bottom, insets.getSystemWindowInsetBottom());   // teclado en Android 10 o anterior
        insTop = top; insBottom = bottom; insLeft = left; insRight = right;
        ViewGroup.LayoutParams lp = v.getLayoutParams();
        if (lp instanceof ViewGroup.MarginLayoutParams) {
            ViewGroup.MarginLayoutParams m = (ViewGroup.MarginLayoutParams) lp;
            if (m.topMargin != top || m.bottomMargin != bottom || m.leftMargin != left || m.rightMargin != right) {
                m.setMargins(left, top, right, bottom);
                v.setLayoutParams(m);
            }
        } else {
            v.setPadding(left, top, right, bottom);
        }
    }

    /** Áreas seguras actuales en píxeles (para el Diagnóstico de Ajustes). */
    String insetsJson() {
        return "{\"top\":" + insTop + ",\"bottom\":" + insBottom + ",\"left\":" + insLeft + ",\"right\":" + insRight + "}";
    }

    /* ---------- Botón / gesto Atrás (v1.05) ---------- */

    // Capacitor sale de la app (o retrocede el historial del WebView) por su cuenta. Aquí la app decide: la web cierra
    // lo que esté abierto o sube un paso (Reproductor → Biblioteca → Inicio) y solo en Inicio se sale.
    // Este callback se registra después del de Capacitor, así que tiene prioridad sobre él.
    private void setupBackHandling(final WebView web) {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                try {
                    web.evaluateJavascript(
                        "(function(){try{return window.PulsarBack?window.PulsarBack():'exit'}catch(e){return 'exit'}})()",
                        new android.webkit.ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                if (value != null && value.contains("handled")) return;   // la web ya retrocedió
                                leaveApp();
                            }
                        });
                } catch (Exception e) {
                    leaveApp();
                }
            }
        });
    }

    /** En Inicio, Atrás manda la app a segundo plano (como casi todos los reproductores): la música sigue sonando. */
    private void leaveApp() {
        try {
            if (!moveTaskToBack(true)) finish();
        } catch (Exception e) {
            finish();
        }
    }

    /* ---------- Audio abierto desde otra app («Abrir con…») ---------- */

    // Capacitor llama a onNewIntent(getIntent()) durante super.onCreate(): por eso handleIncoming no depende de nada más.
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncoming(intent);
    }

    private void handleIncoming(Intent intent) {
        if (intent == null || intent == lastIntent) return;
        lastIntent = intent;
        Uri data = intent.getData();
        if (!Intent.ACTION_VIEW.equals(intent.getAction()) || data == null) return;
        try {
            String name = null;
            if ("content".equals(data.getScheme())) {
                Cursor c = null;
                try {
                    c = getContentResolver().query(data, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
                    if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
                } catch (Exception ignored) { /* se usa un nombre de respaldo */ }
                finally { if (c != null) c.close(); }
            }
            if (name == null || name.isEmpty()) name = data.getLastPathSegment();
            if (name == null || name.isEmpty()) name = "audio";
            String mime = intent.getType();
            JSONObject o = new JSONObject().put("uri", data.toString()).put("name", name).put("mime", mime == null ? "" : mime);
            PulsarBridge.setPendingOpen(o.toString());
            // Si la web ya está abierta lo recoge ahora; si la app está arrancando, lo pide al terminar de cargar
            PulsarEvents.emit("openAudio");
        } catch (Exception ignored) { /* un audio que no se pueda describir simplemente no se abre */ }
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
        // El icono (Light/Dark) se cambia al salir de la app (solo si de verdad cambió)
        boolean light = "light".equals(prefs().getString("icon", "dark"));
        if (light) { setAlias("IconLight", true, false); setAlias("IconDark", false, true); }
        else { setAlias("IconDark", true, true); setAlias("IconLight", false, false); }
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
    public void onDestroy() {
        PulsarEvents.attach(null);
        super.onDestroy();
    }

    /* ---------- Resultados de pantallas del sistema ---------- */

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
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
            // El modo del recorte de cámara ya lo fija setupEdgeToEdge (siempre dentro del recorte, respetando el área segura)
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
            // Detrás de las barras del sistema y del recorte se ve el fondo de la ventana: mitad superior del color de
            // la barra de estado y mitad inferior del de la de navegación (antes era un gris oscuro por defecto)
            ColorDrawable bottomHalf = new ColorDrawable(nav);
            ColorDrawable topHalf = new ColorDrawable(status);
            LayerDrawable bg = new LayerDrawable(new android.graphics.drawable.Drawable[]{bottomHalf, topHalf});
            bg.setLayerInset(1, 0, 0, 0, Math.max(1, getResources().getDisplayMetrics().heightPixels / 2));
            w.setBackgroundDrawable(bg);
        } catch (Exception ignored) {
            // un color inválido no debe cerrar la app
        }
    }

    /** Cambia un alias de icono solo si su estado actual es distinto (evita refrescos del launcher en cada salida). */
    private void setAlias(String name, boolean enabled, boolean manifestDefault) {
        try {
            ComponentName cn = new ComponentName(getPackageName(), "com.pulsarrm.app." + name);
            int now = getPackageManager().getComponentEnabledSetting(cn);
            boolean isOn = now == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                || (now == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && manifestDefault);
            if (isOn == enabled) return;
            getPackageManager().setComponentEnabledSetting(cn,
                enabled ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP);
        } catch (Exception ignored) {
            // un cambio de icono fallido no debe cerrar la app
        }
    }
}
