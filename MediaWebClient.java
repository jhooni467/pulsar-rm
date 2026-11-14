package com.pulsarrm.app;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Message;
import android.util.Base64;
import android.view.KeyEvent;
import android.webkit.ClientCertRequest;
import android.webkit.HttpAuthHandler;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Cliente del WebView que envuelve al de Capacitor (v1.04).
 * Todo se reenvía tal cual al cliente original; solo se atienden dos rutas propias del mismo origen de la app:
 *   /_pulsar_media/<uri en base64url>  -> canción de una carpeta autorizada, con soporte de "Range" (buscar dentro de la canción)
 *   /_pulsar_cover/<archivo>           -> carátula incrustada guardada al leer la biblioteca
 * Solo usa API pública de Android (WebView.getWebViewClient, desde Android 8).
 */
final class MediaWebClient extends WebViewClient {
    private final WebViewClient base;
    private final Context context;

    MediaWebClient(WebViewClient base, Context context) {
        this.base = base;
        this.context = context.getApplicationContext();
    }

    /* ---------- Rutas propias ---------- */

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = url.getPath();
        if (path != null) {
            try {
                if (path.startsWith("/_pulsar_media/")) return media(path.substring("/_pulsar_media/".length()), request.getRequestHeaders());
                if (path.startsWith("/_pulsar_cover/")) return cover(Uri.decode(path.substring("/_pulsar_cover/".length())));
            } catch (Exception e) {
                return error(500, "Error");
            }
        }
        return base != null ? base.shouldInterceptRequest(view, request) : super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse error(int code, String text) {
        return new WebResourceResponse("text/plain", "utf-8", code, text, noCache(), new java.io.ByteArrayInputStream(new byte[0]));
    }

    private Map<String, String> noCache() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "no-store");
        return h;
    }

    private WebResourceResponse cover(String name) {
        if (name.contains("/") || name.contains("..")) return error(404, "Not Found");
        File file = new File(new File(context.getFilesDir(), "covers"), name);
        if (!file.isFile()) return error(404, "Not Found");
        try {
            Map<String, String> h = noCache();
            h.put("Cache-Control", "max-age=86400");
            return new WebResourceResponse("image/jpeg", null, 200, "OK", h, new FileInputStream(file));
        } catch (IOException e) {
            return error(404, "Not Found");
        }
    }

    private WebResourceResponse media(String encoded, Map<String, String> requestHeaders) throws IOException {
        String uriText = new String(Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8);
        Uri uri = Uri.parse(uriText);
        AssetFileDescriptor afd;
        try {
            afd = context.getContentResolver().openAssetFileDescriptor(uri, "r");
        } catch (Exception e) {
            return error(404, "Not Found");
        }
        if (afd == null) return error(404, "Not Found");
        long total = afd.getLength();
        String mime = context.getContentResolver().getType(uri);
        if (mime == null || mime.isEmpty() || "application/octet-stream".equals(mime)) mime = guessMime(uriText);

        long start = 0, end = total - 1;
        boolean partial = false;
        String range = requestHeaders != null ? headerIgnoreCase(requestHeaders, "Range") : null;
        if (range != null && range.startsWith("bytes=") && total > 0) {
            String[] parts = range.substring(6).split("-", 2);
            try {
                if (!parts[0].isEmpty()) {
                    start = Long.parseLong(parts[0]);
                    if (parts.length > 1 && !parts[1].isEmpty()) end = Long.parseLong(parts[1]);
                } else if (parts.length > 1 && !parts[1].isEmpty()) {
                    start = Math.max(0, total - Long.parseLong(parts[1])); // "los últimos N bytes"
                }
                partial = true;
            } catch (NumberFormatException ignored) { start = 0; partial = false; }
            if (start >= total) { try { afd.close(); } catch (IOException ignored) {} return error(416, "Range Not Satisfiable"); }
            if (end >= total) end = total - 1;
        }
        long length = total > 0 ? end - start + 1 : -1;

        FileInputStream in = afd.createInputStream();
        if (start > 0) in.getChannel().position(afd.getStartOffset() + start);
        InputStream body = length >= 0 ? new Limited(in, length, afd) : in;

        Map<String, String> h = noCache();
        h.put("Accept-Ranges", "bytes");
        if (length >= 0) h.put("Content-Length", String.valueOf(length));
        if (partial) {
            h.put("Content-Range", "bytes " + start + "-" + end + "/" + total);
            return new WebResourceResponse(mime, null, 206, "Partial Content", h, body);
        }
        return new WebResourceResponse(mime, null, 200, "OK", h, body);
    }

    private static String headerIgnoreCase(Map<String, String> headers, String name) {
        for (Map.Entry<String, String> e : headers.entrySet()) if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        return null;
    }

    private static String guessMime(String text) {
        String t = text.toLowerCase();
        if (t.endsWith(".mp3")) return "audio/mpeg";
        if (t.endsWith(".m4a") || t.endsWith(".mp4") || t.endsWith(".aac")) return "audio/mp4";
        if (t.endsWith(".flac")) return "audio/flac";
        if (t.endsWith(".ogg") || t.endsWith(".oga") || t.endsWith(".opus")) return "audio/ogg";
        if (t.endsWith(".wav")) return "audio/wav";
        return "audio/mpeg";
    }

    /** Entrega solo «length» bytes y cierra el archivo al terminar. */
    private static final class Limited extends FilterInputStream {
        private long left;
        private final AssetFileDescriptor afd;
        Limited(InputStream in, long length, AssetFileDescriptor afd) { super(in); this.left = length; this.afd = afd; }
        @Override public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }
        @Override public int read(byte[] buffer, int offset, int count) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(buffer, offset, (int) Math.min(count, left));
            if (n > 0) left -= n;
            return n;
        }
        @Override public void close() throws IOException {
            try { super.close(); } finally { try { afd.close(); } catch (IOException ignored) {} }
        }
    }

    /* ---------- Todo lo demás pasa al cliente de Capacitor ---------- */

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return base != null ? base.shouldOverrideUrlLoading(view, request) : super.shouldOverrideUrlLoading(view, request);
    }
    @Override @SuppressWarnings("deprecation") public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return base != null ? base.shouldOverrideUrlLoading(view, url) : super.shouldOverrideUrlLoading(view, url);
    }
    @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
        if (base != null) base.onPageStarted(view, url, favicon); else super.onPageStarted(view, url, favicon);
    }
    @Override public void onPageFinished(WebView view, String url) {
        if (base != null) base.onPageFinished(view, url); else super.onPageFinished(view, url);
    }
    @Override public void onPageCommitVisible(WebView view, String url) {
        if (base != null) base.onPageCommitVisible(view, url); else super.onPageCommitVisible(view, url);
    }
    @Override public void onLoadResource(WebView view, String url) {
        if (base != null) base.onLoadResource(view, url); else super.onLoadResource(view, url);
    }
    @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (base != null) base.onReceivedError(view, request, error); else super.onReceivedError(view, request, error);
    }
    @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        if (base != null) base.onReceivedHttpError(view, request, errorResponse); else super.onReceivedHttpError(view, request, errorResponse);
    }
    @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        if (base != null) base.onReceivedSslError(view, handler, error); else super.onReceivedSslError(view, handler, error);
    }
    @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
        if (base != null) base.onReceivedHttpAuthRequest(view, handler, host, realm); else super.onReceivedHttpAuthRequest(view, handler, host, realm);
    }
    @Override public void onReceivedClientCertRequest(WebView view, ClientCertRequest request) {
        if (base != null) base.onReceivedClientCertRequest(view, request); else super.onReceivedClientCertRequest(view, request);
    }
    @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        return base != null ? base.onRenderProcessGone(view, detail) : super.onRenderProcessGone(view, detail);
    }
    @Override public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
        if (base != null) base.doUpdateVisitedHistory(view, url, isReload); else super.doUpdateVisitedHistory(view, url, isReload);
    }
    @Override public boolean shouldOverrideKeyEvent(WebView view, KeyEvent event) {
        return base != null ? base.shouldOverrideKeyEvent(view, event) : super.shouldOverrideKeyEvent(view, event);
    }
    @Override public void onFormResubmission(WebView view, Message dontResend, Message resend) {
        if (base != null) base.onFormResubmission(view, dontResend, resend); else super.onFormResubmission(view, dontResend, resend);
    }
    @Override public void onScaleChanged(WebView view, float oldScale, float newScale) {
        if (base != null) base.onScaleChanged(view, oldScale, newScale); else super.onScaleChanged(view, oldScale, newScale);
    }
}
