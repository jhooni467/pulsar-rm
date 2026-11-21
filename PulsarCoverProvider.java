package com.pulsarrm.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Portadas para Android Auto y el sistema (v1.06).
 * Las pantallas del coche y los controles multimedia viven en OTRO proceso: no pueden leer files/covers directamente,
 * así que piden las imágenes por content://&lt;paquete&gt;.covers/&lt;archivo&gt;. Solo se entregan, en modo lectura, archivos
 * que están dentro de files/covers (nunca rutas ni otras carpetas) y no hay ninguna otra operación disponible.
 */
public class PulsarCoverProvider extends ContentProvider {

    static String authority(Context ctx) { return ctx.getPackageName() + ".covers"; }

    /** content:// de una portada, o null si el nombre no es válido. */
    static Uri uriFor(Context ctx, String file) {
        String safe = PulsarLibrary.safeFile(file);
        if (safe.isEmpty()) return null;
        return new Uri.Builder().scheme("content").authority(authority(ctx)).appendPath(safe).build();
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (mode != null && mode.contains("w")) throw new FileNotFoundException("Solo lectura");
        Context ctx = getContext();
        String name = uri.getLastPathSegment();
        if (ctx == null || name == null || PulsarLibrary.safeFile(name).isEmpty()) throw new FileNotFoundException("Portada no válida");
        File dir = new File(ctx.getFilesDir(), "covers");
        File f = new File(dir, name);
        try {
            if (!f.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) throw new FileNotFoundException("Fuera de la carpeta");
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("Portada no válida");
        }
        if (!f.isFile()) throw new FileNotFoundException("No existe");
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public String getType(Uri uri) { return "image/*"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}
