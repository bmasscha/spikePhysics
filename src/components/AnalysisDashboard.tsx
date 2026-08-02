import { useCallback, useEffect, useRef, useState } from "react";
import MetricCharts from "./MetricCharts";
import MetricScorecard from "./MetricScorecard";
import SkeletonOverlay from "./SkeletonOverlay";
import type { AnalysisResult, PoseSequence } from "../types/pose";

interface Props {
  sequence: PoseSequence;
  analysis: AnalysisResult;
  /** Object URL of the recorded clip; absent in demo/mock mode. */
  videoUrl?: string | null;
  /** Seconds into the source video that frame 0 corresponds to. */
  clipStart?: number;
}

/**
 * Split view: video plus overlay on one side, graphs on the other, sharing a
 * single play-head. The frame index is the one source of truth — the video and
 * the charts both follow it, so scrubbing either stays in sync.
 */
export default function AnalysisDashboard({
  sequence,
  analysis,
  videoUrl,
  clipStart = 0,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frameIndex, setFrameIndex] = useState(analysis.contactFrame ?? 0);
  const [isPlaying, setIsPlaying] = useState(false);

  const lastFrame = Math.max(0, sequence.frames.length - 1);
  const frameSeconds = (frame: number) =>
    clipStart + (sequence.frames[frame]?.timestampMs ?? 0) / 1000;

  const seekToFrame = useCallback(
    (frame: number) => {
      const clamped = Math.min(lastFrame, Math.max(0, Math.round(frame)));
      setFrameIndex(clamped);
      const video = videoRef.current;
      if (video && !isPlaying) video.currentTime = frameSeconds(clamped);
    },
    // frameSeconds depends only on props that change together with sequence
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastFrame, isPlaying, sequence, clipStart],
  );

  // While the video plays it drives the play-head; when paused, the reverse.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isPlaying) return;

    let raf = 0;
    const follow = () => {
      const elapsedMs = (video.currentTime - clipStart) * 1000;
      const frame = sequence.frames.findIndex((f) => f.timestampMs >= elapsedMs);
      setFrameIndex(frame < 0 ? lastFrame : frame);
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, sequence, clipStart, lastFrame]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.currentTime = frameSeconds(frameIndex);
      void video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const jumpTo = (frame: number | null) => {
    if (frame == null) return;
    videoRef.current?.pause();
    setIsPlaying(false);
    seekToFrame(frame);
  };

  return (
    <div className="grid h-full gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        <div className="relative flex-1 overflow-hidden rounded-3xl bg-black">
          {videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              playsInline
              muted
              className="h-full w-full object-contain"
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-600">
              Demo data — no video attached
            </div>
          )}

          <SkeletonOverlay
            sequence={sequence}
            frameIndex={frameIndex}
            hittingSide={analysis.hittingSide}
            isContactFrame={frameIndex === analysis.contactFrame}
          />

          <div className="absolute right-4 top-4 rounded-full bg-black/70 px-3 py-1 font-mono text-xs tabular-nums">
            frame {frameIndex}/{lastFrame} · {analysis.hittingSide} arm
          </div>
        </div>

        <div className="panel">
          <input
            type="range"
            className="scrub"
            min={0}
            max={lastFrame}
            step={1}
            value={frameIndex}
            onChange={(event) => seekToFrame(Number(event.target.value))}
          />

          <div className="flex flex-wrap items-center gap-2">
            {videoUrl && (
              <button className="btn-ghost" onClick={togglePlay}>
                {isPlaying ? "Pause" : "Play"}
              </button>
            )}
            <button
              className="btn-ghost"
              onClick={() => jumpTo(analysis.elbowTiming.cockingEndFrame)}
              disabled={analysis.elbowTiming.cockingEndFrame == null}
            >
              Cocking end
            </button>
            <button
              className="btn-ghost"
              onClick={() => jumpTo(analysis.contactFrame)}
              disabled={analysis.contactFrame == null}
            >
              Contact
            </button>
          </div>
        </div>

        <MetricScorecard analysis={analysis} />
      </div>

      <div className="overflow-y-auto">
        <MetricCharts
          analysis={analysis}
          frameIndex={frameIndex}
          onSeekFrame={(frame) => jumpTo(frame)}
        />
      </div>
    </div>
  );
}
