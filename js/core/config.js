// Общие настройки приложения JARVIS Mobile.
// Здесь нет и не должно быть ключей или секретов: всё, что лежит в коде
// приложения, видно любому, кто откроет страницу.

export const APP_NAME = 'JARVIS Mobile';
export const APP_VERSION = '0.1.0';
export const APP_STAGE = 1;

export const NOT_SPECIFIED = 'Не указано';
export const MAX_MESSAGE_LENGTH = 4000;

// Схема записи реестра замечаний (предложение, утверждается на этапе 2
// по образцу владельца). На этапе 1 используется только для отображения
// пустого реестра.
export const REGISTRY_FIELDS = [
  { key: 'number', title: '№ п/п' },
  { key: 'date', title: 'Дата' },
  { key: 'object', title: 'Объект / здание' },
  { key: 'location', title: 'Место (ось, отметка, помещение)' },
  { key: 'workType', title: 'Вид работ' },
  { key: 'description', title: 'Описание замечания' },
  { key: 'requirement', title: 'Требование (проект, норма, пункт)' },
  { key: 'responsible', title: 'Ответственная организация' },
  { key: 'deadline', title: 'Срок устранения' },
  { key: 'status', title: 'Статус' },
  { key: 'sourceText', title: 'Исходный текст заметки' },
];

// Создаёт пустую запись реестра: каждое поле — «Не указано».
export function emptyRecord() {
  const record = {};
  for (const field of REGISTRY_FIELDS) record[field.key] = NOT_SPECIFIED;
  return record;
}
