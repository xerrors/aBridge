// Test-only Windows transport for exercising Node shutdown handlers. Windows
// child.kill('SIGTERM') terminates the process without delivering a JS signal.
// This preload is never bundled or installed with any product.
if (process.platform === "win32" && process.send) {
  process.once("message", (message) => {
    if (message !== "abridge-test-stop") throw Error("Unexpected test IPC message");
    process.disconnect();
    if (!process.emit("SIGTERM", "SIGTERM")) throw Error("CLI has no graceful shutdown handler");
  });
  process.channel?.unref();
}
