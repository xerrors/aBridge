// Controlled HTTP/exit failures for the package checker, not a replacement Server or WASM runtime.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const settings = JSON.parse(readFileSync("fixture.json", "utf8"));
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(settings.health, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: "0.0.0" }));
  } else if (request.url === "/") {
    response.end('<script src="/static/app.js"></script>');
  } else {
    response.writeHead(settings.script, { "content-type": "text/javascript" });
    response.end("console.log('fixture')", () => {
      if (settings.earlyExit) {
        console.error("fatal after response");
        writeFileSync("stopped", "yes");
        process.exit(settings.exit);
      }
    });
  }
});
server.listen(0, "127.0.0.1", () => {
  console.log(`aBridge fixture: http://127.0.0.1:${server.address().port}`);
});
process.once("SIGTERM", () => {
  server.close(() => {
    writeFileSync("stopped", "yes");
    process.exit(settings.exit);
  });
});
