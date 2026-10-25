"""Сквозные тесты исправлений 0.3.1 в Chromium на экране Android-телефона (Pixel 7).

Запуск: python3 tests/e2e/test_review031.py [папка_для_скриншотов]

Проверяется: черновики переживают перезапуск и сворачивание приложения;
подтверждённый черновик не возвращается; удаление истории стирает черновики;
статус «Не указано» в таблице; обновление с 0.3.0 сохраняет реестр и нумерацию.
Все данные — вымышленные.
"""
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stage2 as base  # noqa: E402  (общие помощники и учебные заметки)
from playwright.sync_api import sync_playwright, expect  # noqa: E402

N1, N2, NS = base.N1, base.N2, base.NS
parse_notes, draft, draft_field, ready = base.parse_notes, base.draft, base.draft_field, base.ready

TESTS = []


def case(fn):
    TESTS.append(fn)
    return fn


def reload_app(page):
    page.reload()
    ready(page)


def open_registry(page):
    page.click('.tab[data-target="registry"]')
    expect(page.locator('#screen-registry')).to_be_visible()


@case
def drafts_survive_restart(page, ctx):
    parse_notes(page, f'{N1}\n\n{N2}')
    draft_field(page, 0, 'object').fill('корпус 9 (исправлено)')
    page.wait_for_timeout(800)  # отложенное сохранение правки
    reload_app(page)
    open_registry(page)
    expect(page.locator('.draft')).to_have_count(2)
    expect(draft_field(page, 0, 'object')).to_have_value('корпус 9 (исправлено)')
    expect(draft(page, 1).locator('.source-text')).to_have_text(N2)
    expect(page.locator('#records-count')).to_have_text('Записей: 0')


@case
def draft_edit_saved_when_app_goes_to_background(page, ctx):
    parse_notes(page, N2)
    draft_field(page, 0, 'responsible').fill('ООО «Бета»')
    # Сворачивание приложения сразу после ввода (до отложенного сохранения).
    page.evaluate("""() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    page.wait_for_timeout(150)
    reload_app(page)
    open_registry(page)
    expect(draft_field(page, 0, 'responsible')).to_have_value('ООО «Бета»')


@case
def confirmed_draft_does_not_come_back(page, ctx):
    parse_notes(page, f'{N1}\n\n{N2}')
    draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('#toast')).to_have_text('Запись № 1 добавлена в реестр')
    draft(page, 0).get_by_role('button', name='Отклонить').click()
    expect(page.locator('#toast')).to_have_text('Черновик отклонён')
    expect(page.locator('.draft')).to_have_count(0)
    reload_app(page)
    open_registry(page)
    expect(page.locator('.draft')).to_have_count(0)
    expect(page.locator('.record-row')).to_have_count(1)


@case
def delete_history_clears_drafts(page, ctx):
    parse_notes(page, N2)
    page.click('.tab[data-target="settings"]')
    page.click('#delete-history')
    page.click('#confirm-delete button[value="delete"]')
    expect(page.locator('#toast')).to_have_text('История удалена')
    reload_app(page)
    open_registry(page)
    expect(page.locator('.draft')).to_have_count(0)


@case
def status_not_specified_in_table(page, ctx):
    parse_notes(page, 'Ось 1/А — скол бетона, устранено частично')
    expect(draft_field(page, 0, 'status')).to_have_value('')
    draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('.record-row td[data-field="status"]')).to_have_text(NS)
    expect(page.locator('.record-row td[data-field="sourceText"]')).to_have_text('Ось 1/А — скол бетона, устранено частично')


@case
def records_and_numbering_survive_restart(page, ctx):
    parse_notes(page, f'{N1}\n\n{N2}\n\nОсь 5 — мусор')
    for left in (2, 1, 0):
        draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
        expect(page.locator('.draft')).to_have_count(left)
    expect(page.locator('.record-row')).to_have_count(3)
    page.locator('.record-row[data-number="3"]').click()
    page.click('#record-delete')
    page.click('#confirm-record-delete button[value="delete"]')
    expect(page.locator('.record-row')).to_have_count(2)
    reload_app(page)
    parse_notes(page, 'Ось 6 — скол')
    draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('#toast')).to_have_text('Запись № 4 добавлена в реестр')
    numbers = page.locator('.record-row td[data-field="number"]').all_text_contents()
    assert numbers == ['1', '2', '4'], numbers


def upgrade_from_030(browser, device):
    old = base.checkout_old('0.3.0')
    srv = base.Server(old)
    ctx = browser.new_context(**device, locale='ru-RU')
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(srv.url)
        page.wait_for_selector('html[data-ready="true"][data-version="0.3.0"]')
        page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=15000)
        parse_notes(page, f'{N1}\n\n{N2}')
        for left in (1, 0):
            draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
            expect(page.locator('.draft')).to_have_count(left)
        expect(page.locator('.record-row')).to_have_count(2)
        page.locator('.record-row[data-number="2"]').click()
        page.click('#record-delete')
        page.click('#confirm-record-delete button[value="delete"]')
        expect(page.locator('.record-row')).to_have_count(1)

        srv.root = base.ROOT  # новая версия на том же адресе
        page.reload()
        page.wait_for_selector(f'html[data-ready="true"][data-version="{base.APP_VERSION}"]', timeout=30000)
        open_registry(page)
        expect(page.locator('.record-row')).to_have_count(1)
        expect(page.locator('.record-row td[data-field="sourceText"]')).to_have_text(N1)
        expect(page.locator('.msg-user .msg-text')).to_have_text([f'{N1}\n\n{N2}'])
        parse_notes(page, 'Ось 7 — скол')
        draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
        expect(page.locator('#toast')).to_have_text('Запись № 3 добавлена в реестр')
        info = page.evaluate('''async () => {
            const db = await new Promise(r => { const q = indexedDB.open('jarvis-mobile'); q.onsuccess = () => r(q.result); });
            const v = { version: db.version, stores: [...db.objectStoreNames] };
            db.close(); return v; }''')
        assert info == {'version': 1, 'stores': ['messages', 'meta', 'records']}, info
        assert not errors, errors
    finally:
        ctx.close()
        srv.httpd.shutdown()


def main():
    srv = base.Server(base.ROOT)
    failures = 0
    total = len(TESTS) + 1
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
                page.goto(srv.url)
                ready(page)
                fn(page, ctx)
                assert not errors, f'ошибки в консоли: {errors}'
                print(f'ok   {fn.__name__}')
            except Exception:
                failures += 1
                print(f'FAIL {fn.__name__}')
                traceback.print_exc()
            finally:
                ctx.close()
        try:
            upgrade_from_030(browser, device)
            print('ok   upgrade_from_030')
        except Exception:
            failures += 1
            print('FAIL upgrade_from_030')
            traceback.print_exc()
        browser.close()
    srv.httpd.shutdown()
    print(f'\n{total - failures} из {total} тестов пройдено. Файлы: {base.OUT}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
