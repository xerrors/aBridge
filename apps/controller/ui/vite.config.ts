import { defineConfig } from "vite";
export default defineConfig({
  base: "/controller/static/",
  build: { target: "chrome87", outDir: "dist", emptyOutDir: true },
});
