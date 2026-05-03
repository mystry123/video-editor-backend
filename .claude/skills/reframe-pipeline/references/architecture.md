# Reframe pipeline — architecture

```
┌──────────────────────┐  POST /api/reframe         ┌──────────────────────┐
│  Frontend (Remix)    │ ─────────────────────────> │  Express controller  │
│  ReframeSection.tsx  │                            │  reframe.controller  │
│  /ai-reframe page    │ <────────────────────────  │                      │
│                      │  GET /api/reframe/status/  │                      │
└──────────────────────┘                            └──────────┬───────────┘
                                                               │ enqueue
                                                               ▼
                                                  ┌────────────────────────┐
                                                  │  BullMQ "reframe"      │
                                                  │  queue (Redis)         │
                                                  └──────────┬─────────────┘
                                                             │ pick up
                                                             ▼
                                                  ┌────────────────────────┐
                                                  │  reframe.worker.ts     │
                                                  │  - load File metadata  │
                                                  │  - load Transcription  │
                                                  │    if available        │
                                                  └──────────┬─────────────┘
                                                             │ POST /detect
                                                             ▼
                                                  ┌────────────────────────┐
                                                  │  YOLO microservice     │
                                                  │  (FastAPI, port 8000)  │
                                                  │  yolo-service/main.py  │
                                                  │                        │
                                                  │  cv2.VideoCapture →    │
                                                  │  yolov8n-pose every    │
                                                  │  Nth frame → filter →  │
                                                  │  proximity-track →     │
                                                  │  scene_stats →         │
                                                  │  ask_bedrock_for_      │
                                                  │  layout()              │
                                                  └──────────┬─────────────┘
                                                             │ Bedrock
                                                             ▼
                                                  ┌────────────────────────┐
                                                  │  Claude 3 Haiku        │
                                                  │  decide_layout tool    │
                                                  └──────────┬─────────────┘
                                                             │ layout_decision
                                                             ▼
                                                  ┌────────────────────────┐
                                                  │  worker post-process:  │
                                                  │  - smoothDetections    │
                                                  │  - detectionsToZone    │
                                                  │    Keyframes           │
                                                  │  - write reframe[ratio]│
                                                  │    to File doc         │
                                                  └──────────┬─────────────┘
                                                             │ persisted
                                                             ▼
                                                  ┌────────────────────────┐
                                                  │  MongoDB File doc      │
                                                  │  reframe Map<ratio,    │
                                                  │   {status, layout,     │
                                                  │    zones, sceneStats}> │
                                                  └────────────────────────┘
```

## Data shapes

**`POST /api/v1/reframe`** (Express):
```json
{ "fileId": "65f...", "aspectRatio": "9:16", "elementId": "e_abc" }
→ 200 { "status": "queued", "jobId": "..." }
  or  { "status": "already_done", ...cached payload }
```

**`GET /api/v1/reframe/status/:fileId/:aspectRatio`**:
```json
{
  "status": "completed",
  "layoutDecision": { "layout_type": "single_crop", "zones": [...], "reasoning": "...", "confidence": 0.85 },
  "zones": [{ "zone_id": "full", "person_ids": [0], "canvas_top": 0, "canvas_left": 0, "canvas_w": 1, "canvas_h": 1, "keyframes": [...] }],
  "sceneStats": { "person_count": 1, "max_simultaneous": 1, "multi_person_fraction": 0.92, "scene_type": "presentation", ... },
  "fps": 30, "videoWidth": 1920, "videoHeight": 1080,
  "processedAt": "2026-..."
}
```

**YOLO `POST /detect`** payload:
```json
{
  "video_url": "https://cdn/...",
  "sample_every_n": 3,
  "source_ratio": "16:9",
  "target_ratio": "9:16",
  "transcription_text": "<optional>",
  "file_duration": 120.5,
  "has_audio": true
}
```

## Key code locations

| Concern | File | Line |
|---|---|---|
| Trigger from editor sidebar | `app/components/editor-v2/panels/properties/sections/type-specific/ReframeSection.tsx` (frontend) | ~84 |
| Standalone page | `app/routes/ai-reframe/_index.tsx` (frontend) | — |
| Remix shim | `app/routes/api+/reframe.ts`, `reframe.status.ts`, `reframe.delete.ts` | — |
| Service that hits Node | `app/data/services/reframe.service.ts` (frontend) | — |
| Express controller | `src/controllers/reframe.controller.ts` | 18-86 |
| BullMQ queue | `src/queues/index.ts` | 122-131 |
| Worker (orchestrator) | `src/workers/reframe.worker.ts` | 32-165 |
| Smoothing + keyframes | `src/services/reframe.service.ts` | 129-274 |
| YOLO inference loop | `yolo-service/main.py` | inside `detect_subjects()` |
| Bedrock prompt | `yolo-service/main.py` | `ask_bedrock_for_layout` |
| Fallback layout (no Bedrock) | `yolo-service/main.py` | `fallback_layout` |
| File schema reframe field | `src/models/File.ts` | ~65 |

## State machine (per fileId × aspectRatio)

```
not_started → pending → processing → completed
                              └──────> failed
```

`pending` is the initial enqueue write before the worker picks up. `processing` is set by the worker as soon as it starts. `completed` and `failed` are terminal; the frontend stops polling on either.

## Why three processes

The Python service exists because Ultralytics (PyTorch) is not a first-class fit for the Node runtime, and forking out per-job is expensive (the model load is ~1s). FastAPI + persistent model load + REST API was the simplest way to keep YOLO warm.
