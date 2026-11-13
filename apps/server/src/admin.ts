import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  fchmodSync,
  constants,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { BridgeError } from "./types.js";

export const ADMIN_SESSION_SECONDS = 30 * 24 * 60 * 60;
const validToken = (token: string) =>
  token.length >= 32 && token.length <= 512 && /^[\x21-\x7e]+$/.test(token);
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Stored beside the database, never inside the npx package cache. Called under the instance lock. */
export function loadAdminToken(dbPath: string, configured?: string, reset = false): string {
  if (configured !== undefined) {
    if (!validToken(configured))
      throw new BridgeError(
        "invalid_admin_token",
        "ABRIDGE_ADMIN_TOKEN must contain 32–512 printable non-space ASCII characters",
        422,
      );
    if (reset)
      throw new BridgeError(
        "configured_admin_token",
        "Change ABRIDGE_ADMIN_TOKEN and restart to reset the configured token",
        422,
      );
    return configured;
  }
  const path = dbPath + ".admin-token";
  if (!reset) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      else fd = -1;
    }
    if (fd !== -1) {
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024 || (process.getuid && stat.uid !== process.getuid()))
          throw new BridgeError(
            "invalid_admin_token_file",
            "Admin token must be a private file owned by the current user",
            500,
          );
        if (process.platform !== "win32") fchmodSync(fd, 0o600);
        const token = readFileSync(fd, "utf8").trim();
        if (!validToken(token))
          throw new BridgeError(
            "invalid_admin_token_file",
            "Admin token file is invalid; use --reset-admin-token to replace it",
            500,
          );
        return token;
      } finally {
        closeSync(fd);
      }
    }
  }
  const token = "abr_admin_" + randomBytes(32).toString("base64url");
  const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    writeFileSync(temporary, token + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return token;
}

/** Independent signed browser sessions survive restart and are invalidated by token rotation. */
export class AdminAuth {
  constructor(readonly token: string) {}
  private signature(value: string): string {
    return createHmac("sha256", this.token)
      .update("abridge-admin-session:" + value)
      .digest("base64url");
  }
  acceptsToken(candidate: string): boolean {
    return equal(candidate, this.token);
  }
  createSession(): string {
    const value = `${Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS}.${randomBytes(24).toString("base64url")}`;
    return value + "." + this.signature(value);
  }
  acceptsSession(candidate: string): boolean {
    const match = /^(\d{10,11})\.([\w-]{32})\.([\w-]{43})$/.exec(candidate);
    if (!match) return false;
    const expires = Number(match[1]),
      now = Math.floor(Date.now() / 1000);
    return (
      expires > now &&
      expires <= now + ADMIN_SESSION_SECONDS &&
      equal(match[3]!, this.signature(match[1] + "." + match[2]))
    );
  }
}
