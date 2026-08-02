import { expect, test, type Locator, type Page } from "@playwright/test";
import { DEMO_VIDEO_NAME, LANDSCAPE_CLIP, PORTRAIT_CLIP, serveDemoVideo } from "./fixtures";

/**
 * Regression cover for the bug where the two Recharts panels were invisible
 * after processing real footage while the demo path rendered them fine.
 *
 * jsdom has no layout engine, so vitest cannot see a panel collapsed to zero
 * height — which is exactly why the bug shipped. Everything here is measured in
 * a real browser at real tablet viewports.
 */

/** A trace squeezed below this is unreadable on a 10-inch tablet. */
const MIN_PANEL_HEIGHT = 100;

const PANELS = ["chart-joint-speed", "chart-angles"] as const;

async function openDashboard(page: Page, query = ""): Promise<void> {
  await page.goto(`./${query}`);
  await page.getByRole("button", { name: /demo clip/i }).click();
  await expect(page.getByTestId("chart-joint-speed")).toBeAttached();
}

/**
 * Asserts a panel is really on screen: laid out at a usable size, and reachable
 * by scrolling rather than clipped inside a zero-height overflow container.
 */
async function expectPanelUsable(page: Page, panel: Locator, label: string): Promise<void> {
  await panel.scrollIntoViewIfNeeded();
  await expect(panel, `${label} should be visible`).toBeVisible();

  const box = await panel.boundingBox();
  expect(box, `${label} should have a layout box`).not.toBeNull();
  expect(box!.height, `${label} height`).toBeGreaterThan(MIN_PANEL_HEIGHT);
  expect(box!.width, `${label} width`).toBeGreaterThan(MIN_PANEL_HEIGHT);

  // Inside the viewport after scrolling — the old bug left the panels laid out
  // hundreds of pixels below a container clipped to 0 px tall, so they could
  // never be scrolled to.
  const viewport = page.viewportSize()!;
  expect(box!.y, `${label} top within viewport`).toBeLessThan(viewport.height);
  expect(box!.y + box!.height, `${label} bottom within viewport`).toBeGreaterThan(0);
}

test.describe("chart visibility", () => {
  test("demo clip renders both chart panels", async ({ page }) => {
    await openDashboard(page);
    for (const id of PANELS) {
      await expectPanelUsable(page, page.getByTestId(id), `${id} (demo)`);
    }
  });

  for (const [name, clip] of [
    ["landscape", LANDSCAPE_CLIP],
    ["portrait", PORTRAIT_CLIP],
  ] as const) {
    test(`renders both chart panels with a real ${name} video attached`, async ({ page }) => {
      await serveDemoVideo(page, clip);
      await openDashboard(page, `?demoVideo=${DEMO_VIDEO_NAME}`);

      // The video really is mounted and decoded — otherwise this test would
      // pass for the same reason the demo path always did.
      const video = page.locator("main video");
      await expect(video).toBeVisible();
      await expect
        .poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth))
        .toBeGreaterThan(0);

      for (const id of PANELS) {
        await expectPanelUsable(page, page.getByTestId(id), `${id} (${name} video)`);
      }
    });
  }

  test("the video cannot push the layout past its container", async ({ page }) => {
    await serveDemoVideo(page, PORTRAIT_CLIP);
    await openDashboard(page, `?demoVideo=${DEMO_VIDEO_NAME}`);

    const video = page.locator("main video");
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.videoHeight))
      .toBeGreaterThan(0);

    // A tall portrait clip is the worst case: its intrinsic height is what used
    // to inflate the first row and squeeze the chart row to nothing.
    const box = await video.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  });

  test("clicking a chart moves the play-head", async ({ page }) => {
    await serveDemoVideo(page, LANDSCAPE_CLIP);
    await openDashboard(page, `?demoVideo=${DEMO_VIDEO_NAME}`);

    const readout = page.getByText(/^frame \d+\/\d+ · (left|right) arm$/);
    await expect(readout).toBeVisible();
    const before = await readout.textContent();

    const panel = page.getByTestId("chart-joint-speed");
    await panel.scrollIntoViewIfNeeded();
    const box = (await panel.boundingBox())!;
    // Click well inside the plot area, away from the current play-head.
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.6);

    await expect(readout).not.toHaveText(before!);
  });
});
