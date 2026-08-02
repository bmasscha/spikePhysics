/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages serves this repo at /spikePhysics/, so the production build has
// to be base-aware. Dev stays at "/" to keep localhost URLs simple. Anything
// loading an asset at runtime must use import.meta.env.BASE_URL, never a
// leading-slash path — see src/lib/poseEngine.ts.
const BASE = "/spikePhysics/";

export default defineConfig(({ command, isPreview }) => ({
  // `vite preview` reports command === "serve", so without isPreview it would
  // serve the production bundle at "/" while index.html asks for
  // /spikePhysics/assets/* — every script 404s and the page renders blank.
  // Previewing a build is the only local way to exercise the base path, so it
  // has to match production.
  base: command === "build" || isPreview ? BASE : "/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // The Wasm runtime and the .task model live in public/ and are precached so
      // the very first offline open in a gym already has everything it needs.
      includeAssets: ["wasm/**/*", "models/**/*"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,wasm,task}"],
        // pose_landmarker_full.task is ~9 MB; the default 2 MB cap would skip it.
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
      },
      manifest: {
        name: "SpikePhysics",
        short_name: "SpikePhysics",
        description: "On-court volleyball spike biomechanics, fully offline",
        theme_color: "#020617",
        background_color: "#020617",
        display: "fullscreen",
        orientation: "any",
        // Relative, so the installed app works both at the domain root and
        // under the /spikePhysics/ project path.
        id: "./",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Split the two heavyweights out of the app chunk so a code change
        // does not force tablets to re-download them on the next update.
        manualChunks: {
          mediapipe: ["@mediapipe/tasks-vision"],
          charts: ["recharts"],
        },
      },
    },
  },
  server: {
    host: true, // reachable from the tablet over the local network during dev
  },
  test: {
    // Physics tests run in plain node; UI tests opt into jsdom per file.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
