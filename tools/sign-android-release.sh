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

printf '%s' "$ANDROID_KEYSTORE_BASE64" | openssl base64 -d -A > "$work/release.keystore"
"$build_tools/zipalign" -c 4 'apps/android/build/outputs/apk/release/aBridge Android-release-unsigned.apk'
"$build_tools/apksigner" sign \
  --ks "$work/release.keystore" --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD \
  --out "$work/release.apk" 'apps/android/build/outputs/apk/release/aBridge Android-release-unsigned.apk'
"$build_tools/apksigner" verify "$work/release.apk"
size=$(wc -c < "$work/release.apk")
if (( size > 500000 )); then
  echo "Signed Android APK is $size bytes and exceeds the 500,000-byte limit." >&2
  exit 1
fi
mkdir -p "$(dirname "$output")"
cp "$work/release.apk" "$output"
echo "Signed Android APK: $size bytes"
