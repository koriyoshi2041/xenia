import { defineConfig } from "vite";
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": process.env.GFH_BACKEND ?? "http://127.0.0.1:8787",
      "/healthz": process.env.GFH_BACKEND ?? "http://127.0.0.1:8787",
    },
  },
});
