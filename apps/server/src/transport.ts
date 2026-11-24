import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import type { DeviceTransport, JsonObject } from "./types.js";

/** Every send and close has an absolute budget, including a peer that never drains. */
export class WebSocketTransport implements DeviceTransport {
  private pendingProbe: Promise<boolean> | undefined;

  constructor(
    private readonly socket: WebSocket,
    private readonly sendTimeoutMs = 5000,
    private readonly closeTimeoutMs = 1000,
  ) {}
  probe(): Promise<boolean> {
    if (this.pendingProbe) return this.pendingProbe;
    this.pendingProbe = this.probeOnce().finally(() => {
      this.pendingProbe = undefined;
    });
    return this.pendingProbe;
  }
  private probeOnce(): Promise<boolean> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const nonce = randomBytes(16);
    return new Promise((resolve) => {
      const finish = (alive: boolean) => {
        clearTimeout(timer);
        this.socket.off("pong", pong);
        this.socket.off("close", closed);
        resolve(alive);
      };
      const pong = (data: Buffer) => {
        if (nonce.equals(data)) finish(true);
      };
      const closed = () => finish(false);
      const timer = setTimeout(closed, 2000);
      this.socket.on("pong", pong);
      this.socket.once("close", closed);
      try {
        this.socket.ping(nonce, false, (error) => {
          if (error) finish(false);
        });
      } catch {
        finish(false);
      }
    });
  }
  send(frame: JsonObject): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 16 * 1024 * 1024) {
        reject(new Error("Device connection cannot accept data"));
        return;
      }
      const timer = setTimeout(() => {
        this.socket.terminate();
        reject(new Error("Device send deadline exceeded"));
      }, this.sendTimeoutMs);
      this.socket.send(JSON.stringify(frame), (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }
  close(code: number, reason: string): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.socket.off("close", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        this.socket.terminate();
        finish();
      }, this.closeTimeoutMs);
      this.socket.once("close", finish);
      try {
        this.socket.close(code, reason.slice(0, 100));
      } catch {
        this.socket.terminate();
        finish();
      }
    });
  }
}
