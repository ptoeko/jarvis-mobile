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

// ---------- 0.4.0: файлы и буфер обмена ----------

const CHUNK = 512 * 1024; // по 512 КБ: мост Android принимает только строки

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// Передаёт файл в оболочку Android частями во временный файл приложения.
// Возвращает идентификатор переданного файла.
async function sendBlob(bridge, blob) {
  const token = `f-${Date.now().toString(36)}-${++counter}`;
  if (blob.size === 0) {
    bridge.writeChunk(token, '', true);
    return token;
  }
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
    if (!bridge.writeChunk(token, toBase64(bytes), offset === 0)) {
      throw new Error('Не хватает места в памяти телефона.');
    }
  }
  return token;
}

// Сохранение любого файла (резервная копия) через окно Android «Сохранить».
export async function saveBlobViaBridge(bridge, blob, fileName, mimeType) {
  let token;
  try {
    token = await sendBlob(bridge, blob);
  } catch (error) {
    return { status: 'error', message: error.message || 'Не удалось подготовить файл.' };
  }
  return new Promise((resolve) => {
    const id = `save-${Date.now().toString(36)}-${++counter}`;
    pending.set(id, resolve);
    try {
      bridge.saveChunked(token, fileName, mimeType, id);
    } catch {
      pending.delete(id);
      resolve({ status: 'error', message: 'Не удалось открыть окно сохранения файла.' });
    }
  });
}

// Открытие вложения приложением телефона (галерея, PDF, Word, Excel).
// Возвращает { status: 'opened' | 'error', message }.
export async function openBlobViaBridge(bridge, blob, fileName, mimeType) {
  try {
    const token = await sendBlob(bridge, blob);
    const result = String(bridge.openChunked(token, fileName, mimeType) || '');
    return result === 'ok'
      ? { status: 'opened' }
      : { status: 'error', message: result || 'Не удалось открыть файл.' };
  } catch (error) {
    return { status: 'error', message: error.message || 'Не удалось открыть файл.' };
  }
}

// Копирование текста. В APK — системный буфер обмена через оболочку;
// в браузере — Clipboard API, при отказе — старый способ через выделение.
export async function copyText(win, text) {
  const bridge = win.JarvisAndroid;
  if (bridge && typeof bridge.copyText === 'function') {
    return bridge.copyText(String(text)) !== false;
  }
  try {
    await win.navigator.clipboard.writeText(String(text));
    return true;
  } catch {
    const doc = win.document;
    const area = doc.createElement('textarea');
    area.value = String(text);
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = doc.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function supportsFiles(bridge) {
  return !bridge || (typeof bridge.writeChunk === 'function' && typeof bridge.saveChunked === 'function');
}

// ---------- 0.4.2: «Поделиться» ----------
// files: [{ blob, name, type }]. target: telegram | whatsapp | max | email | other.
// Возвращает { status: 'shared' | 'error', message }.
export async function shareViaBridge(bridge, { target, subject, text, files = [] }) {
  try {
    const staged = [];
    for (const f of files) staged.push({ token: await sendBlob(bridge, f.blob), name: f.name, type: f.type });
    const result = String(bridge.shareChunked(JSON.stringify({ target, subject, text, files: staged })) || '');
    return result === 'ok' ? { status: 'shared' } : { status: 'error', message: result || 'Не удалось поделиться.' };
  } catch (error) {
    return { status: 'error', message: error.message || 'Не удалось поделиться.' };
  }
}

export function supportsShare(bridge) {
  return !!bridge && typeof bridge.shareChunked === 'function';
}
