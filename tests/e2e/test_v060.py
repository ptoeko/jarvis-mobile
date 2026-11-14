"""Сквозные тесты версии 0.6.0 (с имитацией посредника), в браузере и в условиях APK.

Запуск: python3 tests/e2e/test_v060.py [папка]

Проверяется: кнопка «Переписка» (только на экране «Диалог»); новый диалог —
переписка в архиве, просмотр архива, удаление из архива; удаление переписки
без потери реестра; агенту уходит текст документов Word и Excel (из учебных
образцов), в том числе из предыдущих сообщений; старый .doc — объяснение;
ответ агента с документом Word и изображением — файлы настоящие; ссылки в
ответе нажимаются. Все данные вымышленные.
"""
import base64
import io
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stage2 as base  # noqa: E402
import test_v040 as v040  # noqa: E402
import test_v050 as v050  # noqa: E402
import test_apk_mode as apk  # noqa: E402
import docx  # noqa: E402
from playwright.sync_api import sync_playwright, expect  # noqa: E402

FIX = base.ROOT / 'tests' / 'fixtures'
PNG_1PX = base64.b64encode(v040.PNG).decode()

TESTS = []


def case(fn):
    TESTS.append(fn)
    return fn


def send(page, text):
    page.fill('#input', text)
    page.click('#send')


def menu(page, value):
    page.click('#dialog-menu-btn')
    expect(page.locator('#dialog-menu')).to_be_visible()
    page.click(f'#dialog-menu button[value="{value}"]')


@case
def menu_button_only_on_dialog(page, ctx, agent):
    expect(page.locator('#dialog-menu-btn')).to_be_visible()
    page.click('.tab[data-target="registry"]')
    expect(page.locator('#dialog-menu-btn')).to_be_hidden()
    v040.to_dialog(page)
    expect(page.locator('#dialog-menu-btn')).to_be_visible()
    menu(page, 'archive')
    expect(page.locator('#toast')).to_have_text('Переписка пуста — архивировать нечего.')


@case
def archive_view_and_delete(page, ctx, agent):
    v050.connected(page)
    v040.to_dialog(page)
    send(page, 'Первый диалог: сводка по зданию 10UJA')
    expect(page.locator('.msg-assistant')).to_have_count(1)
    menu(page, 'archive')
    expect(page.locator('#toast')).to_contain_text('Переписка сохранена в архив: 2 сообщения')
    expect(page.locator('.msg')).to_have_count(0)
    send(page, 'Второй диалог')
    expect(page.locator('.msg-assistant')).to_have_count(1)
    # Агент видит только текущую переписку.
    req = [r for r in agent.requests if r['path'] == '/v1/chat'][-1]['body']['messages']
    assert [m['text'] for m in req] == ['Второй диалог'], req
    page.click('#dialog-menu-btn')
    expect(page.locator('#dialog-menu-list')).to_have_text('Архив переписок (1)')
    page.click('#dialog-menu button[value="list"]')
    expect(page.locator('#archive-items .archive-item')).to_have_count(1)
    expect(page.locator('.archive-item-title')).to_have_text('Первый диалог: сводка по зданию 10UJA')
    base.shot(page, 'v060-01-archive-list')
    page.click('.archive-item')
    expect(page.locator('#archive-view')).to_be_visible()
    expect(page.locator('#archive-messages .msg')).to_have_count(2)
    base.shot(page, 'v060-02-archive-view')
    page.click('#archive-delete')
    page.click('#confirm-dialog-delete button[value="delete"]')
    expect(page.locator('#toast')).to_have_text('Переписка удалена из архива')
    expect(page.locator('#archive-view')).to_be_hidden()
    expect(page.locator('#archive-empty')).to_be_visible()
    page.click('#archive-list button[value="close"]')
    expect(page.locator('.msg-user .msg-text')).to_have_text(['Второй диалог'])


@case
def delete_dialog_keeps_registry(page, ctx, agent):
    v040.to_dialog(page)
    page.fill('#input', 'Ось 1/А — скол')
    page.click('#parse')
    page.locator('.draft').first.get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('.record-row')).to_have_count(1)
    v040.to_dialog(page)
    send(page, 'помощь')
    menu(page, 'delete')
    expect(page.locator('#confirm-dialog-delete-text')).to_contain_text('Будут удалены 4 сообщения')
    page.click('#confirm-dialog-delete button[value="cancel"]')
    expect(page.locator('.msg')).to_have_count(4)
    menu(page, 'delete')
    page.click('#confirm-dialog-delete button[value="delete"]')
    expect(page.locator('#toast')).to_have_text('Переписка удалена')
    expect(page.locator('.msg')).to_have_count(0)
    expect(page.locator('#messages-empty')).to_be_visible()
    page.click('.tab[data-target="registry"]')
    expect(page.locator('.record-row')).to_have_count(1)


@case
def word_and_excel_text_reach_agent(page, ctx, agent):
    v050.connected(page)
    v040.to_dialog(page)
    page.set_input_files('#attach-input', [str(FIX / 'report-sample.docx')])
    send(page, 'Отчёт за первую неделю')
    expect(page.locator('.msg-assistant')).to_have_count(1)
    page.set_input_files('#attach-input', [
        {'name': 'smr-sample.xlsx', 'mimeType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'buffer': (FIX / 'smr-sample.xlsx').read_bytes()},
        {'name': 'старый.doc', 'mimeType': 'application/msword', 'buffer': b'\xd0\xcf\x11\xe0 old word'},
    ])
    send(page, 'Объедини оба отчёта в один документ Word')
    expect(page.locator('.msg-assistant')).to_have_count(2)
    msgs = [r for r in agent.requests if r['path'] == '/v1/chat'][-1]['body']['messages']
    first = msgs[0]['files'][0]
    assert first['name'] == 'report-sample.docx' and '# Отчёт о СМР за неделю' in first['text'], first
    assert 'Бетон, м³ | 120 | 118' in first['text']
    xlsx, old = msgs[-1]['files']
    assert '1 | Здание 10UJA | Бетонирование / плиты | 23.10.2026 | 12,5' in xlsx['text'], xlsx
    assert 'text' not in old and 'Пересохраните' in old['note'], old


@case
def agent_sends_word_image_and_links(page, ctx, agent):
    v050.connected(page)
    agent.chat_reply = {
        'text': 'Сводный отчёт и эскиз во вложении. Источник: https://minstroyrf.gov.ru/docs/123/.',
        'files': [
            {'kind': 'word', 'name': 'Сводный отчёт СМР.docx', 'title': 'Сводный отчёт о СМР', 'orientation': 'landscape', 'blocks': [
                {'type': 'heading', 'text': 'Здание 10UJA', 'level': 1, 'items': [], 'headers': [], 'rows': []},
                {'type': 'paragraph', 'text': 'Бетон 118 м³ из 120 м³ & отставание <2 м³>', 'items': [], 'headers': [], 'rows': []},
                {'type': 'table', 'text': '', 'items': [], 'headers': ['Работа', 'План', 'Факт'], 'rows': [['Бетон, м³', '120', '118']]},
            ]},
            {'kind': 'image', 'name': 'Эскиз узла.png', 'type': 'image/png', 'data': PNG_1PX},
        ],
    }
    v040.to_dialog(page)
    send(page, 'Сделай сводный отчёт и эскиз')
    last = page.locator('.msg-assistant').last
    expect(last.locator('.file-name')).to_have_text(['Сводный отчёт СМР.docx', 'Эскиз узла.png'])
    link = last.locator('.msg-text a')
    expect(link).to_have_text('https://minstroyrf.gov.ru/docs/123/')
    expect(link).to_have_attribute('target', '_blank')
    base.shot(page, 'v060-03-agent-word-image')
    data = page.evaluate('''async () => {
        const db = await new Promise(r => { const q = indexedDB.open('jarvis-mobile'); q.onsuccess = () => r(q.result); });
        const items = await new Promise(r => { const q = db.transaction('attachments').objectStore('attachments').getAll(); q.onsuccess = () => r(q.result); });
        db.close();
        const out = {};
        for (const it of items) out[it.name] = [...new Uint8Array(await it.blob.arrayBuffer())];
        return out; }''')
    d = docx.Document(io.BytesIO(bytes(data['Сводный отчёт СМР.docx'])))
    assert [p.text for p in d.paragraphs if p.text][:3] == ['Сводный отчёт о СМР', 'Здание 10UJA', 'Бетон 118 м³ из 120 м³ & отставание <2 м³>']
    assert [[c.text for c in r.cells] for r in d.tables[0].rows] == [['Работа', 'План', 'Факт'], ['Бетон, м³', '120', '118']]
    assert bytes(data['Эскиз узла.png']) == v040.PNG
    v050.no_vendor_names(page)


def run(browser, device, mode):
    failures = 0
    srv = base.Server(base.ROOT)
    for fn in TESTS:
        agent = v050.Agent()
        ctx = browser.new_context(**device, locale='ru-RU', accept_downloads=True)
        if mode == 'apk':
            ctx.route('**/*', apk.handle)
            ctx.add_init_script(v040.APK_BRIDGE)
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
