import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // PORT env lets a second instance (e.g. a preview/test runner) pick
    // another port without fighting the default dev server.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      "/api": "http://localhost:5275",
    },
  },
});
