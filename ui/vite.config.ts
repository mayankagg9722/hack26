import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the Dew-based Integrations and Migration agent pages into ../app/integrations,
// which Firebase Hosting serves next to the existing static pages.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../app/integrations",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: { "zen-integrations": "src/main.tsx", "zen-agent": "src/agentMain.tsx" },
      output: {
        entryFileNames: "[name].js",
        assetFileNames: (a) => (a.name && a.name.endsWith(".css") ? "zen-integrations.css" : "assets/[name][extname]"),
      },
    },
  },
});
