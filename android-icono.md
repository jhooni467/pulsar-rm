# Cambiar el icono de la app (solo app Android nativa / APK)

La web ya avisa al código nativo con `window.PulsarNative.setPendingIcon("light" | "dark")`.
Light = icono blanco · Dark y Amoled = icono negro. El icono se aplica al cerrar la app.

## 1. Iconos
Usa `icon-light-512.png` y `icon-dark-512.png` como `ic_launcher_light` / `ic_launcher_dark`
(en `res/mipmap-*`; lo ideal es generarlos como "Image Asset" en Android Studio).

## 2. AndroidManifest.xml (dentro de <application>)
Quita el intent-filter LAUNCHER de tu MainActivity y ponlo en dos alias:

```xml
<activity-alias
    android:name=".IconDark"
    android:targetActivity=".MainActivity"
    android:enabled="true"
    android:exported="true"
    android:icon="@mipmap/ic_launcher_dark">
  <intent-filter>
    <action android:name="android.intent.action.MAIN" />
    <category android:name="android.intent.category.LAUNCHER" />
  </intent-filter>
</activity-alias>

<activity-alias
    android:name=".IconLight"
    android:targetActivity=".MainActivity"
    android:enabled="false"
    android:exported="true"
    android:icon="@mipmap/ic_launcher_light">
  <intent-filter>
    <action android:name="android.intent.action.MAIN" />
    <category android:name="android.intent.category.LAUNCHER" />
  </intent-filter>
</activity-alias>
```

## 3. MainActivity.kt
```kotlin
private val prefs by lazy { getSharedPreferences("pulsar", MODE_PRIVATE) }

// Al crear el WebView:
webView.addJavascriptInterface(object {
    @android.webkit.JavascriptInterface
    fun setPendingIcon(variant: String) {
        prefs.edit().putString("icon", variant).apply()   // solo guarda; no cambia nada todavía
    }
}, "PulsarNative")

// El icono se cambia al salir de la app:
override fun onStop() {
    super.onStop()
    val light = prefs.getString("icon", "dark") == "light"
    setAlias("IconLight", light)
    setAlias("IconDark", !light)
}

private fun setAlias(name: String, enabled: Boolean) {
    packageManager.setComponentEnabledSetting(
        ComponentName(this, "com.tuapp.$name"),          // <- tu paquete
        if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
        PackageManager.DONT_KILL_APP
    )
}
```
Cambia `com.tuapp` por el paquete real. Algunos launchers tardan unos segundos en refrescar el icono.
