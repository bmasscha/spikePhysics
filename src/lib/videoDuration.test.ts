// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVideoDuration } from "./videoDuration";

/**
 * Builds a <video> whose `duration` is driven by a variable the test controls,
 * so the Infinity → finite transition can be replayed without a real decode.
 */
function fakeVideo(initial: number) {
  const video = document.createElement("video");
  let duration = initial;
  Object.defineProperty(video, "duration", {
    configurable: true,
    get: () => duration,
  });
  return {
    video,
    /** Mimics the demuxer learning the real length after the probe seek. */
    settle(seconds: number) {
      duration = seconds;
      video.dispatchEvent(new Event("durationchange"));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveVideoDuration", () => {
  it("returns immediately when the duration is already finite", async () => {
    const { video } = fakeVideo(3.5);
    await expect(resolveVideoDuration(video)).resolves.toBe(3.5);
  });

  it("recovers from duration: Infinity once the probe seek settles", async () => {
    const { video, settle } = fakeVideo(Number.POSITIVE_INFINITY);

    const pending = resolveVideoDuration(video);
    settle(7.25);

    await expect(pending).resolves.toBe(7.25);
  });

  it("ignores a durationchange that still reports Infinity", async () => {
    const { video, settle } = fakeVideo(Number.POSITIVE_INFINITY);

    const pending = resolveVideoDuration(video);
    settle(Number.POSITIVE_INFINITY);
    settle(2);

    await expect(pending).resolves.toBe(2);
  });

  it("treats a zero duration as unusable rather than a valid clip", async () => {
    vi.useFakeTimers();
    const { video } = fakeVideo(0);

    const pending = resolveVideoDuration(video, 100);
    const assertion = expect(pending).rejects.toThrow(/never resolved/i);
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });

  it("rejects when no duration ever arrives", async () => {
    vi.useFakeTimers();
    const { video } = fakeVideo(Number.NaN);

    const pending = resolveVideoDuration(video, 500);
    const assertion = expect(pending).rejects.toThrow(/never resolved within 500 ms/i);
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
  });

  it("rejects when the element reports a decode error", async () => {
    const { video } = fakeVideo(Number.NaN);

    const pending = resolveVideoDuration(video);
    const assertion = expect(pending).rejects.toThrow(/decode error/i);
    video.dispatchEvent(new Event("error"));
    await assertion;
  });
});
