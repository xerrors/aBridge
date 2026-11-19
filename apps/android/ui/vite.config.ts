import { defaultConfig } from "@tamagui/config/v6";
import { defineConfig } from "vite";

const themes = Object.fromEntries(
  Object.entries(defaultConfig.themes).filter(([name]) => /^light(?:_(?:white|level[234]))*$/.test(name)),
);
const config = { ...defaultConfig, themes };

export default defineConfig({
  base: "./",
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: "react-native-web" },
      { find: /^react-dom\/client$/, replacement: "preact/compat/client" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react$/, replacement: "preact/compat" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
    ],
  },
  define: {
    __ANDROID_TAMAGUI_CONFIG__: JSON.stringify(config),
    "process.env": JSON.stringify({ NODE_ENV: "production", TAMAGUI_TARGET: "web" }),
  },
  build: { target: "chrome87" },
});
