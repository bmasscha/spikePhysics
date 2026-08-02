/**
 * videoDuration.ts — force a real duration out of a <video> element.
 *
 * Why this exists: Chrome's MediaRecorder writes WebM blobs whose header
 * carries no duration (the length is only known once recording stops, by which
 * point the header has already been flushed), and several imported containers
 * behave the same way — fragmented MP4 straight off a phone in particular.
 * `video.duration` then reads `Infinity` even after `loadedmetadata`, and stays
 * that way until the element is seeked past the end: at that point the demuxer
 * has walked to the last cluster and fires `durationchange` with the real
 * value.
 *
 * Without this workaround the trim range stays 0..0 and "Process video" fails
 * with "Video metadata not ready" — which is exactly the reported bug.
 */

/**
 * How long to wait for a duration before declaring the file unreadable. Five
 * seconds is generous for a local file (no network is involved) but short
 * enough that a coach is not left staring at a spinner on a container the
 * browser silently cannot demux.
 */
export const DURATION_RESOLVE_TIMEOUT_MS = 5000;

/**
 * Seek target used to provoke the demuxer. Any time past the end works — the
 * browser clamps the request to the real end rather than erroring — and
 * MAX_SAFE_INTEGER is guaranteed to be past the end of any real clip.
 */
const PROBE_SEEK_SECONDS = Number.MAX_SAFE_INTEGER;

/**
 * Coach-facing recovery text, phrased like `PoseEngineError.hint`: name the
 * problem, then give one concrete action.
 */
export const UNREADABLE_VIDEO_HINT =
  "This video format can't be read on this tablet. Re-record in the camera app " +
  "using H.264/MP4, or record directly in SpikePhysics.";

/** True once `video.duration` is a real, usable number of seconds. */
export function hasUsableDuration(video: HTMLVideoElement): boolean {
  return Number.isFinite(video.duration) && video.duration > 0;
}

/**
 * Resolves with a finite, positive duration in seconds, applying the
 * seek-to-the-end workaround when the browser reports `Infinity`.
 *
 * Rejects if the element errors out or if no duration ever materialises within
 * `timeoutMs` — callers should surface {@link UNREADABLE_VIDEO_HINT} in that
 * case rather than leaving a dead-end spinner.
 */
export function resolveVideoDuration(
  video: HTMLVideoElement,
  timeoutMs: number = DURATION_RESOLVE_TIMEOUT_MS,
): Promise<number> {
  if (hasUsableDuration(video)) return Promise.resolve(video.duration);

  return new Promise<number>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("durationchange", check);
      video.removeEventListener("seeked", check);
      video.removeEventListener("error", onError);
    };

    const succeed = (duration: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Put the play-head back to the start so the review poster frame and the
      // trim slider agree. Best-effort: some elements reject a seek while still
      // buffering, and by this point we already have what we came for.
      try {
        video.currentTime = 0;
      } catch {
        // Ignored on purpose — the duration is resolved either way.
      }
      resolve(duration);
    };

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    function check() {
      if (hasUsableDuration(video)) succeed(video.duration);
    }

    function onError() {
      fail("The video element reported a decode error while reading its duration");
    }

    const timer = window.setTimeout(
      () => fail(`Duration never resolved within ${timeoutMs} ms`),
      timeoutMs,
    );

    video.addEventListener("durationchange", check);
    video.addEventListener("seeked", check);
    video.addEventListener("error", onError);

    // The provocation itself. Assigning currentTime is what makes the demuxer
    // scan to the end; `durationchange` (or `seeked`) then carries the answer.
    try {
      video.currentTime = PROBE_SEEK_SECONDS;
    } catch {
      // Some engines throw on an out-of-range seek instead of clamping. The
      // listeners stay attached, so a late `durationchange` still wins; if none
      // arrives the timeout reports the failure.
    }

    // A `durationchange` may already have fired between the readiness check
    // above and the listeners being attached.
    check();
  });
}
