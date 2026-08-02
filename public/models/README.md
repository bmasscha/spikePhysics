# Pose model

The app expects `pose_landmarker_full.task` in this folder. It is not committed
(~9 MB) and is not downloaded by `npm install`, so fetch it once on a machine
with a connection:

```bash
curl -L -o public/models/pose_landmarker_full.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
```

Swap `full` for `lite` in both the filename and the URL if you need faster
inference on older tablets — then update `MODEL_PATH` in `src/lib/poseEngine.ts`.

Once the file is here it is precached by the service worker on first load, and
every subsequent open works with no network at all.
