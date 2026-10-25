package ru.jarvis.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/**
 * Оболочка JARVIS Mobile: показывает веб-приложение, которое лежит внутри APK
 * (assets/www). Страницы открываются по адресу https://appassets.androidplatform.net —
 * это не настоящий сервер: каждый запрос перехватывается и обслуживается из файлов
 * APK. Запросы к любым другим адресам блокируются, приложение в сеть не обращается.
 * Данные (IndexedDB) хранятся во внутренней памяти приложения.
 */
public class MainActivity extends Activity {
    private static final String TAG = "JarvisMobile";
    static final String HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + HOST + "/index.html";
    private static final int REQUEST_SAVE_FILE = 1001;
    private static final int REQUEST_CHOOSE_FILE = 1002;
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9-]{1,80}");
    // Типы файлов для кнопки «Прикрепить»: фото, PDF, Word, Excel. Тип
    // octet-stream — потому что некоторые файловые менеджеры не знают тип docx/xlsx.
    private static final String[] ATTACH_MIME = {
            "image/*", "video/*", "application/pdf",
            "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/rtf", "application/vnd.oasis.opendocument.text",
            "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel.sheet.macroEnabled.12", "text/csv",
            "application/vnd.oasis.opendocument.spreadsheet", "application/octet-stream",
    };
    private static final String STATE_PENDING_SAVE = "jarvis.pendingSave";
    private static final String PENDING_FILE = "pending-export.bin";

    private WebView webView;

    // Файл, ожидающий выбора места сохранения. Содержимое лежит во внутренней
    // папке приложения (не в памяти): пока открыто системное окно «Сохранить»,
    // Android может закрыть JARVIS, и без этой копии файл сохранился бы пустым.
    private boolean savePending;
    private String pendingCallbackId;

    // Выбор файла (кнопка «Прикрепить», «Восстановить из копии»).
    private ValueCallback<Uri[]> chooserCallback;
    // Снимок и видео камеры: пишутся сюда, если пользователь выбрал камеру.
    private File cameraFile;
    private File videoFile;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        webView = new WebView(this);
        webView.setBackgroundColor(0x00000000);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        // Учитываем системный размер шрифта телефона.
        s.setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));

        webView.addJavascriptInterface(new Bridge(), "JarvisAndroid");
        webView.setWebViewClient(new LocalAssetsClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(TAG, "console " + m.messageLevel() + ": " + m.message()
                        + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return showFileChooser(callback, params);
            }
        });
        cleanTempFiles();

        // Окно «Сохранить» было открыто, когда Android закрыл приложение:
        // результат придёт в onActivityResult, содержимое ждёт в pendingFile().
        savePending = savedInstanceState != null
                && savedInstanceState.getBoolean(STATE_PENDING_SAVE, false)
                && pendingFile().exists();
        if (!savePending) pendingFile().delete();

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(START_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putBoolean(STATE_PENDING_SAVE, savePending);
        if (webView != null) webView.saveState(outState);
    }

    private File pendingFile() {
        return new File(getCacheDir(), PENDING_FILE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("JarvisAndroid");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // Кнопка «Назад»: сначала закрывается открытое окно приложения, затем
    // возврат к предыдущему экрану, и только потом выход из приложения.
    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!(window.__jarvisBack&&window.__jarvisBack());}catch(e){return false;}})()",
                value -> {
                    if ("true".equals(value)) return;
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        exitApp();
                    }
                });
    }

    private void exitApp() {
        super.onBackPressed();
    }

    // ---------- Сохранение файла через системный диалог «Сохранить» ----------

    private void startSave(String fileName, String mimeType, String content, String callbackId) {
        if (savePending) {
            reportSave(callbackId, "error", "Уже открыто окно сохранения файла.");
            return;
        }
        try (OutputStream out = new FileOutputStream(pendingFile())) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            Log.e(TAG, "pending save failed", e);
            pendingFile().delete();
            reportSave(callbackId, "error", "Не хватает места в памяти телефона для подготовки файла.");
            return;
        }
        startSaveFromPending(fileName, mimeType, callbackId);
    }

    // Файл уже лежит в pendingFile(): открыть окно «Сохранить».
    private void startSaveFromPending(String fileName, String mimeType, String callbackId) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, fileName);
        savePending = true;
        pendingCallbackId = callbackId;
        try {
            startActivityForResult(intent, REQUEST_SAVE_FILE);
        } catch (ActivityNotFoundException e) {
            savePending = false;
            pendingCallbackId = null;
            pendingFile().delete();
            reportSave(callbackId, "error", "На телефоне нет приложения для выбора места сохранения файлов.");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_CHOOSE_FILE) {
            finishFileChooser(resultCode, data);
            return;
        }
        if (requestCode != REQUEST_SAVE_FILE) return;
        // callbackId == null: страница перезапускалась, пока было открыто окно
        // «Сохранить». Файл всё равно записывается, итог — системным сообщением.
        final String callbackId = pendingCallbackId;
        final File source = pendingFile();
        final boolean hadContent = savePending && source.exists();
        savePending = false;
        pendingCallbackId = null;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            source.delete();
            reportSave(callbackId, "cancelled", "Сохранение отменено.");
            return;
        }
        final Uri uri = data.getData();
        if (!hadContent) {
            reportSave(callbackId, "error", "Данные для файла потеряны. Повторите экспорт.");
            return;
        }
        new Thread(() -> {
            try (InputStream in = new FileInputStream(source);
                 OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new IOException("Не удалось открыть файл для записи.");
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                out.flush();
                reportSave(callbackId, "saved", "Файл сохранён.");
            } catch (Exception e) {
                Log.e(TAG, "save failed", e);
                reportSave(callbackId, "error", "Не удалось записать файл. Попробуйте выбрать другую папку.");
            } finally {
                source.delete();
            }
        }).start();
    }

    private void reportSave(String callbackId, String status, String message) {
        if (callbackId == null) {
            runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show());
            Log.i(TAG, "save result without page callback: " + status);
            return;
        }
        final String js = "window.__jarvisSaveResult&&window.__jarvisSaveResult("
                + JSONObject.quote(callbackId) + "," + JSONObject.quote(status) + ","
                + JSONObject.quote(message) + ")";
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(js, null);
        });
    }

    /** Методы, доступные странице как window.JarvisAndroid. */
    private final class Bridge {
        @JavascriptInterface
        public String getVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void saveTextFile(String fileName, String mimeType, String content, String callbackId) {
            if (fileName == null || content == null || callbackId == null) return;
            final String type = mimeType == null || mimeType.isEmpty() ? "text/plain" : mimeType;
            runOnUiThread(() -> startSave(fileName, type, content, callbackId));
        }

        /** Часть файла (base64) во временный файл приложения. first — начать заново. */
        @JavascriptInterface
        public boolean writeChunk(String token, String base64, boolean first) {
            File f = stagingFile(token);
            if (f == null) return false;
            try (OutputStream out = new FileOutputStream(f, !first)) {
                if (base64 != null && !base64.isEmpty()) out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "chunk failed", e);
                f.delete();
                return false;
            }
        }

        /** Сохранить собранный файл через окно «Сохранить». */
        @JavascriptInterface
        public void saveChunked(String token, String fileName, String mimeType, String callbackId) {
            if (fileName == null || callbackId == null) return;
            final String type = mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType;
            runOnUiThread(() -> {
                File f = stagingFile(token);
                if (savePending) {
                    if (f != null) f.delete();
                    reportSave(callbackId, "error", "Уже открыто окно сохранения файла.");
                    return;
                }
                if (f == null || !f.exists()) {
                    reportSave(callbackId, "error", "Файл не подготовлен. Повторите.");
                    return;
                }
                pendingFile().delete();
                if (!f.renameTo(pendingFile())) {
                    f.delete();
                    reportSave(callbackId, "error", "Не удалось подготовить файл.");
                    return;
                }
                startSaveFromPending(fileName, type, callbackId);
            });
        }

        /** Открыть собранный файл приложением телефона. Возвращает "ok" или текст ошибки. */
        @JavascriptInterface
        public String openChunked(String token, String fileName, String mimeType) {
            File f = stagingFile(token);
            if (f == null || !f.exists()) return "Файл не подготовлен. Повторите.";
            File dir = new File(new File(getCacheDir(), FilesProvider.DIR_SHARE), UUID.randomUUID().toString());
            if (!dir.mkdirs()) return "Не хватает места в памяти телефона.";
            File target = new File(dir, FilesProvider.safeName(fileName));
            if (!f.renameTo(target)) return "Не удалось подготовить файл.";
            Uri uri = FilesProvider.uriFor(FilesProvider.DIR_SHARE, dir.getName() + "/" + target.getName());
            Intent view = new Intent(Intent.ACTION_VIEW);
            String type = mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType;
            view.setDataAndType(uri, type);
            view.setClipData(ClipData.newRawUri(target.getName(), uri));
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            AtomicReference<String> result = new AtomicReference<>("Не удалось открыть файл.");
            CountDownLatch done = new CountDownLatch(1);
            runOnUiThread(() -> {
                try {
                    startActivity(Intent.createChooser(view, "Открыть: " + target.getName())
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                    result.set("ok");
                } catch (ActivityNotFoundException e) {
                    result.set("На телефоне нет приложения для открытия файлов этого типа.");
                } catch (Exception e) {
                    Log.e(TAG, "open failed", e);
                } finally {
                    done.countDown();
                }
            });
            try {
                done.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            return result.get();
        }

        /** Копирование текста в буфер обмена телефона. */
        @JavascriptInterface
        public boolean copyText(String text) {
            if (text == null) return false;
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("JARVIS", text));
            });
            return true;
        }
    }

    // ---------- Временные файлы ----------

    private File stagingFile(String token) {
        if (token == null || !TOKEN.matcher(token).matches()) return null;
        File dir = new File(getCacheDir(), "staging");
        if (!dir.exists() && !dir.mkdirs()) return null;
        return new File(dir, token + ".bin");
    }

    // При запуске удаляются старые временные файлы: подготовленные части,
    // копии для просмотра (старше суток) и неиспользованные снимки камеры.
    private void cleanTempFiles() {
        long dayAgo = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
        deleteTree(new File(getCacheDir(), "staging"), Long.MAX_VALUE);
        deleteTree(new File(getCacheDir(), FilesProvider.DIR_SHARE), dayAgo);
        deleteTree(new File(getCacheDir(), FilesProvider.DIR_CAMERA), dayAgo);
    }

    private static void deleteTree(File f, long olderThan) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c, olderThan);
        if (f.isDirectory()) {
            File[] left = f.listFiles();
            if (left != null && left.length == 0 && f.lastModified() < olderThan) f.delete();
        } else if (f.lastModified() < olderThan) {
            f.delete();
        }
    }

    // ---------- Выбор файла и камера ----------

    private boolean showFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (chooserCallback != null) chooserCallback.onReceiveValue(null);
        chooserCallback = callback;

        Log.i(TAG, "file chooser requested, accept=" + java.util.Arrays.toString(params.getAcceptTypes()));
        boolean multiple = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        boolean attach = false;
        for (String t : params.getAcceptTypes()) {
            if (t != null && t.contains("image/")) attach = true;
        }

        Intent content = new Intent(Intent.ACTION_GET_CONTENT);
        content.addCategory(Intent.CATEGORY_OPENABLE);
        content.setType("*/*");
        if (attach) content.putExtra(Intent.EXTRA_MIME_TYPES, ATTACH_MIME);
        if (multiple) content.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

        Intent chooser = Intent.createChooser(content, attach ? "Прикрепить файл" : "Выберите файл");
        cameraFile = null;
        videoFile = null;
        if (attach) {
            List<Intent> extra = new ArrayList<>();
            Intent camera = cameraIntent();
            if (camera != null) extra.add(camera);
            Intent video = videoIntent();
            if (video != null) extra.add(video);
            if (!extra.isEmpty()) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extra.toArray(new Intent[0]));
        }
        try {
            startActivityForResult(chooser, REQUEST_CHOOSE_FILE);
            return true;
        } catch (ActivityNotFoundException e) {
            chooserCallback = null;
            cameraFile = null;
            videoFile = null;
            Toast.makeText(this, "На телефоне нет приложения для выбора файлов.", Toast.LENGTH_LONG).show();
            return false;
        }
    }

    // Съёмка фото камерой телефона. Снимок пишется во внутреннюю папку
    // приложения (не в галерею); разрешение на камеру приложению не нужно.
    private Intent cameraIntent() {
        Intent capture = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (capture.resolveActivity(getPackageManager()) == null) return null;
        File dir = new File(getCacheDir(), FilesProvider.DIR_CAMERA);
        if (!dir.exists() && !dir.mkdirs()) return null;
        String name = "photo-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date()) + ".jpg";
        cameraFile = new File(dir, name);
        Uri uri = FilesProvider.uriFor(FilesProvider.DIR_CAMERA, name);
        capture.putExtra(MediaStore.EXTRA_OUTPUT, uri);
        capture.setClipData(ClipData.newRawUri(name, uri));
        capture.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return capture;
    }

    // Видео камерой телефона — так же во внутреннюю папку приложения.
    private Intent videoIntent() {
        Intent capture = new Intent(MediaStore.ACTION_VIDEO_CAPTURE);
        if (capture.resolveActivity(getPackageManager()) == null) return null;
        File dir = new File(getCacheDir(), FilesProvider.DIR_CAMERA);
        if (!dir.exists() && !dir.mkdirs()) return null;
        String name = "video-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date()) + ".mp4";
        videoFile = new File(dir, name);
        Uri uri = FilesProvider.uriFor(FilesProvider.DIR_CAMERA, name);
        capture.putExtra(MediaStore.EXTRA_OUTPUT, uri);
        // Ограничение размера, совпадающее с лимитом приложения (300 МБ).
        capture.putExtra(MediaStore.EXTRA_SIZE_LIMIT, 300L * 1024 * 1024);
        capture.setClipData(ClipData.newRawUri(name, uri));
        capture.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return capture;
    }

    private void finishFileChooser(int resultCode, Intent data) {
        ValueCallback<Uri[]> callback = chooserCallback;
        File photo = cameraFile;
        File video = videoFile;
        chooserCallback = null;
        cameraFile = null;
        videoFile = null;
        // Снимали видео — дальше оно обрабатывается так же, как снимок.
        if (video != null && video.length() > 0 && (photo == null || photo.length() == 0)) {
            if (photo != null) photo.delete();
            photo = video;
        } else if (video != null && video.length() == 0) {
            video.delete();
        }
        if (callback == null) return; // страница перезапускалась — выбор не к чему применить
        List<Uri> uris = new ArrayList<>();
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null && !"content".equals(u.getScheme()) && !"file".equals(u.getScheme())) continue;
                    if (u != null) uris.add(u);
                }
            }
            if (uris.isEmpty() && data.getData() != null) uris.add(data.getData());
        }
        // Камера возвращает пустой результат: снимок уже в cameraFile.
        if (resultCode == RESULT_OK && photo != null && photo.length() > 0
                && (uris.isEmpty() || uris.contains(FilesProvider.uriFor(FilesProvider.DIR_CAMERA, photo.getName())))) {
            uris.clear();
            uris.add(FilesProvider.uriFor(FilesProvider.DIR_CAMERA, photo.getName()));
        } else if (photo != null && photo.length() == 0) {
            photo.delete();
        }
        callback.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
    }

    // ---------- Файлы приложения из APK ----------

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("png", "image/png");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
    }

    static String mimeFor(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot < 0 ? "" : path.substring(dot + 1).toLowerCase(Locale.ROOT);
        String type = MIME.get(ext);
        return type == null ? "application/octet-stream" : type;
    }

    /** Путь внутри assets/www или null, если путь недопустим. */
    static String assetPath(String urlPath) {
        String path = urlPath == null || urlPath.isEmpty() || "/".equals(urlPath) ? "/index.html" : urlPath;
        if (path.contains("..") || path.contains("\\") || !path.startsWith("/")) return null;
        return "www" + path;
    }

    private final class LocalAssetsClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!"https".equals(url.getScheme()) || !HOST.equals(url.getHost())) {
                return emptyResponse(403, "Forbidden");
            }
            String asset = assetPath(url.getPath());
            if (asset == null) return emptyResponse(404, "Not Found");
            try {
                InputStream in = getAssets().open(asset);
                String mime = mimeFor(asset);
                String encoding = mime.startsWith("text/") || mime.contains("json") || mime.contains("xml") ? "utf-8" : null;
                return new WebResourceResponse(mime, encoding, 200, "OK", headers(), in);
            } catch (IOException e) {
                return emptyResponse(404, "Not Found");
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // Переходы на внешние сайты внутри приложения запрещены.
            return !HOST.equals(request.getUrl().getHost());
        }
    }

    private static Map<String, String> headers() {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        h.put("X-Content-Type-Options", "nosniff");
        h.put("Content-Security-Policy",
                "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; "
                        + "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'");
        return h;
    }

    private static WebResourceResponse emptyResponse(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, headers(),
                new ByteArrayInputStream(new byte[0]));
    }
}
