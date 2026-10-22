"""Тесты веб-части APK в Chromium в условиях, максимально близких к телефону.

Как в Android-оболочке (MainActivity.java):
- приложение открывается по адресу https://appassets.androidplatform.net/index.html;
- файлы отдаются с теми же заголовками (Content-Security-Policy и др.);
- запросы к любым другим адресам блокируются (403);
- объект window.JarvisAndroid (мост) подменён имитацией, которая записывает
  сохраняемый файл и возвращает результат так же, как Java-код.

Запуск: python3 tests/e2e/test_apk_mode.py [папка]
Это не замена проверки настоящего APK: её выполняет сборка на GitHub
на эмуляторе Android.
"""
import mimetypes
import re
import sys
import tempfile
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix='jarvis-apk-'))
OUT.mkdir(parents=True, exist_ok=True)
HOST = 'appassets.androidplatform.net'
START = f'https://{HOST}/index.html'
APP_VERSION = re.search(r"APP_VERSION = '([^']+)'", (ROOT / 'js/core/config.js').read_text(encoding='utf-8')).group(1)

# Заголовки и типы — из MainActivity.java, чтобы тест проверял то же самое.
JAVA = (ROOT / 'android/app/src/main/java/ru/jarvis/mobile/MainActivity.java').read_text(encoding='utf-8')
CSP = ''.join(re.findall(r'"([^"]*)"', re.search(r'"Content-Security-Policy",(.*?)\);', JAVA, re.S).group(1)))
MIME = dict(re.findall(r'MIME\.put\("(\w+)", "([^"]+)"\)', JAVA))
# Какие файлы попадают в APK — из build.gradle.
GRADLE = (ROOT / 'android/app/build.gradle').read_text(encoding='utf-8')
INCLUDE = re.findall(r"'([^']+)'", re.search(r"include (.*)\n", GRADLE).group(1))


def in_apk(rel):
    for pattern in INCLUDE:
        if pattern.endswith('/**') and rel.startswith(pattern[:-2]):
            return True
        if rel == pattern:
            return True
    return False


def handle(route):
    url = route.request.url
    m = re.match(rf'https://{re.escape(HOST)}(/[^?#]*)?', url)
    if not m:
        route.fulfill(status=403, body='')
        return
    path = m.group(1) or '/'
    if path == '/':
        path = '/index.html'
    rel = path.lstrip('/')
    file = ROOT / rel
    if '..' in path or not file.is_file() or not in_apk(rel):
        route.fulfill(status=404, body='')
        return
    ext = file.suffix.lstrip('.').lower()
    route.fulfill(status=200, body=file.read_bytes(),
                  headers={'Content-Type': MIME.get(ext, mimetypes.guess_type(file.name)[0] or 'application/octet-stream'),
                           'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
                           'Content-Security-Policy': CSP})


BRIDGE = """
window.__saved = [];
window.__nextSaveStatus = 'saved';
window.JarvisAndroid = {
  getVersion() { return '%s'; },
  saveTextFile(name, mime, content, id) {
    window.__saved.push({ name, mime, content, id });
    const st = window.__nextSaveStatus;
    setTimeout(() => window.__jarvisSaveResult(id, st, st === 'saved' ? 'Файл сохранён.' : 'Сохранение отменено.'), 50);
  },
};
""" % APP_VERSION

TESTS = []


def case(fn):
    TESTS.append(fn)
    return fn


def ready(page):
    page.wait_for_selector('html[data-ready="true"]')


def add_record(page, text):
    page.click('.tab[data-target="dialog"]')
    page.fill('#input', text)
    page.click('#parse')
    page.locator('.draft').first.get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('.draft')).to_have_count(0)


@case
def runs_under_apk_origin_with_csp(page, ctx):
    assert page.url == START
    expect(page.locator('#mode-line')).to_have_text('Демо-режим: ИИ не подключён')
    regs = page.evaluate('navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(r => r.length) : 0')
    assert regs == 0, 'в APK офлайн-кеш не регистрируется'
    page.click('.tab[data-target="settings"]')
    expect(page.locator('#app-platform')).to_have_text('Приложение Android (APK)')
    expect(page.locator('#app-version')).to_have_text(APP_VERSION)
    page.click('.tab[data-target="status"]')
    expect(page.locator('[data-feature="install"] .state')).to_have_text('APK')
    expect(page.locator('[data-feature="offline"] .state')).to_have_text('Работает')
    expect(page.locator('[data-feature="persist"] .state')).to_have_text('Работает')
    page.screenshot(path=str(OUT / 'apk-status.png'))


@case
def data_survives_restart(page, ctx):
    add_record(page, 'Ось 1/А — скол')
    page.goto(START)
    ready(page)
    page.click('.tab[data-target="registry"]')
    expect(page.locator('.record-row')).to_have_count(1)


@case
def export_goes_through_android_save_dialog(page, ctx):
    add_record(page, 'Ось 3/Б, отм. +6.000 — раковины "до 5 мм"')
    page.click('.tab[data-target="registry"]')
    page.click('#export')
    expect(page.locator('#export-confirm')).to_have_text('Сохранить CSV')
    page.click('#export-confirm')
    expect(page.locator('#toast')).to_contain_text('сохранён')
    saved = page.evaluate('window.__saved')
    assert len(saved) == 1, saved
    f = saved[0]
    assert re.fullmatch(r'jarvis-reestr-\d{4}-\d{2}-\d{2}\.csv', f['name']), f['name']
    assert f['mime'] == 'text/csv'
    assert f['content'].startswith('﻿"№ п/п";"Дата"'), f['content'][:40]
    assert '"Ось 3/Б, отм. +6.000 — раковины ""до 5 мм"""' in f['content']
    assert f['content'].count('\r\n') == 2
    # Пользователь закрыл окно «Сохранить» без выбора папки.
    page.evaluate("window.__nextSaveStatus = 'cancelled'")
    page.click('#export')
    page.click('#export-confirm')
    expect(page.locator('#toast')).to_have_text('Сохранение отменено')


@case
def back_button_closes_dialogs_first(page, ctx):
    add_record(page, 'Ось 2/Б — трещина')
    page.click('.tab[data-target="registry"]')
    assert page.evaluate('window.__jarvisBack()') is False
    page.locator('.record-row').first.click()
    expect(page.locator('#record-dialog')).to_be_visible()
    page.click('#record-delete')
    expect(page.locator('#confirm-record-delete')).to_be_visible()
    assert page.evaluate('window.__jarvisBack()') is True
    expect(page.locator('#confirm-record-delete')).to_be_hidden()
    expect(page.locator('#record-dialog')).to_be_visible()
    assert page.evaluate('window.__jarvisBack()') is True
    expect(page.locator('#record-dialog')).to_be_hidden()
    expect(page.locator('.record-row')).to_have_count(1), 'назад не удаляет запись'


@case
def external_requests_are_blocked(page, ctx):
    status = page.evaluate("fetch('https://example.com/').then(r => r.status).catch(() => 'blocked')")
    assert status in (403, 'blocked'), status
    status = page.evaluate("fetch('/sw.js').then(r => r.status)")
    assert status == 404, 'sw.js не входит в APK'


def main():
    failures = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        device = p.devices['Pixel 7']
        for fn in TESTS:
            ctx = browser.new_context(**device, locale='ru-RU', service_workers='allow')
            ctx.route('**/*', handle)
            ctx.add_init_script(BRIDGE)
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            try:
                page.goto(START)
                ready(page)
                fn(page, ctx)
                # Блокировка внешнего адреса политикой безопасности — ожидаемый результат.
                csp = [e for e in errors if ('Content Security Policy' in e or 'Refused' in e) and 'example.com' not in e]
                assert not csp, f'нарушения CSP: {csp}'
                expected_404 = fn.__name__ == 'external_requests_are_blocked'
                other = [e for e in errors if e not in csp and 'example.com' not in e
                         and not (expected_404 and 'status of 404' in e)]
                assert not other, f'ошибки в консоли: {other}'
                print(f'ok   {fn.__name__}')
            except Exception:
                failures += 1
                print(f'FAIL {fn.__name__}')
                traceback.print_exc()
            finally:
                ctx.close()
        browser.close()
    print(f'\n{len(TESTS) - failures} из {len(TESTS)} тестов пройдено')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
