import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5181, proxy: { "/api": "http://127.0.0.1:5180" } },
  build: { outDir: "dist", emptyOutDir: true },
});
