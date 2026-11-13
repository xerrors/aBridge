#!/bin/bash
set -euo pipefail
for name in APPLE_CERTIFICATE_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_API_KEY_BASE64 APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [ -z "${!name:-}" ]; then echo "Missing required signing input: $name" >&2; exit 1; fi
done
work=$(mktemp -d)
keychain="$work/release.keychain-db"
keychain_password=$(openssl rand -hex 32)
echo "::add-mask::$keychain_password"
original=()
while IFS= read -r path; do original+=("$path"); done < <(security list-keychains -d user | sed -E 's/^[[:space:]]*"//;s/"[[:space:]]*$//')
cleanup() {
  security list-keychains -d user -s "${original[@]}" >/dev/null 2>&1 || true
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  node --input-type=module -e 'import fs from "node:fs";fs.rmSync(process.argv[1],{recursive:true,force:true})' "$work"
}
trap cleanup EXIT
umask 077
printf '%s' "$APPLE_CERTIFICATE_BASE64" | base64 --decode > "$work/certificate.p12"
printf '%s' "$APPLE_API_KEY_BASE64" | base64 --decode > "$work/AuthKey.p8"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/certificate.p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${original[@]}"
export APPLE_API_KEY_FILE="$work/AuthKey.p8"
npm run package:macos -- --signing-identity "$APPLE_SIGNING_IDENTITY" --notarize
