package ru.jarvis.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
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
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

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
    private static final String STATE_PENDING_SAVE = "jarvis.pendingSave";
    private static final String PENDING_FILE = "pending-export.bin";

    private WebView webView;

    // Файл, ожидающий выбора места сохранения. Содержимое лежит во внутренней
    // папке приложения (не в памяти): пока открыто системное окно «Сохранить»,
    // Android может закрыть JARVIS, и без этой копии файл сохранился бы пустым.
    private boolean savePending;
    private String pendingCallbackId;

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
        });

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
