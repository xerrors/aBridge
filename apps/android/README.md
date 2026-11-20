# aBridge for Android

The Android app supports Android 11 and later. Install the signed APK from GitHub Releases and use a Server version that supports Android devices. [GitHub Releases](https://github.com/xerrors/aBridge/releases/latest)

In the management console, create an Android device and copy its Device Key. Open the app, enter the Server address and key, then enable the aBridge accessibility service in Android Settings. Choose the capabilities and working directory in **设置**, then tap **允许 Agent 操作**. Use **暂停 Agent 操作** to pause access while keeping the device connected.

Use HTTPS for remote connections. If you enter an HTTP address, the app asks you to confirm it because the key and device traffic will travel without encryption. The confirmation applies to the saved address, and a device bound over HTTPS keeps using HTTPS.

To update the signed app, go to **设置 → 检查更新**. Open the downloaded APK and follow the Android installer. [Android release process](../../docs/releasing.md#android)

## Build for development

```sh
npm run build
npm --prefix apps/android/ui ci --legacy-peer-deps
apps/android/gradlew -p apps/android assembleDebug
```

The Android build requires JDK 17 and Android SDK Platform 36. Gradle consumes the device contract generated from the shared protocol and bundles the Tamagui UI in the APK. The app loads its bundled Tamagui interface in Android System WebView and connects it to the app using a message channel limited to the local page. The debug APK is under `apps/android/build/outputs/apk/debug/`.

The [Android App workflow](../../.github/workflows/android.yml) builds Debug and Release APKs and runs Android Lint on pull requests and pushes to `main`. Download the installable Debug APK from the run's **abridge-android-debug** artifact.

Debug and Release APKs use R8 to remove unused code and compress the remaining DEX bytecode. Release packaging recompresses the APK before signing and checks the complete signed file against a 200,000-byte budget. Android extracts the bytecode during installation, so the APK size and installed storage usage differ.

## Tools

| Capability | Supported requests                                                                                                                                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen     | `computer_observe` with `desktop=true`. Returns a bounded accessibility tree and optional JPEG. Images and coordinates use the current display orientation.                                                                                                                                                                                        |
| Input      | `computer_act` with a current observation. Primary click, long press, drag, scroll, text replacement, and supported Android system and editor keys. Click and long press accept an element reference or screenshot coordinates. `click_refs` applies up to 12 independent native clicks in the same window and stops if focus or a target changes. |
| Files      | `files_list`, `file_read`, and `file_write` under `/workspace`, which maps to the directory selected in Android's system picker. Reads and writes use UTF-8 and a one MiB limit.                                                                                                                                                                   |

Observations expire after 120 seconds and are invalidated after input and on window changes. Input requires a verified current foreground window. Physical pointer movement, right-click, modifier combinations, and desktop window selection return an unsupported response. Protected windows can refuse capture. Directory providers control filename and write behavior. The app retains accepted operation IDs across restarts and refuses additional work if its bounded journal is full.

An observation of aBridge's own settings advertises only the system navigation that can leave that screen. Home returns to the launcher. Back, touch, scrolling, and text input in aBridge's settings require direct user input.

On Android 11 and 12, the focused editor can expose its own enter action. When available, it appears as `enter` in `supported_keys` and invokes the action configured by the editor. Explicit `search` and `done` keys require Android 13 or newer. The text replacement action is available on all supported versions when the field exposes accessible editing.

See the [public benchmark procedure](../../docs/benchmarks/android-world.md) for emulator setup and result interpretation.
