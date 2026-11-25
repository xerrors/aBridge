import { render } from "preact";
import { App } from "./app.js";

const root = document.querySelector("#app");
if (!root) throw new Error("Management console root is missing");
const hash = location.hash;
if (
  location.pathname === "/" &&
  !location.search &&
  (new URLSearchParams(hash.slice(1)).has("admin_token") || /^#admin(?:\/|$)/.test(hash))
) {
  location.replace("/admin" + hash);
} else render(<App />, root);
