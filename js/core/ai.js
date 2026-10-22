// Точка подключения ИИ (этап 4).
// Приложение никогда не обращается к провайдерам ИИ напрямую и не хранит
// ключи. Запросы пойдут только через серверный посредник с авторизацией,
// ограничением частоты и лимитом расходов. На этапе 1 посредника нет,
// поэтому клиент всегда сообщает «не подключено» и не делает сетевых запросов.

export const AI_PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
];

export class AiNotConfiguredError extends Error {
  constructor() {
    super('ИИ не подключён. Ответы формируются в демонстрационном режиме.');
    this.name = 'AiNotConfiguredError';
  }
}

export function createAiClient() {
  return {
    configured: false,
    provider: null,
    async send() {
      throw new AiNotConfiguredError();
    },
  };
}
