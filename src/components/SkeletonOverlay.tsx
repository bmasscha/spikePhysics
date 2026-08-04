import { useEffect, useRef } from "react";
import { getLandmark, indicesFor, POSE_CONNECTIONS } from "../lib/landmarks";
import type { HittingSide, PoseSequence } from "../types/pose";

interface Props {
  sequence: PoseSequence;
  frameIndex: number;
  /** Only picks the wrist the key-frame ring goes around; the skeleton itself
   * is drawn the same on both sides. */
  hittingSide: HittingSide;
  /**
   * Highlights the technique's key moment — ball contact for a spike, ball-on-
   * platform for a pass. Which frame that is comes from the technique's own
   * analysis (`BaseAnalysis.keyFrame`); this component only draws the ring.
   */
  isKeyFrame?: boolean;
}

/** Cyan, used for every bone and joint — see the note in the draw loop. */
const SKELETON_COLOR = "rgba(34, 211, 238, 0.95)";

/**
 * Draws the tracked skeleton over the video. The canvas keeps the video's own
 * pixel dimensions and is stretched by CSS, so landmark coordinates need no
 * rescaling and the overlay stays aligned at any tablet size.
 */
export default function SkeletonOverlay({
  sequence,
  frameIndex,
  hittingSide,
  isKeyFrame,
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
    const scale = Math.max(1, width / 640);

    // One colour for the whole skeleton. Dimming the bones outside the analysed
    // side used to hint at which arm a spike was measured off, but it reads as
    // "these joints are less reliable" — and on a pass, where both arms make the
    // platform, singling out one side means nothing at all.
    context.strokeStyle = SKELETON_COLOR;
    context.lineWidth = 4 * scale;
    context.lineCap = "round";

    for (const [a, b] of POSE_CONNECTIONS) {
      const from = getLandmark(frame, a);
      const to = getLandmark(frame, b);
      if (!from || !to) continue;

      context.beginPath();
      context.moveTo(from.pixelX, from.pixelY);
      context.lineTo(to.pixelX, to.pixelY);
      context.stroke();
    }

    context.fillStyle = SKELETON_COLOR;
    for (let index = 0; index < frame.landmarks.length; index += 1) {
      const landmark = getLandmark(frame, index);
      if (!landmark) continue;
      context.beginPath();
      context.arc(landmark.pixelX, landmark.pixelY, 5 * scale, 0, Math.PI * 2);
      context.fill();
    }

    if (isKeyFrame) {
      const wrist = getLandmark(frame, hitting.wrist);
      if (wrist) {
        context.strokeStyle = "#f59e0b";
        context.lineWidth = 4 * scale;
        context.beginPath();
        context.arc(wrist.pixelX, wrist.pixelY, 26 * scale, 0, Math.PI * 2);
        context.stroke();
      }
    }
  }, [sequence, frameIndex, hittingSide, isKeyFrame]);

  return (
    <canvas
      ref={canvasRef}
      width={sequence.videoWidth}
      height={sequence.videoHeight}
      className="pointer-events-none absolute inset-0 h-full w-full object-contain"
    />
  );
}
