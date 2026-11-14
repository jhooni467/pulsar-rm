package com.pulsarrm.app;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Lectura de carpetas autorizadas (v1.04) con el Storage Access Framework.
 * Solo se ejecuta cuando la web lo pide (Ajustes → Biblioteca musical → Actualizar). No hay vigilancia en segundo plano.
 *  Fase 1: recorre las carpetas y lista los archivos de audio y las letras (.lrc/.srt/.vtt/.txt) que están al lado.
 *  Fase 2: lee las etiquetas (MediaMetadataRetriever) solo de lo NUEVO o MODIFICADO (la web envía qué conoce ya)
 *          y guarda la portada incrustada reducida en files/covers/.
 * Los resultados llegan a la web por lotes (scanProgress, scanBatch, scanDone).
 */
final class LibraryScanner {
    private static final Set<String> AUDIO_EXT = new HashSet<>();
    private static final Set<String> LYRICS_EXT = new HashSet<>();
    static {
        String[] a = {"mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav", "wma", "amr", "mka"};
        for (String e : a) AUDIO_EXT.add(e);
        String[] l = {"lrc", "srt", "vtt", "txt"};
        for (String e : l) LYRICS_EXT.add(e);
    }

    private static final class Entry {
        String docId, name, mime, folderUri, parentId;
        long size, modified;
        String lyricsDocId, lyricsExt;
    }

    private final Context ctx;
    private final ContentResolver resolver;
    private final AtomicBoolean cancel;
    private long lastProgress = 0;

    LibraryScanner(Context ctx, AtomicBoolean cancel) {
        this.ctx = ctx.getApplicationContext();
        this.resolver = this.ctx.getContentResolver();
        this.cancel = cancel;
    }

    void run(JSONObject options) {
        JSONArray errors = new JSONArray();
        boolean ok = true;
        try {
            JSONArray folders = options.optJSONArray("folders");
            JSONObject known = options.optJSONObject("known");
            if (known == null) known = new JSONObject();
            List<Entry> entries = new ArrayList<>();
            Set<String> seenDocs = new HashSet<>();

            // ----- Fase 1: listar -----
            for (int i = 0; folders != null && i < folders.length() && !cancel.get(); i++) {
                String folder = folders.getString(i);
                try {
                    Uri tree = Uri.parse(folder);
                    String root = DocumentsContract.getTreeDocumentId(tree);
                    if (!walk(tree, folder, root, entries, seenDocs, new int[]{0})) {
                        errors.put(new JSONObject().put("folderUri", folder).put("reason", "unreadable"));
                    }
                } catch (SecurityException e) {
                    errors.put(new JSONObject().put("folderUri", folder).put("reason", "permission"));
                } catch (Exception e) {
                    errors.put(new JSONObject().put("folderUri", folder).put("reason", "unreadable"));
                }
            }

            // ----- Fase 2: leer lo nuevo o cambiado, por lotes -----
            int total = entries.size();
            JSONArray batch = new JSONArray();
            int done = 0;
            for (Entry e : entries) {
                if (cancel.get()) break;
                JSONObject item = new JSONObject();
                String folder = e.folderUri;
                Uri tree = Uri.parse(folder);
                Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, e.docId);
                item.put("docKey", e.docId).put("uri", doc.toString()).put("folderUri", folder)
                    .put("fileName", e.name).put("size", e.size).put("lastModified", e.modified).put("mime", e.mime);
                String sig = e.modified + ":" + e.size;
                if (sig.equals(known.optString(e.docId, ""))) {
                    item.put("unchanged", true);
                } else {
                    item.put("meta", readMeta(doc, e, tree));
                }
                batch.put(item);
                done++;
                if (batch.length() >= 25) { PulsarBridge.event("scanBatch", new JSONObject().put("items", batch).toString()); batch = new JSONArray(); }
                progress("reading", done, total, 0);
            }
            if (batch.length() > 0) PulsarBridge.event("scanBatch", new JSONObject().put("items", batch).toString());
        } catch (Exception e) {
            ok = false;
        }
        try {
            PulsarBridge.event("scanDone", new JSONObject().put("ok", ok).put("cancelled", cancel.get()).put("errors", errors).toString());
        } catch (Exception ignored) { /* nada más que hacer */ }
    }

    private void progress(String phase, int done, int total, int found) {
        long now = System.currentTimeMillis();
        if (now - lastProgress < 150 && done < total) return;
        lastProgress = now;
        try {
            PulsarBridge.event("scanProgress", new JSONObject().put("phase", phase).put("done", done).put("total", total).put("found", found).toString());
        } catch (Exception ignored) { /* no crítico */ }
    }

    /** Recorre una carpeta. Devuelve false si no se pudo leer. */
    private boolean walk(Uri tree, String folderUri, String parentId, List<Entry> out, Set<String> seen, int[] counter) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] cols = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED};
        Cursor c = null;
        List<String> subfolders = new ArrayList<>();
        List<Entry> audio = new ArrayList<>();
        Map<String, String[]> lyrics = new HashMap<>();
        try {
            c = resolver.query(children, cols, null, null, null);
            if (c == null) return false;
            while (c.moveToNext() && !cancel.get()) {
                String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                if (id == null || name == null) continue;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    if (!name.startsWith(".")) subfolders.add(id);
                    continue;
                }
                String ext = extension(name);
                String base = name.contains(".") ? name.substring(0, name.lastIndexOf('.')) : name;
                boolean isAudio = (mime != null && mime.startsWith("audio/")) || (mime != null && mime.equals("application/ogg")) || AUDIO_EXT.contains(ext);
                if (isAudio && !name.startsWith(".")) {
                    if (!seen.add(id)) continue;
                    Entry e = new Entry();
                    e.docId = id; e.name = name; e.mime = mime == null ? "" : mime; e.folderUri = folderUri; e.parentId = parentId;
                    e.size = c.isNull(3) ? 0 : c.getLong(3);
                    e.modified = c.isNull(4) ? 0 : c.getLong(4);
                    audio.add(e);
                } else if (LYRICS_EXT.contains(ext)) {
                    // si hay varias, gana .lrc sobre .vtt/.srt y estas sobre .txt
                    String[] prev = lyrics.get(base.toLowerCase(Locale.ROOT));
                    if (prev == null || rank(ext) < rank(prev[1])) lyrics.put(base.toLowerCase(Locale.ROOT), new String[]{id, ext});
                }
            }
        } finally {
            if (c != null) c.close();
        }
        for (Entry e : audio) {
            String base = e.name.contains(".") ? e.name.substring(0, e.name.lastIndexOf('.')) : e.name;
            String[] l = lyrics.get(base.toLowerCase(Locale.ROOT));
            if (l != null) { e.lyricsDocId = l[0]; e.lyricsExt = l[1]; }
            out.add(e);
        }
        counter[0] += audio.size();
        progress("listing", 0, 0, counter[0]);
        for (String sub : subfolders) {
            if (cancel.get()) break;
            try { walk(tree, folderUri, sub, out, seen, counter); } catch (SecurityException ignored) { /* subcarpeta sin acceso */ }
        }
        return true;
    }

    private static int rank(String ext) { return "lrc".equals(ext) ? 0 : "vtt".equals(ext) ? 1 : "srt".equals(ext) ? 2 : 3; }

    private static String extension(String name) {
        int i = name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i + 1).toLowerCase(Locale.ROOT);
    }

    private JSONObject readMeta(Uri doc, Entry e, Uri tree) throws Exception {
        JSONObject m = new JSONObject();
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(ctx, doc);
            put(m, "title", r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE));
            put(m, "artist", r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST));
            put(m, "album", r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM));
            put(m, "albumArtist", r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST));
            put(m, "genre", r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_GENRE));
            String year = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_YEAR);
            if (year == null) year = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE);
            if (year != null && year.length() >= 4) m.put("year", leadingInt(year.substring(0, 4)));
            m.put("track", leadingInt(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)));
            m.put("disc", leadingInt(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER)));
            String dur = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (dur != null) m.put("duration", Long.parseLong(dur) / 1000.0);
            String br = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE);
            if (br != null) m.put("bitrate", Long.parseLong(br));
            byte[] pic = r.getEmbeddedPicture();
            if (pic != null && pic.length > 0) {
                String file = saveCover(e.docId, pic);
                if (file != null) m.put("coverFile", file);
            }
        } catch (Exception ex) {
            // archivo sin etiquetas legibles: la web usará el nombre del archivo
        } finally {
            try { r.release(); } catch (Exception ignored) { /* nada */ }
        }
        if (e.lyricsDocId != null) {
            m.put("lyricsHint", e.lyricsExt);
            m.put("lrcUri", DocumentsContract.buildDocumentUriUsingTree(tree, e.lyricsDocId).toString());
        }
        return m;
    }

    private static void put(JSONObject o, String key, String value) throws Exception {
        if (value != null && !value.trim().isEmpty()) o.put(key, value.trim());
    }

    private static int leadingInt(String s) {
        if (s == null) return 0;
        int n = 0, i = 0;
        s = s.trim();
        while (i < s.length() && Character.isDigit(s.charAt(i))) { n = n * 10 + (s.charAt(i) - '0'); i++; if (n > 100000) break; }
        return n;
    }

    /** Guarda la portada reducida (máx. 720 px) y devuelve el nombre del archivo. */
    private String saveCover(String docId, byte[] bytes) {
        try {
            File dir = new File(ctx.getFilesDir(), "covers");
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            String name = Integer.toHexString(docId.hashCode()) + "_" + Integer.toHexString(bytes.length) + ".jpg";
            File file = new File(dir, name);
            if (file.isFile()) return name;
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth <= 0) return null;
            int sample = 1;
            while (bounds.outWidth / (sample * 2) >= 720 && bounds.outHeight / (sample * 2) >= 720) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
            if (bmp == null) return null;
            FileOutputStream out = new FileOutputStream(file);
            try { bmp.compress(Bitmap.CompressFormat.JPEG, 86, out); } finally { out.close(); bmp.recycle(); }
            return name;
        } catch (Exception ex) {
            return null;
        }
    }

    /* ---------- Lecturas puntuales (las pide la web cuando hacen falta) ---------- */

    static String readLyrics(Context ctx, JSONObject request) {
        try {
            String lrc = request.optString("lrcUri", "");
            if (lrc.isEmpty()) return new JSONObject().put("ok", false).toString();
            InputStream in = ctx.getContentResolver().openInputStream(Uri.parse(lrc));
            if (in == null) return new JSONObject().put("ok", false).toString();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n, total = 0;
            try {
                while ((n = in.read(chunk)) > 0 && total < 1024 * 1024) { buf.write(chunk, 0, n); total += n; }
            } finally { in.close(); }
            return new JSONObject().put("ok", true).put("b64", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP)).toString();
        } catch (Exception e) {
            return "{\"ok\":false}";
        }
    }

    static String trackInfo(Context ctx, String uri) {
        JSONObject o = new JSONObject();
        MediaExtractor ex = new MediaExtractor();
        try {
            ex.setDataSource(ctx, Uri.parse(uri), null);
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    if (f.containsKey(MediaFormat.KEY_SAMPLE_RATE)) o.put("sampleRate", f.getInteger(MediaFormat.KEY_SAMPLE_RATE));
                    if (f.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) o.put("channels", f.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
                    if (f.containsKey(MediaFormat.KEY_BIT_RATE)) o.put("bitrate", f.getInteger(MediaFormat.KEY_BIT_RATE));
                    break;
                }
            }
        } catch (Exception ignored) {
            // sin datos técnicos
        } finally {
            try { ex.release(); } catch (Exception ignored) { /* nada */ }
        }
        return o.toString();
    }
}
