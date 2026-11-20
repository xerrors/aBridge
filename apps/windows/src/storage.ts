import { normalizeDeviceServer } from "@abridge/protocol";
import { constants } from "node:fs";
import { mkdir, lstat, chmod, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { windowsPrivatePath } from "./windows-security.js";
import { readBounded } from "./io.js";
import { DesktopError, record } from "./errors.js";

export type ClientConfig = {
  url: string;
  capabilities: Record<string, boolean>;
  paused: boolean;
  pause_reason?: string;
  revoked?: boolean;
  http_confirmed_origin?: string;
};
export function normalizeServerUrl(value: string, confirmedHttpOrigin?: string): string {
  try {
    return normalizeDeviceServer(value, confirmedHttpOrigin);
  } catch (error) {
    throw new DesktopError("invalid_url", error instanceof Error ? error.message : "服务地址无效");
  }
}
export async function privateDirectory(path: string, create = true): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw new DesktopError("credential_permissions", "Local state must be an owner-only directory");
  if (process.platform === "win32") {
    await windowsPrivatePath(path, create);
    return;
  }
  if (create) await chmod(path, 0o700);
  else if ((stat.mode & 0o777) !== 0o700)
    throw new DesktopError("credential_permissions", "Local state requires mode 0700");
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  if (process.platform === "win32") await privateDirectory(dirname(path), false);
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
    if (process.platform === "win32") return;
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
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
  if (process.platform === "win32") {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new DesktopError("credential_permissions", "Local state must be a regular private file");
    await windowsPrivatePath(path);
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) ||
      (process.getuid && stat.uid !== process.getuid())
    )
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
  normalizeServerUrl(
    value.url,
    typeof value.http_confirmed_origin === "string" ? value.http_confirmed_origin : undefined,
  );
  return value as ClientConfig;
}
export async function saveConfig(stateDir: string, config: ClientConfig): Promise<void> {
  await privateDirectory(stateDir);
  await writePrivateJson(join(stateDir, "config.json"), config);
}
export async function saveCredential(stateDir: string, url: string, key: string): Promise<void> {
  if (!key.startsWith("abr_device_") || key.length > 4096)
    throw new DesktopError("credential_invalid", "Use a Device Key when binding this computer");
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
