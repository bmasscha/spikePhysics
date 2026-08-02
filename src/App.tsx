import { useCallback, useRef, useState } from "react";
import AnalysisDashboard from "./components/AnalysisDashboard";
import CameraModule from "./components/CameraModule";
import TrimSlider from "./components/TrimSlider";
import { analyzeSequence } from "./lib/biomechanics";
import { generateMockSequence } from "./lib/mockData";
import { disposePoseLandmarker, PoseEngineError, processVideoElement } from "./lib/poseEngine";
import { smoothSequence } from "./lib/smoothing";
import type { AnalysisResult, PoseSequence } from "./types/pose";

type Stage = "capture" | "review" | "analysis";

interface Clip {
  url: string;
  duration: number;
  start: number;
  end: number;
}

export default function App() {
  const reviewVideoRef = useRef<HTMLVideoElement>(null);

  const [stage, setStage] = useState<Stage>("capture");
  const [clip, setClip] = useState<Clip | null>(null);
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
    if (clip) URL.revokeObjectURL(clip.url);
    setClip(null);
    setSequence(null);
    setAnalysis(null);
    setError(null);
    setProgress(0);
    setStage("capture");
    disposePoseLandmarker();
  }, [clip]);

  const handleClipRecorded = useCallback((_blob: Blob, url: string) => {
    setClip({ url, duration: 0, start: 0, end: 0 });
    setError(null);
    setStage("review");
  }, []);

  const handleUseMockData = useCallback(() => {
    const mock = smoothSequence(generateMockSequence());
    setSequence(mock);
    setAnalysis(analyzeSequence(mock));
    setStage("analysis");
  }, []);

  const process = useCallback(async () => {
    const video = reviewVideoRef.current;
    if (!video || !clip) return;

    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const raw = await processVideoElement(video, {
        startSeconds: clip.start,
        endSeconds: clip.end,
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
          : "Processing failed. Record a shorter clip and try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [clip]);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="flex items-center justify-between px-1">
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
            onUseMockData={handleUseMockData}
          />
        )}

        {stage === "review" && clip && (
          <div className="grid h-full gap-4 lg:grid-cols-2">
            <div className="overflow-hidden rounded-3xl bg-black">
              <video
                ref={reviewVideoRef}
                src={clip.url}
                playsInline
                muted
                preload="auto"
                className="h-full w-full object-contain"
                onLoadedMetadata={(event) => {
                  const duration = event.currentTarget.duration;
                  if (Number.isFinite(duration)) {
                    setClip((current) =>
                      current ? { ...current, duration, start: 0, end: duration } : current,
                    );
                  }
                }}
              />
            </div>

            <div className="flex flex-col justify-center gap-4">
              <TrimSlider
                duration={clip.duration}
                start={clip.start}
                end={clip.end}
                onChange={(range) => setClip((c) => (c ? { ...c, ...range } : c))}
                onScrub={(seconds) => {
                  if (reviewVideoRef.current) reviewVideoRef.current.currentTime = seconds;
                }}
              />

              <button className="btn-primary h-16" onClick={() => void process()} disabled={busy}>
                {busy ? `Processing… ${Math.round(progress * 100)}%` : "Process video"}
              </button>

              <button className="btn-ghost" onClick={deleteSession} disabled={busy}>
                Record again
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
