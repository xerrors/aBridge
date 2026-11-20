/** Owner-only local control transport; device state changes stay in DeviceClient. */
import { createServer, createConnection, type Socket } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DesktopError, record } from "./errors.js";
import { privateDirectory, readPrivateJson, writePrivateJson } from "./storage.js";
type ControlHandler = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
export type LocalControlServer = { close(): Promise<void> };
export function controlSocketPath(stateDir: string): string {
  if (process.platform === "win32")
    return `\\\\.\\pipe\\abridge-${createHash("sha256").update(resolve(stateDir).toLowerCase()).digest("hex")}`;
  const standard = join(stateDir, "control.sock");
  return Buffer.byteLength(standard) < 100
    ? standard
    : `/tmp/abridge-${process.getuid?.() ?? "user"}-${createHash("sha256").update(stateDir).digest("hex").slice(0, 24)}.sock`;
}

export async function listenLocalControl(
  stateDir: string,
  handle: ControlHandler,
): Promise<LocalControlServer> {
  const sockets = new Set<Socket>();
  const path = controlSocketPath(stateDir);
  await privateDirectory(stateDir);
  if (process.platform !== "win32")
    try {
      const state = await lstat(path);
      if (!state.isSocket() || (process.getuid && state.uid !== process.getuid()))
        throw new DesktopError("control_socket_invalid", "Control socket is not owned by this user");
      let live = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const probe = createConnection(path);
          probe.setTimeout(500, () => {
            probe.destroy();
            reject(Error("timeout"));
          });
          probe.once("connect", () => {
            probe.destroy();
            resolve();
          });
          probe.once("error", reject);
        });
        live = true;
      } catch {}
      if (live) throw new DesktopError("already_running", "This device client is already running");
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  const token = process.platform === "win32" ? randomBytes(32).toString("hex") : undefined;
  const tokenPath = join(stateDir, "control-auth.json");
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void serveControl(socket, async (request) => {
      if (token) {
        const supplied = typeof request._token === "string" ? Buffer.from(request._token) : Buffer.alloc(0);
        if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
          throw new DesktopError("control_unauthorized", "Local control authentication failed");
        delete request._token;
      }
      return handle(request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  try {
    if (token) await writePrivateJson(tokenPath, { token });
    else await chmod(path, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(token ? tokenPath : path).catch(() => {});
    throw error;
  }
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(token ? tokenPath : path).catch(() => {});
    },
  };
}
async function serveControl(socket: Socket, handle: ControlHandler): Promise<void> {
  socket.setTimeout(3000, () => socket.destroy());
  let buffer = "";
  try {
    const request = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (Buffer.byteLength(buffer) > 8192) {
          reject(new DesktopError("invalid_arguments", "Local request too large"));
          socket.destroy();
        } else if (buffer.includes("\n")) {
          try {
            const value = JSON.parse(buffer.split("\n")[0]);
            if (!record(value)) throw Error();
            resolve(value);
          } catch {
            reject(new DesktopError("invalid_arguments", "Invalid local request"));
          }
        }
      });
      socket.once("error", reject);
      socket.once("close", () => reject(Error("Incomplete local request")));
    });
    socket.setTimeout(15000, () => socket.destroy());
    const response = await handle(request);
    socket.end(JSON.stringify({ ok: true, ...response }) + "\n");
  } catch (error) {
    if (!socket.destroyed)
      socket.end(
        JSON.stringify({
          ok: false,
          error: {
            code: error instanceof DesktopError ? error.code : "control_failed",
            message: error instanceof DesktopError ? error.message : "Local control failed",
          },
        }) + "\n",
      );
  }
}

export async function localControl(
  stateDir: string,
  request: Record<string, unknown>,
  timeout = 15000,
): Promise<Record<string, unknown>> {
  if (process.platform === "win32") {
    const auth = await readPrivateJson(join(stateDir, "control-auth.json"));
    if (!record(auth) || typeof auth.token !== "string")
      throw new DesktopError("control_unauthorized", "Invalid local control credential");
    request = { ...request, _token: auth.token };
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlSocketPath(stateDir));
    let buffer = "";
    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new DesktopError("control_timeout", "Local client did not respond"));
    });
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 131072) {
        socket.destroy();
        reject(Error("Local response too large"));
      } else if (buffer.includes("\n")) {
        socket.end();
        try {
          const response = JSON.parse(buffer.split("\n")[0]);
          if (!record(response)) throw Error();
          if (response.ok === false)
            throw new DesktopError(
              record(response.error) ? String(response.error.code) : "control_failed",
              record(response.error) ? String(response.error.message) : "Local control failed",
            );
          resolve(response);
        } catch (error) {
          reject(error);
        }
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      if (!buffer.includes("\n")) reject(new DesktopError("control_failed", "Incomplete local response"));
    });
  });
}
