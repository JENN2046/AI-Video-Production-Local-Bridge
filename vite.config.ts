import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/workbench-ui",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4181",
      "/imports": "http://127.0.0.1:4181",
      "/media": "http://127.0.0.1:4181",
      "/ui-assets": "http://127.0.0.1:4181"
    }
  },
  build: {
    outDir: "../../dist/workbench-ui",
    emptyOutDir: true,
    assetsDir: "v2-assets",
    sourcemap: true
  }
});
