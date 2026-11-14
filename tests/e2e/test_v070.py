"""Сквозные тесты версии 0.7.0 (с имитацией посредника), в браузере и в условиях APK.

Запуск: python3 tests/e2e/test_v070.py [папка]

Проверяется: сводная книга Excel от агента — настоящий файл с листами, числами
и итоговой формулой; замечания, подготовленные агентом («занеси в реестр»),
попадают в черновики на проверку и после подтверждения — в реестр; кнопка
микрофона вставляет продиктованный текст, «В реестр» работает с ним;
озвучка ответа кнопкой и автоматически, остановка; настройки «Голос JARVIS»
(голоса, скорость, «Прослушать»), обращение «сэр» уходит посреднику.
В браузере синтез и распознавание речи подменены имитацией, в режиме APK —
имитацией моста Android. Все данные вымышленные.
"""
import io
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stage2 as base  # noqa: E402
import test_v040 as v040  # noqa: E402
import test_v050 as v050  # noqa: E402
import test_apk_mode as apk  # noqa: E402
import openpyxl  # noqa: E402
from playwright.sync_api import sync_playwright, expect  # noqa: E402

TESTS = []

# Имитация голоса: в APK — методы моста Android, в браузере — Web Speech API.
# Всё, что «произнесено», записывается в window.__spoken; текст диктовки
# задаётся в window.__dictation.
VOICE = """
window.__spoken = [];
window.__dictation = 'Здание 10UJA, оси 3-5, отметка +6,000, трещина в стене, срок до 20.11.2026';
if (window.JarvisAndroid) {
  Object.assign(window.JarvisAndroid, {
    ttsStatus: () => 'ready',
    ttsVoices: () => JSON.stringify([{ id: 'ru-ru-x-dfc-local', local: true }, { id: 'ru-ru-x-ruc-network', local: false }]),
    speak: (chunks, voice, rate, pitch, id) => {
      window.__spoken.push({ text: JSON.parse(chunks).join(' '), voice, rate, pitch, id });
      window.__lastSpeechId = id;
    },
    stopSpeaking: () => { window.__spoken.push({ stop: true }); setTimeout(() => window.__jarvisSpeech && window.__jarvisSpeech(window.__lastSpeechId, 'stopped'), 0); },
    canDictate: () => true,
    startDictation: () => setTimeout(() => window.__jarvisDictation('ok', window.__dictation), 50),
  });
} else {
  const voices = [{ voiceURI: 'ru-web-1', name: 'Russian', lang: 'ru-RU', localService: true }];
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices: () => voices,
    speak: (u) => { window.__spoken.push({ text: u.text, voice: u.voice && u.voice.voiceURI, rate: u.rate, pitch: u.pitch }); },
    cancel: () => { window.__spoken.push({ stop: true }); },
  } });
  const FakeRecognition = class {
    start() { setTimeout(() => { this.onresult({ results: [[{ transcript: window.__dictation }]] }); this.onend(); }, 50); }
  };
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, writable: true, value: FakeRecognition });
  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, writable: true, value: FakeRecognition });
}
"""


def case(fn):
    TESTS.append(fn)
    return fn


def send(page, text):
    page.fill('#input', text)
    page.click('#send')


def stored_files(page):
    return page.evaluate('''async () => {
        const db = await new Promise(r => { const q = indexedDB.open('jarvis-mobile'); q.onsuccess = () => r(q.result); });
        const items = await new Promise(r => { const q = db.transaction('attachments').objectStore('attachments').getAll(); q.onsuccess = () => r(q.result); });
        db.close();
        const out = {};
        for (const it of items) out[it.name] = [...new Uint8Array(await it.blob.arrayBuffer())];
        return out; }''')


def spoken(page):
    return page.evaluate('window.__spoken')


def wait_until(check, what, timeout=10):
    # wait_for_function со строкой запрещён политикой безопасности страницы APK.
    end = time.time() + timeout
    while time.time() < end:
        if check():
            return
        time.sleep(0.1)
    raise AssertionError(f'не дождались: {what}')


@case
def agent_sends_excel_workbook(page, ctx, agent):
    v050.connected(page)
    agent.chat_reply = {
        'text': 'Сводный отчёт в Excel во вложении.',
        'files': [{'kind': 'workbook', 'name': 'Сводный отчёт СМР.xlsx', 'sheets': [
            {'name': 'Сводка', 'title': 'Сводный отчёт СМР', 'subtitle': 'Период: 01–07.11.2026 (учебные данные)',
             'headers': ['Здание', 'Вид работ', 'Объём, м³', 'Выполнение, %', 'Отметка'],
             'rows': [['10UJA', 'Бетонирование', '125,5', '48%', '-0,300'], ['10UKA', 'Армирование', '1 200', '12%', '+6,000']],
             'numberColumns': [2, 3], 'totalColumns': [2], 'totalLabel': 'Итого', 'landscape': True},
            {'name': 'Расхождения', 'title': '', 'subtitle': '', 'headers': ['Здание', 'Что расходится'],
             'rows': [['10UJA', 'Отчёт 1: 125,5 м³; отчёт 2: 130 м³']], 'numberColumns': [], 'totalColumns': [], 'totalLabel': '', 'landscape': True},
        ]}],
    }
    v040.to_dialog(page)
    send(page, 'Сведи отчёты в Excel')
    last = page.locator('.msg-assistant').last
    expect(last.locator('.file-name')).to_have_text(['Сводный отчёт СМР.xlsx'])
    base.shot(page, 'v070-01-excel-reply')
    wb = openpyxl.load_workbook(io.BytesIO(bytes(stored_files(page)['Сводный отчёт СМР.xlsx'])))
    assert wb.sheetnames == ['Сводка', 'Расхождения'], wb.sheetnames
    ws = wb['Сводка']
    rows = list(ws.iter_rows(values_only=True))
    assert rows[0][0] == 'Сводный отчёт СМР'
    assert rows[3] == ('Здание', 'Вид работ', 'Объём, м³', 'Выполнение, %', 'Отметка'), rows[3]
    assert rows[4] == ('10UJA', 'Бетонирование', 125.5, 0.48, '-0,300'), rows[4]
    assert rows[5][2] == 1200
    assert rows[6][0] == 'Итого' and rows[6][2] == '=SUBTOTAL(9,C5:C6)', rows[6]
    assert ws.freeze_panes == 'A5'
    # Посчитанное значение итога сохранено в файле (видно и без пересчёта формул).
    cached = openpyxl.load_workbook(io.BytesIO(bytes(stored_files(page)['Сводный отчёт СМР.xlsx'])), data_only=True)
    assert cached['Сводка']['C7'].value == 1325.5


@case
def agent_prepares_registry_drafts(page, ctx, agent):
    v050.connected(page)
    said = 'Занеси в реестр: здание 10UJA, оси 3-5, трещина в стене, исполнитель ООО «Учебный подрядчик», срок до 20.11.2026'
    agent.chat_reply = {
        'text': 'Подготовил одно замечание, проверьте в «Реестре».',
        'files': [],
        'drafts': [{'sourceText': 'здание 10UJA, оси 3-5, трещина в стене, исполнитель ООО «Учебный подрядчик», срок до 20.11.2026',
                    'date': 'Не указано', 'object': 'Здание 10UJA', 'location': 'оси 3-5', 'workType': 'Не указано',
                    'description': 'Трещина в стене', 'requirement': 'Не указано', 'responsible': 'ООО «Учебный подрядчик»',
                    'deadline': '20.11.2026', 'status': 'Не указано'}],
    }
    v040.to_dialog(page)
    send(page, said)
    expect(page.locator('#toast')).to_contain_text('На проверке в «Реестре»: 1')
    page.click('.tab[data-target="registry"]')
    draft = page.locator('.draft')
    expect(draft).to_have_count(1)
    expect(draft.locator('h4')).to_contain_text('поля заполнил ИИ агент')
    expect(draft.locator('.source-text')).to_have_text('здание 10UJA, оси 3-5, трещина в стене, исполнитель ООО «Учебный подрядчик», срок до 20.11.2026')
    expect(draft.locator('[data-field="object"]:is(input, textarea)')).to_have_value('Здание 10UJA')
    expect(draft.locator('[data-field="deadline"]:is(input, textarea)')).to_have_value('20.11.2026')
    base.shot(page, 'v070-02-agent-draft')
    draft.locator('button.send').click()
    expect(page.locator('#toast')).to_have_text('Запись № 1 добавлена в реестр')
    expect(page.locator('.record-row')).to_have_count(1)
    expect(page.locator('.record-row td[data-field="description"]')).to_have_text('Трещина в стене')


@case
def dictation_to_registry(page, ctx, agent):
    v050.connected(page)
    v040.to_dialog(page)
    expect(page.locator('#mic')).to_be_visible()
    page.click('#mic')
    expect(page.locator('#input')).to_have_value('Здание 10UJA, оси 3-5, отметка +6,000, трещина в стене, срок до 20.11.2026')
    # Вторая диктовка дописывается к первой.
    page.evaluate("window.__dictation = 'исполнитель ООО «Учебный подрядчик»'")
    page.click('#mic')
    expect(page.locator('#input')).to_have_value('Здание 10UJA, оси 3-5, отметка +6,000, трещина в стене, срок до 20.11.2026. Исполнитель ООО «Учебный подрядчик»')
    base.shot(page, 'v070-03-dictation')
    page.click('#parse')
    expect(page.locator('.draft')).to_have_count(1)
    parse = [r for r in agent.requests if r['path'] == '/v1/parse'][-1]['body']
    assert parse['notes'][0].startswith('Здание 10UJA, оси 3-5'), parse


@case
def speak_reply_and_stop(page, ctx, agent):
    v050.connected(page)
    agent.chat_reply = {'text': 'Готово. Источник: https://minstroyrf.gov.ru/\n\nИсточники:\n1. Минстрой — https://minstroyrf.gov.ru/', 'files': []}
    v040.to_dialog(page)
    send(page, 'Найди сайт Минстроя')
    button = page.locator('.msg-assistant .speak-btn').last
    expect(button).to_be_visible()
    assert spoken(page) == []  # без автоозвучки ответ не читается сам
    button.click()
    said = [s for s in spoken(page) if 'text' in s][-1]
    assert said['text'] == 'Готово. Источник: ссылка\nИсточники — в тексте ответа.', said
    assert abs(said['rate'] - 0.95) < 1e-9 and abs(said['pitch'] - 0.82) < 1e-9, said
    expect(button).to_have_class('copy-btn speak-btn active')
    button.click()
    assert spoken(page)[-1] == {'stop': True}
    expect(button).to_have_class('copy-btn speak-btn')


@case
def voice_settings_auto_and_sir(page, ctx, agent):
    v050.connected(page)
    page.click('.tab[data-target="settings"]')
    expect(page.locator('#voice-state')).to_have_text('Готов')
    options = page.locator('#voice-select option')
    if page.evaluate('!!(window.JarvisAndroid && window.JarvisAndroid.speak)'):
        expect(options).to_have_text(['Голос 1', 'Голос 2 (нужен интернет)'])
        page.select_option('#voice-select', 'ru-ru-x-ruc-network')
    else:
        expect(options).to_have_text(['Голос 1'])
    page.select_option('#voice-rate', '0.85')
    page.check('#voice-auto')
    page.check('#voice-sir')
    base.shot(page, 'v070-04-voice-settings')
    page.click('#voice-test')
    test = [s for s in spoken(page) if 'text' in s][-1]
    assert test['text'] == 'Слушаю, сэр. Я JARVIS. Готов к работе на площадке.', test
    assert abs(test['rate'] - 0.85) < 1e-9
    # Настройки сохраняются: после перезапуска приложения они те же.
    page.reload()
    base.ready(page)
    page.click('.tab[data-target="settings"]')
    expect(page.locator('#voice-auto')).to_be_checked()
    expect(page.locator('#voice-sir')).to_be_checked()
    expect(page.locator('#voice-rate')).to_have_value('0.85')
    # Автоозвучка ответа и «сэр» в запросе к посреднику.
    agent.chat_reply = {'text': 'Слушаю, сэр. Отчёт готов.', 'files': []}
    v040.to_dialog(page)
    send(page, 'Как дела?')
    expect(page.locator('.msg-assistant:not(.typing)')).to_have_count(1)
    wait_until(lambda: any(x.get('text') == 'Слушаю, сэр. Отчёт готов.' for x in spoken(page)), 'автоозвучка ответа')
    chat = [r for r in agent.requests if r['path'] == '/v1/chat'][-1]['body']
    assert chat['prefs'] == {'sir': True}, chat
    v050.no_vendor_names(page)


@case
def sir_off_by_default(page, ctx, agent):
    v050.connected(page)
    v040.to_dialog(page)
    send(page, 'Кто тебя создал?')
    expect(page.locator('.msg-assistant:not(.typing)')).to_have_count(1)
    chat = [r for r in agent.requests if r['path'] == '/v1/chat'][-1]['body']
    assert chat['prefs'] == {'sir': False}, chat


def run(browser, device, mode):
    failures = 0
    srv = base.Server(base.ROOT)
    for fn in TESTS:
        agent = v050.Agent()
        ctx = browser.new_context(**device, locale='ru-RU', accept_downloads=True)
        if mode == 'apk':
            ctx.route('**/*', apk.handle)
            ctx.add_init_script(v040.APK_BRIDGE)
        ctx.add_init_script(VOICE)
        ctx.route(f'{v050.AGENT}/**', agent.handle)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        try:
            page.goto(apk.START if mode == 'apk' else srv.url)
            base.ready(page)
            fn(page, ctx, agent)
            assert not errors, f'ошибки в консоли: {errors}'
            print(f'ok   {mode}:{fn.__name__}')
        except Exception:
            failures += 1
            print(f'FAIL {mode}:{fn.__name__}')
            traceback.print_exc()
        finally:
            ctx.close()
    srv.httpd.shutdown()
    return failures


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        device = p.devices['Pixel 7']
        failures = run(browser, device, 'web') + run(browser, device, 'apk')
        browser.close()
    total = len(TESTS) * 2
    print(f'\n{total - failures} из {total} тестов пройдено. Файлы: {base.OUT}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
