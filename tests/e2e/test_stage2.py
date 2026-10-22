"""Сквозные тесты этапа 2 в Chromium на экране Android-телефона (Pixel 7).

Запуск: python3 tests/e2e/test_stage2.py [папка_для_скриншотов_и_файлов]

Проверяется: заметка → черновики → правка → подтверждение → правка записи →
удаление → экспорт CSV; импорт скачанного файла в LibreOffice с проверкой
каждой ячейки; обновление приложения с версии 0.1.0 без потери данных.
Нужны: Python-пакет playwright с Chromium, LibreOffice (soffice), openpyxl, git.
Все данные — вымышленные.
"""
import functools
import http.server
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import traceback
from pathlib import Path

import openpyxl
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix='jarvis-e2e-'))
OUT.mkdir(parents=True, exist_ok=True)
NS = 'Не указано'
import re as _re
APP_VERSION = _re.search(r"APP_VERSION = '([^']+)'", (ROOT / 'js/core/config.js').read_text(encoding='utf-8')).group(1)
TITLES = ['№ п/п', 'Дата', 'Объект / здание', 'Место (ось, отметка, помещение)', 'Вид работ',
          'Описание замечания', 'Требование (проект, норма, пункт)', 'Ответственная организация',
          'Срок устранения', 'Статус', 'Исходный текст заметки']

# Сервер с переключаемой папкой: нужен для проверки обновления версии
# на одном и том же адресе (как на GitHub Pages).
class Server:
    def __init__(self, root):
        self.root = Path(root)
        server = self

        class Handler(http.server.SimpleHTTPRequestHandler):
            extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                              '.webmanifest': 'application/manifest+json', '.js': 'text/javascript'}

            def __init__(self, *a, **k):
                super().__init__(*a, directory=str(server.root), **k)

            def log_message(self, *args):
                pass

        self.httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}/'


TESTS = []


def case(fn):
    TESTS.append(fn)
    return fn


def ready(page):
    page.wait_for_selector('html[data-ready="true"]')


def parse_notes(page, text):
    page.click('.tab[data-target="dialog"]')
    page.fill('#input', text)
    page.click('#parse')
    expect(page.locator('#screen-registry')).to_be_visible()


def draft(page, i):
    return page.locator('.draft').nth(i)


def draft_field(page, i, key):
    return draft(page, i).locator(f'[data-field="{key}"]:is(input, textarea)')


def shot(page, name):
    page.screenshot(path=str(OUT / f'{name}.png'))


# ---------- Учебные заметки (вымышленные) ----------
N1 = ('23.10.2026. Объект: корпус 7. Ось 3/Б, отм. +6.000 — раковины "до 5 мм"; см. фото\n'
      'вторая строка. Подрядчик: ООО «Альфа, Бета и К», срок до 30.10.2026')
N2 = 'Пом. 2.15: трещина в стяжке'
N3 = 'ёЁ щЩ ъЪ — «кавычки» и "двойные"'


# ---------- Тесты ----------
@case
def note_becomes_drafts_not_records(page, srv, ctx):
    parse_notes(page, f'{N1}\n\n{N2}')
    expect(page.locator('.draft')).to_have_count(2)
    expect(page.locator('#drafts-title')).to_have_text('На проверке: 2')
    expect(page.locator('#records-count')).to_have_text('Записей: 0')
    # Поля первого черновика — только явно написанное.
    expected = {'date': '23.10.2026', 'object': 'корпус 7', 'location': 'Ось 3/Б, отм. +6.000',
                'workType': NS, 'description': N1, 'requirement': NS,
                'responsible': 'ООО «Альфа, Бета и К»', 'deadline': '30.10.2026', 'status': NS}
    for key, value in expected.items():
        # «Не указано» — подсказка в пустом поле, значение поля пустое.
        expect(draft_field(page, 0, key)).to_have_value('' if value == NS else value)
        expect(draft_field(page, 0, key)).to_have_attribute('placeholder', NS)
    expect(draft(page, 0).locator('.source-text')).to_have_text(N1)
    expect(draft_field(page, 1, 'location')).to_have_value('Пом. 2.15')
    # Диалог: заметка и демо-ответ о черновиках.
    page.click('.tab[data-target="dialog"]')
    expect(page.locator('.msg-user .msg-text').last).to_have_text(f'{N1}\n\n{N2}')
    expect(page.locator('.msg-assistant').last).to_contain_text('Создано 2 черновика')
    expect(page.locator('.msg-assistant .badge').last).to_have_text('Демо')
    # Черновики сохраняются при переходе между вкладками.
    page.click('.tab[data-target="registry"]')
    expect(page.locator('.draft')).to_have_count(2)
    shot(page, '10-drafts')


@case
def confirm_reject_and_edit_draft(page, srv, ctx):
    parse_notes(page, f'{N1}\n\n{N2}')
    draft_field(page, 0, 'status').fill('открыто')
    draft_field(page, 0, 'workType').fill('   ')  # пустое → «Не указано»
    draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('#toast')).to_have_text('Запись № 1 добавлена в реестр')
    expect(page.locator('.draft')).to_have_count(1)
    draft(page, 0).get_by_role('button', name='Отклонить').click()
    expect(page.locator('.draft')).to_have_count(0)
    expect(page.locator('#drafts')).to_be_hidden()
    expect(page.locator('#records-count')).to_have_text('Записей: 1')
    row = page.locator('.record-row').first
    expect(row.locator('td[data-field="number"]')).to_have_text('1')
    expect(row.locator('td[data-field="status"]')).to_have_text('открыто')
    expect(row.locator('td[data-field="workType"]')).to_have_text(NS)
    expect(row.locator('td[data-field="sourceText"]')).to_have_text(N1)
    expect(page.locator('#export')).to_be_enabled()
    # Запись сохраняется после перезагрузки; неподтверждённых черновиков нет.
    page.reload()
    ready(page)
    expect(page.locator('.record-row')).to_have_count(1)
    shot(page, '11-registry')


@case
def drafts_are_lost_on_reload_but_note_stays(page, srv, ctx):
    parse_notes(page, N2)
    expect(page.locator('.draft')).to_have_count(1)
    page.reload()
    ready(page)
    expect(page.locator('.draft')).to_have_count(0)
    expect(page.locator('#records-count')).to_have_text('Записей: 0')
    page.click('.tab[data-target="dialog"]')
    expect(page.locator('.msg-user .msg-text').last).to_have_text(N2)


@case
def field_too_long_shows_error_and_keeps_draft(page, srv, ctx):
    parse_notes(page, N2)
    page.evaluate("document.querySelector('.draft textarea[data-field=description]').value = 'я'.repeat(4001)")
    draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(draft(page, 0).locator('.form-error')).to_have_text('Исправьте поля записи.')
    expect(draft(page, 0).locator('[data-field="description"] .field-error')).to_contain_text('слишком длинное')
    expect(page.locator('.draft')).to_have_count(1)
    expect(page.locator('#records-count')).to_have_text('Записей: 0')


@case
def html_in_note_is_text(page, srv, ctx):
    payload = '<img src=x onerror="window.__xss=1"> Объект: <b>корпус</b>'
    parse_notes(page, payload)
    expect(draft(page, 0).locator('.source-text')).to_have_text(payload)
    draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('.record-row')).to_have_count(1)
    assert page.locator('#screen-registry img').count() == 0
    assert page.evaluate('window.__xss') is None


@case
def edit_keeps_number_and_source_delete_keeps_numbers(page, srv, ctx):
    parse_notes(page, f'{N1}\n\n{N2}\n\n{N3}')
    for _ in range(3):
        draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
        page.wait_for_timeout(50)
    expect(page.locator('.record-row')).to_have_count(3)
    # Редактирование записи № 2: номер и исходный текст не меняются.
    page.locator('.record-row[data-number="2"]').click()
    expect(page.locator('#record-dialog')).to_be_visible()
    expect(page.locator('#record-title')).to_have_text('Запись № 2')
    expect(page.locator('#record-fields .source-text')).to_have_text(N2)
    assert page.locator('#record-fields [data-field="number"]').count() == 0
    assert page.locator('#record-fields [data-field="sourceText"]').count() == 0
    # Окно открывается без фокуса в поле ввода (не выскакивает клавиатура).
    assert page.evaluate("document.activeElement.id") == 'record-title'
    expect(page.locator('#edit-workType')).to_have_value('')
    page.fill('#edit-description', 'трещина заделана')
    page.fill('#edit-status', 'устранено')
    shot(page, '12-edit-record')
    page.click('#record-save')
    expect(page.locator('#record-dialog')).to_be_hidden()
    row2 = page.locator('.record-row[data-number="2"]')
    expect(row2.locator('td[data-field="description"]')).to_have_text('трещина заделана')
    expect(row2.locator('td[data-field="status"]')).to_have_text('устранено')
    expect(row2.locator('td[data-field="sourceText"]')).to_have_text(N2)
    # Удаление: сначала отмена, затем подтверждение. Номера 1 и 3 остаются.
    row2.click()
    page.click('#record-delete')
    expect(page.locator('#confirm-record-title')).to_have_text('Удалить запись № 2?')
    page.click('#confirm-record-delete button[value="cancel"]')
    expect(page.locator('#record-dialog')).to_be_visible()
    page.click('#record-delete')
    page.click('#confirm-record-delete button[value="delete"]')
    expect(page.locator('#toast')).to_have_text('Запись № 2 удалена')
    numbers = page.locator('.record-row td[data-field="number"]').all_text_contents()
    assert numbers == ['1', '3'], numbers
    # Новая запись получает номер 4, а не 2 или 3.
    parse_notes(page, 'ось 9 — скол')
    draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('#toast')).to_have_text('Запись № 4 добавлена в реестр')
    numbers = page.locator('.record-row td[data-field="number"]').all_text_contents()
    assert numbers == ['1', '3', '4'], numbers


def libreoffice_import(csv_path, text_columns):
    """Импортирует CSV в LibreOffice и возвращает строки листа.
    text_columns=True — все столбцы как текст (точное значение);
    False — обычный импорт с автоопределением чисел и дат."""
    out = Path(tempfile.mkdtemp(prefix='lo-'))
    fmt = '/'.join(f'{i}/2' for i in range(1, 12)) if text_columns else ''
    # Параметры фильтра CSV: разделитель «;» (59), кавычка (34), UTF-8 (76),
    # с первой строки, форматы столбцов, язык русский (1049),
    # значения в кавычках как текст, распознавание особых чисел.
    opts = f'59,34,76,1,{fmt},1049,{"true" if text_columns else "false"},{"false" if text_columns else "true"}'
    env = {**os.environ, 'HOME': str(out)}
    subprocess.run(['soffice', '--headless', f'-env:UserInstallation=file://{out}/profile',
                    f'--infilter=CSV:{opts}', '--convert-to', 'xlsx', '--outdir', str(out), str(csv_path)],
                   check=True, capture_output=True, timeout=180, env=env)
    xlsx = out / (csv_path.stem + '.xlsx')
    ws = openpyxl.load_workbook(xlsx).active
    rows = [[c for c in row] for row in ws.iter_rows(values_only=True)]
    shutil.copy(xlsx, OUT / f'{csv_path.stem}-{"text" if text_columns else "auto"}.xlsx')
    return rows


@case
def export_csv_and_check_every_cell_in_libreoffice(page, srv, ctx):
    parse_notes(page, f'{N1}\n\n{N2}\n\n{N3}')
    # Третья заметка: вручную задаём отметку и «формулу» — проверка защиты.
    draft_field(page, 2, 'location').fill('-0,300')
    draft_field(page, 2, 'workType').fill('=СУММ(A1)')
    draft_field(page, 2, 'status').fill('открыто')
    for _ in range(3):
        draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
        page.wait_for_timeout(50)
    expect(page.locator('.record-row')).to_have_count(3)
    page.locator('.record-row[data-number="2"]').click()
    page.click('#record-delete')
    page.click('#confirm-record-delete button[value="delete"]')
    expect(page.locator('.record-row')).to_have_count(2)

    page.click('#export')
    expect(page.locator('#export-summary')).to_contain_text('Будет выгружено записей: 2, столбцов: 11.')
    shot(page, '13-export-confirm')
    page.click('#confirm-export button[value="cancel"]')  # отмена ничего не скачивает
    page.click('#export')
    with page.expect_download() as info:
        page.click('#confirm-export button[value="export"]')
    download = info.value
    assert download.suggested_filename.startswith('jarvis-reestr-') and download.suggested_filename.endswith('.csv')
    csv_path = OUT / download.suggested_filename
    download.save_as(csv_path)
    expect(page.locator('#toast')).to_contain_text('сохранён')

    raw = csv_path.read_bytes()
    assert raw.startswith(b'\xef\xbb\xbf'), 'нет BOM UTF-8'
    text = raw.decode('utf-8-sig')
    assert text.endswith('\r\n')

    expected = [
        TITLES,
        ['1', '23.10.2026', 'корпус 7', 'Ось 3/Б, отм. +6.000', NS, N1, NS,
         'ООО «Альфа, Бета и К»', '30.10.2026', NS, N1],
        ['3', NS, NS, '-0,300', "'=СУММ(A1)", N3, NS, NS, NS, 'открыто', N3],
    ]

    # 1. Импорт всех столбцов как текста: каждая ячейка должна совпасть точно.
    rows = libreoffice_import(csv_path, text_columns=True)
    rows = [r for r in rows if any(c not in (None, '') for c in r)]
    assert len(rows) == 3, f'строк {len(rows)}'
    for r_i, (got, exp) in enumerate(zip(rows, expected)):
        assert len(got) == 11, f'строка {r_i}: столбцов {len(got)}'
        for c_i, (g, e) in enumerate(zip(got, exp)):
            assert (g if g is not None else '') == e, f'строка {r_i}, столбец {c_i + 1} ({TITLES[c_i]}): {g!r} != {e!r}'

    # 2. Обычный импорт с автоопределением: текстовые ячейки (кириллица,
    # кавычки, переносы) совпадают; числа и даты LibreOffice может преобразовать —
    # это фиксируется в отчёте как известное ограничение CSV.
    rows = libreoffice_import(csv_path, text_columns=False)
    rows = [r for r in rows if any(c not in (None, '') for c in r)]
    assert len(rows) == 3 and all(len(r) == 11 for r in rows)
    assert rows[0] == TITLES
    for r_i in (1, 2):
        for c_i in (2, 5, 7, 10):  # объект, описание, организация, исходный текст
            assert rows[r_i][c_i] == expected[r_i][c_i], (r_i, c_i, rows[r_i][c_i])
    assert rows[2][4] == "'=СУММ(A1)", f'формула не должна вычисляться: {rows[2][4]!r}'
    conversions = {TITLES[c]: repr(rows[r][c]) for r in (1, 2) for c in range(11)
                   if not isinstance(rows[r][c], str) or rows[r][c] != expected[r][c]}
    (OUT / 'libreoffice-auto-import.txt').write_text(
        'Что LibreOffice преобразовал при обычном импорте (без выбора формата «Текст»):\n' +
        '\n'.join(f'{k}: {v}' for k, v in conversions.items()), encoding='utf-8')


@case
def status_and_settings_reflect_stage2(page, srv, ctx):
    parse_notes(page, N2)
    draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    page.click('.tab[data-target="settings"]')
    expect(page.locator('#count-records')).to_have_text('1')
    expect(page.locator('#app-version')).to_have_text(APP_VERSION)
    expect(page.locator('#app-platform')).to_have_text('Веб-приложение')
    expect(page.locator('#app-stage')).to_have_text('Этап 2 из 5')
    page.click('#delete-history')
    page.click('#confirm-delete button[value="delete"]')
    expect(page.locator('#count-records')).to_have_text('0')
    page.click('.tab[data-target="status"]')
    expect(page.locator('[data-feature="registry"] .state')).to_have_text('По правилам')
    expect(page.locator('[data-feature="dialog"] .state')).to_have_text('Демо')
    expect(page.locator('[data-feature="ai"] .state')).to_have_text('Этап 4')


@case
def no_horizontal_scroll_with_drafts_and_records(page, srv, ctx):
    page.set_viewport_size({'width': 360, 'height': 740})
    parse_notes(page, f'{N1}\n\n{N2}')
    draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    overflow = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    assert overflow <= 0, f'горизонтальная прокрутка {overflow}px'
    page.locator('.record-row').first.click()
    box = page.locator('#record-dialog').bounding_box()
    assert box['x'] >= 0 and box['x'] + box['width'] <= 360, box
    shot(page, '14-edit-360px')


@case
def light_theme_screenshots(page, srv, ctx):
    page.emulate_media(color_scheme='light')
    parse_notes(page, f'{N1}\n\n{N2}')
    shot(page, '15-drafts-light')
    draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    page.evaluate("document.getElementById('main').scrollTop = 1e6")
    shot(page, '16-registry-light')


# ---------- Обновление с версии 0.1.0 ----------
def upgrade_from_stage1(browser, device):
    old = Path(tempfile.mkdtemp(prefix='jarvis-v010-'))
    archive = old / 'v010.tar'
    subprocess.run(['git', '-C', str(ROOT), 'archive', '-o', str(archive), 'v0.1.0-stage1'], check=True)
    subprocess.run(['tar', '-xf', str(archive), '-C', str(old)], check=True)
    srv = Server(old)
    ctx = browser.new_context(**device, locale='ru-RU')
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        # Версия 0.1.0: офлайн-кеш установлен, есть история.
        page.goto(srv.url)
        ready(page)
        page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=15000)
        for text in ['старое сообщение 1', 'старое сообщение 2']:
            page.fill('#input', text)
            page.click('#send')
        expect(page.locator('.msg')).to_have_count(4)
        assert page.locator('#parse').count() == 0, 'это должна быть версия 0.1.0'

        # Публикуем текущую версию на тот же адрес и открываем приложение.
        srv.root = ROOT
        page.reload()
        # Первая загрузка может пройти со старыми файлами из кеша 0.1.0; новая
        # версия кеша берёт управление и один раз перезагружает страницу.
        page.wait_for_selector(f'html[data-ready="true"][data-version="{APP_VERSION}"]', timeout=30000)
        expect(page.locator('.msg-user .msg-text')).to_have_text(['старое сообщение 1', 'старое сообщение 2'])
        info = page.evaluate('''async () => {
            const db = await new Promise(r => { const q = indexedDB.open('jarvis-mobile'); q.onsuccess = () => r(q.result); });
            const v = { version: db.version, stores: [...db.objectStoreNames] };
            db.close();
            v.caches = await caches.keys();
            v.appVersion = (await import('./js/core/config.js')).APP_VERSION;
            return v; }''')
        assert info['version'] == 1, info
        assert info['stores'] == ['messages', 'meta', 'records'], info
        assert info['appVersion'] == APP_VERSION, info
        page.wait_for_function(f"caches.keys().then(k => k.length === 1 && k[0] === 'jarvis-shell-{APP_VERSION}')", timeout=15000)

        # Реестр работает поверх старой базы.
        parse_notes(page, 'Ось 1/А — скол')
        draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
        expect(page.locator('#toast')).to_have_text('Запись № 1 добавлена в реестр')

        # После обновления приложение открывается без интернета.
        ctx.set_offline(True)
        page.reload()
        page.wait_for_selector(f'html[data-ready="true"][data-version="{APP_VERSION}"]')
        expect(page.locator('#screen-registry')).to_be_visible()
        expect(page.locator('.record-row')).to_have_count(1)
        ctx.set_offline(False)
        assert not errors, errors
    finally:
        ctx.close()
        srv.httpd.shutdown()


# ---------- Запуск ----------
def main():
    srv = Server(ROOT)
    failures = 0
    total = len(TESTS) + 1
    with sync_playwright() as p:
        browser = p.chromium.launch()
        device = p.devices['Pixel 7']
        for fn in TESTS:
            ctx = browser.new_context(**device, locale='ru-RU', color_scheme='dark', accept_downloads=True)
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            try:
                page.goto(srv.url)
                ready(page)
                fn(page, srv, ctx)
                assert not errors, f'ошибки в консоли: {errors}'
                print(f'ok   {fn.__name__}')
            except Exception:
                failures += 1
                print(f'FAIL {fn.__name__}')
                traceback.print_exc()
            finally:
                ctx.close()
        try:
            upgrade_from_stage1(browser, device)
            print('ok   upgrade_from_stage1')
        except Exception:
            failures += 1
            print('FAIL upgrade_from_stage1')
            traceback.print_exc()
        browser.close()
    srv.httpd.shutdown()
    print(f'\n{total - failures} из {total} тестов пройдено. Файлы: {OUT}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
