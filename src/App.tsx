import { useCallback, useEffect, useRef, useState } from "react";
import AnalysisDashboard from "./components/AnalysisDashboard";
import CameraModule from "./components/CameraModule";
import TrimSlider from "./components/TrimSlider";
import { analyzeSequence } from "./lib/biomechanics";
import { generateMockSequence } from "./lib/mockData";
import { disposePoseLandmarker, PoseEngineError, processVideoElement } from "./lib/poseEngine";
import { smoothSequence } from "./lib/smoothing";
import { resolveVideoDuration, UNREADABLE_VIDEO_HINT } from "./lib/videoDuration";
import type { AnalysisResult, PoseSequence } from "./types/pose";

type Stage = "capture" | "review" | "analysis";

/** Where the clip came from. Only used for copy, never for pipeline branching. */
type ClipSource = "recording" | "import";

/** Whether a real duration is known yet for the clip sitting in review. */
type ClipStatus = "reading" | "ready" | "unreadable";

/**
 * Longest window the analysis will actually process, in seconds.
 *
 * An imported clip can be minutes long; at ~30 samples/s that is thousands of
 * MediaPipe inferences and a locked-up tablet. When the coach's selection is
 * longer we process the FIRST MAX_ANALYSIS_SECONDS of it — the window then
 * starts exactly where they put the start handle — and say so on screen. The
 * one thing we never do is truncate silently.
 */
const MAX_ANALYSIS_SECONDS = 10;

/**
 * How long to wait for `loadedmetadata` before declaring the file unreadable.
 * A container the browser cannot demux (some HEVC/MOV off an iPhone, opened in
 * a non-Apple browser) sometimes fires nothing at all rather than `error`, so a
 * timeout is the only way to avoid a dead-end spinner.
 */
const METADATA_TIMEOUT_MS = 8000;

interface Clip {
  url: string;
  source: ClipSource;
  duration: number;
  start: number;
  end: number;
}

/**
 * Initial trim window for a freshly loaded clip.
 *
 * For a long clip the spike is almost always at the end — the coach films the
 * rally and stops after the hit — so default to the last MAX_ANALYSIS_SECONDS
 * rather than the first, which would otherwise analyse the approach of the
 * previous point. Both handles stay fully adjustable. Short clips keep the
 * whole 0..duration range, as before.
 */
function defaultTrimWindow(duration: number): { start: number; end: number } {
  return duration > MAX_ANALYSIS_SECONDS
    ? { start: duration - MAX_ANALYSIS_SECONDS, end: duration }
    : { start: 0, end: duration };
}

/**
 * Test seam for the chart-layout regression suite.
 *
 * The layout bug only reproduces when a real <video> with an intrinsic size is
 * mounted in the dashboard, but reaching the analysis stage from real footage
 * needs the pose model — which is not committed, and would find no player in a
 * synthetic fixture anyway. `?demoVideo=<name>` renders the mock analysis with
 * a real video element in place of the placeholder, producing exactly the DOM
 * the recorded path produces.
 *
 * The value is resolved against BASE_URL and stripped of anything that could
 * point off-origin, so this cannot be turned into a "fetch a remote video"
 * lever — nothing leaves the device (§5). Coaches never type a URL; this is
 * invisible to them.
 */
function demoVideoUrlFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const name = new URLSearchParams(window.location.search).get("demoVideo");
  if (!name) return null;
  const safe = name.split(/[/\\]/).pop();
  return safe ? `${import.meta.env.BASE_URL}${safe}` : null;
}

export default function App() {
  const reviewVideoRef = useRef<HTMLVideoElement>(null);
  /**
   * The object URL currently held open. Kept in a ref rather than read off
   * `clip` so revoking never depends on which render a callback closed over —
   * a stale closure here means a leaked blob (the whole video stays pinned in
   * memory until the tab dies).
   */
  const clipUrlRef = useRef<string | null>(null);

  const [stage, setStage] = useState<Stage>("capture");
  const [clip, setClip] = useState<Clip | null>(null);
  const [clipStatus, setClipStatus] = useState<ClipStatus>("reading");
  const [sequence, setSequence] = useState<PoseSequence | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Wipes everything. Nothing was ever written to disk — footage and landmarks
   * live only in this tab's memory — so dropping state and revoking the object
   * URL is a complete erase (§5).
   */
  const deleteSession = useCallback(() => {
    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = null;
    }
    setClip(null);
    setClipStatus("reading");
    setSequence(null);
    setAnalysis(null);
    setError(null);
    setProgress(0);
    setStage("capture");
    disposePoseLandmarker();
  }, []);

  /**
   * Single entry point for both capture routes. Recordings and imports share
   * one code path from here on: object URL → review → trim → processVideoElement.
   */
  const adoptClip = useCallback((url: string, source: ClipSource) => {
    // Replacing a clip must free the previous one first, or every re-take
    // leaks another full video into memory.
    if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    clipUrlRef.current = url;

    setClip({ url, source, duration: 0, start: 0, end: 0 });
    setClipStatus("reading");
    setSequence(null);
    setAnalysis(null);
    setProgress(0);
    setError(null);
    setStage("review");
  }, []);

  const handleClipRecorded = useCallback(
    (_blob: Blob, url: string) => adoptClip(url, "recording"),
    [adoptClip],
  );

  const handleVideoImported = useCallback(
    (_file: File, url: string) => adoptClip(url, "import"),
    [adoptClip],
  );

  const handleUseMockData = useCallback(() => {
    const mock = smoothSequence(generateMockSequence());
    setSequence(mock);
    setAnalysis(analyzeSequence(mock));
    // Normally the demo dashboard has no video attached. See
    // demoVideoUrlFromLocation for the one exception.
    const demoVideo = demoVideoUrlFromLocation();
    setClip(
      demoVideo ? { url: demoVideo, source: "import", duration: 0, start: 0, end: 0 } : null,
    );
    setStage("analysis");
  }, []);

  const clipUrl = clip?.url ?? null;

  /**
   * Resolves the clip's real duration once it is mounted in the review stage.
   *
   * This replaces the old `if (Number.isFinite(duration))` guard, which
   * silently skipped the update on the very common `duration === Infinity`
   * case and left the trim range at 0..0, so "Process video" failed with
   * "Video metadata not ready". See lib/videoDuration.ts for why Infinity
   * happens and how it is forced to resolve.
   */
  useEffect(() => {
    if (stage !== "review" || !clipUrl) return;
    const video = reviewVideoRef.current;
    if (!video) return;

    let cancelled = false;

    const fail = () => {
      if (cancelled) return;
      window.clearTimeout(metadataTimer);
      setClipStatus("unreadable");
      setError(UNREADABLE_VIDEO_HINT);
    };

    const onMetadata = () => {
      if (cancelled) return;
      window.clearTimeout(metadataTimer);
      resolveVideoDuration(video).then((duration) => {
        if (cancelled) return;
        setClipStatus("ready");
        setClip((current) =>
          current && current.url === clipUrl
            ? { ...current, duration, ...defaultTrimWindow(duration) }
            : current,
        );
      }, fail);
    };

    const metadataTimer = window.setTimeout(fail, METADATA_TIMEOUT_MS);

    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("error", fail);

    // The element may already have loaded (or failed) before this effect ran,
    // in which case no further event is coming.
    if (video.error) fail();
    else if (video.readyState >= 1 /* HAVE_METADATA */) onMetadata();

    return () => {
      cancelled = true;
      window.clearTimeout(metadataTimer);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("error", fail);
    };
  }, [stage, clipUrl]);

  const selectionSeconds = clip ? clip.end - clip.start : 0;
  const selectionCapped = selectionSeconds > MAX_ANALYSIS_SECONDS;

  const process = useCallback(async () => {
    const video = reviewVideoRef.current;
    if (!video || !clip || clipStatus !== "ready") return;

    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const raw = await processVideoElement(video, {
        startSeconds: clip.start,
        // The cap is applied here, at the one place that decides how much work
        // the tablet does. See MAX_ANALYSIS_SECONDS.
        endSeconds: Math.min(clip.end, clip.start + MAX_ANALYSIS_SECONDS),
        onProgress: setProgress,
      });
      const smoothed = smoothSequence(raw);
      setSequence(smoothed);
      setAnalysis(analyzeSequence(smoothed));
      setStage("analysis");
    } catch (err) {
      setError(
        err instanceof PoseEngineError
          ? err.hint
          : "Processing failed. Trim to a shorter window and try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [clip, clipStatus]);

  const processLabel = busy
    ? `Processing… ${Math.round(progress * 100)}%`
    : clipStatus === "ready"
      ? "Process video"
      : clipStatus === "reading"
        ? "Reading video…"
        : "Can't read this video";

  return (
    <div className="flex h-full flex-col gap-3 p-safe">
      <header className="flex items-center justify-between px-safe-1">
        <h1 className="text-xl font-black tracking-tight">
          Spike<span className="text-signal-accent">Physics</span>
        </h1>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-slate-500 sm:inline">
            100% on this tablet · nothing uploaded
          </span>
          {stage !== "capture" && (
            <button className="btn-danger" onClick={deleteSession}>
              Delete session
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="rounded-2xl border border-signal-danger/40 bg-signal-danger/10 p-3 text-signal-danger">
          {error}
        </p>
      )}

      <main className="min-h-0 flex-1">
        {stage === "capture" && (
          <CameraModule
            onClipRecorded={handleClipRecorded}
            onVideoImported={handleVideoImported}
            onUseMockData={handleUseMockData}
          />
        )}

        {stage === "review" && clip && (
          <div className="grid h-full gap-4 split:grid-cols-2">
            <div className="overflow-hidden rounded-3xl bg-black">
              <video
                ref={reviewVideoRef}
                src={clip.url}
                playsInline
                muted
                preload="auto"
                className="h-full w-full object-contain"
              />
            </div>

            <div className="flex flex-col justify-center gap-4">
              <p className="px-1 text-sm text-slate-400">
                {clipStatus === "ready"
                  ? `${clip.source === "import" ? "Imported clip" : "Recorded clip"} · ${clip.duration.toFixed(1)}s`
                  : clipStatus === "reading"
                    ? "Reading video…"
                    : "This clip could not be read."}
              </p>

              <TrimSlider
                duration={clip.duration}
                start={clip.start}
                end={clip.end}
                onChange={(range) => setClip((c) => (c ? { ...c, ...range } : c))}
                onScrub={(seconds) => {
                  if (reviewVideoRef.current) reviewVideoRef.current.currentTime = seconds;
                }}
              />

              {selectionCapped && (
                <p className="rounded-2xl border border-signal-accent/40 bg-signal-accent/10 p-3 text-sm text-slate-200">
                  Analysing the first {MAX_ANALYSIS_SECONDS}s of your{" "}
                  {selectionSeconds.toFixed(1)}s selection — trim closer to the swing for
                  the full window.
                </p>
              )}

              <button
                className="btn-primary h-16"
                onClick={() => void process()}
                disabled={busy || clipStatus !== "ready"}
              >
                {processLabel}
              </button>

              <button className="btn-ghost" onClick={deleteSession} disabled={busy}>
                Choose another clip
              </button>
            </div>
          </div>
        )}

        {stage === "analysis" && sequence && analysis && (
          <AnalysisDashboard
            sequence={sequence}
            analysis={analysis}
            videoUrl={clip?.url ?? null}
            clipStart={clip?.start ?? 0}
          />
        )}
      </main>
    </div>
  );
}
