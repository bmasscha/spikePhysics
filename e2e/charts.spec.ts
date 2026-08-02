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

  test("rotating mid-session preserves video node state and covers video box", async ({ page }) => {
    await serveDemoVideo(page, LANDSCAPE_CLIP);
    await openDashboard(page, `?demoVideo=${DEMO_VIDEO_NAME}`);

    const video = page.locator("main video");
    await expect(video).toBeVisible();

    // Wait until the video's metadata is loaded and seekable
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState))
      .toBeGreaterThanOrEqual(3);

    // Play the video briefly to move its currentTime past 0
    await video.evaluate(async (el: HTMLVideoElement) => {
      el.muted = true;
      await el.play();
    });

    // Wait until currentTime has advanced past 0
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
      .toBeGreaterThan(0.1);

    // Pause the video to hold its current state
    await video.evaluate((el: HTMLVideoElement) => {
      el.pause();
    });

    // Retrieve the exact time it paused at
    const initialTime = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    expect(initialTime).toBeGreaterThan(0.1);

    // Mark the video element to track its DOM identity
    await video.evaluate((el: HTMLVideoElement) => {
      el.dataset.testIdentityMarker = "rotation-survivor";
    });

    // Check pre-rotation viewport dynamics
    const originalViewport = page.viewportSize()!;
    const targetWidth = originalViewport.height;
    const targetHeight = originalViewport.width;

    // Rotate the screen by swapping viewport axes
    await page.setViewportSize({ width: targetWidth, height: targetHeight });

    // Assert video element identity survives and currentTime is preserved
    const videoData = await video.evaluate((el: HTMLVideoElement) => ({
      marker: el.dataset.testIdentityMarker,
      currentTime: el.currentTime,
    }));
    expect(videoData.marker, "video node identity should be preserved").toBe("rotation-survivor");
    expect(videoData.currentTime, "video currentTime should not reset").toBeCloseTo(initialTime, 2);

    // Assert both chart panels are still taller than 100 px and still reachable
    for (const id of PANELS) {
      await expectPanelUsable(page, page.getByTestId(id), `${id} (rotated)`);
    }

    // Assert skeleton canvas covers the video box (its boundaries are identical or overlap the video element)
    const canvas = page.locator("main canvas");
    await expect(canvas).toBeVisible();
    const videoBox = (await video.boundingBox())!;
    const canvasBox = (await canvas.boundingBox())!;

    // Bounding boxes should match or be almost exactly equal (within small layout tolerance)
    expect(canvasBox.width).toBeCloseTo(videoBox.width, 1);
    expect(canvasBox.height).toBeCloseTo(videoBox.height, 1);
    expect(canvasBox.x).toBeCloseTo(videoBox.x, 1);
    expect(canvasBox.y).toBeCloseTo(videoBox.y, 1);
  });

  test("simulated safe-area inset shifts the outer shell and header padding", async ({ page }) => {
    await serveDemoVideo(page, LANDSCAPE_CLIP);
    await openDashboard(page, `?demoVideo=${DEMO_VIDEO_NAME}`);

    const outerShell = page.locator(".p-safe");
    await expect(outerShell).toBeVisible();

    // Measure original padding / styles of outerShell and header in base condition (no safe area inset)
    const initialStyles = await page.evaluate(() => {
      const shell = document.querySelector(".p-safe")!;
      const header = document.querySelector(".px-safe-1")!;
      const shellStyle = window.getComputedStyle(shell);
      const headerStyle = window.getComputedStyle(header);
      return {
        shellLeft: parseFloat(shellStyle.paddingLeft),
        shellTop: parseFloat(shellStyle.paddingTop),
        headerLeft: parseFloat(headerStyle.paddingLeft),
      };
    });

    expect(initialStyles.shellLeft).toBe(12);
    expect(initialStyles.shellTop).toBe(12);
    expect(initialStyles.headerLeft).toBe(4);

    // Simulate safe area inset by setting CSS variables
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-area-left", "40px");
      document.documentElement.style.setProperty("--safe-area-top", "24px");
      document.documentElement.style.setProperty("--safe-area-right", "40px");
      document.documentElement.style.setProperty("--safe-area-bottom", "24px");
    });

    // Verify paddings are updated to at least the safe area bounds
    const updatedStyles = await page.evaluate(() => {
      const shell = document.querySelector(".p-safe")!;
      const header = document.querySelector(".px-safe-1")!;
      const shellStyle = window.getComputedStyle(shell);
      const headerStyle = window.getComputedStyle(header);
      return {
        shellLeft: parseFloat(shellStyle.paddingLeft),
        shellTop: parseFloat(shellStyle.paddingTop),
        headerLeft: parseFloat(headerStyle.paddingLeft),
      };
    });

    expect(updatedStyles.shellLeft).toBe(40);
    expect(updatedStyles.shellTop).toBe(24);
    expect(updatedStyles.headerLeft).toBe(40); // px-safe-1 has max(0.25rem, env(safe-area-inset-left)) which should be 40px
  });
});
