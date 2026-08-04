import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type { TechniqueMeta } from "../types/technique";

interface Props {
  /** The chosen technique's capture rules — how long to record and what to frame. */
  technique: TechniqueMeta;
  onClipRecorded: (blob: Blob, url: string) => void;
  /** Called with a file the coach picked from device storage, plus its object URL. */
  onVideoImported: (file: File, url: string) => void;
  onUseMockData: () => void;
}

type CameraState = "idle" | "ready" | "recording" | "denied" | "unsupported";

/**
 * Live preview + MediaRecorder capture. Prefers the rear camera at the widest
 * angle available, because coaches film from the sideline at 5–10 m.
 */
export default function CameraModule({
  technique,
  onClipRecorded,
  onVideoImported,
  onUseMockData,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stopTimerRef = useRef<number | null>(null);

  const [state, setState] = useState<CameraState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Per-technique cap, not a fixed 5 s: a spike is over in an instant, but a
  // pass rally the coach wants the platform contact from can run longer. The
  // cap still exists for the same reason it always did — it keeps the
  // inference pass, which runs entirely on-device, under a few seconds.
  const maxRecordingMs = technique.maxRecordingSeconds * 1000;

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setState("unsupported");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 60 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setState("ready");
      } catch (err) {
        setState("denied");
        setError(
          err instanceof Error && err.name === "NotAllowedError"
            ? "Camera access was blocked. Allow the camera in your browser settings, then reload."
            : "No camera could be opened. You can still import a video from this tablet, or explore the app with demo data.",
        );
      }
    }

    void start();
    return () => {
      cancelled = true;
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const stopRecording = useCallback(() => {
    if (stopTimerRef.current) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    recorderRef.current?.state === "recording" && recorderRef.current.stop();
  }, []);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;

    const mimeType = [
      "video/mp4;codecs=avc1",
      "video/webm;codecs=vp9",
      "video/webm",
    ].find((type) => MediaRecorder.isTypeSupported(type));

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      setState("ready");
      setElapsed(0);
      const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
      onClipRecorded(blob, URL.createObjectURL(blob));
    };
    recorder.onerror = () => {
      setState("ready");
      setError("Recording failed. Try again.");
    };

    recorderRef.current = recorder;
    recorder.start();
    setState("recording");

    const startedAt = performance.now();
    const tick = () => {
      if (recorder.state !== "recording") return;
      setElapsed(performance.now() - startedAt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    stopTimerRef.current = window.setTimeout(stopRecording, maxRecordingMs);
  }, [maxRecordingMs, onClipRecorded, stopRecording]);

  const handleFileChosen = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target;
      const file = input.files?.[0];
      // Clear the input before doing anything else: without this, picking the
      // same file a second time is a no-op because `change` only fires on a
      // value change. Read `file` first — resetting empties the FileList.
      input.value = "";
      if (!file) return;
      onVideoImported(file, URL.createObjectURL(file));
    },
    [onVideoImported],
  );

  const recording = state === "recording";
  const remaining = Math.max(0, maxRecordingMs - elapsed) / 1000;

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="relative flex-1 overflow-hidden rounded-3xl bg-black">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="h-full w-full object-contain"
        />

        {/* Framing guide: the whole body must fit inside the box. */}
        <div className="pointer-events-none absolute inset-6 rounded-2xl border-2 border-dashed border-signal-accent/30" />

        {/*
          Per-technique framing advice. Anchored to the bottom of the preview,
          inside the dashed guide, rather than above the video: it needs to sit
          near the thing it explains without covering the coach's view of the
          subject (usually centred, upper frame) or eating into the fixed-height
          controls row below, which an in-flow element here would do since this
          box is absolutely positioned and takes no layout space.
        */}
        {/*
          Gone the moment recording starts: the banner sits over the bottom of
          the frame, which is exactly where the feet are, and the hint itself
          asks for the whole body in shot. It has done its job by then anyway.
        */}
        {!recording && (
          <div className="pointer-events-none absolute inset-x-6 bottom-6 rounded-xl bg-black/70 px-3 py-2 text-center text-xs text-slate-200 split:text-sm">
            {technique.captureHint}
          </div>
        )}

        {recording && (
          <div className="absolute left-6 top-6 flex items-center gap-2 rounded-full bg-black/70 px-4 py-2">
            <span className="h-3 w-3 animate-pulse rounded-full bg-signal-danger" />
            <span className="font-mono text-lg tabular-nums">
              {remaining.toFixed(1)}s
            </span>
          </div>
        )}

        {(state === "denied" || state === "unsupported") && (
          <div className="absolute inset-0 flex items-center justify-center p-8 text-center">
            <p className="max-w-md text-slate-300">
              {error ?? "This browser cannot record video."}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-4">
        <button className="btn-ghost" onClick={onUseMockData}>
          Demo clip
        </button>

        {/*
          Deliberately a <label> wrapping a visually hidden <input>: that is the
          only way to get the native picker while keeping the control keyboard
          and screen-reader reachable (sr-only clips the box but leaves it
          focusable, unlike display:none). It sits outside the preview box, so
          it stays available when the camera is denied or unsupported — a coach
          with no camera permission must still be able to analyse a file.
          No `capture` attribute: that would force the camera on mobile and
          defeat the point of importing.
        */}
        <label className={recording ? "btn-ghost cursor-pointer opacity-40" : "btn-ghost cursor-pointer"}>
          Import video
          <input
            type="file"
            accept="video/*"
            aria-label="Import video"
            className="sr-only"
            disabled={recording}
            onChange={handleFileChosen}
          />
        </label>

        <button
          className={recording ? "btn-danger h-20 w-20 rounded-full" : "btn-primary h-20 w-20 rounded-full"}
          onClick={recording ? stopRecording : startRecording}
          disabled={state !== "ready" && !recording}
          aria-label={recording ? "Stop recording" : "Start recording"}
        >
          <span className={recording ? "h-6 w-6 rounded bg-current" : "h-8 w-8 rounded-full bg-current"} />
        </button>

        <div className="min-w-tap text-sm text-slate-400">
          max&nbsp;{technique.maxRecordingSeconds}s
        </div>
      </div>
    </div>
  );
}
