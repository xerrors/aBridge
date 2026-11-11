# Third-party notices

The Apple Silicon macOS 14+ runtime installs the internal embedded-only
`cua-driver==0.46.1+abridge.1` wheel as a separate locked dependency. It is built
from upstream commit `93c9b500a0d4f9daa56063d3d3e3fb3c9e6070ee`, with the reviewed
Chinese consent-window candidate fix in `vendor/cua-driver/`. Its manifest records
the source, patch, compiler settings, library hash, and wheel hash. This is a
modified internal build, not an unmodified upstream release.

The upstream Python bindings are retained. The upstream CLI executable and its
console entry point are omitted; aBridge uses only the explicit embedded SDK.
Rust and build caches are not client runtime dependencies. The core Cua Driver
is MIT licensed. Optional perception/model extensions are not included. The wheel
retains these notices and the upstream Rust dependency notices. Other installed
Python dependencies retain their own metadata and license notices in the runtime.

Source: https://github.com/trycua/cua

## Cua Driver

MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
