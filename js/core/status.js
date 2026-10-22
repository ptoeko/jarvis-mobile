// Правдивая сводка о том, что работает, а что нет.
// Состояния: 'works' — работает, 'demo' — демонстрационный режим,
// 'planned' — запланировано на этап N, 'unavailable' — не работает на этом устройстве,
// 'off' — доступно, но пока не включено пользователем или браузером.

export const STATE_LABELS = {
  works: 'Работает',
  demo: 'Демо',
  planned: 'Запланировано',
  unavailable: 'Недоступно',
  off: 'Не включено',
  unknown: 'Проверяется',
};

// env: { storage: 'indexeddb'|'memory', persisted: true|false|null,
//        offlineReady: true|false|null, standalone: bool, online: bool, aiConfigured: bool }
export function computeFeatures(env) {
  const features = [];

  features.push({ id: 'ui', name: 'Интерфейс и экраны', state: 'works', note: 'Диалог, Реестр, Настройки, Статус.' });

  features.push({
    id: 'dialog',
    name: 'Диалог',
    state: env.aiConfigured ? 'works' : 'demo',
    note: env.aiConfigured
      ? 'Ответы формирует подключённый ИИ.'
      : 'Ответы — заранее заданные тексты. ИИ не подключён.',
  });

  features.push(
    env.storage === 'indexeddb'
      ? { id: 'storage', name: 'Сохранение на устройстве', state: 'works', note: 'История хранится только в этом браузере.' }
      : {
          id: 'storage',
          name: 'Сохранение на устройстве',
          state: 'unavailable',
          note: 'Хранилище браузера недоступно. Данные пропадут при закрытии приложения.',
        },
  );

  features.push({
    id: 'persist',
    name: 'Защита данных от автоочистки',
    state: env.persisted === true ? 'works' : env.persisted === false ? 'off' : 'unknown',
    note:
      env.persisted === true
        ? 'Браузер не удалит данные при нехватке места.'
        : env.persisted === false
          ? 'Браузер может удалить данные при нехватке места. Установка приложения на главный экран обычно это исправляет.'
          : 'Состояние ещё не определено.',
  });

  features.push({ id: 'delete', name: 'Удаление истории', state: 'works', note: 'Настройки → «Удалить всю историю».' });

  features.push({
    id: 'offline',
    name: 'Запуск без интернета',
    state: env.offlineReady === true ? 'works' : env.offlineReady === false ? 'unavailable' : 'unknown',
    note:
      env.offlineReady === true
        ? 'Файлы приложения сохранены на телефоне.'
        : env.offlineReady === false
          ? 'Офлайн-кеш не работает в этом браузере.'
          : 'Файлы приложения сохраняются при первом открытии.',
  });

  features.push({
    id: 'install',
    name: 'Установка на главный экран',
    state: env.standalone ? 'works' : 'off',
    label: env.standalone ? undefined : 'Не установлено',
    note: env.standalone
      ? 'Приложение запущено с главного экрана.'
      : 'Открыто в браузере. Меню Chrome ⋮ → «Установить приложение».',
  });

  features.push({
    id: 'voice-keyboard',
    name: 'Диктовка с клавиатуры',
    state: 'works',
    note: 'Микрофон на клавиатуре телефона. Работает средствами клавиатуры, не приложения.',
  });

  features.push({
    id: 'registry',
    name: 'Разбор заметок в реестр',
    state: 'demo',
    label: 'По правилам',
    note: 'Распознаётся только явно написанное: дата, оси, отметки, нормы, срок, поля с метками. Это не ИИ. Каждая запись подтверждается вручную.',
  });
  features.push({
    id: 'export',
    name: 'Экспорт в CSV',
    state: 'works',
    note: 'Файл для Excel и LibreOffice. Excel может сам превратить отметки и номера в числа или даты.',
  });
  features.push({
    id: 'xlsx',
    name: 'Экспорт в XLSX',
    state: 'off',
    label: 'Не подключено',
    note: 'Требует отдельного решения о подключении библиотеки.',
  });
  features.push({ id: 'voice-app', name: 'Кнопка микрофона в приложении', state: 'planned', stage: 3, note: 'Этап 3.' });
  features.push({
    id: 'ai',
    name: 'Подключение ИИ',
    state: env.aiConfigured ? 'works' : 'planned',
    stage: 4,
    note: env.aiConfigured ? 'Подключено через сервер-посредник.' : 'Этап 4, через защищённый сервер-посредник.',
  });

  features.push({
    id: 'network',
    name: 'Интернет',
    state: env.online ? 'works' : 'unavailable',
    note: env.online ? 'Есть подключение.' : 'Нет подключения. Приложение работает с сохранёнными данными.',
  });

  return features;
}

export function statusSummary(features) {
  return features
    .filter((f) => ['dialog', 'storage', 'registry', 'ai'].includes(f.id))
    .map((f) => `${f.name}: ${(f.label || STATE_LABELS[f.state]).toLowerCase()}${f.stage && f.state === 'planned' ? ` (этап ${f.stage})` : ''}`)
    .join('\n');
}
