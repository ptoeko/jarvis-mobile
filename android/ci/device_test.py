"""Проверка APK на эмуляторе Android (запускается в GitHub Actions).

Режим full (отладочный APK): через протокол отладки WebView (CDP) проходит
сценарий пользователя — заметка → черновики → подтверждение → удаление →
перезапуск приложения → экспорт CSV через системное окно «Сохранить» →
кнопка «Назад». Сохранённый файл забирается с эмулятора и проверяется.

Дополнительно (0.3.1): черновики переживают закрытие приложения системой;
экспорт работает, даже если Android закрыл JARVIS, пока открыто окно «Сохранить»
(режим «Не сохранять действия»).

Режим smoke (подписанный APK для выпуска): установка, запуск, интерфейс
на экране, нет ошибок JavaScript и аварийных завершений.

Режим update (подписанный APK): установка ПОВЕРХ тестовой версии с данными,
как при обновлении на телефоне. Запись реестра должна сохраниться — это
доказывает, что подпись совпадает и обновление не требует удаления.

Запуск: python3 device_test.py full|smoke|update путь/к.apk папка_результатов [--keep]
Все данные — вымышленные.
"""
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websocket  # пакет websocket-client

PKG = 'ru.jarvis.mobile'
ACTIVITY = f'{PKG}/.MainActivity'
MODE, APK, OUT = sys.argv[1], sys.argv[2], Path(sys.argv[3])
KEEP = '--keep' in sys.argv  # не удалять приложение после full (для режима update)
OUT.mkdir(parents=True, exist_ok=True)
step_no = 0


def adb(*args, check=True, text=True):
    r = subprocess.run(['adb', *args], capture_output=True, text=text, timeout=120)
    if check and r.returncode != 0:
        raise RuntimeError(f'adb {" ".join(args)}: {r.stderr or r.stdout}')
    return r.stdout


def shot(name):
    global step_no
    step_no += 1
    data = subprocess.run(['adb', 'exec-out', 'screencap', '-p'], capture_output=True, timeout=60).stdout
    (OUT / f'{step_no:02d}-{name}.png').write_bytes(data)


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def ui_dump():
    adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml', check=False)
    adb('pull', '/sdcard/ui.xml', str(OUT / 'ui.xml'), check=False)
    p = OUT / 'ui.xml'
    return p.read_text(encoding='utf-8', errors='replace') if p.exists() else ''


def wait_ui_text(pattern, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        xml = ui_dump()
        if re.search(pattern, xml):
            return xml
        time.sleep(2)
    raise AssertionError(f'на экране не появилось: {pattern}')


def tap_save_in_picker():
    xml = wait_ui_text(r'(?i)text="(SAVE|Сохранить)"', 40)
    shot('android-save-dialog')
    m = re.search(r'text="(?:SAVE|Save|Сохранить)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
    assert m, 'кнопка «Сохранить» системного окна не найдена'
    x1, y1, x2, y2 = map(int, m.groups())
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))


def tap_text(text, timeout=30):
    attr = r'(?:text|content-desc)="' + re.escape(text) + '"'
    xml = wait_ui_text(attr, timeout)
    m = re.search(attr + r'[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
    assert m, f'на экране нет «{text}»'
    x1, y1, x2, y2 = map(int, m.groups())
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))


def exported_files():
    return sorted(adb('shell', 'find', '/sdcard/', '-name', 'jarvis-reestr-*.csv', check=False).split())


def start_app():
    adb('shell', 'am', 'start', '-W', '-n', ACTIVITY)


def stop_app():
    adb('shell', 'am', 'force-stop', PKG)


def check_logcat():
    text = adb('logcat', '-d')
    (OUT / 'logcat.txt').write_text(text, encoding='utf-8')
    assert 'FATAL EXCEPTION' not in text, 'аварийное завершение приложения (см. logcat.txt)'
    errors = [l for l in text.splitlines() if 'JarvisMobile' in l and 'console ERROR' in l]
    assert not errors, 'ошибки JavaScript:\n' + '\n'.join(errors)


# ---------- Протокол отладки WebView ----------
class Page:
    def __init__(self):
        pid = adb('shell', 'pidof', PKG).strip()
        assert pid, 'приложение не запущено'
        sock = f'webview_devtools_remote_{pid}'
        end = time.time() + 30
        while sock not in adb('shell', 'cat', '/proc/net/unix') and time.time() < end:
            time.sleep(1)
        adb('forward', '--remove-all', check=False)
        adb('forward', 'tcp:9222', f'localabstract:{sock}')
        target = None
        while time.time() < end and not target:
            try:
                pages = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json', timeout=5))
                target = next((p for p in pages if 'appassets' in p.get('url', '')), None)
            except Exception:
                pass
            time.sleep(1)
        assert target, 'страница приложения не найдена в отладчике WebView'
        self.ws = websocket.create_connection(target['webSocketDebuggerUrl'], timeout=30)
        self.n = 0

    def js(self, expression):
        self.n += 1
        self.ws.send(json.dumps({'id': self.n, 'method': 'Runtime.evaluate',
                                 'params': {'expression': expression, 'awaitPromise': True, 'returnByValue': True}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == self.n:
                break
        res = msg.get('result', {})
        if 'exceptionDetails' in res:
            raise RuntimeError(f'ошибка JS: {res["exceptionDetails"]}')
        return res.get('result', {}).get('value')

    def wait(self, expression, timeout=20, what=None):
        end = time.time() + timeout
        while time.time() < end:
            if self.js(f'!!({expression})'):
                return
            time.sleep(0.3)
        raise AssertionError(f'не дождались: {what or expression}')

    def close(self):
        self.ws.close()


N1 = 'Ось 3/Б, отм. +6.000 — раковины "до 5 мм". Подрядчик: ООО «Ромашка-Строй», срок до 30.10.2026'
N2 = 'Пом. 2.15: трещина в стяжке'


def full():
    adb('install', '-r', APK)
    adb('logcat', '-c')
    start_app()
    page = Page()
    page.wait('document.documentElement.dataset.ready === "true"', 30, 'запуск приложения')
    shot('start')
    assert page.js("document.querySelector('#mode-line').textContent") == 'Демо-режим: ИИ не подключён'
    page.js("location.hash = 'settings'")
    page.wait("document.querySelector('#app-platform').textContent === 'Приложение Android (APK)'", 10, 'вариант APK')
    log('Запуск: OK, вариант APK')

    # Заметка → два черновика.
    page.js("location.hash = 'dialog'")
    page.js(f"""(() => {{ const i = document.querySelector('#input'); i.value = {json.dumps(N1 + chr(10) + chr(10) + N2)};
        i.dispatchEvent(new Event('input')); document.querySelector('#parse').click(); }})()""")
    page.wait("document.querySelectorAll('.draft').length === 2", 10, 'два черновика')
    loc = page.js("document.querySelector('.draft input[data-field=location]').value")
    assert loc == 'Ось 3/Б, отм. +6.000', loc
    shot('drafts')
    for _ in range(2):
        page.js("[...document.querySelectorAll('.draft button')].find(b => b.textContent === 'Добавить в реестр').click()")
        time.sleep(0.5)
    page.wait("document.querySelectorAll('.record-row').length === 2", 10, 'две записи')
    log('Черновики подтверждены: OK')

    # Удаление записи № 1: номер второй записи не меняется.
    page.js("document.querySelector('.record-row[data-number=\"1\"]').click()")
    page.wait("document.querySelector('#record-dialog').open", 5)
    page.js("document.querySelector('#record-delete').click()")
    page.wait("document.querySelector('#confirm-record-delete').open", 5)
    page.js("document.querySelector('#confirm-record-delete button[value=delete]').click()")
    page.wait("document.querySelectorAll('.record-row').length === 1", 5, 'удаление')
    numbers = page.js("[...document.querySelectorAll('.record-row td[data-field=number]')].map(t => t.textContent)")
    assert numbers == ['2'], numbers
    log('Удаление без перенумерации: OK')

    # Непроверенный черновик перед закрытием приложения.
    page.js("location.hash = 'dialog'")
    page.js(f"""(() => {{ const i = document.querySelector('#input'); i.value = {json.dumps(N2)};
        i.dispatchEvent(new Event('input')); document.querySelector('#parse').click(); }})()""")
    page.wait("document.querySelectorAll('.draft').length === 1", 10, 'черновик')
    time.sleep(1)

    # Перезапуск приложения (как если бы Android закрыл его в фоне): данные сохранились.
    page.close()
    stop_app()
    time.sleep(1)
    start_app()
    page = Page()
    page.wait('document.documentElement.dataset.ready === "true"', 30, 'повторный запуск')
    page.js("location.hash = 'registry'")
    page.wait("document.querySelectorAll('.record-row').length === 1", 10, 'запись после перезапуска')
    page.wait("document.querySelectorAll('.draft').length === 1", 10, 'черновик после перезапуска')
    shot('registry-after-restart')
    page.js("[...document.querySelectorAll('.draft button')].find(b => b.textContent === 'Отклонить').click()")
    page.wait("document.querySelectorAll('.draft').length === 0", 5, 'отклонение черновика')
    log('Данные и черновик после перезапуска: OK')

    # Кнопка «Назад» закрывает окно записи, а не приложение.
    page.js("document.querySelector('.record-row').click()")
    page.wait("document.querySelector('#record-dialog').open", 5)
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    page.wait("!document.querySelector('#record-dialog').open", 5, 'закрытие окна кнопкой «Назад»')
    assert adb('shell', 'pidof', PKG).strip(), 'приложение закрылось'
    log('Кнопка «Назад»: OK')

    # Экспорт CSV через системное окно «Сохранить».
    adb('shell', 'rm', '-f', '/sdcard/Download/jarvis-reestr-*.csv', check=False)
    page.js("document.querySelector('#export').click()")
    page.wait("document.querySelector('#confirm-export').open", 5)
    page.js("document.querySelector('#export-confirm').click()")
    tap_save_in_picker()
    page.wait("(document.querySelector('#toast').textContent || '').includes('сохранён')", 30, 'сообщение о сохранении')
    shot('saved')
    found = adb('shell', 'find', '/sdcard/', '-name', 'jarvis-reestr-*.csv', check=False).split()
    assert found, 'сохранённый файл не найден на эмуляторе'
    adb('pull', found[0], str(OUT / 'exported.csv'))
    raw = (OUT / 'exported.csv').read_bytes()
    assert raw.startswith(b'\xef\xbb\xbf'), 'нет BOM'
    text = raw.decode('utf-8-sig')
    lines = text.split('\r\n')
    assert lines[0].startswith('"№ п/п";"Дата";'), lines[0]
    assert lines[1].startswith('"2";'), lines[1]
    assert 'Пом. 2.15' in lines[1]
    assert lines[2] == '' and len(lines) == 3, lines
    log(f'Экспорт CSV через окно Android: OK ({found[0]})')

    # Экспорт, когда Android закрывает JARVIS, пока открыто окно «Сохранить».
    # До 0.3.1 файл в этом случае сохранялся пустым.
    adb('shell', 'settings', 'put', 'global', 'always_finish_activities', '1')
    try:
        page.js("document.querySelector('#export').click()")
        page.wait("document.querySelector('#confirm-export').open", 5)
        page.js("document.querySelector('#export-confirm').click()")
        page.close()
        tap_save_in_picker()
        end = time.time() + 30
        while len(exported_files()) < 2 and time.time() < end:
            time.sleep(1)
        files = exported_files()
        assert len(files) >= 2, f'второй файл не сохранён: {files}'
        time.sleep(2)
        for i, f in enumerate(files):
            adb('pull', f, str(OUT / f'exported-{i}.csv'))
            data = (OUT / f'exported-{i}.csv').read_bytes()
            assert data == raw, f'{f}: содержимое отличается ({len(data)} байт вместо {len(raw)})'
        shot('saved-after-activity-restart')
        assert adb('shell', 'pidof', PKG).strip(), 'приложение закрылось'
        log('Экспорт при закрытии приложения системой: OK')
    finally:
        adb('shell', 'settings', 'put', 'global', 'always_finish_activities', '0')

    check_logcat()
    if KEEP:
        log('Приложение оставлено с данными для проверки обновления')
    else:
        adb('uninstall', PKG, check=False)
    log('ПОЛНАЯ ПРОВЕРКА ПРОЙДЕНА')


def smoke():
    adb('uninstall', PKG, check=False)
    adb('install', APK)
    adb('logcat', '-c')
    start_app()
    wait_ui_text('Демо-режим', 60)
    shot('release-start')
    time.sleep(3)
    assert adb('shell', 'pidof', PKG).strip(), 'приложение не запущено'
    check_logcat()
    log('ПРОВЕРКА ПОДПИСАННОГО APK ПРОЙДЕНА')


def update():
    # Тестовая версия с одной записью уже установлена (full --keep).
    adb('logcat', '-c')
    adb('install', '-r', APK)  # без удаления: как обновление на телефоне
    start_app()
    wait_ui_text('Демо-режим', 60)
    tap_text('Реестр')
    wait_ui_text('Записей: 1', 30)
    shot('registry-after-update')
    check_logcat()
    adb('uninstall', PKG, check=False)
    log('ОБНОВЛЕНИЕ БЕЗ ПОТЕРИ ДАННЫХ: OK')


if __name__ == '__main__':
    try:
        {'full': full, 'smoke': smoke, 'update': update}[MODE]()
    except Exception:
        try:
            shot('failure')
            adb('logcat', '-d') and (OUT / 'logcat.txt').write_text(adb('logcat', '-d'), encoding='utf-8')
        except Exception:
            pass
        raise
