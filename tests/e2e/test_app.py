"""Сквозные тесты JARVIS Mobile в Chromium на экране Android-телефона.

Запуск: python3 tests/e2e/test_app.py [папка_для_скриншотов]
Нужен Python-пакет playwright с установленным Chromium.
Приложение раздаётся локальным сервером на 127.0.0.1 (это «безопасный
контекст», как HTTPS, поэтому service worker и IndexedDB работают).
"""
import functools
import http.server
import socketserver
import sys
import threading
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else None


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.webmanifest': 'application/manifest+json', '.js': 'text/javascript'}

    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f'http://127.0.0.1:{httpd.server_address[1]}/'


TESTS = []


def case(fn):
    TESTS.append(fn)
    return fn


def send(page, text):
    page.fill('#input', text)
    page.click('#send')


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f'{name}.png'))


# ---------- Тесты ----------
@case
def starts_in_demo_mode(page, url, ctx):
    expect(page).to_have_title('JARVIS Mobile')
    expect(page.locator('#mode-line')).to_have_text('Демо-режим: ИИ не подключён')
    expect(page.locator('#messages-empty')).to_be_visible()
    expect(page.locator('#storage-banner')).to_be_hidden()
    shot(page, '01-dialog-empty')


@case
def empty_message_shows_error(page, url, ctx):
    page.click('#send')
    expect(page.locator('#composer-error')).to_have_text('Введите текст сообщения.')
    assert page.locator('.msg').count() == 0
    page.fill('#input', 'а')
    expect(page.locator('#composer-error')).to_be_hidden()


@case
def help_command_gets_labelled_demo_reply(page, url, ctx):
    send(page, 'помощь')
    expect(page.locator('.msg')).to_have_count(2)
    reply = page.locator('.msg-assistant').last
    expect(reply.locator('.badge')).to_have_text('Демо')
    expect(reply).to_contain_text('Демо-ответ, не ИИ')
    expect(reply).to_contain_text('ИИ не подключён')
    expect(page.locator('#input')).to_have_value('')
    send(page, 'Ось 3/Б, отм. +6.000: трещина в стене')
    expect(page.locator('.msg')).to_have_count(4)
    shot(page, '02-dialog-messages')


@case
def enter_key_sends(page, url, ctx):
    page.fill('#input', 'статус')
    page.press('#input', 'Enter')
    expect(page.locator('.msg-assistant').last).to_contain_text('Состояние приложения')


@case
def html_is_shown_as_text(page, url, ctx):
    payload = '<img src=x onerror="window.__xss=1"><b>жирный</b>'
    send(page, payload)
    expect(page.locator('.msg-user .msg-text').last).to_have_text(payload)
    assert page.locator('.msg img').count() == 0
    assert page.evaluate('window.__xss') is None


@case
def too_long_message_rejected(page, url, ctx):
    page.evaluate("document.getElementById('input').removeAttribute('maxlength')")
    page.fill('#input', 'я' * 4001)
    page.click('#send')
    expect(page.locator('#composer-error')).to_contain_text('слишком длинное')
    assert page.locator('.msg').count() == 0


@case
def history_survives_reload(page, url, ctx):
    send(page, 'проверка сохранения')
    expect(page.locator('.msg')).to_have_count(2)
    page.reload()
    page.wait_for_selector('html[data-ready="true"]')
    expect(page.locator('.msg')).to_have_count(2)
    expect(page.locator('.msg-user .msg-text')).to_have_text('проверка сохранения')


@case
def tabs_switch_screens_and_back_button_works(page, url, ctx):
    for name, title in [('registry', 'Реестр замечаний'), ('settings', 'Настройки'), ('status', 'Статус')]:
        page.click(f'.tab[data-target="{name}"]')
        expect(page.locator(f'#screen-{name}')).to_be_visible()
        expect(page.locator(f'#screen-{name} h2')).to_have_text(title)
        expect(page.locator(f'.tab[data-target="{name}"]')).to_have_attribute('aria-current', 'page')
        assert page.locator('.screen:visible').count() == 1
    page.go_back()
    expect(page.locator('#screen-settings')).to_be_visible()


@case
def registry_is_empty_with_all_columns(page, url, ctx):
    page.click('.tab[data-target="registry"]')
    expect(page.locator('#records-count')).to_have_text('Записей: 0')
    expect(page.locator('.registry th')).to_have_count(11)
    expect(page.locator('.registry td.empty-row')).to_have_text('Записей пока нет.')
    shot(page, '03-registry')


@case
def status_is_honest(page, url, ctx):
    page.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null || true")
    page.click('.tab[data-target="status"]')
    def state(fid):
        return page.locator(f'[data-feature="{fid}"] .state')
    expect(state('dialog')).to_have_text('Демо')
    expect(state('storage')).to_have_text('Работает')
    expect(state('ai')).to_have_text('Этап 4')
    expect(state('registry')).to_have_text('Этап 2')
    expect(state('export')).to_have_text('Этап 2')
    expect(state('voice-app')).to_have_text('Этап 3')
    expect(state('offline')).to_have_text('Работает', timeout=10000)
    shot(page, '04-status')


@case
def delete_history_cancel_then_confirm(page, url, ctx):
    send(page, 'удали меня')
    page.click('.tab[data-target="settings"]')
    expect(page.locator('#count-messages')).to_have_text('2')
    page.click('#delete-history')
    expect(page.locator('#confirm-delete')).to_be_visible()
    shot(page, '05-confirm-delete')
    page.click('#confirm-delete button[value="cancel"]')
    expect(page.locator('#confirm-delete')).to_be_hidden()
    expect(page.locator('#count-messages')).to_have_text('2')

    page.click('#delete-history')
    page.click('#confirm-delete button[value="delete"]')
    expect(page.locator('#toast')).to_have_text('История удалена')
    expect(page.locator('#count-messages')).to_have_text('0')
    page.reload()
    page.wait_for_selector('html[data-ready="true"]')
    page.click('.tab[data-target="dialog"]')
    expect(page.locator('.msg')).to_have_count(0)
    expect(page.locator('#messages-empty')).to_be_visible()


@case
def opens_without_internet(page, url, ctx):
    page.evaluate('navigator.serviceWorker.ready')
    page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=10000)
    send(page, 'до отключения сети')
    ctx.set_offline(True)
    try:
        page.reload()
        page.wait_for_selector('html[data-ready="true"]', timeout=10000)
        expect(page.locator('#mode-line')).to_be_visible()
        expect(page.locator('.msg-user .msg-text')).to_have_text('до отключения сети')
        page.click('.tab[data-target="status"]')
        expect(page.locator('[data-feature="network"] .state')).to_have_text('Недоступно')
    finally:
        ctx.set_offline(False)


@case
def no_horizontal_scroll_on_small_phone(page, url, ctx):
    page.set_viewport_size({'width': 360, 'height': 740})
    for name in ['dialog', 'registry', 'settings', 'status']:
        page.click(f'.tab[data-target="{name}"]')
        overflow = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        assert overflow <= 0, f'{name}: горизонтальная прокрутка {overflow}px'


@case
def tap_targets_are_large_enough(page, url, ctx):
    for sel in ['#send', '.tab']:
        box = page.locator(sel).first.bounding_box()
        assert box['height'] >= 44, f'{sel}: высота {box["height"]}'


@case
def manifest_and_icons_are_valid(page, url, ctx):
    manifest = page.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
    assert manifest['display'] == 'standalone'
    assert manifest['start_url'] == './'
    for icon in manifest['icons']:
        status = page.evaluate(f"fetch('{icon['src']}').then(r => r.status)")
        assert status == 200, icon['src']
    assert any(i.get('purpose') == 'maskable' for i in manifest['icons'])


@case
def light_theme_screenshot(page, url, ctx):
    page.emulate_media(color_scheme='light')
    send(page, 'помощь')
    shot(page, '06-dialog-light')
    page.click('.tab[data-target="settings"]')
    shot(page, '07-settings-light')


# ---------- Запуск ----------
def main():
    httpd, url = serve()
    failures = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        device = p.devices['Pixel 7']
        for fn in TESTS:
            ctx = browser.new_context(**device, locale='ru-RU', color_scheme='dark')
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            try:
                page.goto(url)
                page.wait_for_selector('html[data-ready="true"]')
                fn(page, url, ctx)
                real = [e for e in errors if 'ERR_INTERNET_DISCONNECTED' not in e]
                assert not real, f'ошибки в консоли: {real}'
                print(f'ok   {fn.__name__}')
            except Exception:
                failures += 1
                print(f'FAIL {fn.__name__}')
                traceback.print_exc()
            finally:
                ctx.close()
        browser.close()
    httpd.shutdown()
    print(f'\n{len(TESTS) - failures} из {len(TESTS)} тестов пройдено')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
