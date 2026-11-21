package com.pulsarrm.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.Charset;
import java.text.Collator;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Copia de la biblioteca para Android (v1.06).
 *
 * La biblioteca vive en la web (IndexedDB). Para que Android Auto, el Asistente, Bluetooth y los controles del sistema
 * puedan EXPLORARLA y BUSCAR en ella sin abrir la app, la web envía una foto compacta (setLibrary) que se guarda en
 * files/library.json. Aquí se lee esa foto y se arma el árbol de exploración:
 *
 *   root
 *   ├─ songs            Canciones (si son muchas, agrupadas por letra: songs:A, songs:B…)
 *   ├─ albums           Álbumes   → album:&lt;clave&gt;   → canciones
 *   ├─ artists          Artistas  → artist:&lt;nombre&gt; → canciones
 *   └─ lists            Listas    → list:recent (recién agregadas) · genre:&lt;género&gt; · pl:&lt;id&gt; (listas de la app, si existen)
 *
 * Una canción se identifica como "s:&lt;id&gt;@&lt;lista de la que viene&gt;" para que al tocarla se reproduzca esa lista completa.
 * Esta clase no toca el audio: solo datos. Los ids son los mismos de la biblioteca de la web.
 */
final class PulsarLibrary {
    private PulsarLibrary() {}

    static final String FILE = "library.json";
    /** Con más canciones que esto, «Canciones» se agrupa por letra (las pantallas de los coches muestran listas cortas). */
    static final int LETTER_SPLIT = 120;
    static final int RECENT_MAX = 100;
    private static final Charset UTF8 = Charset.forName("UTF-8");

    /* ---------- Modelos ---------- */

    static final class Song {
        final long id, durationMs, addedAt;
        final String title, artist, album, albumArtist, genre, cover;
        final int track, disc, year;

        Song(long id, String title, String artist, String album, String albumArtist, String genre, String cover,
             long durationMs, long addedAt, int track, int disc, int year) {
            this.id = id;
            this.title = title.isEmpty() ? "Sin título" : title;
            this.artist = artist;
            this.album = album;
            this.albumArtist = albumArtist;
            this.genre = genre;
            this.cover = cover;
            this.durationMs = durationMs;
            this.addedAt = addedAt;
            this.track = track;
            this.disc = disc;
            this.year = year;
        }

        // Mismas reglas de agrupación que la pestaña Álbumes / Artistas de la app
        String artistKey() { return unknownArtist(artist) ? "Artista desconocido" : artist.trim(); }
        String albumKey() {
            if (album.isEmpty()) return "";
            String who = albumArtist.isEmpty() ? artist : albumArtist;
            return album.trim() + "||" + who.trim();
        }
        String subtitle() {
            StringBuilder sb = new StringBuilder(artistKey());
            if (!album.isEmpty()) sb.append(" · ").append(album);
            return sb.toString();
        }
    }

    static final class Playlist {
        final String id, name;
        final List<Long> ids;
        Playlist(String id, String name, List<Long> ids) { this.id = id; this.name = name; this.ids = ids; }
    }

    /** Un elemento del árbol (carpeta navegable o canción reproducible). */
    static final class Entry {
        final String id, title, subtitle, cover;
        final boolean browsable;
        final long durationMs;
        Entry(String id, String title, String subtitle, String cover, boolean browsable, long durationMs) {
            this.id = id; this.title = title; this.subtitle = subtitle; this.cover = cover; this.browsable = browsable; this.durationMs = durationMs;
        }
    }

    static final class Snapshot {
        final List<Song> songs;
        final Map<Long, Song> byId = new HashMap<>();
        final List<Playlist> playlists;
        Snapshot(List<Song> songs, List<Playlist> playlists) {
            this.songs = songs;
            this.playlists = playlists;
            for (Song s : songs) byId.put(s.id, s);
        }
        boolean isEmpty() { return songs.isEmpty(); }
    }

    /* ---------- Guardar / leer la foto ---------- */

    private static Snapshot cache;

    /** Guarda la foto que manda la web y la deja lista en memoria. Lanza excepción si el texto no es válido (no se guarda). */
    static synchronized void save(Context ctx, String json) throws Exception {
        Snapshot snap = parse(json); // valida antes de escribir
        File dir = ctx.getFilesDir();
        File tmp = new File(dir, FILE + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try { out.write(json.getBytes(UTF8)); out.getFD().sync(); } finally { out.close(); }
        File dest = new File(dir, FILE);
        if (!tmp.renameTo(dest)) {
            if (dest.exists() && !dest.delete()) throw new IOException("No se pudo reemplazar " + FILE);
            if (!tmp.renameTo(dest)) throw new IOException("No se pudo guardar " + FILE);
        }
        cache = snap;
    }

    /** La foto actual (vacía si la web aún no la mandó). Nunca devuelve null ni lanza. */
    static synchronized Snapshot get(Context ctx) {
        if (cache != null) return cache;
        try {
            File f = new File(ctx.getFilesDir(), FILE);
            if (f.isFile()) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                FileInputStream in = new FileInputStream(f);
                try {
                    byte[] buf = new byte[32 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                } finally { in.close(); }
                cache = parse(new String(bos.toByteArray(), UTF8));
                return cache;
            }
        } catch (Exception ignored) { /* archivo dañado: se trata como vacío */ }
        cache = new Snapshot(new ArrayList<Song>(), new ArrayList<Playlist>());
        return cache;
    }

    static Snapshot parse(String json) throws Exception {
        JSONObject root = new JSONObject(json);
        List<Song> songs = new ArrayList<>();
        JSONArray arr = root.optJSONArray("songs");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null || !o.has("i")) continue;
                songs.add(new Song(
                    o.optLong("i"), o.optString("t", ""), o.optString("a", ""), o.optString("al", ""), o.optString("aa", ""),
                    o.optString("g", "").trim(), safeFile(o.optString("c", "")),
                    o.optLong("d", 0), o.optLong("ad", 0), o.optInt("n", 0), o.optInt("dc", 0), o.optInt("y", 0)));
            }
        }
        List<Playlist> lists = new ArrayList<>();
        JSONArray pls = root.optJSONArray("playlists");
        if (pls != null) {
            for (int i = 0; i < pls.length(); i++) {
                JSONObject o = pls.optJSONObject(i);
                if (o == null) continue;
                List<Long> ids = new ArrayList<>();
                JSONArray a = o.optJSONArray("s");
                if (a != null) for (int k = 0; k < a.length(); k++) ids.add(a.optLong(k));
                String id = o.optString("i", "");
                if (!id.isEmpty()) lists.add(new Playlist(id, o.optString("n", "Lista"), ids));
            }
        }
        return new Snapshot(songs, lists);
    }

    /** Solo nombres simples de archivo (nunca rutas) para las portadas. */
    static String safeFile(String name) {
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("\\") || name.contains("..")) return "";
        return name;
    }

    /* ---------- Textos y orden ---------- */

    static boolean unknownArtist(String name) {
        if (name == null) return true;
        String n = name.trim().toLowerCase(Locale.ROOT);
        return n.isEmpty() || n.equals("archivo local") || n.equals("desconocido") || n.equals("<unknown>") || n.equals("unknown");
    }

    /** Minúsculas y sin acentos, para comparar búsquedas. */
    static String fold(String s) {
        if (s == null) return "";
        String n = Normalizer.normalize(s, Normalizer.Form.NFD);
        StringBuilder sb = new StringBuilder(n.length());
        for (int i = 0; i < n.length(); i++) {
            char c = n.charAt(i);
            if (Character.getType(c) != Character.NON_SPACING_MARK) sb.append(c);
        }
        return sb.toString().toLowerCase(Locale.ROOT).trim();
    }

    private static Collator collator() {
        Collator c = Collator.getInstance(new Locale("es"));
        c.setStrength(Collator.PRIMARY);
        return c;
    }

    /** Letra de agrupación: A–Z (sin acentos) o «#». */
    static String letterOf(String title) {
        String f = fold(title);
        if (f.isEmpty()) return "#";
        char c = Character.toUpperCase(f.charAt(0));
        return (c >= 'A' && c <= 'Z') ? String.valueOf(c) : "#";
    }

    private static List<Song> sortedByTitle(List<Song> in) {
        List<Song> out = new ArrayList<>(in);
        final Collator col = collator();
        Collections.sort(out, new Comparator<Song>() {
            @Override public int compare(Song a, Song b) { return col.compare(a.title, b.title); }
        });
        return out;
    }

    private static List<Song> sortedByAlbumOrder(List<Song> in) {
        List<Song> out = new ArrayList<>(in);
        final Collator col = collator();
        Collections.sort(out, new Comparator<Song>() {
            @Override public int compare(Song a, Song b) {
                int c = col.compare(a.album, b.album);
                if (c != 0) return c;
                if (a.disc != b.disc) return a.disc < b.disc ? -1 : 1;
                if (a.track != b.track) return a.track < b.track ? -1 : 1;
                return col.compare(a.title, b.title);
            }
        });
        return out;
    }

    /* ---------- Árbol de exploración ---------- */

    static Entry songEntry(Song s, String parentId) {
        return new Entry("s:" + s.id + "@" + parentId, s.title, s.subtitle(), s.cover, false, s.durationMs);
    }

    private static List<Song> songsOf(Snapshot snap, String parentId) {
        List<Song> out = new ArrayList<>();
        if (parentId == null) return out;
        if (parentId.equals("songs") || parentId.equals("root")) return sortedByTitle(snap.songs);
        if (parentId.startsWith("songs:")) {
            String letter = parentId.substring(6);
            for (Song s : snap.songs) if (letterOf(s.title).equals(letter)) out.add(s);
            return sortedByTitle(out);
        }
        if (parentId.startsWith("album:")) {
            String key = parentId.substring(6);
            for (Song s : snap.songs) if (s.albumKey().equals(key)) out.add(s);
            return sortedByAlbumOrder(out);
        }
        if (parentId.startsWith("artist:")) {
            String name = parentId.substring(7);
            for (Song s : snap.songs) if (s.artistKey().equals(name)) out.add(s);
            return sortedByAlbumOrder(out);
        }
        if (parentId.equals("list:recent")) {
            out.addAll(snap.songs);
            Collections.sort(out, new Comparator<Song>() {
                @Override public int compare(Song a, Song b) { return a.addedAt == b.addedAt ? Long.compare(b.id, a.id) : Long.compare(b.addedAt, a.addedAt); }
            });
            return out.size() > RECENT_MAX ? new ArrayList<>(out.subList(0, RECENT_MAX)) : out;
        }
        if (parentId.startsWith("genre:")) {
            String g = parentId.substring(6);
            for (Song s : snap.songs) if (s.genre.equalsIgnoreCase(g)) out.add(s);
            return sortedByTitle(out);
        }
        if (parentId.startsWith("pl:")) {
            String id = parentId.substring(3);
            for (Playlist p : snap.playlists) {
                if (!p.id.equals(id)) continue;
                for (Long sid : p.ids) { Song s = snap.byId.get(sid); if (s != null) out.add(s); }
            }
        }
        return out;
    }

    /** Canciones (en orden) de una lista del árbol: lo que suena al tocar una canción dentro de ella. */
    static List<Long> idsOf(Snapshot snap, String parentId) {
        List<Long> ids = new ArrayList<>();
        for (Song s : songsOf(snap, parentId)) ids.add(s.id);
        return ids;
    }

    /** Todo lo que hay dentro de «parentId». Vacío si no existe o la biblioteca aún no llegó. */
    static List<Entry> children(Snapshot snap, String parentId) {
        List<Entry> out = new ArrayList<>();
        if (snap == null || snap.isEmpty() && snap.playlists.isEmpty()) return out;
        if (parentId == null || parentId.equals("root") || parentId.equals("pulsar_root")) {
            out.add(new Entry("songs", "Canciones", snap.songs.size() + " canciones", null, true, 0));
            out.add(new Entry("albums", "Álbumes", null, null, true, 0));
            out.add(new Entry("artists", "Artistas", null, null, true, 0));
            out.add(new Entry("lists", "Listas", null, null, true, 0));
            return out;
        }
        if (parentId.equals("songs")) {
            List<Song> all = sortedByTitle(snap.songs);
            if (all.size() > LETTER_SPLIT) {
                Map<String, Integer> counts = new LinkedHashMap<>();
                for (Song s : all) {
                    String l = letterOf(s.title);
                    Integer n = counts.get(l);
                    counts.put(l, n == null ? 1 : n + 1);
                }
                List<String> letters = new ArrayList<>(counts.keySet());
                Collections.sort(letters, new Comparator<String>() { // «#» al final
                    @Override public int compare(String a, String b) {
                        if (a.equals("#")) return b.equals("#") ? 0 : 1;
                        if (b.equals("#")) return -1;
                        return a.compareTo(b);
                    }
                });
                for (String l : letters) out.add(new Entry("songs:" + l, l, counts.get(l) + (counts.get(l) == 1 ? " canción" : " canciones"), null, true, 0));
            } else {
                for (Song s : all) out.add(songEntry(s, "songs"));
            }
            return out;
        }
        if (parentId.equals("albums")) {
            Map<String, List<Song>> groups = new LinkedHashMap<>();
            for (Song s : snap.songs) {
                String k = s.albumKey();
                List<Song> g = groups.get(k);
                if (g == null) { g = new ArrayList<>(); groups.put(k, g); }
                g.add(s);
            }
            List<String> keys = new ArrayList<>(groups.keySet());
            final Collator col = collator();
            Collections.sort(keys, new Comparator<String>() {
                @Override public int compare(String a, String b) { return col.compare(albumName(a), albumName(b)); }
            });
            for (String k : keys) {
                List<Song> g = groups.get(k);
                out.add(new Entry("album:" + k, albumName(k), albumArtist(k, g) + " · " + count(g.size()), firstCover(g), true, 0));
            }
            return out;
        }
        if (parentId.equals("artists")) {
            Map<String, List<Song>> groups = new LinkedHashMap<>();
            for (Song s : snap.songs) {
                String k = s.artistKey();
                List<Song> g = groups.get(k);
                if (g == null) { g = new ArrayList<>(); groups.put(k, g); }
                g.add(s);
            }
            List<String> keys = new ArrayList<>(groups.keySet());
            final Collator col = collator();
            Collections.sort(keys, new Comparator<String>() {
                @Override public int compare(String a, String b) { return col.compare(a, b); }
            });
            for (String k : keys) {
                List<Song> g = groups.get(k);
                out.add(new Entry("artist:" + k, k, count(g.size()), firstCover(g), true, 0));
            }
            return out;
        }
        if (parentId.equals("lists")) {
            if (!snap.songs.isEmpty()) out.add(new Entry("list:recent", "Recién agregadas", null, null, true, 0));
            for (Playlist p : snap.playlists) out.add(new Entry("pl:" + p.id, p.name, count(p.ids.size()), null, true, 0));
            Map<String, Integer> genres = new LinkedHashMap<>();
            for (Song s : snap.songs) {
                if (s.genre.isEmpty()) continue;
                Integer n = genres.get(s.genre.toLowerCase(Locale.ROOT));
                genres.put(s.genre.toLowerCase(Locale.ROOT), n == null ? 1 : n + 1);
            }
            Map<String, String> display = new HashMap<>();
            for (Song s : snap.songs) if (!s.genre.isEmpty() && !display.containsKey(s.genre.toLowerCase(Locale.ROOT))) display.put(s.genre.toLowerCase(Locale.ROOT), s.genre);
            List<String> names = new ArrayList<>(display.values());
            final Collator col = collator();
            Collections.sort(names, new Comparator<String>() {
                @Override public int compare(String a, String b) { return col.compare(a, b); }
            });
            for (String g : names) out.add(new Entry("genre:" + g, g, "Género · " + count(genres.get(g.toLowerCase(Locale.ROOT))), null, true, 0));
            return out;
        }
        // Una lista de canciones (letra, álbum, artista, recientes, género, lista de la app)
        for (Song s : songsOf(snap, parentId)) out.add(songEntry(s, parentId));
        return out;
    }

    static String albumName(String key) {
        int i = key.indexOf("||");
        return i <= 0 ? "Sin álbum" : key.substring(0, i);
    }

    private static String albumArtist(String key, List<Song> g) {
        int i = key.indexOf("||");
        String who = i < 0 ? "" : key.substring(i + 2);
        if (who.isEmpty() || unknownArtist(who)) return g.isEmpty() ? "Artista desconocido" : g.get(0).artistKey();
        return who;
    }

    private static String count(int n) { return n + (n == 1 ? " canción" : " canciones"); }

    private static String firstCover(List<Song> g) {
        for (Song s : g) if (!s.cover.isEmpty()) return s.cover;
        return null;
    }

    /** Primera canción reproducible de un id del árbol (para «tocar» un álbum o artista). null si no hay. */
    static Long firstIdOf(Snapshot snap, String parentId) {
        List<Long> ids = idsOf(snap, parentId);
        return ids.isEmpty() ? null : ids.get(0);
    }

    /* ---------- Búsqueda (voz y pantalla de búsqueda del coche) ---------- */

    private static String haystack(Song s) {
        return fold(s.title) + " " + fold(s.artist) + " " + fold(s.albumArtist) + " " + fold(s.album) + " " + fold(s.genre);
    }

    /** Puntaje: título que empieza igual > título que contiene > resto. -1 = no coincide. */
    private static int score(Song s, String[] tokens, String whole) {
        String hay = haystack(s);
        for (String t : tokens) if (!hay.contains(t)) return -1;
        String title = fold(s.title);
        if (title.equals(whole)) return 100;
        if (title.startsWith(whole)) return 80;
        if (title.contains(whole)) return 60;
        if (fold(s.artist).contains(whole)) return 40;
        return 20;
    }

    /**
     * Qué canciones reproducir para una búsqueda por voz.
     * Los extras del Asistente (artista, álbum, título, género) afinan la búsqueda; sin ninguno se usa el texto libre.
     * Consulta vacía = «pon música»: toda la biblioteca.
     */
    static List<Long> searchIds(Snapshot snap, String query, String artist, String album, String title, String genre) {
        List<Long> out = new ArrayList<>();
        String q = fold(query), a = fold(artist), al = fold(album), t = fold(title), g = fold(genre);
        boolean structured = !a.isEmpty() || !al.isEmpty() || !t.isEmpty() || !g.isEmpty();
        if (!structured && q.isEmpty()) { // «pon música»
            for (Song s : sortedByTitle(snap.songs)) out.add(s.id);
            return out;
        }
        if (structured) {
            List<Song> hits = new ArrayList<>();
            for (Song s : snap.songs) {
                if (!a.isEmpty() && !(fold(s.artist).contains(a) || fold(s.albumArtist).contains(a))) continue;
                if (!al.isEmpty() && !fold(s.album).contains(al)) continue;
                if (!t.isEmpty() && !fold(s.title).contains(t)) continue;
                if (!g.isEmpty() && !fold(s.genre).contains(g)) continue;
                hits.add(s);
            }
            if (!hits.isEmpty()) {
                // un artista o un álbum se escuchan en el orden del disco; un título suelto, la mejor coincidencia primero
                if (t.isEmpty()) hits = sortedByAlbumOrder(hits);
                for (Song s : hits) out.add(s.id);
                return out;
            }
        }
        if (q.isEmpty()) return out;
        final String[] tokens = q.split("\\s+");
        final String whole = q;
        List<Song> scored = new ArrayList<>();
        final Map<Long, Integer> points = new HashMap<>();
        for (Song s : snap.songs) {
            int p = score(s, tokens, whole);
            if (p >= 0) { scored.add(s); points.put(s.id, p); }
        }
        final Collator col = collator();
        Collections.sort(scored, new Comparator<Song>() {
            @Override public int compare(Song x, Song y) {
                int d = points.get(y.id) - points.get(x.id);
                return d != 0 ? d : col.compare(x.title, y.title);
            }
        });
        // Si lo escrito coincide con un artista o álbum entero, se reproduce completo y en orden del disco
        boolean sameArtist = !scored.isEmpty(), sameAlbum = !scored.isEmpty();
        String firstArtist = scored.isEmpty() ? "" : scored.get(0).artistKey();
        String firstAlbum = scored.isEmpty() ? "" : scored.get(0).albumKey();
        for (Song s : scored) {
            if (!s.artistKey().equals(firstArtist)) sameArtist = false;
            if (!s.albumKey().equals(firstAlbum) || firstAlbum.isEmpty()) sameAlbum = false;
        }
        if ((sameArtist || sameAlbum) && scored.size() > 1 && !fold(scored.get(0).title).contains(whole)) scored = sortedByAlbumOrder(scored);
        int max = Math.min(scored.size(), 200);
        for (int i = 0; i < max; i++) out.add(scored.get(i).id);
        return out;
    }

    /** Separa «s:123@album:Clave» en [id, lista]. null si no es una canción. */
    static String[] parseSongId(String mediaId) {
        if (mediaId == null || !mediaId.startsWith("s:")) return null;
        int at = mediaId.indexOf('@');
        String id = at < 0 ? mediaId.substring(2) : mediaId.substring(2, at);
        String ctx = at < 0 ? "songs" : mediaId.substring(at + 1);
        return new String[]{id, ctx};
    }
}
