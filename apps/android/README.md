# aBridge for Android

Development preview for Android 11 and newer. Use a Server built from this branch or a later build that includes the Android device time handshake. The app registers as an independent computer device and connects directly to the server. Use a computer Device Key whose grant includes the capabilities you intend to enable.

```sh
npm run build
npm --prefix apps/android/ui ci --legacy-peer-deps
apps/android/gradlew -p apps/android assembleDebug
```

The Android build requires JDK 17 and Android SDK Platform 36. Gradle consumes the device contract generated from the shared protocol and bundles the Tamagui UI in the APK. The app requires Android System WebView with WebMessageListener support and has been tested on Android 11 with WebView 87. The debug APK is under `apps/android/build/outputs/apk/debug/`.

The [Android App workflow](../../.github/workflows/android.yml) builds Debug and Release APKs and runs Android Lint on pull requests and pushes to `main`. Download the installable Debug APK from the run's **abridge-android-debug** artifact.

Open the app, enter the HTTPS server address and Device Key, and enable the aBridge accessibility service in Android Settings. Configure the capabilities in **能力设置** and use **设备详情** to choose a working directory for file access. Select **允许 Agent 操作** to accept authorized requests or **暂停 Agent 操作** to close access. The device can stay connected in either mode, and local access changes take effect before the Server receives the update. Debug builds also permit HTTP at the emulator host address (`10.0.2.2`) or at `127.0.0.1` for testing over `adb reverse`.

| Capability | Supported requests                                                                                                                                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen     | `computer_observe` with `desktop=true`. Returns a bounded accessibility tree and optional JPEG. Images and coordinates use the current display orientation.                                                                                                                                                                                        |
| Input      | `computer_act` with a current observation. Primary click, long press, drag, scroll, text replacement, and supported Android system and editor keys. Click and long press accept an element reference or screenshot coordinates. `click_refs` applies up to 12 independent native clicks in the same window and stops if focus or a target changes. |
| Files      | `files_list`, `file_read`, and `file_write` under `/workspace`, which maps to the directory selected in Android's system picker. Reads and writes use UTF-8 and a one MiB limit.                                                                                                                                                                   |

Observations expire after 120 seconds and are invalidated after input and on window changes. Input requires a verified current foreground window. Physical pointer movement, right-click, modifier combinations, and desktop window selection return an unsupported response. Protected windows can refuse capture. Directory providers control filename and write behavior. The app retains accepted operation IDs across restarts and refuses additional work if its bounded journal is full.

On Android 11 and 12, the focused editor can expose its own enter action. When available, it appears as `enter` in `supported_keys` and invokes the action configured by the editor. Explicit `search` and `done` keys require Android 13 or newer. The text replacement action is available on all supported versions when the field exposes accessible editing.

See the [public benchmark procedure](../../docs/benchmarks/android-world.md) for emulator setup and result interpretation.
