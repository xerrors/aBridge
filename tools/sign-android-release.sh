#!/usr/bin/env bash
set -euo pipefail

: "${ANDROID_KEYSTORE_BASE64:?Missing Android release keystore}"
: "${ANDROID_KEYSTORE_PASSWORD:?Missing Android keystore password}"
: "${ANDROID_KEY_ALIAS:?Missing Android signing alias}"
: "${ANDROID_KEY_PASSWORD:?Missing Android signing key password}"
: "${ANDROID_HOME:?Missing Android SDK}"

version=$(node -p "require('./package.json').version")
build_tools="$ANDROID_HOME/build-tools/36.0.0"
output="dist/releases/aBridge-$version-android.apk"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077
python="${ANDROID_APK_PYTHON:-python3}"
unsigned='apps/android/build/outputs/apk/release/aBridge Android-release-unsigned.apk'

printf '%s' "$ANDROID_KEYSTORE_BASE64" | openssl base64 -d -A > "$work/release.keystore"
"$python" tools/recompress-android-apk.py "$unsigned" "$work/repacked.apk"
"$build_tools/zipalign" -f -P 16 4 "$work/repacked.apk" "$work/aligned.apk"
"$build_tools/zipalign" -c -P 16 4 "$work/aligned.apk"
"$build_tools/apksigner" sign \
  --ks "$work/release.keystore" --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD \
  --v4-signing-enabled false --out "$work/release.apk" "$work/aligned.apk"
"$build_tools/apksigner" verify "$work/release.apk"
size=$(wc -c < "$work/release.apk")
if (( size > 200000 )); then
  echo "Signed Android APK is $size bytes and exceeds the 200,000-byte limit." >&2
  exit 1
fi
mkdir -p "$(dirname "$output")"
cp "$work/release.apk" "$output"
echo "Signed Android APK: $size bytes"
