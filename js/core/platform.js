// Где запущено приложение: внутри APK (Android-оболочка с мостом
// window.JarvisAndroid) или в браузере как веб-приложение (PWA).

export function detectPlatform(win = globalThis) {
  const bridge = win && win.JarvisAndroid;
  if (bridge && typeof bridge.saveTextFile === 'function') return { kind: 'apk', bridge };
  return { kind: 'web', bridge: null };
}

// Сохранение файла через системное окно Android «Сохранить».
// Оболочка сообщает результат вызовом window.__jarvisSaveResult(id, status, message),
// где status: 'saved' | 'cancelled' | 'error'.
const pending = new Map();
let counter = 0;

export function installSaveCallback(win = globalThis) {
  win.__jarvisSaveResult = (id, status, message) => {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve({ status, message });
  };
}

export function saveViaBridge(bridge, fileName, mimeType, content) {
  return new Promise((resolve) => {
    const id = `save-${Date.now().toString(36)}-${++counter}`;
    pending.set(id, resolve);
    try {
      bridge.saveTextFile(fileName, mimeType, content, id);
    } catch (error) {
      pending.delete(id);
      resolve({ status: 'error', message: 'Не удалось открыть окно сохранения файла.' });
    }
  });
}
