import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  resolve: { alias: [{ find: /^react-native$/, replacement: "react-native-web" }] },
  define: { "process.env": JSON.stringify({ NODE_ENV: "production", TAMAGUI_TARGET: "web" }) },
  build: { target: "chrome87" },
});
