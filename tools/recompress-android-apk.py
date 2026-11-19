"""Recompress an unsigned APK without changing the bytes Android installs."""

import sys
import zipfile
from pathlib import Path

import zopfli.zlib


class ZopfliDeflater:
    def __init__(self):
        self.chunks = bytearray()

    def compress(self, data):
        self.chunks.extend(data)
        return b""

    def flush(self):
        wrapped = zopfli.zlib.compress(bytes(self.chunks), numiterations=20)
        return wrapped[2:-4]  # A ZIP entry uses raw DEFLATE without the zlib header and checksum.


def recompress(source, destination):
    default_compressor = zipfile._get_compressor

    def compressor(method, level=None):
        if method == zipfile.ZIP_DEFLATED:
            return ZopfliDeflater()
        return default_compressor(method, level)

    with zipfile.ZipFile(source) as original:
        entries = original.infolist()
        zipfile._get_compressor = compressor
        try:
            with zipfile.ZipFile(destination, "w") as result:
                for entry in entries:
                    # zipalign regenerates alignment padding after compression.
                    clean = zipfile.ZipInfo(entry.filename, entry.date_time)
                    result.writestr(clean, original.read(entry), compress_type=entry.compress_type)
        finally:
            zipfile._get_compressor = default_compressor

        with zipfile.ZipFile(destination) as result:
            if original.namelist() != result.namelist() or any(
                original.read(name) != result.read(name) for name in original.namelist()
            ):
                raise RuntimeError("APK entries changed during recompression")


if __name__ == "__main__":
    source, destination = map(Path, sys.argv[1:])
    recompress(source, destination)
