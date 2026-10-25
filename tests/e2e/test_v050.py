"""Сквозные тесты версии 0.5.0: «ИИ агент» (с имитацией посредника).

Запуск: python3 tests/e2e/test_v050.py [папка]

Проверяется: подключение в Настройках (неверный адрес, короткий код, неверный
код, успех); переписка — агенту уходят история, фото (уменьшенное, JPEG) и PDF
последнего сообщения; ответ агента с меткой «ИИ агент» и файлами (Excel,
текст); «печатает…»; ошибка агента не теряет сообщение; разбор заметок
агентом и откат на правила; в интерфейсе нет названий моделей и поставщиков;
код доступа не попадает в резервную копию; работа в условиях APK (CSP).
"""
import base64
import io
import json
import re
import sys
import traceback
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stage2 as base  # noqa: E402
import test_v040 as v040  # noqa: E402
import test_apk_mode as apk  # noqa: E402
import openpyxl  # noqa: E402
from playwright.sync_api import sync_playwright, expect  # noqa: E402

OUT = base.OUT
AGENT = 'https://jarvis-agent.test.workers.dev'
CODE = 'test-access-code-0123456789'
FORBIDDEN = re.compile(r'claude|anthropic|open\s?ai|chat\s?gpt|\bgpt|sonnet|haiku|\bopus\b', re.I)


class Agent:
    """Имитация посредника: проверяет код, запоминает запросы, отвечает по сценарию."""

    def __init__(self):
        self.requests = []
        self.chat_reply = {'text': 'Здравствуйте! Я ИИ агент JARVIS.', 'files': []}
        self.parse_reply = None
        self.fail_with = None
        self.delay_ms = 0

    def handle(self, route):
        req = route.request
        if req.method == 'OPTIONS':
            route.fulfill(status=204, headers=self.cors())
            return
        auth = req.headers.get('authorization', '')
        if auth != f'Bearer {CODE}':
            route.fulfill(status=401, headers=self.cors(), body=json.dumps({'error': 'Неверный код доступа.'}))
            return
        path = req.url.replace(AGENT, '')
        body = json.loads(req.post_data) if req.post_data else None
        self.requests.append({'path': path, 'body': body})
        if self.fail_with and path != '/v1/health':
            route.fulfill(status=502, headers=self.cors(), body=json.dumps({'error': self.fail_with}))
            return
        if path == '/v1/health':
            data = {'ok': True, 'agent': 'ИИ агент'}
        elif path == '/v1/chat':
            data = self.chat_reply
        elif path == '/v1/parse':
            data = self.parse_reply or {'items': [self.item(n) for n in body['notes']]}
        else:
            route.fulfill(status=404, headers=self.cors(), body='{}')
            return
        if self.delay_ms:
            import time
            time.sleep(self.delay_ms / 1000)
        route.fulfill(status=200, headers={**self.cors(), 'Content-Type': 'application/json'}, body=json.dumps(data))

    @staticmethod
    def item(note):
        return {'date': 'Не указано', 'object': 'корпус 9 (ИИ)', 'location': 'Не указано', 'workType': 'бетонные работы',
                'description': f'суть: {note[:20]}', 'requirement': 'Не указано', 'responsible': 'Не указано',
                'deadline': 'Не указано', 'status': 'Не указано'}

    @staticmethod
    def cors():
        return {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'}


def connect(page, url=AGENT, code=CODE):
    page.click('.tab[data-target="settings"]')
    page.fill('#ai-url', url)
    page.fill('#ai-code', code)
    page.click('#ai-connect')


def connected(page):
    connect(page)
    expect(page.locator('#mode-line')).to_have_text('ИИ агент подключён')


def no_vendor_names(page):
    text = page.evaluate('document.body.innerText')
    assert not FORBIDDEN.search(text), FORBIDDEN.search(text)


TESTS = []


def case(fn):
    TESTS.append(fn)
    return fn


@case
def connect_validation_and_success(page, ctx, agent):
    connect(page, url='https://example.com', code=CODE)
    expect(page.locator('#ai-error')).to_contain_text('Неверный адрес')
    connect(page, code='короткий')
    expect(page.locator('#ai-error')).to_contain_text('не короче 16')
    connect(page, code='wrong-code-but-long-enough')
    expect(page.locator('#ai-error')).to_have_text('Неверный код доступа ИИ агента.')
    expect(page.locator('#mode-line')).to_have_text('Демо-режим: ИИ не подключён')
    connect(page, url='jarvis-agent.test.workers.dev/')  # без https:// и со слэшем — допустимо
    expect(page.locator('#mode-line')).to_have_text('ИИ агент подключён')
    expect(page.locator('#ai-state')).to_have_text('Подключён')
    expect(page.locator('#ai-note')).to_contain_text('внешним ИИ-сервисом')
    expect(page.locator('#ai-code')).to_have_value('')  # код не остаётся в поле
    base.shot(page, 'v050-01-settings-connected')
    page.reload()
    base.ready(page)
    expect(page.locator('#mode-line')).to_have_text('ИИ агент подключён')  # сохранено
    page.click('.tab[data-target="status"]')
    expect(page.locator('[data-feature="ai"] .state')).to_have_text('Работает')
    expect(page.locator('[data-feature="registry"] .state')).to_have_text('ИИ агент')
    no_vendor_names(page)
    page.click('.tab[data-target="settings"]')
    page.click('#ai-disconnect')
    expect(page.locator('#mode-line')).to_have_text('Демо-режим: ИИ не подключён')


@case
def chat_with_files_both_ways(page, ctx, agent):
    connected(page)
    agent.chat_reply = {'text': 'Готово: ведомость и письмо во вложении.', 'files': [
        {'kind': 'table', 'name': 'Ведомость корпус 7.xlsx', 'headers': ['№', 'Замечание'], 'rows': [['1', 'скол -0,300'], ['2', 'трещина']]},
        {'kind': 'text', 'name': 'письмо.txt', 'content': 'Уважаемые коллеги!\nПрошу устранить.'},
    ]}
    v040.to_dialog(page)
    page.fill('#input', 'первый вопрос без файлов')
    page.click('#send')
    expect(page.locator('.msg-assistant')).to_have_count(1)
    v040.attach(page, 'фото трещины.png', 'акт освидетельствования.pdf', 'ведомость.docx')
    page.fill('#input', 'Сделай ведомость по фото и акту')
    page.click('#send')
    expect(page.locator('.msg-assistant')).to_have_count(2)
    last = page.locator('.msg-assistant').last
    expect(last.locator('.badge')).to_have_text('ИИ агент')
    expect(last.locator('.msg-text')).to_have_text('Готово: ведомость и письмо во вложении.')
    expect(last.locator('.file-name')).to_have_text(['Ведомость корпус 7.xlsx', 'письмо.txt'])
    base.shot(page, 'v050-02-agent-reply-files')

    req = [r for r in agent.requests if r['path'] == '/v1/chat'][-1]['body']['messages']
    assert [m['role'] for m in req] == ['user', 'assistant', 'user'], [m['role'] for m in req]
    files = req[-1]['files']
    assert [f['name'] for f in files] == ['фото трещины.png', 'акт освидетельствования.pdf', 'ведомость.docx']
    assert files[0]['type'] == 'image/jpeg' and base64.b64decode(files[0]['data'])[:2] == b'\xff\xd8', 'фото уменьшено в JPEG'
    assert base64.b64decode(files[1]['data']) == v040.FILES['акт освидетельствования.pdf']
    assert 'data' not in files[2], 'Word передаётся только названием'

    # Файл Excel от агента — настоящий и читается.
    data = page.evaluate('''async () => {
        const db = await new Promise(r => { const q = indexedDB.open('jarvis-mobile'); q.onsuccess = () => r(q.result); });
        const items = await new Promise(r => { const q = db.transaction('attachments').objectStore('attachments').getAll(); q.onsuccess = () => r(q.result); });
        db.close();
        const x = items.find(i => i.name.endsWith('.xlsx'));
        return [...new Uint8Array(await x.blob.arrayBuffer())]; }''')
    ws = openpyxl.load_workbook(io.BytesIO(bytes(data))).active
    assert [[c.value for c in r] for r in ws.iter_rows()] == [['№', 'Замечание'], ['1', 'скол -0,300'], ['2', 'трещина']]
    no_vendor_names(page)


@case
def typing_indicator_and_error_keeps_message(page, ctx, agent):
    connected(page)
    v040.to_dialog(page)
    agent.delay_ms = 1200
    page.fill('#input', 'долгий ответ')
    page.click('#send')
    expect(page.locator('#agent-typing')).to_be_visible()
    expect(page.locator('#agent-typing')).to_have_count(0, timeout=10000)
    agent.delay_ms = 0
    agent.fail_with = 'ИИ агент временно перегружен. Повторите через минуту.'
    page.fill('#input', 'вопрос при сбое')
    page.click('#send')
    expect(page.locator('#composer-error')).to_contain_text('перегружен')
    expect(page.locator('#composer-error')).to_contain_text('сообщение сохранено')
    expect(page.locator('.msg-user .msg-text').last).to_have_text('вопрос при сбое')
    expect(page.locator('.msg-assistant')).to_have_count(1)


@case
def notes_parsed_by_agent_with_fallback(page, ctx, agent):
    connected(page)
    v040.to_dialog(page)
    page.fill('#input', f'{base.N1}\n\n{base.N2}')
    page.click('#parse')
    expect(page.locator('.draft')).to_have_count(2)
    expect(page.locator('.draft h4').first).to_contain_text('поля заполнил ИИ агент')
    expect(base.draft_field(page, 0, 'object')).to_have_value('корпус 9 (ИИ)')
    expect(base.draft_field(page, 0, 'status')).to_have_value('')  # «Не указано»
    expect(base.draft(page, 0).locator('.source-text')).to_have_text(base.N1)  # исходный текст дословно
    assert [r for r in agent.requests if r['path'] == '/v1/parse'][0]['body']['notes'] == [base.N1, base.N2]
    base.draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('.record-row td[data-field="object"]')).to_have_text('корпус 9 (ИИ)')
    base.shot(page, 'v050-03-drafts-by-agent')
    # Агент недоступен — поля по правилам, предупреждение.
    agent.fail_with = 'ИИ агент временно перегружен.'
    v040.to_dialog(page)
    page.fill('#input', 'Ось 5/В — скол')
    page.click('#parse')
    expect(page.locator('#toast')).to_contain_text('Поля заполнены по правилам')
    expect(page.locator('.draft h4').last).to_contain_text('по правилам')
    expect(base.draft_field(page, 1, 'location')).to_have_value('Ось 5/В')


@case
def access_code_not_in_backup(page, ctx, agent):
    connected(page)
    v040.to_dialog(page)
    page.fill('#input', 'запись для копии')
    page.click('#send')
    expect(page.locator('.msg-assistant')).to_have_count(1)
    page.click('.tab[data-target="settings"]')
    with page.expect_download() as dl:
        page.click('#backup-save')
    path = OUT / 'backup-ai.zip'
    dl.value.save_as(path)
    with zipfile.ZipFile(path) as z:
        manifest = z.read('manifest.json').decode('utf-8')
    assert CODE not in manifest and 'aiCode' not in manifest and 'aiUrl' not in manifest
    # После восстановления подключение остаётся.
    page.set_input_files('#restore-input', str(path))
    page.click('#confirm-restore button[value="restore"]')
    expect(page.locator('#toast')).to_contain_text('Данные восстановлены')
    expect(page.locator('#mode-line')).to_have_text('ИИ агент подключён')


@case
def phone_screen_settings(page, ctx, agent):
    page.set_viewport_size({'width': 360, 'height': 740})
    connected(page)
    overflow = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    assert overflow <= 0, overflow
    page.locator('#ai-group').scroll_into_view_if_needed()
    base.shot(page, 'v050-04-settings-360px')


def run(browser, device, mode):
    failures = 0
    srv = base.Server(base.ROOT)
    for fn in TESTS:
        agent = Agent()
        ctx = browser.new_context(**device, locale='ru-RU', accept_downloads=True)
        if mode == 'apk':
            ctx.route('**/*', apk.handle)
            ctx.add_init_script(v040.APK_BRIDGE)
        ctx.route(f'{AGENT}/**', agent.handle)  # позже добавленный маршрут проверяется первым
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        try:
            page.goto(apk.START if mode == 'apk' else srv.url)
            base.ready(page)
            if mode == 'apk' and fn.__name__ == 'access_code_not_in_backup':
                print(f'skip {fn.__name__} (apk: скачивание через мост проверено в test_v040)')
                continue
            fn(page, ctx, agent)
            bad = [e for e in errors if 'status of 401' not in e and 'status of 502' not in e]
            assert not bad, f'ошибки в консоли: {bad}'
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
    total = len(TESTS) * 2 - 1
    print(f'\n{total - failures} из {total} тестов пройдено. Файлы: {OUT}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
