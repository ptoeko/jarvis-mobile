"""Сквозные тесты версии 0.4.2: «Поделиться».

Запуск: python3 tests/e2e/test_v042.py [папка]

Вариант APK (имитация моста Android): сообщение с файлами, запись реестра и
файл Excel уходят в выбранное приложение (Telegram, WhatsApp, MAX, почта,
другое); файлы передаются полностью; ошибка «не установлен» показывается.
Веб-вариант: системное окно «Поделиться» браузера (имитация navigator.share).
"""
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stage2 as base  # noqa: E402
import test_v040 as v040  # noqa: E402
import test_apk_mode as apk  # noqa: E402
from playwright.sync_api import sync_playwright, expect  # noqa: E402

OUT = base.OUT

SHARE_BRIDGE = v040.APK_BRIDGE.replace('copyText(text) {', """shareChunked(json) {
    const req = JSON.parse(json);
    req.files = req.files.map(f => ({ name: f.name, type: f.type, data: window.__chunks[f.token] }));
    window.__shared.push(req);
    return window.__shareAnswer || 'ok';
  },
  copyText(text) {""").replace('window.__chunks = {};', 'window.__chunks = {};\nwindow.__shared = [];')

WEB_SHARE = """
window.__webShared = [];
navigator.share = async (data) => {
  window.__webShared.push({ title: data.title, text: data.text, files: (data.files || []).map(f => f.name) });
};
navigator.canShare = () => true;
"""


def poll(page, expr, timeout=5000):
    """Ожидание без eval-строк (в APK их запрещает политика безопасности)."""
    for _ in range(timeout // 100):
        if page.evaluate(expr):
            return
        page.wait_for_timeout(100)
    raise AssertionError(f'не дождались: {expr}')


def choose(page, target):
    expect(page.locator('#share-menu')).to_be_visible()
    page.click(f'#share-menu button[value="{target}"]')


APK_TESTS = []
WEB_TESTS = []


def apk_case(fn):
    APK_TESTS.append(fn)
    return fn


def web_case(fn):
    WEB_TESTS.append(fn)
    return fn


@apk_case
def share_message_with_files_to_telegram(page, ctx):
    v040.to_dialog(page)
    v040.attach(page, 'фото трещины.png', 'акт освидетельствования.pdf')
    page.fill('#input', 'Ось 3/Б — трещина, фото и акт')
    page.click('#send')
    page.locator('.msg-user').last.get_by_role('button', name='Поделиться сообщением').click()
    expect(page.locator('#share-what')).to_have_text('Текст и файлов: 2')
    base.shot(page, 'v042-01-share-menu')
    choose(page, 'telegram')
    poll(page, '() => window.__shared.length === 1')
    req = page.evaluate('() => window.__shared[0]')
    assert req['target'] == 'telegram'
    assert req['text'] == 'Ось 3/Б — трещина, фото и акт'
    assert [f['name'] for f in req['files']] == ['фото трещины.png', 'акт освидетельствования.pdf']
    assert req['files'][1]['data'].encode('latin-1') == v040.FILES['акт освидетельствования.pdf']
    assert req['files'][0]['type'] == 'image/png'


@apk_case
def share_record_to_whatsapp_max_email(page, ctx):
    v040.to_dialog(page)
    page.fill('#input', base.N1)
    page.click('#parse')
    base.draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('.record-row')).to_have_count(1)
    for target in ['whatsapp', 'max', 'email']:
        page.locator('.record-row').first.click()
        page.click('#record-share')
        expect(page.locator('#share-what')).to_have_text('Запись № 1')
        choose(page, target)
        n = ['whatsapp', 'max', 'email'].index(target) + 1
        poll(page, f'() => window.__shared.length === {n}')
        page.evaluate("() => document.getElementById('record-dialog').close()")
    reqs = page.evaluate('() => window.__shared')
    assert [r['target'] for r in reqs] == ['whatsapp', 'max', 'email']
    assert reqs[0]['subject'] == 'JARVIS: замечание № 1'
    assert reqs[0]['text'].startswith('Замечание № 1\nДата: 23.10.2026\nОбъект / здание: корпус 7')
    assert 'Не указано' not in reqs[0]['text']


@apk_case
def share_excel_file(page, ctx):
    v040.to_dialog(page)
    page.fill('#input', base.N2)
    page.click('#parse')
    base.draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    page.click('#export-xlsx')
    page.click('#export-xlsx-share')
    expect(page.locator('#share-what')).to_contain_text('.xlsx')
    choose(page, 'other')
    poll(page, '() => window.__shared.length === 1')
    req = page.evaluate('() => window.__shared[0]')
    assert req['target'] == 'other' and len(req['files']) == 1
    f = req['files'][0]
    assert f['name'].endswith('.xlsx') and f['type'] == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    path = OUT / 'shared.xlsx'
    path.write_bytes(f['data'].encode('latin-1'))
    with zipfile.ZipFile(path) as z:
        assert 'Пом. 2.15' in z.read('xl/worksheets/sheet1.xml').decode('utf-8')


@apk_case
def not_installed_message_and_cancel(page, ctx):
    v040.to_dialog(page)
    page.fill('#input', 'проверка')
    page.click('#send')
    page.evaluate("() => { window.__shareAnswer = 'MAX не установлен на телефоне. Выберите «Другое приложение».'; }")
    page.locator('.msg-user').last.get_by_role('button', name='Поделиться сообщением').click()
    choose(page, 'max')
    expect(page.locator('#notice')).to_be_visible()
    expect(page.locator('#notice-text')).to_contain_text('MAX не установлен')
    page.click('#notice button[value="ok"]')
    # «Отмена» ничего не отправляет.
    page.locator('.msg-user').last.get_by_role('button', name='Поделиться сообщением').click()
    choose(page, 'cancel')
    expect(page.locator('#share-menu')).to_be_hidden()
    assert page.evaluate('() => window.__shared.length') == 1


@web_case
def web_uses_system_share(page, ctx):
    v040.to_dialog(page)
    v040.attach(page, 'фото трещины.png')
    page.fill('#input', 'веб: поделиться')
    page.click('#send')
    page.locator('.msg-user').last.get_by_role('button', name='Поделиться сообщением').click()
    choose(page, 'whatsapp')
    poll(page, '() => window.__webShared.length === 1')
    data = page.evaluate('() => window.__webShared[0]')
    assert data['text'] == 'веб: поделиться' and data['files'] == ['фото трещины.png'], data


@web_case
def share_buttons_fit_phone(page, ctx):
    page.set_viewport_size({'width': 360, 'height': 740})
    v040.to_dialog(page)
    page.fill('#input', 'Ось 1/А — скол бетона на колонне, длинный текст для проверки ширины')
    page.click('#parse')
    base.draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    v040.to_dialog(page)
    overflow = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    assert overflow <= 0, overflow
    page.click('.tab[data-target="registry"]')
    page.locator('.record-row').first.click()
    box = page.locator('#record-share').bounding_box()
    assert box['height'] >= 44 and box['x'] + box['width'] <= 360, box
    base.shot(page, 'v042-02-record-share')


def main():
    srv = base.Server(base.ROOT)
    failures = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        device = p.devices['Pixel 7']
        import traceback
        for fn, mode in [(f, 'apk') for f in APK_TESTS] + [(f, 'web') for f in WEB_TESTS]:
            ctx = browser.new_context(**device, locale='ru-RU')
            if mode == 'apk':
                ctx.route('**/*', apk.handle)
                ctx.add_init_script(SHARE_BRIDGE)
            else:
                ctx.add_init_script(WEB_SHARE)
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            try:
                page.goto(apk.START if mode == 'apk' else srv.url)
                base.ready(page)
                fn(page, ctx)
                assert not errors, f'ошибки в консоли: {errors}'
                print(f'ok   {fn.__name__}')
            except Exception:
                failures += 1
                print(f'FAIL {fn.__name__}')
                traceback.print_exc()
            finally:
                ctx.close()
        browser.close()
    srv.httpd.shutdown()
    total = len(APK_TESTS) + len(WEB_TESTS)
    print(f'\n{total - failures} из {total} тестов пройдено. Файлы: {OUT}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
