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
npm test                     # physics unit tests
npm run build && npm run preview
```

The camera needs a secure context. `localhost` counts; to test from a tablet on
the LAN, serve the built app over HTTPS or use a tunnel.

Without the `.task` model the app still runs — press **Demo clip** to drive the
whole dashboard from the synthetic generator.

## Deployment

Pushing to `main` runs the tests, builds, and force-pushes `dist/` to the
`gh-pages` branch, which is what Pages serves. No repo settings to configure —
Pages enabled itself when that branch first appeared.

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
    mockData.ts        synthetic spike generator (dev fixture + test ground truth)
  components/          camera, trim slider, overlay, charts, scorecard, dashboard
  types/pose.ts        shared landmark/analysis types
```

Pipeline: **record → trim → `processVideoElement` → `smoothSequence` →
`analyzeSequence` → dashboard.**

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
