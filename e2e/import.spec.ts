import { expect, test } from "@playwright/test";
import { LANDSCAPE_CLIP } from "./fixtures";

/**
 * The import path in a real browser, which is the only place the
 * `duration: Infinity` workaround can actually be exercised — the fixtures are
 * MediaRecorder WebM, so they report an infinite duration until seeked, exactly
 * like a clip recorded in the app.
 */
test.describe("importing a video", () => {
  test("a picked file reaches the review stage with a real duration", async ({ page }) => {
    await page.goto("./");

    await page.getByLabel(/import video/i).setInputFiles(LANDSCAPE_CLIP);

    await expect(page.getByRole("button", { name: /process video/i })).toBeEnabled({
      timeout: 15_000,
    });
    await expect(page.getByText(/imported clip · \d+\.\d+s/i)).toBeVisible();

    // The trim handles are what the resolved duration feeds; 0..0 was the
    // symptom of the Infinity bug.
    const end = page.getByLabel(/clip end/i);
    await expect.poll(() => end.inputValue().then(Number)).toBeGreaterThan(0);

    const video = page.locator("main video");
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.duration))
      .toBeLessThan(Number.POSITIVE_INFINITY);
  });

  test("the import control works with no camera available", async ({ page }) => {
    // The Playwright browser has no camera, which is the same state a coach
    // sees after blocking the permission — the import control must still work.
    await page.goto("./");
    await expect(page.getByLabel(/import video/i)).toBeAttached();
    await page.getByLabel(/import video/i).setInputFiles(LANDSCAPE_CLIP);
    await expect(page.getByRole("button", { name: /choose another clip/i })).toBeVisible();
  });
});
