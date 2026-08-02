import { useCallback, useEffect, useRef, useState } from "react";

/** Hard cap from the brief: 5 s keeps the inference pass under a few seconds. */
const MAX_RECORDING_MS = 5000;

interface Props {
  onClipRecorded: (blob: Blob, url: string) => void;
  onUseMockData: () => void;
}

type CameraState = "idle" | "ready" | "recording" | "denied" | "unsupported";

/**
 * Live preview + MediaRecorder capture. Prefers the rear camera at the widest
 * angle available, because coaches film from the sideline at 5–10 m.
 */
export default function CameraModule({ onClipRecorded, onUseMockData }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stopTimerRef = useRef<number | null>(null);

  const [state, setState] = useState<CameraState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

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
            : "No camera could be opened. You can still explore the app with demo data.",
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

    stopTimerRef.current = window.setTimeout(stopRecording, MAX_RECORDING_MS);
  }, [onClipRecorded, stopRecording]);

  const recording = state === "recording";
  const remaining = Math.max(0, MAX_RECORDING_MS - elapsed) / 1000;

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

        <button
          className={recording ? "btn-danger h-20 w-20 rounded-full" : "btn-primary h-20 w-20 rounded-full"}
          onClick={recording ? stopRecording : startRecording}
          disabled={state !== "ready" && !recording}
          aria-label={recording ? "Stop recording" : "Start recording"}
        >
          <span className={recording ? "h-6 w-6 rounded bg-current" : "h-8 w-8 rounded-full bg-current"} />
        </button>

        <div className="min-w-tap text-sm text-slate-400">
          max&nbsp;{MAX_RECORDING_MS / 1000}s
        </div>
      </div>
    </div>
  );
}
