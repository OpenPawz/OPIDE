#!/usr/bin/env bash
#
# Build a signed + notarized OPIDE release DMG.
#
# Tauri signs and notarizes automatically during `tauri build` when the right
# environment variables are present. Set these (do NOT commit them):
#
#   APPLE_SIGNING_IDENTITY  "Developer ID Application: Your Name (TEAMID)"
#                           (list yours with: security find-identity -v -p codesigning)
#   APPLE_ID                your Apple ID email
#   APPLE_PASSWORD          an app-specific password from appleid.apple.com
#                           (NOT your normal password)
#   APPLE_TEAM_ID           your 10-character team id
#
# With APPLE_SIGNING_IDENTITY set, Tauri signs the .app with the hardened
# runtime + src-tauri/entitlements.plist. With the APPLE_* creds also set, it
# notarizes the bundle and staples the ticket, so the DMG opens cleanly on
# other Macs (no Gatekeeper "unidentified developer" block).
#
set -euo pipefail
cd "$(dirname "$0")/.."

missing=0
for v in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!v:-}" ]; then
    echo "ERROR: \$$v is not set"
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo
  echo "Set the variables documented at the top of this script, then re-run."
  echo "Unsigned local builds can still use: npm run tauri:build"
  exit 1
fi

echo "Signing identity : $APPLE_SIGNING_IDENTITY"
echo "Apple team       : $APPLE_TEAM_ID"
echo "Building signed + notarized release (this also notarizes — can take several minutes)..."
echo

npm run tauri:build

APP="target/release/bundle/macos/OPIDE.app"
DMG_DIR="target/release/bundle/dmg"

echo
echo "── Verifying code signature ──────────────────────────────────────────"
codesign --verify --deep --strict --verbose=2 "$APP"

echo
echo "── Verifying Gatekeeper acceptance (notarization stapled) ────────────"
# 'spctl' should report 'accepted' + 'source=Notarized Developer ID'.
spctl -a -vvv --type exec "$APP" || {
  echo "WARNING: spctl did not accept the app. Check notarization output above."
}

echo
echo "Done. Artifacts:"
echo "  app: $APP"
echo "  dmg: $(ls "$DMG_DIR"/*.dmg 2>/dev/null || echo "$DMG_DIR (no dmg found)")"
