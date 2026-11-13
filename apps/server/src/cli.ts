#!/usr/bin/env node
import { serverMain } from "./command.js";
serverMain().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
