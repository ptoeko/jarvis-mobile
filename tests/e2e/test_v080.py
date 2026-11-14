"""Сквозные тесты версии 0.8.0 (браузер и режим APK).

Запуск: python3 tests/e2e/test_v080.py [папка]

Проверяется: код входа — создание при первом запуске (простой код и несовпадение
отклоняются), запрос при каждом запуске, неверный код, пауза после 5 ошибок,
кнопка «Назад» не открывает приложение, смена кода в Настройках, сброс кода
с удалением данных; три вкладки внизу, разделы «Основные / Данные / Статус»;
синяя гамма вместо оранжевой. Все данные вымышленные.
"""
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stage2 as base  # noqa: E402
import test_v040 as v040  # noqa: E402
import test_apk_mode as apk  # noqa: E402
from playwright.sync_api import sync_playwright, expect  # noqa: E402

TESTS = []
PIN = base.TEST_PIN


def case(fn):
    TESTS.append(fn)
    return fn


def press(page, pin):
    base.press_pin(page, pin)


def restart(page):
    page.reload()
    page.wait_for_selector('html[data-ready="true"]')


@case
def first_launch_creates_pin(page, ctx, mode):
    lock = page.locator('#lock')
    expect(lock).to_be_visible()
    expect(page.locator('#lock-title')).to_have_text('Придумайте код из 4 цифр')
    assert page.evaluate("document.querySelector('.app').inert") is True
    assert page.locator('.tab').count() == 3
    base.shot(page, 'v080-01-create-pin')
    press(page, '1111')
    expect(page.locator('#lock-message')).to_contain_text('Слишком простой код')
    press(page, PIN)
    expect(page.locator('#lock-title')).to_have_text('Повторите код')
    press(page, '9999')
    expect(page.locator('#lock-message')).to_have_text('Коды не совпали. Придумайте код ещё раз.')
    expect(page.locator('#lock-title')).to_have_text('Придумайте код из 4 цифр')
    press(page, PIN)
    press(page, PIN)
    expect(lock).to_be_hidden()
    expect(page.locator('#toast')).to_have_text('Код входа сохранён')
    # При следующем запуске — ввод кода.
    restart(page)
    expect(lock).to_be_visible()
    expect(page.locator('#lock-title')).to_have_text('Введите код')
    expect(page.locator('#lock-forgot')).to_be_visible()
    if mode == 'apk':
        # «Назад» на экране кода не открывает приложение: оболочка сворачивает его.
        assert page.evaluate('window.__jarvisBack()') is False
        expect(lock).to_be_visible()
    press(page, '1234')
    expect(page.locator('#lock-message')).to_have_text('Неверный код. Осталось попыток до паузы: 4.')
    page.click('#lock-keys button[data-key="2"]')
    page.click('#lock-keys button[data-key="back"]')
    expect(page.locator('#lock-dots span.on')).to_have_count(0)
    base.shot(page, 'v080-02-enter-pin')
    press(page, PIN)
    expect(lock).to_be_hidden()
    stored = page.evaluate('''async () => {
        const db = await new Promise(r => { const q = indexedDB.open('jarvis-mobile'); q.onsuccess = () => r(q.result); });
        const v = await new Promise(r => { const q = db.transaction('meta').objectStore('meta').get('pinLock'); q.onsuccess = () => r(q.result); });
        db.close(); return JSON.stringify(v); }''')
    assert PIN not in stored.replace('"iterations":', ''), 'код хранится открыто'


@case
def pause_after_five_errors(page, ctx, mode):
    base.unlock(page)
    restart(page)
    for i in range(1, 5):
        press(page, '0000')
        expect(page.locator('#lock-message')).to_have_text(f'Неверный код. Осталось попыток до паузы: {5 - i}.')
    press(page, '0000')
    expect(page.locator('#lock-message')).to_contain_text('Много неверных попыток. Повторите через')
    expect(page.locator('#lock-keys button[data-key="1"]')).to_be_disabled()
    # Перезапуск не снимает паузу.
    restart(page)
    expect(page.locator('#lock-message')).to_contain_text('Много неверных попыток')
    expect(page.locator('#lock-keys button[data-key="1"]')).to_be_disabled()


@case
def change_pin_in_settings(page, ctx, mode):
    base.unlock(page)
    page.click('.tab[data-target="settings"]')
    page.click('#pin-change')
    expect(page.locator('#lock-title')).to_have_text('Введите текущий код')
    expect(page.locator('#lock-cancel')).to_be_visible()
    page.click('#lock-cancel')
    expect(page.locator('#lock')).to_be_hidden()
    page.click('#pin-change')
    press(page, PIN)
    expect(page.locator('#lock-title')).to_have_text('Придумайте код из 4 цифр')
    press(page, '4826')
    press(page, '4826')
    expect(page.locator('#toast')).to_have_text('Код входа изменён')
    restart(page)
    press(page, PIN)
    expect(page.locator('#lock-message')).to_contain_text('Неверный код')
    press(page, '4826')
    expect(page.locator('#lock')).to_be_hidden()


@case
def forgot_pin_resets_data(page, ctx, mode):
    base.unlock(page)
    v040.to_dialog(page)
    page.fill('#input', 'Секретная заметка')
    page.click('#send')
    expect(page.locator('.msg')).to_have_count(2)
    restart(page)
    page.click('#lock-forgot')
    expect(page.locator('#confirm-pin-reset')).to_be_visible()
    page.click('#confirm-pin-reset button[value="cancel"]')
    expect(page.locator('#lock-title')).to_have_text('Введите код')
    page.click('#lock-forgot')
    page.click('#confirm-pin-reset button[value="reset"]')
    expect(page.locator('#lock-title')).to_have_text('Придумайте код из 4 цифр')
    expect(page.locator('#lock-message')).to_have_text('Данные удалены. Придумайте новый код.')
    press(page, '3691')
    press(page, '3691')
    expect(page.locator('#lock')).to_be_hidden()
    expect(page.locator('.msg')).to_have_count(0)


@case
def settings_sections_and_blue_theme(page, ctx, mode):
    base.unlock(page)
    page.click('.tab[data-target="settings"]')
    expect(page.locator('#ai-group')).to_be_visible()
    expect(page.locator('#voice-group')).to_be_visible()
    expect(page.locator('#delete-history')).to_be_hidden()
    base.shot(page, 'v080-03-settings-main')
    page.click('.subtab[data-pane="data"]')
    expect(page.locator('#delete-history')).to_be_visible()
    expect(page.locator('#backup-save')).to_be_visible()
    page.click('.subtab[data-pane="status"]')
    expect(page.locator('#features .feature').first).to_be_visible()
    expect(page.locator('#app-version')).to_have_text(base.APP_VERSION)
    base.shot(page, 'v080-04-settings-status')
    # Нигде нет оранжевого: сигнальный цвет — синий.
    colors = page.evaluate('''() => {
        const out = new Set();
        for (const el of document.querySelectorAll('*')) {
            const cs = getComputedStyle(el);
            for (const p of ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'fill', 'stroke']) out.add(cs[p]);
        }
        return [...out]; }''')
    def orange(c):
        import re
        m = re.match(r'rgba?\((\d+), (\d+), (\d+)', c)
        if not m:
            return False
        r, g, b = map(int, m.groups())
        return r > 180 and 90 < g < 200 and b < 90
    assert not [c for c in colors if orange(c)], [c for c in colors if orange(c)]
    send = page.evaluate("getComputedStyle(document.querySelector('.subtab[aria-selected=true]')).backgroundColor")
    assert send in ('rgb(47, 111, 224)', 'rgb(31, 95, 214)'), send


def run(browser, device, mode):
    failures = 0
    srv = base.Server(base.ROOT)
    for fn in TESTS:
        ctx = browser.new_context(**device, locale='ru-RU')
        if mode == 'apk':
            ctx.route('**/*', apk.handle)
            ctx.add_init_script(v040.APK_BRIDGE)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        try:
            page.goto(apk.START if mode == 'apk' else srv.url)
            page.wait_for_selector('html[data-ready="true"]')
            fn(page, ctx, mode)
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
