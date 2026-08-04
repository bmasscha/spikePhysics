import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

export const LANDSCAPE_CLIP = fileURLToPath(
  new URL("./fixtures/swing-landscape.webm", import.meta.url),
);
export const PORTRAIT_CLIP = fileURLToPath(
  new URL("./fixtures/swing-portrait.webm", import.meta.url),
);

/** Filename the app is asked to load via ?demoVideo=; served by the route below. */
export const DEMO_VIDEO_NAME = "e2e-clip.webm";

/**
 * Serves a fixture at the URL the ?demoVideo= seam resolves to, so the clip
 * never has to ship in the production bundle.
 */
export async function serveDemoVideo(page: Page, clipPath: string): Promise<void> {
  await page.route(`**/${DEMO_VIDEO_NAME}`, (route) =>
    route.fulfill({ path: clipPath, contentType: "video/webm" }),
  );
}

/**
 * Navigates to the app and picks Spike from the technique picker, landing on
 * the capture screen. The app now opens on "what are we analysing?" rather
 * than the camera/import screen directly, so every spec that used to
 * `page.goto("./")` and expect capture-screen controls needs this first.
 */
export async function gotoSpikeCapture(page: Page, query = ""): Promise<void> {
  await page.goto(`./${query}`);
  await page.getByRole("button", { name: /analyse a spike/i }).click();
}
