#!/usr/bin/env node
import { desktopMain } from "./command.js";
desktopMain().catch((error) => {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
