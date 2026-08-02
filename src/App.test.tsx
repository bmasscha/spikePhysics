// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    render(<App />);
    expect(screen.getByText(/SpikePhysics|Spike/)).toBeDefined();
    expect(screen.getByRole("button", { name: /demo clip/i })).toBeDefined();
  });

  it("analyses the demo clip and renders the scorecard", () => {
    // Recharts measures its container, which jsdom reports as 0x0.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    render(<App />);
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
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /demo clip/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete session/i }));

    expect(screen.queryByText(/shoulder abduction at contact/i)).toBeNull();
    expect(screen.getByRole("button", { name: /demo clip/i })).toBeDefined();
  });
});
