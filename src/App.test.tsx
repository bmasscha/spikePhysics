// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

// Auto-cleanup only registers itself when vitest runs with `globals: true`,
// which this project does not; without it renders stack up across tests.
afterEach(cleanup);

// Recharts' ResponsiveContainer observes its box; jsdom has no ResizeObserver.
// The charts then render at zero size, which is fine — this test is about the
// components mounting and the metrics rendering, not about chart geometry.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom has no 2D canvas. SkeletonOverlay already treats a null context as
// "nothing to draw", so returning null exercises that path quietly instead of
// filling the output with not-implemented errors.
HTMLCanvasElement.prototype.getContext = () => null;

// jsdom implements neither the Blob URL store nor any media decoding, so both
// have to be faked. `mediaDuration` stands in for what the demuxer would
// report and is rewritten per test — including the Infinity case that this
// whole code path exists to survive.
let mediaDuration = Number.NaN;
const revokedUrls: string[] = [];

URL.createObjectURL = vi.fn((_source: Blob) => `blob:spikephysics/${Math.random()}`);
URL.revokeObjectURL = vi.fn((url: string) => {
  revokedUrls.push(url);
});

Object.defineProperty(HTMLMediaElement.prototype, "duration", {
  configurable: true,
  get: () => mediaDuration,
});
Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
  configurable: true,
  get: () => 1920,
});
Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
  configurable: true,
  get: () => 1080,
});

beforeEach(() => {
  mediaDuration = Number.NaN;
  revokedUrls.length = 0;
});

/**
 * Renders the app and picks Spike from the technique picker — the app's new
 * entry point, which every test below that exercises capture/review/analysis
 * must get past first. Selects the card the way a coach would: by the card's
 * own call-to-action text, not a test id.
 */
function renderAtCapture() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /analyse a spike/i }));
}

/** Picks a file through the import control, exactly as a coach would. */
function importFile(name = "spike.mp4") {
  const input = screen.getByLabelText(/import video/i) as HTMLInputElement;
  const file = new File(["fake-mp4-bytes"], name, { type: "video/mp4" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  fireEvent.change(input);
}

/** The <video> mounted by the review stage. */
function reviewVideo(): HTMLVideoElement {
  const video = document.querySelector("video");
  if (!video) throw new Error("review stage did not mount a <video>");
  return video as HTMLVideoElement;
}

/** The trim slider's [start, end] range inputs. */
function trimHandles(): [HTMLInputElement, HTMLInputElement] {
  const [start, end] = screen.getAllByRole("slider") as HTMLInputElement[];
  if (!start || !end) throw new Error("trim slider handles not rendered");
  return [start, end];
}

/**
 * Smoke test for the whole UI: mounts the app with no camera available (which
 * is what jsdom gives us, and what a tablet with a blocked camera gives the
 * coach) and walks the demo path through to the dashboard.
 *
 * This catches the class of failure unit tests cannot — a component that throws
 * on mount, a bad import, a metric that renders as "undefined" — without
 * needing a real browser.
 */
describe("App", () => {
  it("mounts and offers a demo path when no camera is available", () => {
    renderAtCapture();
    expect(screen.getByRole("heading", { name: /spike\s*physics/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /demo clip/i })).toBeDefined();
  });

  it("analyses the demo clip and renders the scorecard", () => {
    // Recharts measures its container, which jsdom reports as 0x0.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    renderAtCapture();
    fireEvent.click(screen.getByRole("button", { name: /demo clip/i }));

    expect(screen.getByText(/shoulder abduction at contact/i)).toBeDefined();
    expect(screen.getByText(/elbow extension timing/i)).toBeDefined();
    // "Kinetic chain" appears twice: scorecard title and chart heading.
    expect(screen.getAllByText(/kinetic chain/i).length).toBeGreaterThan(0);

    // The demo spike is built to be textbook: sequenced chain, elite angle.
    expect(screen.getByText(/hip → shoulder → elbow → wrist/)).toBeDefined();
    expect(screen.getByText(/^1(2[89]|3[0-5])\.\d°$/)).toBeDefined();

    // And the session can be wiped again.
    expect(screen.getByRole("button", { name: /delete session/i })).toBeDefined();
  });

  it("wipes state when the session is deleted", () => {
    renderAtCapture();
    fireEvent.click(screen.getByRole("button", { name: /demo clip/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete session/i }));

    expect(screen.queryByText(/shoulder abduction at contact/i)).toBeNull();
    expect(screen.getByRole("button", { name: /demo clip/i })).toBeDefined();
  });
});

/**
 * The app's new entry point. Everything above this line used to be the first
 * screen mounted; now it is one tap away, gated on a technique choice, so
 * that flow gets its own coverage rather than being assumed.
 */
describe("App — technique picker", () => {
  it("is the first thing rendered, and lists every registered technique", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /what are we analysing/i })).toBeDefined();
    // Ready and coming-soon techniques both show up as cards.
    expect(screen.getByRole("button", { name: /analyse a spike/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /serve-receive/i })).toBeDefined();
  });

  it("renders the coming-soon technique but keeps it unselectable", () => {
    render(<App />);

    const comingSoon = screen.getByRole("button", { name: /serve-receive/i });
    expect((comingSoon as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(comingSoon);

    // A disabled control firing its handler anyway would be a real bug: still
    // on the picker, capture screen never mounted.
    expect(screen.getByRole("heading", { name: /what are we analysing/i })).toBeDefined();
    expect(screen.queryByLabelText(/import video/i)).toBeNull();
  });

  it("reaches the capture screen once Spike is chosen", () => {
    renderAtCapture();

    expect(screen.getByLabelText(/import video/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /demo clip/i })).toBeDefined();
  });

  it("exposes the chosen technique in the header, and returning to the picker wipes the session", () => {
    // Recharts measures its container, which jsdom reports as 0x0.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    renderAtCapture();
    fireEvent.click(screen.getByRole("button", { name: /demo clip/i }));
    // Reached the dashboard — confirms there is a real session to wipe. Not
    // "shoulder abduction at contact": that phrase is also a bullet on the
    // picker's own Spike card, so it would pass even with a stale dashboard.
    expect(screen.getByText(/hip → shoulder → elbow → wrist/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /technique: spike/i }));

    // Back at the picker, and the dashboard went with it — not just hidden.
    expect(screen.getByRole("heading", { name: /what are we analysing/i })).toBeDefined();
    expect(screen.queryByText(/hip → shoulder → elbow → wrist/)).toBeNull();
  });
});

/**
 * Import path. jsdom cannot decode anything, so the video element's metadata is
 * faked — which is the point: these tests are about the state machine around
 * the decode, not the decode itself.
 */
describe("App — importing a video", () => {
  it("offers the import control even with no camera available", () => {
    renderAtCapture();
    // jsdom has no getUserMedia, i.e. the `unsupported` state — the control
    // must still be there for a coach whose camera is blocked.
    expect(screen.getByLabelText(/import video/i)).toBeDefined();
  });

  it("does not set the capture attribute, which would force the camera", () => {
    renderAtCapture();
    expect(screen.getByLabelText(/import video/i).hasAttribute("capture")).toBe(false);
  });

  it("moves to review and populates the trim range once metadata resolves", async () => {
    renderAtCapture();
    importFile();

    // Review stage is up, but nothing is processable until a duration is known.
    const processButton = screen.getByRole("button", { name: /reading video/i });
    expect((processButton as HTMLButtonElement).disabled).toBe(true);

    mediaDuration = 4.5;
    fireEvent.loadedMetadata(reviewVideo());

    expect(await screen.findByText(/imported clip · 4\.5s/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /^process video$/i })).toBeDefined();

    // Short clip: the trim window defaults to the whole thing.
    const [start, end] = trimHandles();
    expect(start.value).toBe("0");
    expect(end.value).toBe("4.5");
    expect(end.max).toBe("4.5");
  });

  it("recovers when duration is initially Infinity", async () => {
    renderAtCapture();
    importFile();

    // What Chrome actually reports for a MediaRecorder blob and for some
    // imported containers: metadata arrives, duration does not.
    mediaDuration = Number.POSITIVE_INFINITY;
    fireEvent.loadedMetadata(reviewVideo());

    expect(screen.getByRole("button", { name: /reading video/i })).toBeDefined();

    // The probe seek makes the demuxer walk to the end and announce the truth.
    mediaDuration = 6;
    fireEvent.durationChange(reviewVideo());

    expect(await screen.findByText(/imported clip · 6\.0s/i)).toBeDefined();
    const [, end] = trimHandles();
    expect(end.value).toBe("6");
  });

  it("defaults a long clip to its last seconds and warns if the selection is capped", async () => {
    renderAtCapture();
    importFile("rally.mp4");

    mediaDuration = 24;
    fireEvent.loadedMetadata(reviewVideo());

    // The spike is at the end of a long clip, so that is where the window goes.
    await screen.findByText(/imported clip · 24\.0s/i);
    const [start, end] = trimHandles();
    expect(start.value).toBe("14");
    expect(end.value).toBe("24");
    expect(screen.queryByText(/analysing the first/i)).toBeNull();

    // Widening past the cap must say so rather than truncate silently.
    fireEvent.change(start, { target: { value: "0" } });
    expect(screen.getByText(/analysing the first 10s of your 24\.0s selection/i)).toBeDefined();
  });

  it("surfaces a recovery message when the file cannot be decoded", async () => {
    renderAtCapture();
    importFile("clip.mov");

    fireEvent.error(reviewVideo());

    expect(await screen.findByText(/this video format can't be read on this tablet/i)).toBeDefined();
    // Never a dead-end: the way back to capture is still there.
    expect(screen.getByRole("button", { name: /choose another clip/i })).toBeDefined();
  });

  it("revokes the object URL when a clip is replaced and when the session is deleted", async () => {
    renderAtCapture();

    importFile("first.mp4");
    const firstUrl = reviewVideo().getAttribute("src");
    mediaDuration = 3;
    fireEvent.loadedMetadata(reviewVideo());
    await screen.findByText(/imported clip · 3\.0s/i);

    fireEvent.click(screen.getByRole("button", { name: /choose another clip/i }));
    expect(revokedUrls).toContain(firstUrl);

    importFile("second.mp4");
    const secondUrl = reviewVideo().getAttribute("src");
    fireEvent.click(screen.getByRole("button", { name: /delete session/i }));

    await waitFor(() => expect(revokedUrls).toContain(secondUrl));
  });
});
