# Agent Prompt — SpikePhysics v2: fix missing charts, add video import

You are working on **SpikePhysics**, a shipped, working offline-first PWA that
analyses volleyball spike biomechanics entirely in the browser. It is deployed
at <https://bmasscha.github.io/spikePhysics/> and the repository is
<https://github.com/bmasscha/spikePhysics>.

This is a **maintenance task on working software**, not a greenfield build. Two
defects are described below. Do not rewrite the architecture, do not restyle the
app, and do not "improve" code outside the scope of these two tasks.

---

## 0. Orientation

### Run it

```bash
npm install          # postinstall vendors MediaPipe Wasm into public/wasm
npm run dev          # http://localhost:5173 (also on the LAN via --host)
npm test             # 59 tests, all currently passing
npm run typecheck
npm run build
```

The pose model is not committed. For live inference locally:

```bash
curl -L -o public/models/pose_landmarker_full.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
```

Without it, the **Demo clip** button still drives the whole dashboard from a
synthetic generator.

### Architecture

```
src/
  App.tsx                    stage machine: capture -> review -> analysis
  components/
    CameraModule.tsx         live preview + MediaRecorder (5 s cap)
    TrimSlider.tsx           two-handle trim over the recorded clip
    AnalysisDashboard.tsx    split view; owns frameIndex, the shared play-head
    SkeletonOverlay.tsx      canvas skeleton, drawn in video pixel coordinates
    MetricCharts.tsx         Recharts: joint speeds + abduction/elbow angles
    MetricScorecard.tsx      the three result cards
    ErrorBoundary.tsx
  lib/
    poseEngine.ts            MediaPipe wrapper; seeks a <video> frame by frame
    smoothing.ts             Savitzky-Golay / moving average over trajectories
    biomechanics.ts          scale factor, abduction, kinetic chain, elbow SSC
    vectorMath.ts            pure vector/kinematics helpers
    landmarks.ts             indices, visibility gate, hitting-side detection
    mockData.ts              forward-kinematic synthetic spike (test ground truth)
  types/pose.ts
```

Pipeline: **record/import → trim → `processVideoElement` → `smoothSequence` →
`analyzeSequence` → `AnalysisDashboard`**.

### Invariants you must not break

These were established deliberately; violating them silently corrupts results.

1. **Angles are computed in isotropic pixel space, never in normalized
   coordinates.** MediaPipe divides `x` by frame width and `y` by frame height,
   so on a 16:9 clip the vertical axis is stretched 1.78x and every angle is
   wrong (a constructed 131° reads back as 112°). Use `spatialPoint()`
   (`pixelX/pixelY/pixelZ`) for angles and `pixelPoint()` for image-plane speeds.
2. **End of cocking is not peak elbow flexion.** `detectCockingEndFrame` finds
   the *last* reversal of the hand's reach behind the shoulder before contact.
   Defining it as peak elbow flexion puts it immediately before extension by
   construction and collapses the whip/push ratio to ~0 for every player.
3. **Speeds are in torso-lengths per second**, via the per-frame scale factor
   `1 / torsoPixels`, so results are invariant to camera distance.
4. **Nothing leaves the device.** No uploads, no analytics, no third-party
   requests at runtime. Video and landmarks live in tab memory only.
5. **Runtime asset paths go through `import.meta.env.BASE_URL`.** Production is
   served from `/spikePhysics/`; a hardcoded `/wasm` works locally and 404s on
   GitHub Pages.
6. **Tablet ergonomics:** interactive controls stay at least 48x48 px.

---

## Task A — Charts are missing on real footage (bug, priority 1)

### Symptom

After processing a **recorded video**, the dashboard shows the three metric
cards, but the two Recharts panels (joint speed; shoulder abduction + elbow
angle) are not visible. With **Demo clip**, on the same device, the same two
charts render correctly.

### What has already been ruled out

Confirmed by the reporter on the real-video result:

- The three metric cards show **real numeric values** (e.g. `128.4°`) and a real
  kinetic-chain ordering — not `—` or "unknown".
- The **cyan skeleton overlay draws correctly** and tracks the player.

Therefore the landmark pipeline, the visibility gate, the scale factor and
`analyzeSequence` are all working on real footage. **This is a presentation-layer
defect.** Do not go looking for a physics bug.

(For completeness, one hypothesis this evidence kills: `poseEngine.ts` maps
`visibility: result.worldLandmarks[0]?.[i]?.visibility ?? lm.visibility ?? 1`,
where `?? 1` does not catch a literal `0`. Had MediaPipe returned 0, every
landmark would fail the 0.5 gate and every series would be all-null. The cards
and overlay prove that is not happening. Leave that line alone unless you find
independent evidence.)

### Leading hypothesis: the real `<video>` blows out the flex/grid layout

The only structural difference between the demo and real paths is that
`AnalysisDashboard` renders an actual `<video>` element when `videoUrl` is set;
in demo mode it renders a plain placeholder `<div>`.

A `<video>` has an **intrinsic size**; an empty `<div>` does not. Flex and grid
children default to `min-height: auto`, so the video's intrinsic height can force
its container taller than the space available, instead of shrinking to fit.

Relevant structure today (`AnalysisDashboard.tsx`):

```jsx
<div className="grid h-full gap-4 lg:grid-cols-2">   {/* fixed height  */}
  <div className="flex flex-col gap-3">
    <div className="relative flex-1 overflow-hidden rounded-3xl bg-black">
      <video className="h-full w-full object-contain" />   {/* intrinsic size */}
    </div>
    ...slider, scorecard...
  </div>
  <div className="overflow-y-auto">                  {/* charts live here */}
    <MetricCharts ... />
  </div>
</div>
```

and in `App.tsx` the dashboard sits inside `<main className="min-h-0 flex-1">`
within `<div className="flex h-full flex-col ...">`.

Consequences to check:

- On a **narrow/portrait** viewport `lg:grid-cols-2` does not apply, so the
  charts become the **second grid row**. With `h-full` on the grid and a first
  row inflated by the video's intrinsic height, the charts row can be squeezed
  to near-zero height — and because that div is `overflow-y-auto`, its content is
  clipped rather than pushed into view. The result is exactly the reported
  symptom: cards visible, charts absent.
- The page as a whole is not scrollable in a way that can reveal them, since
  `html, body, #root` are all `height: 100%` (`src/index.css`).

### Required diagnosis before fixing

Reproduce first; do not fix blind.

1. Serve the app, process a real clip (or temporarily point the review stage at a
   local sample file to iterate quickly).
2. In devtools, select the charts container and record `clientHeight`,
   `clientWidth`, and the computed height of the grid rows. Do the same in demo
   mode. Report both sets of numbers in your final summary.
3. Check the browser console for Recharts warnings about zero width/height.
4. Confirm the chart data itself is populated: log
   `analysis.kineticChain.series.map(s => s.speed.filter(v => v != null).length)`
   and `analysis.abductionSeries.filter(v => v != null).length`. If these are
   non-zero (they should be, given the cards render), the data is fine and the
   fault is layout.

If the measurements contradict the hypothesis above, follow the evidence and say
so plainly — the hypothesis is a starting point, not a conclusion.

### Fix requirements

- Charts must be visible and correctly sized after processing a **real** video,
  in **both** portrait and landscape, on a tablet-sized viewport.
- Landscape keeps the two-column split (video + overlay left, charts right).
- Portrait stacks vertically and the whole dashboard scrolls smoothly as one
  surface; the coach must be able to reach the charts by scrolling.
- The video must not be able to force the layout taller than its container —
  constrain it (e.g. an explicit aspect-ratio box or `max-height`, plus
  `min-h-0` on the flex/grid children that need to shrink).
- The play-head stays synchronised: scrubbing the video moves the chart marker,
  and clicking a chart still seeks the video.
- Do not reduce chart height so far that the traces become unreadable on a
  10-inch tablet.

### Regression protection

jsdom has no layout engine, so the existing test suite cannot catch this class of
bug — that is precisely why it shipped. Add real protection:

- Add a Playwright test (`@playwright/test`) that loads the app, triggers the
  demo path **and** a path with a real `<video>` present, at two viewports
  (e.g. 1280x800 landscape and 800x1280 portrait), and asserts that both chart
  panels have a bounding box with `height > 100` and are within the scrollable
  area.
- To make the "real video" case testable without a camera, allow the analysis
  stage to be driven by an imported file — which Task B adds anyway. Sequence the
  work so Task B lands first if that makes the test simpler.
- Keep the Playwright run out of the default `npm test` if it slows the loop;
  wire it as `npm run test:e2e` and add it to the CI workflow.

---

## Task B — Import a video from device storage (feature, priority 2)

### Motivation

Coaches already have footage on the tablet — filmed earlier in the session, or
shot with the native camera app at 120/240 fps slow motion, which is far better
for a swing than what `MediaRecorder` produces. Today the only way in is to
record inside the app.

### Requirements

1. **Entry point.** On the capture screen, next to the record button and the
   "Demo clip" button, add an **Import video** control that opens the native file
   picker: `<input type="file" accept="video/*">`, visually presented as a button
   matching the existing `btn-ghost` style and the 48x48 px minimum.
   - Do **not** set the `capture` attribute — that forces the camera on mobile
     and defeats the purpose.
   - The control must be reachable when the camera is unavailable or blocked
     (state `denied` / `unsupported` in `CameraModule.tsx`), since a coach with no
     camera permission should still be able to analyse a file.
2. **Same pipeline.** An imported file must flow into exactly the same
   `review → process → analysis` path as a recording: object URL, `TrimSlider`,
   `processVideoElement`, `smoothSequence`, `analyzeSequence`. Do not fork the
   pipeline.
3. **Duration handling.** Imported clips can be minutes long, while the analysis
   is designed around a few seconds.
   - Show the real duration and let the coach trim to the swing.
   - Cap what is actually processed (suggest ~10 s of trimmed window) and tell
     the coach why if their selection is longer, rather than silently truncating
     or freezing the tablet.
   - Consider defaulting the trim window to the last few seconds of a long clip,
     since the spike is usually at the end — but keep it adjustable.
4. **Known pitfall — `duration: Infinity`.** Chrome's `MediaRecorder` blobs, and
   some imported containers, report `duration === Infinity` until the video is
   seeked. `App.tsx` currently guards with `Number.isFinite(duration)` and
   silently skips the update, leaving the trim range at `0..0` and making
   "Process video" fail with "Video metadata not ready". Fix this for both
   recordings and imports: force duration resolution (seek to a large time, wait
   for `durationchange`/`seeked`, then seek back) before enabling processing.
5. **Unsupported codecs.** A tablet may hand back a container the browser cannot
   decode (e.g. some HEVC/MOV on non-Apple browsers). Detect the failure
   (`error` event on the `<video>`, or metadata never arriving within a timeout)
   and show a coaching-toned recovery message consistent with the existing
   `PoseEngineError.hint` style — e.g. *"This video format can't be read on this
   tablet. Re-record in the camera app using H.264/MP4, or record directly in
   SpikePhysics."* Never leave a dead-end spinner.
6. **High frame-rate footage.** Slow-motion clips (120/240 fps) are ideal input.
   `processVideoElement` samples at `targetFps` (default 30). Make sure a
   high-fps source is handled sensibly: either sample at the source rate up to a
   ceiling, or document why 30 is kept. Timestamps drive `dt` everywhere, so
   whatever you choose must keep `PoseFrame.timestampMs` truthful — the physics
   depends on it.
7. **Privacy.** The imported file is read locally only. Revoke every object URL
   in **Delete session** and when replacing a clip, so nothing leaks or leaks
   memory. Never copy the file anywhere persistent.
8. **Orientation/rotation.** Phone/tablet footage often carries a rotation flag.
   If a portrait-shot video renders rotated relative to the landmark coordinates,
   the skeleton overlay will be misaligned. Verify with a portrait clip and fix
   the overlay's coordinate mapping if needed (`SkeletonOverlay` draws in
   `sequence.videoWidth/videoHeight` space).

### Tests

- Unit/jsdom: importing a `File` sets the review stage, populates the trim range
  once metadata resolves, and reaching the analysis stage renders the scorecard.
  Mock the video element's metadata; do not require a real decode.
- Include a case where `duration` is initially `Infinity` and asserts the app
  recovers to a finite range.
- Playwright: import a small fixture video and assert the dashboard renders
  (this also serves Task A's regression test).

---

## Working agreement

- **Keep all 59 existing tests green.** Run `npm test` and `npm run typecheck`
  before you finish. If you change a physics threshold or a mock parameter,
  explain why in the commit message.
- Match the existing code style: named constants over magic numbers, comments
  that explain *why* (especially non-obvious biomechanics or browser
  workarounds), no dead code, no commented-out blocks.
- Commit in logical steps with meaningful messages. Push to `main`; the workflow
  in `.github/workflows/deploy.yml` runs the tests, builds, and force-pushes
  `dist/` to the `gh-pages` branch that GitHub Pages serves.
- **Verify on the deployed site, not just locally**, since the base-path handling
  (`/spikePhysics/`) only exercises in a production build.

## Definition of done

- [ ] Charts render on real footage in portrait and landscape on a tablet-sized
      viewport, with the measured container heights reported.
- [ ] A video can be imported from device storage and analysed through the same
      pipeline as a recording.
- [ ] `duration: Infinity` no longer blocks processing.
- [ ] Unreadable formats produce a clear, actionable message.
- [ ] Playwright coverage exists for chart visibility at both orientations.
- [ ] `npm test` and `npm run typecheck` pass; production build succeeds.
- [ ] Deployed and confirmed working at <https://bmasscha.github.io/spikePhysics/>.
- [ ] README updated to mention importing video.

## Report back with

1. What the measurements showed and what the chart bug actually was — confirm or
   correct the layout hypothesis with evidence.
2. Anything you found that is wrong but out of scope, listed and left alone.
3. Any place you had to trade off tablet performance against accuracy.
