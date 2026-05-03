---
name: reframe-pipeline
description: Trigger, inspect, and debug the AI Reframe pipeline (Python YOLO microservice + BullMQ worker + Bedrock layout reasoning + Mongo File doc). Use when working on reframe failures, single-vs-multi-person mis-classification, sampleEveryN tuning, YOLO model swaps, or layout-decision issues.
---

# Reframe pipeline — operator's guide

The AI Reframe feature spans three processes:

```
Frontend  ──>  Express controller  ──>  BullMQ worker  ──>  Python YOLO svc  ──>  Bedrock Claude
                       │                       │                                        │
                       └──> Mongo File doc <──┘ <──── zone keyframes + scene_stats ─────┘
```

For deeper architecture details see `references/architecture.md`.

## 1. Quick start (local dev)

Three terminals.

```bash
# Terminal 1 — YOLO microservice (Python, FastAPI, port 8000)
cd yolo-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
uvicorn main:app --port 8000 --reload

# Terminal 2 — Express API
npm run dev

# Terminal 3 — BullMQ workers (must be in a separate process)
npm run start:workers
```

Required env vars on the Node side: `MONGODB_URI`, `REDIS_URL`, `YOLO_SERVICE_URL` (defaults to `http://localhost:8000`), AWS Bedrock creds.

Sanity check the YOLO service: `curl http://localhost:8000/health` should return `{"status":"ok","model":"yolov8n-pose","bedrock":"available"}`.

## 2. Trigger a reframe from the CLI

Use the helper script:

```bash
.claude/skills/reframe-pipeline/scripts/trigger-reframe.sh <fileId> <aspectRatio> [authToken]
# example: trigger-reframe.sh 65f1a... 9:16 eyJhbGc...
```

It posts to `/api/v1/reframe`, then polls `/api/v1/reframe/status/:fileId/:aspectRatio` every 3s until `completed` or `failed`, and prints the layout decision.

## 3. Inspect job state

**File doc (Mongo).** Pretty-print whatever `reframe[ratio]` looks like for a fileId:

```bash
node .claude/skills/reframe-pipeline/scripts/inspect-reframe.js <fileId> [aspectRatio]
```

It prints status, layout type, zone count, scene_stats (including `multi_person_fraction`), and any error.

**BullMQ.** Use Redis CLI or BullMQ UI to look at the `reframe` queue. Failed jobs keep their stack trace in `job.failedReason`.

```bash
redis-cli LRANGE bull:reframe:failed 0 -1
redis-cli HGETALL bull:reframe:<jobId>
```

**YOLO service logs.** stdout includes `✅ YOLO model loaded`, `✅ Bedrock client initialized`, and per-detection error traces. If you see `⚠️ Bedrock call failed`, the pipeline silently falls back to `fallback_layout()` (see yolo-service/main.py:329) — the layout is centroid-based and lower quality.

## 4. Common failure modes

### "Single person video produces split_screen layout"
- Symptom: `scene_stats.person_count: 2`, layout = `split_screen_vertical`, but the video clearly has one person.
- First check: `scene_stats.multi_person_fraction`. If <0.3 the new debounce should already force `single_crop` — if it didn't, the Bedrock prompt may have been overridden by a transcript hint; check `transcription_text`.
- If multi_person_fraction is itself >0.3, YOLO is genuinely seeing >1 person too often. Likely culprits: low confidence threshold (currently `MIN_CONFIDENCE = 0.5` in yolo-service/main.py), missing bbox-size filter (`MIN_BBOX_HEIGHT = 0.15`), or a person on a screen/poster that passes those filters.
- Workaround for one-off bad videos: temporarily raise `MIN_CONFIDENCE` to 0.6 and re-run.

### "Tracker drift — same person gets dozens of person_ids"
- Symptom: `scene_stats.unique_ids_raw` is 5–20 for a single subject.
- Cause: `TRACKER_PROXIMITY_THRESHOLD` (yolo-service/main.py) is too small for the current sample rate. Threshold should be roughly `0.04 × sample_every_n` (the larger the gap between sampled frames, the more the centroid can move).
- Long-term fix: switch from proximity to `model.track(persist=True, tracker='bytetrack.yaml')`. Not done yet — benchmark before merging.

### "Bedrock unavailable / IAM error"
- The YOLO service silently falls back to `fallback_layout()`. The user still gets a layout, but it's purely centroid-based — no transcript reasoning, no scene-type heuristics on top of geometry.
- Verify with `curl http://localhost:8000/health` — `bedrock` field should say `available`. If it says `unavailable`, check AWS env vars and the `bedrock-runtime` IAM permission.

### "IndentationError / SyntaxError in main.py"
- Add a pre-commit hook: `python3 -m py_compile yolo-service/main.py`. The file has been broken once before by a stray indent on the per-frame aggregator block (commit history will show the fix).

## 5. Tuning knobs

| Knob | Where | Default | Effect |
|---|---|---|---|
| `sample_every_n` | `src/workers/reframe.worker.ts` (worker passes; YOLO `DetectRequest` default) | 3 | Higher = faster, less accurate. |
| `MIN_CONFIDENCE` | `yolo-service/main.py` | 0.5 | YOLO conf threshold. Raise to cut false positives, lower to catch faint subjects. |
| `MIN_BBOX_HEIGHT` | `yolo-service/main.py` | 0.15 | Reject persons smaller than 15% of frame height (kills people-on-TV). |
| `MIN_BBOX_AR / MAX_BBOX_AR` | `yolo-service/main.py` | 0.15 / 2.5 | Aspect-ratio sanity check. |
| `TRACKER_PROXIMITY_THRESHOLD` | `yolo-service/main.py` | 0.12 | Per-frame tracker matching radius (normalized). Scale roughly linearly with `sample_every_n`. |
| `MULTI_PERSON_FRACTION_THRESHOLD` | `yolo-service/main.py` | 0.3 | Min share of frames that must contain ≥2 people for the scene to count as multi-person. |
| `smoothing_window` | `src/workers/reframe.worker.ts` | 5 | Frames in moving-average for keyframes. Was tuned for sample_every_n=15; verify if you change sampling. |
| `1.3×` padding factor | `src/services/reframe.service.ts:243-244` | 1.3 | Extra crop margin around detected persons. |

## 6. Don't change without benchmarking

- **YOLO model variant.** `yolov8n-pose.pt` was picked for size (~6.8 MB) + speed. `yolov8s-pose` is more accurate but ~3× slower and 4× larger. `yolo11n-pose` is similar to v8n but Ultralytics 8.3+. Don't swap mid-feature.
- **`smoothing_window=5`.** Tuned against the old `sample_every_n=15`. With `sample_every_n=3` the same window covers 5× shorter time; consider raising to 7–11 only if you observe jitter.
- **`1.3×` keyframe padding.** Lower → tighter crop, persons clip out at frame edges. Higher → camera barely moves.

## 7. References

- `references/architecture.md` — full data flow, schemas, queue config.
- The plan that produced the current pipeline: `~/.claude/plans/thats-why-i-said-ethereal-russell.md`.
