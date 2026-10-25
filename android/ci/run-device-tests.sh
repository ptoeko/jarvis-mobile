#!/usr/bin/env bash
# Запускается внутри эмулятора Android в GitHub Actions.
# 1) полный сценарий на тестовом APK;
# 2) если есть подписанный APK: установка поверх тестовой версии с данными
#    (проверка обновления без потери данных) и запуск с нуля.
set -euo pipefail
OUT="${1:-device-out}"
mkdir -p "$OUT"
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done'

TEST_APK=$(ls dist/JARVIS-*-test.apk | head -1)
RELEASE_APK=$(ls dist/JARVIS-*.apk | grep -v -- '-test.apk' | grep -v 'JARVIS-Mobile.apk' | head -1 || true)

if [ -n "$RELEASE_APK" ]; then
  python3 android/ci/device_test.py full "$TEST_APK" "$OUT/full" --keep
  python3 android/ci/device_test.py update "$RELEASE_APK" "$OUT/update"
  python3 android/ci/device_test.py smoke "$RELEASE_APK" "$OUT/release"
else
  python3 android/ci/device_test.py full "$TEST_APK" "$OUT/full"
  echo "Подписанного APK нет — проверка обновления и выпуска пропущена."
fi
