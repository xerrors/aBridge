import { constants } from "node:fs";
import { mkdir, lstat, chmod, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readBounded } from "./io.js";
import { DesktopError, record } from "./errors.js";

export type ClientConfig = {
  url: string;
  capabilities: Record<string, boolean>;
  paused: boolean;
  pause_reason?: string;
  revoked?: boolean;
};
export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DesktopError("invalid_url", "Enter a valid server URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new DesktopError("invalid_url", "Use HTTPS, or HTTP on localhost");
  return url.href.replace(/\/$/, "");
}
export async function privateDirectory(path: string, create = true): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw new DesktopError("credential_permissions", "Local state must be an owner-only directory");
  if (create) await chmod(path, 0o700);
  else if ((stat.mode & 0o777) !== 0o700)
    throw new DesktopError("credential_permissions", "Local state requires mode 0700");
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(
      path.slice(0, path.lastIndexOf("/")) || ".",
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function readPrivateJson(path: string, maxBytes = 8192): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()))
      throw new DesktopError("credential_permissions", "Local state requires an owner-only regular file");
    const data = await readBounded(file, maxBytes);
    if (data.length > maxBytes)
      throw new DesktopError("credential_invalid", "Stored local state is too large");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } finally {
    await file.close();
  }
}
export async function loadConfig(stateDir: string): Promise<ClientConfig> {
  await privateDirectory(stateDir, false);
  const value = await readPrivateJson(join(stateDir, "config.json"));
  if (
    !record(value) ||
    typeof value.url !== "string" ||
    !record(value.capabilities) ||
    typeof value.paused !== "boolean"
  )
    throw new DesktopError("configuration_invalid", "Bind this device in aBridge settings");
  return value as ClientConfig;
}
export async function saveConfig(stateDir: string, config: ClientConfig): Promise<void> {
  await privateDirectory(stateDir);
  await writePrivateJson(join(stateDir, "config.json"), config);
}
export async function saveCredential(stateDir: string, url: string, key: string): Promise<void> {
  if (!key.startsWith("abr_device_") || key.length > 4096)
    throw new DesktopError("credential_invalid", "Use a Device Key when binding this Mac");
  await privateDirectory(stateDir);
  const directory = join(stateDir, "credentials");
  await privateDirectory(directory);
  await writePrivateJson(join(directory, "device.json"), { server_url: url, device_key: key });
}
export async function loadCredential(stateDir: string, url: string): Promise<string> {
  await privateDirectory(stateDir, false);
  await privateDirectory(join(stateDir, "credentials"), false);
  const value = await readPrivateJson(join(stateDir, "credentials", "device.json"));
  if (!record(value) || typeof value.device_key !== "string" || !value.device_key.startsWith("abr_device_"))
    throw new DesktopError("credential_invalid", "Rebind this device");
  if (value.server_url !== url)
    throw new DesktopError("credential_mismatch", "Credential belongs to another server");
  return value.device_key;
}
export async function deleteCredential(stateDir: string): Promise<void> {
  await unlink(join(stateDir, "credentials", "device.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
export class OperationJournal {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,status TEXT NOT NULL,updated_at REAL NOT NULL); UPDATE operations SET status='outcome_unknown' WHERE status='executing'",
    );
  }
  get(id: string): { request_hash: string; status: string } | undefined {
    return this.db.prepare("SELECT request_hash,status FROM operations WHERE id=?").get(id) as
      { request_hash: string; status: string } | undefined;
  }
  start(id: string, hash: string): void {
    this.db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(id, hash, "executing", Date.now() / 1000);
  }
  finish(id: string, status: string): void {
    this.db
      .prepare("UPDATE operations SET status=?,updated_at=? WHERE id=?")
      .run(status, Date.now() / 1000, id);
  }
  close(): void {
    this.db.close();
  }
}
