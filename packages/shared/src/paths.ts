import { homedir } from "node:os";
import { join } from "node:path";
export function defaultDataDirectory(): string {
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/aBridge");
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "aBridge");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "abridge");
}
