import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import { existsSync, readFileSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

function appVersionLabel(): string {
  try {
    if (existsSync(new URL("./src/build-stamp.ts", import.meta.url))) {
      const text = readFileSync(new URL("./src/build-stamp.ts", import.meta.url), "utf8");
      const match = text.match(/APP_VERSION_LABEL = "([^"]+)"/);
      if (match?.[1]) return match[1];
    }
  } catch {
    /* dev builds stay on the placeholder */
  }
  return "0.1.0+dev";
}

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION_LABEL__: JSON.stringify(appVersionLabel()),
  },
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
