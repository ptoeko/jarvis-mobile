// Голос JARVIS: озвучка ответов и диктовка.
//
// В APK — через Android (window.JarvisAndroid): встроенный синтезатор речи
// телефона (работает без интернета, если установлен русский голос) и
// системное окно распознавания речи. В браузере — Web Speech API, если есть.
// Свой «голос JARVIS» — это постоянные настройки синтезатора: голос, низкий
// тон, неторопливая скорость.

export const META_VOICE = 'voicePrefs';
export const DEFAULT_PREFS = Object.freeze({ auto: false, sir: false, voice: '', rate: 0.95, pitch: 0.82 });
export const RATES = [
  { value: 0.85, label: 'Медленно' },
  { value: 0.95, label: 'Обычно' },
  { value: 1.1, label: 'Быстрее' },
];

export function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const rate = Number(p.rate);
  const pitch = Number(p.pitch);
  return {
    auto: p.auto === true,
    sir: p.sir === true,
    voice: typeof p.voice === 'string' ? p.voice.slice(0, 200) : '',
    rate: Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? rate : DEFAULT_PREFS.rate,
    pitch: Number.isFinite(pitch) && pitch >= 0.5 && pitch <= 2 ? pitch : DEFAULT_PREFS.pitch,
  };
}

// Текст для чтения вслух: ссылки и список источников не зачитываются.
export function speechText(text) {
  let s = String(text ?? '');
  const sources = s.search(/\n\s*Источники:/);
  if (sources >= 0) s = `${s.slice(0, sources)}\nИсточники — в тексте ответа.`;
  s = s.replace(/https?:\/\/[^\s<>"«»]+/g, 'ссылка');
  s = s.replace(/[*#_`>|]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return s.slice(0, 20000);
}

// Деление длинного текста на части по предложениям (у синтезатора есть предел длины).
export function speechChunks(text, max = 3000) {
  const out = [];
  let buf = '';
  for (const part of String(text).split(/(?<=[.!?…\n])\s+/)) {
    if (!part) continue;
    if ((buf + ' ' + part).length > max && buf) {
      out.push(buf.trim());
      buf = '';
    }
    if (part.length > max) {
      for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max));
    } else {
      buf += (buf ? ' ' : '') + part;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

let seq = 0;

export function createSpeech(win = globalThis) {
  const bridge = win.JarvisAndroid;
  const native = !!(bridge && typeof bridge.speak === 'function');
  const listeners = new Set();
  let speakingId = null;

  function emit(state) {
    for (const fn of listeners) {
      try { fn(state, speakingId); } catch { /* слушатель не должен ломать озвучку */ }
    }
  }

  // Ответы Android приходят сюда.
  if (native) {
    win.__jarvisSpeech = (id, state) => {
      if (id !== speakingId) return;
      if (state === 'done' || state === 'error' || state === 'stopped') {
        speakingId = null;
        emit(state === 'error' ? 'error' : 'idle');
      }
    };
  }

  const web = !native && win.speechSynthesis && win.SpeechSynthesisUtterance ? win.speechSynthesis : null;

  return {
    native,
    get canSpeak() {
      if (native) return true;
      return !!web;
    },
    get speaking() {
      return speakingId !== null;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Состояние синтезатора: 'ready' | 'loading' | 'no-russian' | 'unavailable'.
    status() {
      if (native) {
        try { return String(bridge.ttsStatus() || 'unavailable'); } catch { return 'unavailable'; }
      }
      return web ? 'ready' : 'unavailable';
    },
    // Русские голоса телефона: [{ id, name, local }].
    voices() {
      if (native) {
        try {
          const list = JSON.parse(bridge.ttsVoices() || '[]');
          return Array.isArray(list) ? list.filter((v) => v && typeof v.id === 'string') : [];
        } catch {
          return [];
        }
      }
      if (!web) return [];
      return web.getVoices().filter((v) => /^ru/i.test(v.lang)).map((v) => ({ id: v.voiceURI, name: v.name, local: v.localService }));
    },
    speak(text, prefs = DEFAULT_PREFS) {
      const clean = speechText(text);
      if (!clean) return false;
      this.stop();
      const p = normalizePrefs(prefs);
      speakingId = `s${++seq}`;
      if (native) {
        try {
          bridge.speak(JSON.stringify(speechChunks(clean)), p.voice, p.rate, p.pitch, speakingId);
        } catch {
          speakingId = null;
          return false;
        }
        emit('speaking');
        return true;
      }
      if (!web) {
        speakingId = null;
        return false;
      }
      const id = speakingId;
      const voice = web.getVoices().find((v) => v.voiceURI === p.voice) || web.getVoices().find((v) => /^ru/i.test(v.lang));
      const parts = speechChunks(clean, 300);
      parts.forEach((part, i) => {
        const u = new win.SpeechSynthesisUtterance(part);
        u.lang = 'ru-RU';
        if (voice) u.voice = voice;
        u.rate = p.rate;
        u.pitch = p.pitch;
        if (i === parts.length - 1) u.onend = () => { if (speakingId === id) { speakingId = null; emit('idle'); } };
        u.onerror = () => { if (speakingId === id) { speakingId = null; emit('error'); } };
        web.speak(u);
      });
      emit('speaking');
      return true;
    },
    stop() {
      if (speakingId === null) return;
      speakingId = null;
      if (native) {
        try { bridge.stopSpeaking(); } catch { /* уже остановлено */ }
      } else if (web) {
        web.cancel();
      }
      emit('idle');
    },
    // Диктовка: может ли телефон распознавать речь.
    get canDictate() {
      if (native) {
        try { return typeof bridge.canDictate === 'function' && bridge.canDictate() === true; } catch { return false; }
      }
      return !!(win.SpeechRecognition || win.webkitSpeechRecognition);
    },
    // Распознанный текст или пустая строка (отмена). Ошибка — исключение с текстом.
    dictate() {
      if (native) {
        return new Promise((resolve, reject) => {
          win.__jarvisDictation = (status, text) => {
            win.__jarvisDictation = null;
            if (status === 'ok') resolve(String(text || ''));
            else if (status === 'cancelled') resolve('');
            else reject(new Error(String(text || 'Не удалось распознать речь.')));
          };
          try {
            bridge.startDictation();
          } catch {
            win.__jarvisDictation = null;
            reject(new Error('Распознавание речи недоступно на этом телефоне.'));
          }
        });
      }
      const Rec = win.SpeechRecognition || win.webkitSpeechRecognition;
      if (!Rec) return Promise.reject(new Error('Распознавание речи недоступно в этом браузере.'));
      return new Promise((resolve, reject) => {
        const rec = new Rec();
        rec.lang = 'ru-RU';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        let text = '';
        rec.onresult = (e) => { text = Array.from(e.results).map((r) => r[0].transcript).join(' '); };
        rec.onerror = (e) => (e.error === 'no-speech' || e.error === 'aborted' ? resolve('') : reject(new Error('Не удалось распознать речь. Проверьте доступ к микрофону.')));
        rec.onend = () => resolve(text);
        rec.start();
      });
    },
  };
}
