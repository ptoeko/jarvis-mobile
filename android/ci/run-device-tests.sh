#!/usr/bin/env bash
# Запускается внутри эмулятора Android в GitHub Actions.
# 1) полный сценарий на отладочном APK; 2) запуск подписанного APK (если есть).
set -euo pipefail
OUT="${1:-device-out}"
mkdir -p "$OUT"
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done'

TEST_APK=$(ls dist/JARVIS-*-test.apk | head -1)
python3 android/ci/device_test.py full "$TEST_APK" "$OUT/full"

RELEASE_APK=$(ls dist/JARVIS-*.apk | grep -v -- '-test.apk' | head -1 || true)
if [ -n "$RELEASE_APK" ]; then
  python3 android/ci/device_test.py smoke "$RELEASE_APK" "$OUT/release"
else
  echo "Подписанного APK нет — проверка выпуска пропущена."
fi
