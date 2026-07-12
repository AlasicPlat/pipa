import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Creates the shared Vite configuration for web tests and Tauri builds.
 * Parameters: none.
 * @returns A promise resolving to the Vite user configuration.
 * Side effects: creates the React plugin instance used by Vite.
 */
async function createViteConfig(): Promise<UserConfig> {
  return {
    plugins: [react()],

    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
}

export default defineConfig(createViteConfig);
