"""Сквозные тесты версии 0.7.1: произношение голоса JARVIS (браузер и режим APK).

Запуск: python3 tests/e2e/test_v071.py [папка]

Проверяется: встроенный словарь (JARVIS, AYRAT, осях, ведомостей, поиск);
свой словарь в настройках — добавить, прослушать, сохранить после
перезапуска, удалить; «Точные ударения через ИИ агента» — текст уходит
посреднику, ответ с ударениями читается; неверный ответ посредника не
искажает озвучку; без переключателя посредник не вызывается.
Все данные вымышленные.
"""
import json
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stage2 as base  # noqa: E402
import test_v040 as v040  # noqa: E402
import test_v050 as v050  # noqa: E402
import test_v070 as v070  # noqa: E402
import test_apk_mode as apk  # noqa: E402
from playwright.sync_api import sync_playwright, expect  # noqa: E402

S = '́'
TESTS = []


class Agent(v050.Agent):
    """Посредник с ударениями: /v1/accent отвечает по функции accent_fn."""

    def __init__(self):
        super().__init__()
        self.accent_fn = lambda text: text

    def handle(self, route):
        req = route.request
        if req.method == 'POST' and req.url.endswith('/v1/accent'):
            body = json.loads(req.post_data)
            self.requests.append({'path': '/v1/accent', 'body': body})
            route.fulfill(status=200, headers={**self.cors(), 'Content-Type': 'application/json'},
                          body=json.dumps({'text': self.accent_fn(body['text'])}))
            return
        super().handle(route)


def case(fn):
    TESTS.append(fn)
    return fn


def last_spoken(page, what):
    v070.wait_until(lambda: any('text' in s for s in v070.spoken(page)), what)
    return [s for s in v070.spoken(page) if 'text' in s][-1]['text']


def reply_and_speak(page, agent, text):
    agent.chat_reply = {'text': text, 'files': []}
    v040.to_dialog(page)
    v070.send(page, 'Проверка голоса')
    page.locator('.msg-assistant .speak-btn').last.click()


@case
def builtin_dictionary(page, ctx, agent):
    v050.connected(page)
    reply_and_speak(page, agent, 'Я JARVIS, мой разработчик — AYRAT. В осях 3-5 нет ведомостей. Поиск по СМР.')
    said = last_spoken(page, 'озвучка')
    assert said == f'Я Джа{S}рвис, мой разработчик — Айра{S}т. В ося{S}х 3-5 нет ве{S}домостей. По{S}иск по эс-эм-э{S}р.', said
    assert not [r for r in agent.requests if r['path'] == '/v1/accent']  # переключатель выключен


@case
def own_dictionary(page, ctx, agent):
    page.click('.tab[data-target="settings"]')
    expect(page.locator('#pron-empty')).to_be_visible()
    page.fill('#pron-word', 'ростверк')
    page.fill('#pron-reading', 'ростве+рк')
    page.click('#pron-add')
    expect(page.locator('#toast')).to_have_text('В словаре: ростверк → ростве+рк')
    expect(page.locator('.pron-item .pron-text')).to_have_text(['ростверк → ростве+рк'])
    base.shot(page, 'v071-01-dictionary')
    page.locator('.pron-item button', has_text='Прослушать').click()
    assert last_spoken(page, 'прослушивание') == f'ростве{S}рк'
    page.reload()
    base.ready(page)
    page.click('.tab[data-target="settings"]')
    expect(page.locator('.pron-item')).to_have_count(1)
    page.locator('.pron-item button', has_text='Удалить').click()
    expect(page.locator('.pron-item')).to_have_count(0)
    expect(page.locator('#pron-empty')).to_be_visible()


@case
def accents_from_agent(page, ctx, agent):
    v050.connected(page)
    page.click('.tab[data-target="settings"]')
    page.check('#voice-accents')
    agent.accent_fn = lambda text: text.replace('замок', 'за+мок').replace('готов', 'гото+в')
    reply_and_speak(page, agent, 'На двери замок. JARVIS готов.')
    said = last_spoken(page, 'озвучка с ударениями')
    assert said == f'На двери за{S}мок. Джа{S}рвис гото{S}в.', said
    sent = [r for r in agent.requests if r['path'] == '/v1/accent'][-1]['body']['text']
    assert sent == f'На двери замок. Джа{S}рвис готов.', sent


@case
def bad_accents_ignored(page, ctx, agent):
    v050.connected(page)
    page.click('.tab[data-target="settings"]')
    page.check('#voice-accents')
    agent.accent_fn = lambda text: 'Совсем другой текст'
    reply_and_speak(page, agent, 'Отчёт по осях готов.')
    said = last_spoken(page, 'озвучка без ударений агента')
    assert said == f'Отчёт по ося{S}х готов.', said


def run(browser, device, mode):
    failures = 0
    srv = base.Server(base.ROOT)
    for fn in TESTS:
        agent = Agent()
        ctx = browser.new_context(**device, locale='ru-RU')
        if mode == 'apk':
            ctx.route('**/*', apk.handle)
            ctx.add_init_script(v040.APK_BRIDGE)
        ctx.add_init_script(v070.VOICE)
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
