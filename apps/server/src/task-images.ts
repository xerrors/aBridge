import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const referencePattern = /^([a-zA-Z0-9_-]+)\/([a-f0-9]{32}\.jpg)$/;

/** Accept only bounded JPEG thumbnails; original device images stay outside the archive. */
function thumbnail(value: string): Buffer | undefined {
  if (value.length > 750_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return;
  const data = Buffer.from(value.slice("data:image/jpeg;base64,".length), "base64");
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9)
    return;
  let dimensions = false;
  for (let offset = 2; offset + 4 <= data.length;) {
    if (data[offset++] !== 0xff) return;
    while (data[offset] === 0xff) offset++;
    if (offset + 3 > data.length) return;
    const marker = data[offset++];
    if (marker === 0xda) return dimensions ? data : undefined;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) return;
      const height = data.readUInt16BE(offset + 3),
        width = data.readUInt16BE(offset + 5);
      if (!width || !height || width > 960 || height > 960) return;
      dimensions = true;
    }
    offset += length;
  }
}

export class TaskImages {
  constructor(private readonly directory: string) {}

  save(task: string, value: string): string | undefined {
    const data = thumbnail(value);
    if (!data || !/^[a-zA-Z0-9_-]+$/.test(task)) return;
    const name = randomBytes(16).toString("hex") + ".jpg";
    const directory = join(this.directory, task),
      target = join(directory, name),
      temporary = target + ".tmp";
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, data);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, target);
      return `${task}/${name}`;
    } catch {
      // Optional archival must not discard the tool receipt or fail the task.
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Optional archive cleanup. */
      }
      return;
    }
  }

  read(task: string, reference: string): Buffer | undefined {
    const match = referencePattern.exec(reference);
    if (!match || match[1] !== task) return;
    try {
      return readFileSync(join(this.directory, match[1]!, match[2]!));
    } catch {
      return;
    }
  }

  remove(reference: string): void {
    if (referencePattern.test(reference)) {
      try {
        rmSync(join(this.directory, reference), { force: true });
      } catch {
        /* Best-effort rollback. */
      }
    }
  }
}
