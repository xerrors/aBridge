import type { FileHandle } from "node:fs/promises";
/** Read at most limit+1 bytes, including when a filesystem returns short reads. */
export async function readBounded(file: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}
