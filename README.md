# SpikePhysics

Offline-first, tablet-first PWA that turns a 5-second clip of a spike into
actionable biomechanics. Everything — video capture, pose estimation, physics —
runs in the browser on the coach's own tablet. Nothing is uploaded, no account
is needed, and the app works in a sports hall with no Wi-Fi at all.

**Live: https://bmasscha.github.io/spikePhysics/** — press *Demo clip* to see the
full dashboard without a camera.

## Getting started

```bash
npm install                  # also vendors the MediaPipe Wasm into public/wasm
npm run icons                # regenerate the PWA icons (already committed)
# one-off, needs a network — see public/models/README.md
curl -L -o public/models/pose_landmarker_full.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task

npm run dev                  # http://localhost:5173, also served on the LAN
npm test                     # physics + component unit tests (jsdom)
npm run typecheck
npm run test:e2e             # Playwright; builds and previews first
npm run build && npm run preview
```

`npm run test:e2e` needs a browser once: `npx playwright install chromium`.
It runs against the **production preview**, not the dev server, so the
`/spikePhysics/` base path is exercised the same way Pages serves it.

The camera needs a secure context. `localhost` counts; to test from a tablet on
the LAN, serve the built app over HTTPS or use a tunnel.

Without the `.task` model the app still runs — press **Demo clip** to drive the
whole dashboard from the synthetic generator.

## Deployment

Pushing to `main` runs the unit tests, the typecheck and the Playwright suite,
builds, and force-pushes `dist/` to the `gh-pages` branch, which is what Pages
serves. No repo settings to configure — Pages enabled itself when that branch
first appeared.

The workflow downloads the pose model at build time, so the deployed app can do
live inference without the 9 MB blob ever entering git history. The production
build is served from `/spikePhysics/`, which is why runtime asset paths go
through `import.meta.env.BASE_URL` instead of a leading slash — hardcode `/wasm`
anywhere and it will 404 on Pages while working fine locally.

## Layout

```
src/
  lib/
    vectorMath.ts      pure vector/kinematics helpers (angles, speeds, derivatives)
    biomechanics.ts    the four analyses: scale factor, abduction, kinetic chain, SSC
    smoothing.ts       Savitzky-Golay + moving average over landmark trajectories
    landmarks.ts       MediaPipe indices, hitting-side detection, skeleton topology
    poseEngine.ts      Tasks-Vision wrapper; seeks a video and returns landmarks
    videoDuration.ts   forces a real duration out of a clip that reports Infinity
    mockData.ts        synthetic spike generator (dev fixture + test ground truth)
  components/          camera, trim slider, overlay, charts, scorecard, dashboard
  types/pose.ts        shared landmark/analysis types
e2e/                   Playwright specs + tiny committed video fixtures
```

Pipeline: **record or import → trim → `processVideoElement` → `smoothSequence` →
`analyzeSequence` → dashboard.**

## Importing footage instead of recording

*Import video* on the capture screen opens the tablet's own file picker, so
footage already shot with the native camera app — including 120/240 fps slow
motion, which is far better for a swing than what `MediaRecorder` produces —
goes through exactly the same pipeline as a recording. The control stays
available when the camera is blocked or unsupported. The file is read locally
only; its object URL is revoked when the clip is replaced or the session is
deleted, and nothing is ever copied anywhere persistent.

Three things are worth knowing:

- Long clips default their trim window to the **last 10 seconds**, because the
  spike is nearly always at the end of what a coach filmed. `MAX_ANALYSIS_SECONDS`
  in `src/App.tsx` caps what is actually processed; a wider selection is
  analysed from its start and the coach is told so on screen rather than having
  it truncated silently.
- `video.duration` is frequently `Infinity` until the element has been seeked —
  both for Chrome's `MediaRecorder` blobs and for some phone containers.
  `src/lib/videoDuration.ts` forces it to resolve; a file that never yields a
  duration, or that the browser cannot decode, produces a coaching-toned
  recovery message rather than a stuck spinner.
- Inference always samples at `DEFAULT_SAMPLE_FPS` (30) in `poseEngine.ts`, even
  for slow-motion sources. No browser API reports a file's real frame rate, and
  guessing high is worse than sampling low — over-sampling makes consecutive
  seeks land on the same decoded frame, which turns the speed series into a
  sawtooth. The full reasoning, and what it costs, is on the constant.
- If your camera app writes slow motion back as a time-stretched 30 fps file,
  the speeds reported are the *played* speeds, not the athlete's:
  `PoseFrame.timestampMs` is media time by design. Export at the real rate for
  true figures.

## Things worth knowing before you change the dashboard layout

The two chart panels once disappeared entirely after processing real footage,
while the demo path rendered them fine. The cause was structural, not visual: a
`<video>` has an intrinsic size and the demo placeholder `<div>` does not, and
flex/grid children default to `min-height: auto`, so the video's intrinsic
height inflated its row rather than fitting the space. On an 800x1280 portrait
viewport the grid rows measured `1915px 0px` — the chart row was squeezed to
nothing and its `overflow-y-auto` clipped the charts out of existence.

Three rules keep it fixed, and `e2e/charts.spec.ts` enforces them in a real
browser at all orientations and viewport combinations:

1. Every flex/grid child on the path to the video carries `min-h-0`.
2. The video box takes its height from an aspect-ratio box (capped in `vh`),
   never from the video's own intrinsic size.
3. **Orientation layout is decided by the `split:` screen query.** Instead of the hardcoded width-based `lg:` breakpoint (which forces unreadable side-by-side layouts on portrait iPad Pros at 1024px width, and squishes landscape phones at 390px height), layout transitions are controlled by a custom Tailwind media query: `(orientation: landscape) and (min-height: 600px)`. This query translates to "there is actually room for two columns side by side". This ensures that phones and portrait tablets stay in the robust stacked layout while landscape tablets transition to a side-by-side split layout. Because this decision is entirely CSS-driven, rotation preserves the DOM tree intact; the `<video>` node is never unmounted, ensuring `currentTime`, buffered state, and play-head are perfectly preserved across rotations.

Unit tests cannot cover this — jsdom has no layout engine, which is exactly why
the bug shipped. Anything about sizing belongs in the Playwright suite.

## Things worth knowing before you change the physics

**Angles must be computed in pixel space, never in normalized coordinates.**
MediaPipe divides `x` by the frame width and `y` by the height, so on a 16:9
clip the vertical axis is stretched by 1.78x and every angle computed from
`x/y/z` is wrong (a constructed 131° read back as 112°). `PoseLandmark` carries
`pixelX/pixelY/pixelZ` on one isotropic scale for exactly this reason; use
`spatialPoint()` for angles and `pixelPoint()` for image-plane speeds.

**Cocking-end is not peak elbow flexion.** Defining it that way puts it
immediately before extension by construction, collapsing the whip/push ratio to
~0 for every player. `detectCockingEndFrame` instead finds the last reversal of
the hand's reach behind the shoulder before contact — the arm also trails behind
the body during the approach, so it must be the *last* reversal, not the deepest.

**Speeds are in torso-lengths per second.** The per-frame scale factor
(`1 / torsoPixels`) cancels the player's distance from the camera, so a spike
filmed from 5 m and one filmed from 10 m produce comparable numbers.

**The mock is a planar model with `z = 0`.** Its `abductionAtContact` option is
what the arm is *built* to reach; the analysis measures 3–5° lower because
contact is detected a frame or two before the arm settles. Useful
`elbowOnsetRatio` range is 0–0.9.

## Coaching thresholds

| Metric | 🟢 Optimal | 🔴 Danger |
| --- | --- | --- |
| Shoulder abduction at contact | 130–133° | < 115° or > 145° |
| Kinetic chain | hip → shoulder → elbow → wrist | hip peaks at/after wrist |
| Elbow extension onset | < 55% of swing (whip) | > 75% of swing (push) |

All three live as named constants at the top of `src/lib/biomechanics.ts`.

## Privacy

Video and landmarks exist only in the tab's memory: no IndexedDB writes, no
network calls after the app has cached itself, no analytics. **Delete session**
drops that state and revokes the object URL, which is a complete erase.
