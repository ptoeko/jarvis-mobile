package ru.jarvis.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.Locale;

/**
 * Выдаёт другим приложениям доступ к отдельным временным файлам JARVIS:
 * share/  — копия вложения для просмотра (только чтение);
 * camera/ — снимок камеры (камера пишет, JARVIS читает).
 * Доступ даётся только на конкретный файл и только на время запроса
 * (FLAG_GRANT_*_URI_PERMISSION). Остальные данные приложения недоступны.
 * Своя реализация вместо androidx FileProvider: в проекте нет сторонних библиотек.
 */
public class FilesProvider extends ContentProvider {
    static final String AUTHORITY = "ru.jarvis.mobile.files";
    static final String DIR_SHARE = "share";
    static final String DIR_CAMERA = "camera";

    static Uri uriFor(String dir, String relative) {
        Uri.Builder b = new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(dir);
        for (String part : relative.split("/")) b.appendPath(part);
        return b.build();
    }

    /** Имя файла без путей и запрещённых символов. */
    static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (n.isEmpty() || n.equals(".") || n.equals("..")) n = "file";
        return n.length() > 150 ? n.substring(n.length() - 150) : n;
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        if (getContext() == null || uri.getPathSegments().size() < 2) throw new FileNotFoundException();
        String dir = uri.getPathSegments().get(0);
        if (!DIR_SHARE.equals(dir) && !DIR_CAMERA.equals(dir)) throw new FileNotFoundException();
        File root = new File(getContext().getCacheDir(), dir);
        File f = new File(root, uri.getPath().substring(dir.length() + 2));
        try {
            String rootPath = root.getCanonicalPath() + File.separator;
            if (!f.getCanonicalPath().startsWith(rootPath)) throw new FileNotFoundException();
        } catch (IOException e) {
            throw new FileNotFoundException();
        }
        return f;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = fileFor(uri);
        boolean write = mode != null && mode.contains("w");
        if (write) {
            // Писать можно только снимок камеры.
            if (!DIR_CAMERA.equals(uri.getPathSegments().get(0))) throw new FileNotFoundException();
            return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_WRITE_ONLY
                    | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE);
        }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File f;
        try {
            f = fileFor(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        c.addRow(row);
        return c;
    }

    @Override
    public String getType(Uri uri) {
        String name = uri.getLastPathSegment();
        int dot = name == null ? -1 : name.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return type == null ? "application/octet-stream" : type;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
