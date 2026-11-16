import { render } from "preact";
import { App } from "./app.js";

const root = document.querySelector("#app");
if (!root) throw new Error("Management console root is missing");
render(<App />, root);
