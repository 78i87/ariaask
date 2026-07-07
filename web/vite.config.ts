import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { ICON_NAMES } from "./src/components/iconNames";

/**
 * Keeps the Material Symbols subset in index.html in lockstep with the icons
 * the code actually uses (components/iconNames.ts). The hardcoded list in
 * index.html is only a fallback for opening the file without Vite.
 */
function iconFontSubset(): Plugin {
  return {
    name: "aria-icon-font-subset",
    transformIndexHtml(html) {
      return html.replace(/icon_names=[a-z0-9_,]*/, `icon_names=${[...ICON_NAMES].sort().join(",")}`);
    },
  };
}

export default defineConfig({
  plugins: [react(), iconFontSubset()],
  server: {
    // PORT env lets a second instance (e.g. a preview/test runner) pick
    // another port without fighting the default dev server.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      "/api": "http://localhost:5275",
    },
  },
});
