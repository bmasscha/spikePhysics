import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import SkeletonOverlay from "./SkeletonOverlay";
import type { PoseSequence } from "../types/pose";
import type { AnyTechnique, BaseAnalysis } from "../types/technique";

interface Props {
  technique: AnyTechnique;
  sequence: PoseSequence;
  analysis: BaseAnalysis;
  /** Object URL of the recorded clip; absent in demo/mock mode. */
  videoUrl?: string | null;
  /** Seconds into the source video that frame 0 corresponds to. */
  clipStart?: number;
  /**
   * Re-runs the analysis with the coach's own key moment. Absent when the
   * shell has nothing to re-analyse.
   */
  onSetKeyFrame?: (frame: number) => void;
}

/**
 * Split view: video plus overlay on one side, graphs on the other, sharing a
 * single play-head. The frame index is the one source of truth — the video and
 * the charts both follow it, so scrubbing either stays in sync.
 *
 * Layout note — this is what caused charts to vanish on real footage. A <video>
 * has an intrinsic size and an empty placeholder <div> does not, so the demo
 * path and the recorded path laid out differently. Flex and grid children
 * default to `min-height: auto`, which refuses to shrink below content, so the
 * video's intrinsic height inflated its row instead of fitting the space. In
 * portrait that pushed the second grid row to 0 px and its `overflow-y-auto`
 * clipped the charts entirely. Two rules keep that from coming back:
 *
 *  1. every flex/grid child on the path to the video carries `min-h-0`, and
 *  2. the video box's height comes from an aspect-ratio box (capped by vh),
 *     never from the video's own intrinsic size.
 *
 * Portrait scrolls the whole dashboard as one surface; only landscape, where
 * everything fits, gives the chart column its own scroller.
 *
 * Technique-agnostic note: this shell no longer knows spike from pass. The
 * scorecard, the charts and the transport bar's jump targets all come from
 * `technique` — see types/technique.ts for the contract. What stays here is
 * what every technique shares: the play-head, the video, the skeleton overlay
 * and the warning strip.
 */
export default function AnalysisDashboard({
  technique,
  sequence,
  analysis,
  videoUrl,
  clipStart = 0,
  onSetKeyFrame,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frameIndex, setFrameIndex] = useState(analysis.keyFrame ?? 0);
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

  // Drives the aspect-ratio box below. Falling back to 16:9 keeps the box sane
  // if a sequence ever arrives without dimensions.
  const clipAspect =
    sequence.videoWidth > 0 && sequence.videoHeight > 0
      ? sequence.videoWidth / sequence.videoHeight
      : 16 / 9;

  const { Scorecard, Charts } = technique;
  const keyMoments = technique.keyMoments(analysis);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto split:grid split:grid-cols-2 split:overflow-hidden">
      <div className="flex flex-col gap-3 shrink-0 split:shrink split:min-h-0 split:flex-1">
        <div
          // Portrait: a box sized by the clip's own aspect ratio, capped so the
          // charts below always stay within a scroll or two. Landscape: back to
          // filling the leftover column height.
          className="relative aspect-[var(--clip-aspect)] max-h-[50vh] w-full shrink-0 overflow-hidden rounded-3xl bg-black split:aspect-auto split:max-h-none split:min-h-0 split:flex-1 split:shrink"
          style={{ "--clip-aspect": String(clipAspect) } as CSSProperties}
        >
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
            isKeyFrame={frameIndex === analysis.keyFrame}
          />

          <div className="absolute right-4 top-4 rounded-full bg-black/70 px-3 py-1 font-mono text-xs tabular-nums">
            {/* "side", not "arm": a pass is analysed off the platform, not one arm. */}
            frame {frameIndex}/{lastFrame} · {analysis.hittingSide} side
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
            {keyMoments.map((moment) => (
              <button
                key={moment.label}
                className="btn-ghost"
                onClick={() => jumpTo(moment.frame)}
                disabled={moment.frame == null}
              >
                {moment.label}
              </button>
            ))}

            {/*
              The coach's correction. Detecting the key moment is a guess made
              without ever seeing the ball — solid for a spike, genuinely hard
              for a pass — and every figure on this screen is measured against
              it. Whoever is holding the tablet can see the ball, so they get
              the last word: scrub to the right frame, tap, and the analysis
              re-runs on the same landmarks. No re-inference, so it is instant.
            */}
            {onSetKeyFrame && (
              <button
                className="btn-ghost ml-auto"
                onClick={() => onSetKeyFrame(frameIndex)}
                disabled={frameIndex === analysis.keyFrame}
              >
                Set {technique.keyFrameLabel} here
              </button>
            )}
          </div>
        </div>

        <Scorecard analysis={analysis} />

        {analysis.warnings.map((warning) => (
          <p
            key={warning}
            className="rounded-2xl border border-signal-warn/30 bg-signal-warn/10 p-3 text-sm text-signal-warn"
          >
            {warning}
          </p>
        ))}
      </div>

      <div className="shrink-0 split:shrink split:min-h-0 split:overflow-y-auto">
        <Charts
          analysis={analysis}
          frameIndex={frameIndex}
          onSeekFrame={(frame) => jumpTo(frame)}
        />
      </div>
    </div>
  );
}
