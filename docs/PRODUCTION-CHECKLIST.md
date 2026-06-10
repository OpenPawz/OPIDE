# OPIDE Production Checklist

_Last audited: 2026-06-09. Items marked [Eli] need account access only you have._

## Done (verified this audit)
- [x] Full workspace test suite green: 793 tests, 0 failures (engine 733,
      sandbox 45, ai 12, shell 3).
- [x] Packaged app works end to end: sidecar bundled + commonjs anchor,
      localhost asset server (service workers / extension webviews), Claude
      Code extension runs and edits real files.
- [x] Version metadata aligned at 0.1.0 (package.json, tauri.conf.json,
      crates).
- [x] Crash handler writes ~/.opide/crash.log (panic hook).
- [x] Project rules, web_search, FIM completions, terminal Cmd+K, @git,
      Cmd+L shipped; audit fixed rules contamination + Tool RAG gating.
- [x] Localhost port now logged after logger init so it lands in opide.log.

## Blockers for public distribution

### 1. Code signing certificate [Eli]
`security find-identity` shows Apple Distribution (App Store) and Apple
Development certs only. Distributing a DMG outside the App Store requires a
**Developer ID Application** certificate:
1. developer.apple.com → Certificates → Create → "Developer ID Application"
   (team: Splash Pro Io Corp, 694X65WWQS).
2. Install it in the login keychain.
3. Build with `scripts/build-release-signed.sh` (already checks the env vars):
   `APPLE_SIGNING_IDENTITY="Developer ID Application: Splash Pro Io Corp (694X65WWQS)"`
   plus `APPLE_ID` / `APPLE_PASSWORD` (app-specific) / `APPLE_TEAM_ID` for
   notarization. Unsigned builds get Gatekeeper-blocked on other Macs.

### 2. Auto-updater [Eli + code]
tauri.conf.json has placeholder updater config:
- `pubkey: "PLACEHOLDER_GENERATE_WITH_TAURI_SIGNER"`
- endpoint `https://releases.openpawz.com/...` (not live)
Currently dormant — nothing in the frontend calls the updater, so it cannot
crash. Before enabling:
1. `npx tauri signer generate` → keep the PRIVATE key out of the repo
   (password manager / CI secret). Put the public key in tauri.conf.json.
2. Stand up the releases endpoint (static JSON per target/arch works).
3. Set `bundle.createUpdaterArtifacts: true`.
4. Add a "Check for Updates…" menu item calling plugin-updater.

### 3. Open VSX gallery TOS
The Extensions panel hits open-vsx.org from the app. Fine for personal use;
for a public product, register/confirm usage per Open VSX terms (Eclipse
Foundation) the way VSCodium does.

## Should-do before a 1.0
- [ ] First-run experience: empty-state guidance for "no provider configured"
      (the panel exists; verify the cold-start path on a fresh machine
      account with no ~/.opide).
- [ ] Surface extension-host crashes to the UI (currently log-only restart).
- [ ] A short privacy note: what leaves the machine (provider APIs, Open VSX,
      open-vsx readme CDN, DuckDuckGo for web_search) and what stays local.
- [ ] Windows/Linux: extension host search paths and node resolution are
      macOS-tuned; gate or port before claiming cross-platform.
- [ ] Rotate any provider API keys that were pasted during development
      sessions if logs/transcripts ever leave this machine.

## Known cosmetics / debt
- `cargo check` warnings: a handful of unused imports/variables (harmless;
  `cargo fix` candidates).
- `read_project_rules` reads rule files on every chat turn (fine — small
  files; cache if it ever shows up in profiles).
- Center-editor extension detail view was reverted (sidebar detail works);
  retry requires identifying the missing workbench service first.
