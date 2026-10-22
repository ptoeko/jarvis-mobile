// Общие настройки приложения JARVIS Mobile.
// Здесь нет и не должно быть ключей или секретов: всё, что лежит в коде
// приложения, видно любому, кто откроет страницу.

export const APP_NAME = 'JARVIS Mobile';
export const APP_VERSION = '0.3.0';
export const APP_STAGE = 2;

export const NOT_SPECIFIED = 'Не указано';
export const MAX_MESSAGE_LENGTH = 4000;
// Равен длине сообщения: «Описание» по умолчанию — полный текст заметки.
export const MAX_FIELD_LENGTH = MAX_MESSAGE_LENGTH;
export const MAX_NOTES_PER_MESSAGE = 20;

// Схема записи реестра замечаний — 11 полей, порядок совпадает с порядком
// столбцов в таблице и в CSV. Порядок не менять без согласования.
// editable: поле можно исправить вручную. «№ п/п» присваивается при
// подтверждении и не меняется; «Исходный текст» хранится как записан.
export const REGISTRY_FIELDS = [
  { key: 'number', title: '№ п/п', editable: false },
  { key: 'date', title: 'Дата', editable: true },
  { key: 'object', title: 'Объект / здание', editable: true },
  { key: 'location', title: 'Место (ось, отметка, помещение)', editable: true },
  { key: 'workType', title: 'Вид работ', editable: true },
  { key: 'description', title: 'Описание замечания', editable: true, multiline: true },
  { key: 'requirement', title: 'Требование (проект, норма, пункт)', editable: true },
  { key: 'responsible', title: 'Ответственная организация', editable: true },
  { key: 'deadline', title: 'Срок устранения', editable: true },
  { key: 'status', title: 'Статус', editable: true },
  { key: 'sourceText', title: 'Исходный текст заметки', editable: false, multiline: true },
];

export const EDITABLE_FIELDS = REGISTRY_FIELDS.filter((f) => f.editable).map((f) => f.key);

// Создаёт пустую запись реестра: каждое поле — «Не указано».
export function emptyRecord() {
  const record = {};
  for (const field of REGISTRY_FIELDS) record[field.key] = NOT_SPECIFIED;
  return record;
}
