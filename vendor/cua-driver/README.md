# Internal embedded Cua SDK

This directory contains the reviewed patch and the internal SDK artifact used by
aBridge on Apple Silicon, macOS 14 or later. The package version is
`0.46.1+abridge.1`; it must not be represented as an unmodified upstream `0.46.1`.

The source is fixed at `93c9b500a0d4f9daa56063d3d3e3fb3c9e6070ee`. The patch
excludes Chrome's Chinese remote-debugging consent sheet from the normal-window
candidate list and adds it to the existing candidate-selection unit test. It
retains the approved window, other normal windows, and all ambiguity refusals.
It does not auto-authorize another profile or weaken aBridge's owner selection.

Build with `python3 deploy/build_cua_sdk.py` on Apple Silicon. The build uses a
fixed official Rust 1.97.1 toolchain in `~/Library/Caches/aBridge`, the upstream
locked third-party dependencies, two build jobs, and macOS 14 as the deployment target.
Only workspace package versions are updated to identify the internal build. It runs the
single affected Rust unit test and builds the SDK library. `strip=none` avoids
[Rust's documented macOS 27 LINKEDIT issue](https://github.com/rust-lang/rust/issues/157750).
Rust, source archives, and compilation caches are build dependencies only.

The wheel reuses the unmodified upstream Python bindings, with its version and
package metadata updated to identify this internal build. It contains the
patched SDK library and retained notices, and omits the upstream command-line
binary and console entry point. It is intended only for aBridge's explicit
embedded SDK construction; no second app or driver daemon is installed.

`manifest.json` records the source, input hashes, patch, compiler settings,
library hash, and final wheel hash. A successful build and unit test do not
replace the installed-App and Yuxi checks of Chrome consent and business effects.
