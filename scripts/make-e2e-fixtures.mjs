/**
 * Generates the tiny video fixtures the Playwright suite imports.
 *
 * The e2e tests need a real <video> with a real intrinsic size — that is the
 * whole point of the chart-layout regression test — but committing a phone clip
 * would bloat the repo. Chromium can make one for us: draw a moving shape on a
 * canvas, capture the stream, and let MediaRecorder encode a couple of seconds
 * of VP8. The result is a few kilobytes.
 *
 * The output is committed, so CI never runs this. Re-run it only if the
 * fixtures need to change:  node scripts/make-e2e-fixtures.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "e2e", "fixtures");

/**
 * Portrait is the interesting case: a tall intrinsic height is what can inflate
 * a grid row and squeeze the charts out of view. Landscape is the common one.
 */
const FIXTURES = [
  { name: "swing-landscape.webm", width: 640, height: 360 },
  { name: "swing-portrait.webm", width: 360, height: 640 },
];

const DURATION_MS = 2000;
const FPS = 15;

async function record(page, { width, height }) {
  return page.evaluate(
    async ({ width, height, durationMs, fps }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");

      const stream = canvas.captureStream(fps);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      const done = new Promise((resolveDone) => {
        recorder.onstop = () => resolveDone();
      });

      recorder.start();
      const startedAt = performance.now();
      await new Promise((resolveDraw) => {
        const draw = () => {
          const t = (performance.now() - startedAt) / durationMs;
          ctx.fillStyle = "#020617";
          ctx.fillRect(0, 0, width, height);
          // A single moving dot keeps every frame distinct, so the encoder
          // cannot collapse the clip into one keyframe and report a zero
          // duration.
          ctx.fillStyle = "#22d3ee";
          ctx.beginPath();
          ctx.arc(width * (0.2 + 0.6 * t), height * 0.5, Math.min(width, height) * 0.08, 0, 7);
          ctx.fill();
          if (t >= 1) resolveDraw();
          else requestAnimationFrame(draw);
        };
        draw();
      });
      recorder.stop();
      await done;

      const blob = new Blob(chunks, { type: "video/webm" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return Array.from(bytes);
    },
    { width, height, durationMs: DURATION_MS, fps: FPS },
  );
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");
await mkdir(OUT_DIR, { recursive: true });

for (const fixture of FIXTURES) {
  const bytes = await record(page, fixture);
  const target = resolve(OUT_DIR, fixture.name);
  await writeFile(target, Buffer.from(bytes));
  console.log(`${fixture.name}: ${fixture.width}x${fixture.height}, ${bytes.length} bytes`);
}

await browser.close();
