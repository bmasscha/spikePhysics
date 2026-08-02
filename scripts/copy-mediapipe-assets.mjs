/**
 * Vendors the MediaPipe Wasm runtime into public/wasm so the app can be served
 * — and cached by the service worker — with no CDN dependency at all (§2, §5).
 *
 * Runs automatically on `npm install`. The .task model file is NOT downloaded
 * here: it is ~9 MB, licensed separately, and fetching it would make the
 * install require a network. See public/models/README.md.
 */

import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const target = join(root, "public", "wasm");

if (!existsSync(source)) {
  console.warn(
    "[assets] @mediapipe/tasks-vision not installed yet — skipping Wasm copy.",
  );
  process.exit(0);
}

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

const files = await readdir(target);
console.log(`[assets] Copied ${files.length} MediaPipe Wasm files to public/wasm`);

if (!existsSync(join(root, "public", "models", "pose_landmarker_full.task"))) {
  console.warn(
    "[assets] Missing public/models/pose_landmarker_full.task — the app will run " +
      "in mock mode only. See public/models/README.md for the download link.",
  );
}
