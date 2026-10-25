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

// env: { platform: 'apk'|'web', storage: 'indexeddb'|'memory', persisted: true|false|null,
//        offlineReady: true|false|null, standalone: bool, online: bool, aiConfigured: bool }
export function computeFeatures(env) {
  const features = [];
  const apk = env.platform === 'apk';

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
      ? {
          id: 'storage',
          name: 'Сохранение на устройстве',
          state: 'works',
          note: apk ? 'История хранится во внутренней памяти приложения.' : 'История хранится только в этом браузере.',
        }
      : {
          id: 'storage',
          name: 'Сохранение на устройстве',
          state: 'unavailable',
          note: 'Хранилище браузера недоступно. Данные пропадут при закрытии приложения.',
        },
  );

  features.push(apk ? {
    id: 'persist',
    name: 'Защита данных от автоочистки',
    state: 'works',
    note: 'Данные приложения не очищаются браузером. Они удаляются только при удалении приложения или очистке его данных в настройках Android.',
  } : {
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

  features.push(apk ? {
    id: 'offline',
    name: 'Запуск без интернета',
    state: 'works',
    note: 'Все файлы приложения находятся внутри APK.',
  } : {
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

  features.push(apk ? {
    id: 'install',
    name: 'Установка на телефон',
    state: 'works',
    label: 'APK',
    note: 'Установлено как приложение Android.',
  } : {
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
    note: `${apk ? 'Место сохранения выбирается в окне Android «Сохранить». ' : 'Файл сохраняется в «Загрузки». '}Excel может сам превратить отметки и номера в числа или даты.`,
  });
  features.push({
    id: 'attachments',
    name: 'Вложения: фото, видео, Word, PDF, Excel',
    state: 'works',
    note: `Кнопка-скрепка в «Диалоге»${apk ? ', можно снять фото или видео камерой' : ''}. Файлы хранятся на телефоне и открываются его приложениями. Без ИИ содержимое файлов не анализируется.`,
  });
  features.push({
    id: 'copy',
    name: 'Копирование текста',
    state: 'works',
    note: 'Кнопка «Копировать» у сообщения или выделение долгим нажатием.',
  });
  features.push({
    id: 'share',
    name: 'Поделиться',
    state: 'works',
    note: apk
      ? 'Сообщение, запись реестра или файл Excel — в Telegram, WhatsApp, MAX, на почту или в другое приложение.'
      : 'Через системное окно «Поделиться» браузера.',
  });
  features.push({
    id: 'backup',
    name: 'Резервная копия и восстановление',
    state: 'works',
    note: 'Настройки → «Сохранить копию». Один ZIP-файл со всеми данными и вложениями.',
  });
  features.push({
    id: 'xlsx',
    name: 'Экспорт в Excel (XLSX)',
    state: 'works',
    note: 'Реестр → «Экспорт в Excel». Все значения — текст, шапка закреплена, фильтры, столбец с именами файлов.',
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
