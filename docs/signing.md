# Signing the macOS app

TwanAgent is a Tauri app. macOS will not grant the microphone or local network to an unsigned binary, so both the release bundle and the debug app are signed with `codesign`.

The bundle id is `app.twanagent.desktop`. The debug wrapper uses `app.twanagent.desktop.dev` so it keeps its own TCC prompts and app data.

## What gets signed

`src-tauri/Entitlements.plist` is attached to every signature:

- `com.apple.security.device.audio-input` — dictate into the composer
- `com.apple.security.network.client` — xAI, SSH, and downloads
- `com.apple.security.network.server` — the local MCP sign-in callback

`src-tauri/Info.plist` is merged into the app's `Info.plist` on a release build. It carries:

- `NSMicrophoneUsageDescription`
- `NSLocalNetworkUsageDescription`
- `NSBonjourServices` (`_ssh._tcp`) for finding SSH servers

Tauri is told to use both files from `src-tauri/tauri.macos.conf.json`.

## Release

A release build signs the `.app` with your Apple Development identity. Tauri picks the identity from the login keychain. Nothing in this repo stores a certificate or a notarization profile.

```bash
npm install
npm run tauri build
```

That runs `npm run build`, compiles the Rust app, bundles `src-tauri/target/release/bundle/macos/TwanAgent.app`, and codesigns it with `Entitlements.plist`.

Check the signature:

```bash
codesign -dv --entitlements :- "src-tauri/target/release/bundle/macos/TwanAgent.app"
```

The output should show identifier `app.twanagent.desktop`, a TeamIdentifier, and the three entitlements above.

To force one identity, pass it to Tauri:

```bash
npm run tauri build -- --config '{"bundle":{"macOS":{"signingIdentity":"Apple Development: you@example.com (TEAMID)"}}}'
```

`security find-identity -v -p codesigning` lists the identities in the keychain.

This signature is enough to run the app on this Mac. It is not notarized. Gatekeeper on another Mac will reject it until the app is signed with a Developer ID Application certificate and submitted with `notarytool`. Notarization is not set up here.

## Debug

`npm run tauri dev` embeds the webview and an Info.plist in the debug binary, then `src-tauri/scripts/sign-microphone.sh` ad-hoc signs that binary (`codesign --sign -`). Ad-hoc is enough for the microphone prompt. It is not enough for the local network prompt.

When macOS blocks SSH to a machine on your LAN, quit the dev window and run:

```bash
npm run dev:mac
```

`scripts/dev-macos-app.sh` wraps `src-tauri/target/debug/twanagent` in `TwanAgent Dev.app`, writes a small Info.plist with the local network usage string, and signs that bundle with the Apple Development identity named in the script. Open that app and allow the prompt. The identity has to be in the keychain. Change the `identity=` line if the certificate name changes.

The debug binary must already exist. Run `npm run tauri dev` once so Rust has compiled it.
