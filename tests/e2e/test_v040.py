"""Сквозные тесты версии 0.4.0 в Chromium на экране Android-телефона (Pixel 7).

Запуск: python3 tests/e2e/test_v040.py [папка]

Веб-вариант: вложения (фото, PDF, Word, Excel), сообщение только из файлов,
файлы заметки в черновике и записи, открытие файла, копирование текста,
резервная копия → удаление → восстановление (файлы совпадают байт в байт),
некорректный файл копии, экран 360 px, обновление с 0.3.1 (версия на телефоне
владельца) без потери данных.
Вариант APK (имитация моста Android): передача файла частями, сохранение
копии через окно «Сохранить», открытие файла, копирование через буфер Android.
Все данные — вымышленные.
"""
import base64
import hashlib
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stage2 as base  # noqa: E402
import test_apk_mode as apk  # noqa: E402
from playwright.sync_api import sync_playwright, expect  # noqa: E402

OUT = base.OUT
NS = base.NS
FIX = OUT / 'fixtures'
FIX.mkdir(parents=True, exist_ok=True)

# Настоящий PNG 2×2 — чтобы миниатюра действительно отрисовывалась.
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDgRWlsgAAAABJRU5ErkJggg==')
FILES = {
    'фото трещины.png': PNG,
    'акт освидетельствования.pdf': b'%PDF-1.4\n% fictitious test file\n%%EOF\n',
    'ведомость.docx': b'PK\x03\x04 fictitious docx ' + bytes(range(256)),
    'график.xlsx': b'PK\x03\x04 fictitious xlsx ' + bytes(range(255, -1, -1)),
}
for name, data in FILES.items():
    (FIX / name).write_bytes(data)
(FIX / 'вирус.exe').write_bytes(b'MZ fictitious')
(FIX / 'не копия.zip').write_bytes(b'PK\x05\x06' + b'\x00' * 18)
(FIX / 'текст.txt').write_bytes('это не резервная копия'.encode())
fx = lambda name: str(FIX / name)  # noqa: E731

TESTS = []
APK_TESTS = []


def case(fn):
    TESTS.append(fn)
    return fn


def apk_case(fn):
    APK_TESTS.append(fn)
    return fn


def to_dialog(page):
    page.click('.tab[data-target="dialog"]')
    expect(page.locator('#screen-dialog')).to_be_visible()


def attach(page, *names):
    page.set_input_files('#attach-input', [fx(n) for n in names])


def stored_files(page):
    """Все файлы из базы приложения: имя → sha256 содержимого."""
    return page.evaluate('''async () => {
        const db = await new Promise(r => { const q = indexedDB.open('jarvis-mobile'); q.onsuccess = () => r(q.result); });
        const items = await new Promise(r => { const q = db.transaction('attachments').objectStore('attachments').getAll(); q.onsuccess = () => r(q.result); });
        db.close();
        const out = {};
        for (const it of items) {
            const buf = await crypto.subtle.digest('SHA-256', await it.blob.arrayBuffer());
            out[it.name] = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
        }
        return out; }''')


def sha(data):
    return hashlib.sha256(data).hexdigest()


# ---------- Веб-вариант ----------
@case
def attach_files_and_send(page, ctx):
    to_dialog(page)
    attach(page, *FILES)
    expect(page.locator('#pending-files .pending-file')).to_have_count(4)
    page.fill('#input', 'Фото и документы по оси 3')
    page.click('#send')
    msg = page.locator('.msg-user').last
    expect(msg.locator('.file-chip')).to_have_count(4)
    expect(page.locator('#pending-files')).to_be_hidden()
    expect(msg.locator('img.thumb')).to_have_count(1)  # миниатюра фото
    page.wait_for_function("[...document.querySelectorAll('img.thumb')].every(i => i.complete && i.naturalWidth === 2)")
    base.shot(page, 'v040-01-message-with-files')
    # После перезапуска файлы на месте и совпадают байт в байт.
    page.reload()
    base.ready(page)
    expect(page.locator('.msg-user').last.locator('.file-chip')).to_have_count(4)
    assert stored_files(page) == {n: sha(d) for n, d in FILES.items()}


@case
def remove_file_before_sending(page, ctx):
    to_dialog(page)
    attach(page, 'фото трещины.png', 'акт освидетельствования.pdf')
    page.get_by_role('button', name='Убрать файл фото трещины.png').click()
    expect(page.locator('#pending-files .pending-file')).to_have_count(1)
    page.click('#send')  # без текста: сообщение только из файла
    msg = page.locator('.msg-user').last
    expect(msg.locator('.file-chip')).to_have_count(1)
    expect(msg.locator('.msg-text')).to_have_count(0)
    expect(page.locator('.msg-assistant').last).to_contain_text('Файлов сохранено: 1')


@case
def unsupported_file_is_rejected(page, ctx):
    to_dialog(page)
    attach(page, 'вирус.exe')
    expect(page.locator('#composer-error')).to_contain_text('не поддерживается')
    expect(page.locator('#pending-files')).to_be_hidden()
    page.click('#send')
    expect(page.locator('#composer-error')).to_have_text('Введите текст сообщения.')
    expect(page.locator('.msg')).to_have_count(0)


@case
def note_files_go_to_draft_and_record(page, ctx):
    to_dialog(page)
    attach(page, 'фото трещины.png')
    page.fill('#input', 'Ось 3/Б — трещина в стене')
    page.click('#parse')
    expect(page.locator('#screen-registry')).to_be_visible()
    d = base.draft(page, 0)
    expect(d.locator('.file-chip')).to_have_count(1)
    expect(base.draft_field(page, 0, 'status')).to_have_value('')
    d.get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('.record-row')).to_have_count(1)
    page.locator('.record-row').first.click()
    expect(page.locator('#record-dialog .file-chip')).to_have_count(1)
    expect(page.locator('#record-dialog .file-name')).to_have_text('фото трещины.png')
    base.shot(page, 'v040-02-record-with-photo')


@case
def parse_requires_text(page, ctx):
    to_dialog(page)
    attach(page, 'акт освидетельствования.pdf')
    page.click('#parse')
    expect(page.locator('#composer-error')).to_contain_text('Напишите текст заметки')
    expect(page.locator('#pending-files .pending-file')).to_have_count(1)  # файл не потерян


@case
def open_attachment_in_browser(page, ctx):
    to_dialog(page)
    attach(page, 'акт освидетельствования.pdf')
    page.click('#send')
    with page.expect_popup() as new:
        page.locator('.msg-user .file-chip').first.click()
    new.value.close()  # PDF открылся во вкладке (просмотрщик Chrome)
    assert not page.evaluate("[...document.querySelectorAll('a[download]')].length"), 'лишнее скачивание'


@case
def copy_message_text(page, ctx):
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'])
    to_dialog(page)
    text = 'Ось 3/Б, отм. +6.000 — раковины\nвторая строка'
    page.fill('#input', text)
    page.click('#send')
    page.locator('.msg-user').last.get_by_role('button', name='Копировать текст сообщения').click()
    expect(page.locator('#toast')).to_have_text('Текст скопирован')
    assert page.evaluate('navigator.clipboard.readText()') == text
    # Ответ ассистента тоже копируется.
    page.locator('.msg-assistant').last.get_by_role('button', name='Копировать текст сообщения').click()
    assert 'ИИ не подключён' in page.evaluate('navigator.clipboard.readText()')


def make_data(page):
    to_dialog(page)
    attach(page, *FILES)
    page.fill('#input', f'{base.N1}\n\n{base.N2}')
    page.click('#parse')
    base.draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('.draft')).to_have_count(1)  # второй — черновик
    expect(page.locator('.record-row')).to_have_count(1)


@case
def backup_then_restore_on_clean_phone(page, ctx):
    make_data(page)
    page.click('.tab[data-target="settings"]')
    expect(page.locator('#count-attachments')).to_contain_text('4')
    with page.expect_download() as dl:
        page.click('#backup-save')
    path = OUT / 'backup.zip'
    dl.value.save_as(path)
    assert dl.value.suggested_filename.startswith('jarvis-backup-') and dl.value.suggested_filename.endswith('.zip')
    expect(page.locator('#last-backup')).not_to_have_text('Не создавалась')
    before = stored_files(page)

    # «Новый телефон»: всё удалено.
    page.click('#delete-history')
    page.click('#confirm-delete button[value="delete"]')
    expect(page.locator('#toast')).to_have_text('История удалена')
    assert stored_files(page) == {}

    page.set_input_files('#restore-input', str(path))
    expect(page.locator('#confirm-restore')).to_be_visible()
    expect(page.locator('#restore-summary')).to_contain_text('записей реестра 1, черновиков 1, файлов 4')
    base.shot(page, 'v040-03-restore-confirm')
    page.click('#confirm-restore button[value="restore"]')
    expect(page.locator('#toast')).to_contain_text('Данные восстановлены')
    assert stored_files(page) == before
    page.click('.tab[data-target="registry"]')
    expect(page.locator('.record-row')).to_have_count(1)
    expect(page.locator('.draft')).to_have_count(1)
    expect(page.locator('.record-row td[data-field="sourceText"]')).to_have_text(base.N1)
    # Нумерация продолжается.
    base.draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
    expect(page.locator('#toast')).to_have_text('Запись № 2 добавлена в реестр')
    # После перезапуска всё на месте.
    page.reload()
    base.ready(page)
    page.click('.tab[data-target="registry"]')
    expect(page.locator('.record-row')).to_have_count(2)


@case
def restore_cancel_keeps_data(page, ctx):
    make_data(page)
    page.click('.tab[data-target="settings"]')
    with page.expect_download() as dl:
        page.click('#backup-save')
    path = OUT / 'backup-cancel.zip'
    dl.value.save_as(path)
    to_dialog(page)
    page.fill('#input', 'новое после копии')
    page.click('#send')
    page.click('.tab[data-target="settings"]')
    page.set_input_files('#restore-input', str(path))
    page.click('#confirm-restore button[value="cancel"]')
    to_dialog(page)
    expect(page.locator('.msg-user .msg-text').last).to_have_text('новое после копии')


@case
def bad_backup_files_are_rejected(page, ctx):
    to_dialog(page)
    page.fill('#input', 'моё сообщение')
    page.click('#send')
    page.click('.tab[data-target="settings"]')
    for name, expected in [('текст.txt', 'не является'), ('не копия.zip', 'нет manifest.json')]:
        page.set_input_files('#restore-input', fx(name))
        expect(page.locator('#notice')).to_be_visible()
        expect(page.locator('#notice-text')).to_contain_text(expected)
        expect(page.locator('#notice-text')).to_contain_text('Данные на телефоне не изменены')
        page.click('#notice button[value="ok"]')
    to_dialog(page)
    expect(page.locator('.msg-user .msg-text')).to_have_text(['моё сообщение'])


@case
def phone_screen_360px(page, ctx):
    page.set_viewport_size({'width': 360, 'height': 740})
    to_dialog(page)
    attach(page, *FILES)
    page.fill('#input', 'длинное имя файла и несколько вложений')
    page.click('#send')
    expect(page.locator('.msg-user .file-chip')).to_have_count(4)
    for name in ['dialog', 'registry', 'settings', 'status']:
        page.click(f'.tab[data-target="{name}"]')
        overflow = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        assert overflow <= 0, f'{name}: горизонтальная прокрутка {overflow}px'
    to_dialog(page)
    small = page.evaluate("""[...document.querySelectorAll('#attach, .copy-btn, .file-chip')]
        .map(b => [b.id || b.className, b.getBoundingClientRect()]).filter(([, r]) => r.height < 32 || r.width < 44)
        .map(([n, r]) => `${n} ${Math.round(r.width)}x${Math.round(r.height)}`)""")
    assert not small, f'мелкие кнопки: {small}'
    base.shot(page, 'v040-04-dialog-360px')
    page.click('.tab[data-target="settings"]')
    expect(page.locator('#storage-kind')).to_have_text('В браузере телефона')
    base.shot(page, 'v040-05-settings-360px')
    page.click('.tab[data-target="status"]')
    for f in ['attachments', 'copy', 'backup']:
        expect(page.locator(f'[data-feature="{f}"] .state')).to_have_text('Работает')


def upgrade_from_031(browser, device):
    """Версия 0.3.1 — та, что сейчас установлена у владельца."""
    base.OLD_VERSIONS['0.3.1'] = '9560bc99e492dea53bfe2b9fbb463135c0008c49'
    old = base.checkout_old('0.3.1')
    srv = base.Server(old)
    ctx = browser.new_context(**device, locale='ru-RU')
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(srv.url)
        page.wait_for_selector('html[data-ready="true"][data-version="0.3.1"]')
        page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=15000)
        base.parse_notes(page, f'{base.N1}\n\n{base.N2}')
        base.draft(page, 0).get_by_role('button', name='Добавить в реестр').click()
        expect(page.locator('.draft')).to_have_count(1)

        srv.root = base.ROOT
        page.reload()
        page.wait_for_selector(f'html[data-ready="true"][data-version="{base.APP_VERSION}"]', timeout=30000)
        page.click('.tab[data-target="registry"]')
        expect(page.locator('.record-row')).to_have_count(1)
        expect(page.locator('.draft')).to_have_count(1)  # черновик 0.3.1 сохранился
        info = page.evaluate('''async () => {
            const db = await new Promise(r => { const q = indexedDB.open('jarvis-mobile'); q.onsuccess = () => r(q.result); });
            const v = { version: db.version, stores: [...db.objectStoreNames] }; db.close(); return v; }''')
        assert info == {'version': 2, 'stores': ['attachments', 'messages', 'meta', 'records']}, info
        # Новое работает поверх старых данных.
        to_dialog(page)
        attach(page, 'фото трещины.png')
        page.fill('#input', 'Ось 9 — после обновления')
        page.click('#parse')
        expect(page.locator('.draft')).to_have_count(2)
        base.draft(page, 1).get_by_role('button', name='Добавить в реестр').click()
        expect(page.locator('#toast')).to_have_text('Запись № 2 добавлена в реестр')
        assert not errors, errors
    finally:
        ctx.close()
        srv.httpd.shutdown()


# ---------- Вариант APK (имитация моста Android) ----------
APK_BRIDGE = apk.BRIDGE.replace('window.JarvisAndroid = {', """window.__chunks = {};
window.__opened = [];
window.__copied = [];
window.JarvisAndroid = {
  writeChunk(token, b64, first) {
    if (first || !window.__chunks[token]) window.__chunks[token] = '';
    window.__chunks[token] += atob(b64);
    return true;
  },
  saveChunked(token, name, mime, id) {
    window.__saved.push({ name, mime, size: (window.__chunks[token] || '').length, token, id });
    const st = window.__nextSaveStatus;
    setTimeout(() => window.__jarvisSaveResult(id, st, st === 'saved' ? 'Файл сохранён.' : 'Сохранение отменено.'), 50);
  },
  openChunked(token, name, mime) {
    window.__opened.push({ name, mime, data: window.__chunks[token] });
    return 'ok';
  },
  copyText(text) { window.__copied.push(text); return true; },""")


@apk_case
def apk_backup_goes_through_save_dialog_in_chunks(page, ctx):
    # Фото 1,3 МБ — больше одной части (512 КБ): проверяется склейка.
    big = bytes((i * 7) % 256 for i in range(1300 * 1024))
    (FIX / 'большое фото.jpg').write_bytes(big)
    to_dialog(page)
    page.set_input_files('#attach-input', fx('большое фото.jpg'))
    page.fill('#input', 'Ось 1 — фото')
    page.click('#send')
    expect(page.locator('.msg-user .file-chip')).to_have_count(1)
    page.click('.tab[data-target="settings"]')
    expect(page.locator('#storage-kind')).to_have_text('В памяти приложения')
    page.click('#backup-save')
    expect(page.locator('#toast')).to_contain_text('Копия сохранена')
    saved = page.evaluate('window.__saved')
    assert len(saved) == 1 and saved[0]['mime'] == 'application/zip', saved
    assert saved[0]['name'].startswith('jarvis-backup-')
    assert saved[0]['size'] > len(big), saved[0]['size']
    # Собранный из частей архив читается и восстанавливается.
    ok = page.evaluate('''async (token) => {
        const s = window.__chunks[token];
        const bytes = Uint8Array.from(s, c => c.charCodeAt(0));
        const { inspectBackup } = await import('./js/core/backup.js');
        const r = await inspectBackup(new Blob([bytes]));
        return r.summary.attachments === 1 && r.data.attachments[0].size === %d; }''' % len(big), saved[0]['token'])
    assert ok


@apk_case
def apk_open_and_copy_use_android(page, ctx):
    to_dialog(page)
    page.set_input_files('#attach-input', fx('акт освидетельствования.pdf'))
    page.fill('#input', 'текст для копирования')
    page.click('#send')
    page.locator('.msg-user .file-chip').first.click()
    # Без wait_for_function: политика безопасности APK запрещает eval.
    for _ in range(50):
        if page.evaluate('() => window.__opened.length') == 1:
            break
        page.wait_for_timeout(100)
    opened = page.evaluate('window.__opened[0]')
    assert opened['name'] == 'акт освидетельствования.pdf' and opened['mime'] == 'application/pdf', opened
    assert opened['data'].encode('latin-1') == FILES['акт освидетельствования.pdf']
    page.locator('.msg-user').last.get_by_role('button', name='Копировать текст сообщения').click()
    expect(page.locator('#toast')).to_have_text('Текст скопирован')
    assert page.evaluate('window.__copied') == ['текст для копирования']


def run(cases, browser, device, mode):
    failures = 0
    for fn in cases:
        if mode == 'web':
            ctx = browser.new_context(**device, locale='ru-RU', color_scheme='dark', accept_downloads=True)
        else:
            ctx = browser.new_context(**device, locale='ru-RU')
            ctx.route('**/*', apk.handle)
            ctx.add_init_script(APK_BRIDGE)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        try:
            page.goto(srv_url if mode == 'web' else apk.START)
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
    return failures


def main():
    global srv_url
    srv = base.Server(base.ROOT)
    srv_url = srv.url
    failures = 0
    total = len(TESTS) + len(APK_TESTS) + 1
    with sync_playwright() as p:
        browser = p.chromium.launch()
        device = p.devices['Pixel 7']
        failures += run(TESTS, browser, device, 'web')
        failures += run(APK_TESTS, browser, device, 'apk')
        try:
            upgrade_from_031(browser, device)
            print('ok   upgrade_from_031')
        except Exception:
            failures += 1
            print('FAIL upgrade_from_031')
            traceback.print_exc()
        browser.close()
    srv.httpd.shutdown()
    print(f'\n{total - failures} из {total} тестов пройдено. Файлы: {OUT}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
