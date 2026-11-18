# AndroidWorld public subset

This benchmark runs the 15 task/seed pairs in [suite.json](https://github.com/xerrors/aBridge/blob/main/tools/android-world/suite.json) on a dedicated Pixel 6 emulator with Android 13 (API 33). The controller uses the pinned public AndroidWorld task registry, parameter generators, setup, teardown, and success checks. It opens each task's declared app before handing control to the agent. The public initializer controls the emulator wall clock. aBridge checks dispatch expiry against the server clock advanced with Android monotonic time.

The agent sees the public goal and a single aBridge session. Its gateway allows only `computer_observe` and `computer_act`. The controller alone uses AndroidWorld and ADB for provisioning, initialization, and grading. This suite measures end-to-end screen and input operations, including file management through the Android Files app. Direct aBridge file API access has separate authorization and is outside this suite's scoring scope.

Use a disposable AVD named `AndroidWorldAvd` with a Pixel 6 profile and the API 33 Google APIs ARM64 image. Launch with `-port 5562 -no-snapshot -grpc 8554` and install the aBridge debug APK. Keep the emulator and its gRPC port on a trusted test host.

Check out the [pinned upstream source](https://github.com/google-research/android_world/tree/55ddaf5edc6f6c25673aed343907d5b9dca66f84). Follow its Python 3.11 dependency and Protobuf generation steps. Run the controller from the aBridge repository root with the upstream checkout on `PYTHONPATH`.

```sh
python tools/android-world/run.py --setup --adb /absolute/path/to/adb --out .local/android/setup
python tools/android-world/run.py --adb /absolute/path/to/adb \
  --model-catalog /absolute/path/to/model-catalog.json --out .local/android/run-01
```

The controller creates an isolated loopback server that explicitly accepts the emulator host alias `10.0.2.2`. The disposable APK connects to that server. It records each result and writes the aggregate to `results.json`. A strict success requires an upstream reward of 1 and a normal actor exit within both budgets and within its tool grant. Each member of a bulk click consumes one action unit from the existing 45-unit limit. The report also records the number of MCP calls. Failures, timeouts and tool refusals stay visible. Raw agent traces and disposable credentials remain under `.local/`. This subset should be reported with its exact tasks, seeds, environment and model.

The optional two-emulator run keeps the same 15 pairs. Assign Files tasks to `AndroidWorldAvd` on console/gRPC ports 5562/8554 and Markor tasks to `AndroidWorldAvdMarkor` on ports 5564/8556. Both use the same Pixel 6 profile and system image. Run setup separately for each emulator with its group and ports, then run the two groups with the same model catalog. Each group runs sequentially. Merge results only after both complete.

```sh
python tools/android-world/run.py --adb /absolute/path/to/adb --group files \
  --model-catalog /absolute/path/to/model-catalog.json --out .local/android/run-files
python tools/android-world/run.py --adb /absolute/path/to/adb --group markor --port 5564 --grpc 8556 \
  --model-catalog /absolute/path/to/model-catalog.json --out .local/android/run-markor
python tools/android-world/merge-results.py .local/android/run-files/results.json \
  .local/android/run-markor/results.json --out .local/android/results.json
```

In a separate deterministic file API check, the controller used the public `MarkorCreateNote` generator and grader with seeds 0, 1 and 2. On the API 33 emulator, the three cases each passed official grading and verified aBridge directory listing, write, read-back, default overwrite refusal and traversal refusal. This probe uses the task parameters as inputs and is outside the agent score.

## Measured result

The frozen AndroidWorld subset reached **15/15 strict successes** on aBridge product and runner commit `6e9a811`. Both emulators completed their assigned sets, Files **6/6** and Markor **9/9**. No planned episode was removed or retried within this run. Table cells show the unmodified AndroidWorld reward.

| Public task           | seed 0 | seed 1 | seed 2 | MCP calls | Action units | Agent P50 |
| --------------------- | ------ | ------ | ------ | --------: | -----------: | --------: |
| `FilesMoveFile`       | 1      | 1      | 1      |        92 |          100 |   278.2 s |
| `FilesDeleteFile`     | 1      | 1      | 1      |        50 |           71 |   109.5 s |
| `MarkorCreateNote`    | 1      | 1      | 1      |        48 |           48 |   146.7 s |
| `MarkorEditNote`      | 1      | 1      | 1      |        26 |           26 |    75.7 s |
| `MarkorAddNoteHeader` | 1      | 1      | 1      |        63 |           63 |   176.7 s |

The source used gpt-6.1-sol with medium reasoning, one fixed model catalog, and a 360-second / 45-action-unit limit. The two Pixel 6 emulators used the same Android 13 image and the same debug APK, whose SHA-256 appears in the [per-case result snapshot](android-world-results.json). The agent made **279 MCP calls**, charged **308 action units**, and had **146.7 s** median latency. This includes model and CLI wall time. All 15 agent sessions and all 15 public test cases cleaned up. The logs contained **31 recoverable stale-observation refusals**, 24 image responses, and zero out-of-scope tool calls.

The measured combination includes semantic Android actions, batched native clicks with per-step revalidation, and instructions to verify that edits persist before ending the task. The result describes this five-task subset and this emulator configuration. Each row has three samples.

## Development evidence

| Development checkpoint          | Observed result                                                                | Change made                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Initial emulator run            | Requests refused as expired before screen capture                              | Use server time plus Android monotonic elapsed time so the public initializer can set the Android clock.                              |
| Initial Files input run         | File selection exhausted time or action budgets in multiple tasks              | Add element-based long press and bounded batches of native clicks. A batch saves model round trips and charges each click separately. |
| Initial editor run              | 3/3 creates passed. 0/3 edits were persisted according to the upstream grader. | Require the Agent to verify the application's normal save flow and the saved state before finishing.                                  |
| Two-emulator infrastructure run | An ADB reset removed port forwarding and invalidated the sessions              | Use the emulator's host loopback alias with an explicitly allowlisted Host on the isolated benchmark Server.                          |

Development interruptions, failures, and raw logs are retained in separate run directories. The final score uses exactly one complete run over the registered plan.

## Challenge suite

The original 15 episodes serve as a two-app regression set. The [challenge manifest](https://github.com/xerrors/aBridge/blob/main/tools/android-world/challenge.json) fixes **10 new public tasks, seeds 3–5, and 30 episodes** before any scoring. The task IDs, parameters, and graders come from the same upstream revision. The suite spans seven apps. Five tasks require information to move between apps, including receipt transcription and expense or recipe entry from an image or a note.

| Public challenge                            | Upstream complexity | What the task adds                                                    |
| ------------------------------------------- | ------------------: | --------------------------------------------------------------------- |
| `ExpenseAddMultipleFromMarkor`              |                   6 | Read several entries in Markor and record them in Pro Expense         |
| `ExpenseAddMultipleFromGallery`             |                   6 | Extract expense details from images and enter several records         |
| `RecipeAddMultipleRecipesFromMarkor`        |                   6 | Transfer several structured recipes from notes into Broccoli          |
| `RecipeAddMultipleRecipesFromImage`         |                   6 | Read recipes from an image and populate structured fields             |
| `MarkorTranscribeReceipt`                   |                 1.8 | Read a receipt in Gallery and save its content in Markor              |
| `MarkorMergeNotes`                          |                 7.8 | Consolidate content from several notes and verify the resulting files |
| `SimpleCalendarAddRepeatingEvent`           |                 3.4 | Configure and save a recurring calendar event                         |
| `VlcCreateTwoPlaylists`                     |                 4.8 | Build two playlists with distinct contents                            |
| `RetroSavePlaylist`                         |                   5 | Save a playback queue as a playlist                                   |
| `RecipeDeleteMultipleRecipesWithConstraint` |                   4 | Delete the recipes that match the public task's constraints           |

The mean of the upstream complexity values is **5.08** for these ten tasks and **1.64** for the regression tasks. The upstream values are task metadata. The measured success rate still comes from the public grader.

The challenge uses the same model and two-tool boundary. Every episode gets **600 seconds and 75 action units**, fixed before the run. The longer budget accommodates multi-app and multi-record tasks. This makes the challenge score and the regression score separate measurements. Each group runs seed 3 across all five assigned tasks, then seeds 4 and 5. The controller opens the first declared app and lets the Agent switch apps through the launcher when needed.

Use the same two AVDs and model catalog as the regression run. Run each setup command first to install and initialize the public apps for its group. Start the two scoring commands only after setup has finished on both emulators. On the headless AVD, provisioning disables physical system-key events for AndroidWorld’s one-event Monkey app launches. This keeps the VLC initialization usable on the same image.

```sh
python tools/android-world/run.py --setup --group challenge-a \
  --adb /absolute/path/to/adb --out .local/android/challenge/setup-a
python tools/android-world/run.py --setup --group challenge-b --port 5564 --grpc 8556 \
  --adb /absolute/path/to/adb --out .local/android/challenge/setup-b

python tools/android-world/run.py --group challenge-a --adb /absolute/path/to/adb \
  --model-catalog /absolute/path/to/model-catalog.json --out .local/android/challenge/a
python tools/android-world/run.py --group challenge-b --port 5564 --grpc 8556 \
  --adb /absolute/path/to/adb --model-catalog /absolute/path/to/model-catalog.json \
  --out .local/android/challenge/b

python tools/android-world/merge-results.py .local/android/challenge/a/results.json \
  .local/android/challenge/b/results.json --out .local/android/challenge/results.json
```

The 80% acceptance threshold is 24/30, and 90% is 27/30. The merger requires all 30 registered pairs, with a common product revision, catalog and emulator image. Intermediate results are progress records.

### Challenge results

The first complete challenge run scored **15/30 (50%)**. Nine episodes missed the upstream goal, and six exceeded the 600-second limit. The test retained all 30 planned episodes. The APK and runner belong to the 0.4.17 development snapshot `0cabb04`.

| Public task                                 | seed 3       | seed 4       | seed 5       | Passed |
| ------------------------------------------- | ------------ | ------------ | ------------ | -----: |
| `ExpenseAddMultipleFromMarkor`              | Goal not met | Goal not met | Goal not met |    0/3 |
| `RecipeAddMultipleRecipesFromImage`         | Pass         | Pass         | Timeout      |    2/3 |
| `MarkorMergeNotes`                          | Goal not met | Goal not met | Goal not met |    0/3 |
| `SimpleCalendarAddRepeatingEvent`           | Pass         | Pass         | Pass         |    3/3 |
| `VlcCreateTwoPlaylists`                     | Timeout      | Timeout      | Timeout      |    0/3 |
| `ExpenseAddMultipleFromGallery`             | Pass         | Timeout      | Timeout      |    1/3 |
| `RecipeAddMultipleRecipesFromMarkor`        | Pass         | Pass         | Goal not met |    2/3 |
| `MarkorTranscribeReceipt`                   | Pass         | Goal not met | Pass         |    2/3 |
| `RetroSavePlaylist`                         | Pass         | Pass         | Pass         |    3/3 |
| `RecipeDeleteMultipleRecipesWithConstraint` | Pass         | Pass         | Goal not met |    2/3 |

The agent made 1,114 MCP calls with a median latency of 515.7 seconds. AndroidWorld confirmed teardown for all 30 episodes. The gateway confirmed session cleanup for 28 episodes and recorded zero tool-scope violations. The two sessions without cleanup confirmation are visible in the [complete results](android-world-challenge-results.json). The challenge missed the documented 80% threshold.

In this run, expense entry from notes and note merging scored 0/3 each. All three VLC two-playlist tasks timed out. These three task families account for nine of the 15 failures.

### Integration verification

After merging main 0.4.18, the debug APK built and installed on a Pixel 6 / API 33 emulator. An MCP screenshot returned a 1080 × 2400 image, and an element click opened the Apps page in Android Settings. The direct file interface passed three checks against the public Markor data on this APK. The fully scored Agent runs above were measured on their recorded 0.4.17 revisions.
