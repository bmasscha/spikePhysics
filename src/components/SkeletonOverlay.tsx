import { useEffect, useRef } from "react";
import { getLandmark, indicesFor, POSE_CONNECTIONS } from "../lib/landmarks";
import type { HittingSide, PoseSequence } from "../types/pose";

interface Props {
  sequence: PoseSequence;
  frameIndex: number;
  hittingSide: HittingSide;
  /** Highlights the frame identified as ball contact. */
  isContactFrame?: boolean;
}

/**
 * Draws the tracked skeleton over the video. The canvas keeps the video's own
 * pixel dimensions and is stretched by CSS, so landmark coordinates need no
 * rescaling and the overlay stays aligned at any tablet size.
 */
export default function SkeletonOverlay({
  sequence,
  frameIndex,
  hittingSide,
  isContactFrame,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const { videoWidth: width, videoHeight: height } = sequence;
    context.clearRect(0, 0, width, height);

    const frame = sequence.frames[frameIndex];
    if (!frame) return;

    const hitting = indicesFor(hittingSide);
    const hittingChain = new Set([
      hitting.shoulder,
      hitting.elbow,
      hitting.wrist,
      hitting.hip,
    ]);

    const scale = Math.max(1, width / 640);

    for (const [a, b] of POSE_CONNECTIONS) {
      const from = getLandmark(frame, a);
      const to = getLandmark(frame, b);
      if (!from || !to) continue;

      const onHittingChain = hittingChain.has(a) && hittingChain.has(b);
      context.strokeStyle = onHittingChain
        ? "rgba(34, 211, 238, 0.95)" // cyan: the arm being analysed
        : "rgba(148, 163, 184, 0.55)";
      context.lineWidth = (onHittingChain ? 5 : 3) * scale;
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(from.pixelX, from.pixelY);
      context.lineTo(to.pixelX, to.pixelY);
      context.stroke();
    }

    for (let index = 0; index < frame.landmarks.length; index += 1) {
      const landmark = getLandmark(frame, index);
      if (!landmark) continue;
      const key = hittingChain.has(index);
      context.fillStyle = key ? "#22d3ee" : "rgba(226, 232, 240, 0.7)";
      context.beginPath();
      context.arc(landmark.pixelX, landmark.pixelY, (key ? 7 : 4) * scale, 0, Math.PI * 2);
      context.fill();
    }

    if (isContactFrame) {
      const wrist = getLandmark(frame, hitting.wrist);
      if (wrist) {
        context.strokeStyle = "#f59e0b";
        context.lineWidth = 4 * scale;
        context.beginPath();
        context.arc(wrist.pixelX, wrist.pixelY, 26 * scale, 0, Math.PI * 2);
        context.stroke();
      }
    }
  }, [sequence, frameIndex, hittingSide, isContactFrame]);

  return (
    <canvas
      ref={canvasRef}
      width={sequence.videoWidth}
      height={sequence.videoHeight}
      className="pointer-events-none absolute inset-0 h-full w-full object-contain"
    />
  );
}
