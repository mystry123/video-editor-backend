# yolo-service/main.py
# AI Reframe Microservice: YOLO person detection + Bedrock Claude layout reasoning

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import cv2
import json
import os
from ultralytics import YOLO
import boto3

app = FastAPI(title="YOLO Reframe Service", version="1.0.0")

# ─── Load YOLO model once at startup ─────────────────────────────────────────
# yolov8n-pose: detects full body (head to ankles), not just face
# Downloads automatically from Ultralytics on first run (~6MB)
model = YOLO("yolov8n-pose.pt")
print("✅ YOLO model loaded")

# ─── Bedrock client ───────────────────────────────────────────────────────────
# Uses same AWS credentials as the Node.js backend (IAM role or env vars)
bedrock_client = None
try:
    bedrock_client = boto3.client(
        "bedrock-runtime",
        region_name=os.environ.get("AWS_REGION", "us-east-1"),
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )
    print("✅ Bedrock client initialized")
except Exception as e:
    print(f"⚠️ Bedrock client failed to initialize: {e}")
    print("   Layout reasoning will be disabled, falling back to centroid-based crop")


# ═══════════════════════════════════════════════════════════════════════════════
# SCHEMAS
# ═══════════════════════════════════════════════════════════════════════════════

class DetectRequest(BaseModel):
    video_url: str
    sample_every_n: Optional[int] = 3  # sample every N frames (3 ≈ 10 fps at 30fps source — denser sampling improves debounce)
    source_ratio: Optional[str] = "16:9"
    target_ratio: Optional[str] = "9:16"
    transcription_text: Optional[str] = None  # scene context from ElevenLabs
    file_duration: Optional[float] = None
    has_audio: Optional[bool] = True


class BoundingBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float
    cx: float  # center x (normalized 0-1)
    cy: float  # center y (normalized 0-1)
    width: float  # normalized 0-1
    height: float  # normalized 0-1


class Detection(BaseModel):
    time: float  # timestamp in seconds
    frame: int
    bbox: BoundingBox
    confidence: float
    person_id: int  # track which person this is


class LayoutZone(BaseModel):
    zone_id: str
    person_ids: list[int]
    crop_cx: float
    crop_cy: float
    crop_width: float
    crop_height: float
    canvas_top: float  # position in target canvas (0-1)
    canvas_left: float
    canvas_w: float
    canvas_h: float


class LayoutDecision(BaseModel):
    layout_type: str
    zones: list[LayoutZone]
    reasoning: str
    confidence: float


class DetectResponse(BaseModel):
    detections: list[Detection]
    layout_decision: Optional[LayoutDecision] = None
    scene_stats: Optional[dict] = None
    fps: float
    total_frames: int
    video_width: int
    video_height: int
    status: str


# ═══════════════════════════════════════════════════════════════════════════════
# SCENE ANALYSIS (computed from YOLO detections — free, no API call)
# ═══════════════════════════════════════════════════════════════════════════════

# Fraction of sampled frames that must contain ≥2 people before we treat the
# scene as multi-person. A single bad frame (poster, reflection, edge clip) must
# not flip a single-person scene to split-screen.
MULTI_PERSON_FRACTION_THRESHOLD = 0.3


def compute_scene_stats(
    detections: list[Detection],
    max_simultaneous: int = 0,
    multi_person_fraction: float = 0.0,
    sampled_frame_count: int = 0,
) -> dict:
    """
    Analyze YOLO detections to infer scene type without any vision API.
    person_count is debounced: max_simultaneous alone would let a single false
    positive (e.g. a poster) flip a 1-person scene to multi-person. We require
    ≥MULTI_PERSON_FRACTION_THRESHOLD of sampled frames to actually contain
    multiple people before honoring max_simultaneous.
    """
    if not detections:
        return {
            "person_count": 0,
            "max_simultaneous": 0,
            "multi_person_fraction": 0.0,
            "sampled_frame_count": sampled_frame_count,
            "motion_level": "none",
            "spatial_spread": "none",
            "scene_type": "empty",
        }

    unique_ids = set(d.person_id for d in detections)

    # Debounced person_count
    if max_simultaneous == 0:
        person_count = 0
    elif max_simultaneous == 1:
        person_count = 1
    elif multi_person_fraction >= MULTI_PERSON_FRACTION_THRESHOLD:
        person_count = max_simultaneous
    else:
        # max_simultaneous>=2 but it appeared in too few frames → noise
        person_count = 1

    # Motion: how much the primary person's center moves over time
    # Use the person_id with the most detections (the "primary" subject)
    from collections import Counter
    id_counts = Counter(d.person_id for d in detections)
    primary_id = id_counts.most_common(1)[0][0]
    cx_values = [d.bbox.cx for d in detections if d.person_id == primary_id]
    cy_values = [d.bbox.cy for d in detections if d.person_id == primary_id]

    if cx_values:
        cx_range = max(cx_values) - min(cx_values)
        cy_range = max(cy_values) - min(cy_values)
        motion = max(cx_range, cy_range)
    else:
        motion = 0.0

    # Spatial spread: computed per-frame to avoid cross-frame inflation
    # Only meaningful when multiple people are in the SAME frame
    spread = 0.0
    if person_count >= 2:
        # Group detections by frame and compute spread within each frame
        from collections import defaultdict
        by_frame = defaultdict(list)
        for d in detections:
            by_frame[d.frame].append(d)
        frame_spreads = []
        for frame_dets in by_frame.values():
            if len(frame_dets) >= 2:
                frame_cxs = [d.bbox.cx for d in frame_dets]
                frame_spreads.append(max(frame_cxs) - min(frame_cxs))
        spread = max(frame_spreads) if frame_spreads else 0.0

    # Infer scene type
    if person_count == 1 and motion < 0.1:
        scene_type = "presentation"
    elif person_count == 1:
        scene_type = "solo_dynamic"
    elif person_count == 2 and motion < 0.15:
        scene_type = "interview"
    elif person_count == 2 and motion >= 0.15:
        scene_type = "conversation_dynamic"
    elif motion > 0.3:
        scene_type = "action"
    elif person_count >= 3:
        scene_type = "group"
    else:
        scene_type = "general"

    return {
        "person_count": person_count,
        "unique_ids_raw": len(unique_ids),  # for debugging
        "max_simultaneous": max_simultaneous,
        "multi_person_fraction": round(multi_person_fraction, 3),
        "sampled_frame_count": sampled_frame_count,
        "motion_level": "high" if motion > 0.3 else "medium" if motion > 0.1 else "low",
        "spatial_spread": "wide" if spread > 0.4 else "medium" if spread > 0.2 else "clustered",
        "scene_type": scene_type,
        "motion_value": round(motion, 3),
        "spread_value": round(spread, 3),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# BEDROCK LAYOUT REASONING
# ═══════════════════════════════════════════════════════════════════════════════

LAYOUT_TOOL_SCHEMA = {
    "name": "decide_layout",
    "description": "Decide the optimal video layout for reframing. Return the layout type and zone definitions.",
    "input_schema": {
        "type": "object",
        "properties": {
            "layout_type": {
                "type": "string",
                "enum": [
                    "single_crop",
                    "single_crop_wide",
                    "split_screen_vertical",
                    "split_screen_thirds",
                    "grid_2x2",
                    "focus_crop",
                    "center_crop",
                ],
                "description": "The layout strategy to use for reframing.",
            },
            "zones": {
                "type": "array",
                "description": "Array of zones, each defining a crop region in the source and a placement in the target canvas.",
                "items": {
                    "type": "object",
                    "properties": {
                        "zone_id": {"type": "string", "description": "Unique zone identifier like 'top', 'bottom', 'full', 'q1', 'q2', etc."},
                        "person_ids": {"type": "array", "items": {"type": "integer"}, "description": "Which detected person IDs belong in this zone."},
                        "crop_cx": {"type": "number", "description": "Center X of the crop in source video (normalized 0-1)."},
                        "crop_cy": {"type": "number", "description": "Center Y of the crop in source video (normalized 0-1)."},
                        "crop_width": {"type": "number", "description": "Width of the crop in source video (normalized 0-1)."},
                        "crop_height": {"type": "number", "description": "Height of the crop in source video (normalized 0-1)."},
                        "canvas_top": {"type": "number", "description": "Top position in target canvas (normalized 0-1)."},
                        "canvas_left": {"type": "number", "description": "Left position in target canvas (normalized 0-1)."},
                        "canvas_w": {"type": "number", "description": "Width in target canvas (normalized 0-1)."},
                        "canvas_h": {"type": "number", "description": "Height in target canvas (normalized 0-1)."},
                    },
                    "required": ["zone_id", "person_ids", "crop_cx", "crop_cy", "crop_width", "crop_height", "canvas_top", "canvas_left", "canvas_w", "canvas_h"],
                },
            },
            "reasoning": {"type": "string", "description": "Brief explanation of why this layout was chosen."},
            "confidence": {"type": "number", "description": "Confidence score 0-1 for this layout decision."},
        },
        "required": ["layout_type", "zones", "reasoning", "confidence"],
    },
}


def ask_bedrock_for_layout(
    detections_summary: list[dict],
    scene_stats: dict,
    source_ratio: str,
    target_ratio: str,
    transcription_text: str | None,
    file_duration: float | None,
    has_audio: bool,
    video_width: int,
    video_height: int,
) -> dict | None:
    """
    Send YOLO detection summary + scene context to Claude Haiku on Bedrock.
    Returns a LayoutDecision dict with zones and crop coordinates.
    Cost: ~$0.0002 per call (Claude 3 Haiku).
    """
    if not bedrock_client:
        return None

    # Build the context prompt
    transcript_section = ""
    if transcription_text:
        # Truncate to keep tokens low
        truncated = transcription_text[:600]
        transcript_section = f"""
## TRANSCRIPT (what was said in the video)
\"\"\"{truncated}\"\"\"
"""

    prompt = f"""You are a professional video editor AI deciding the best layout for reframing a video.

## VIDEO METADATA
- Resolution: {video_width}x{video_height}px
- Duration: {file_duration or 'unknown'}s
- Has audio: {has_audio}
- Converting: {source_ratio} → {target_ratio}

## SCENE ANALYSIS (from computer vision)
- People detected (debounced): {scene_stats['person_count']}
- Max in any single sampled frame: {scene_stats.get('max_simultaneous', 0)}
- Multi-person fraction: {scene_stats.get('multi_person_fraction', 0.0)} (share of {scene_stats.get('sampled_frame_count', 0)} sampled frames where ≥2 people were detected)
- Motion level: {scene_stats['motion_level']} (value: {scene_stats.get('motion_value', 'N/A')})
- Spatial spread: {scene_stats['spatial_spread']} (value: {scene_stats.get('spread_value', 'N/A')})
- Inferred scene type: {scene_stats['scene_type']}
{transcript_section}
## PERSON POSITIONS (normalized 0-1, sampled every ~2s)
{json.dumps(detections_summary[:20], indent=2)}

## LAYOUT RULES
- All coordinates are normalized (0=left/top, 1=right/bottom)
- crop_cx/cy = center of crop in SOURCE video (normalized 0-1)
- crop_width/height = size of crop in SOURCE video (normalized 0-1)
- canvas_top/left/w/h = position in TARGET canvas (normalized 0-1)
- All crop values must stay within 0-1 bounds
- crop_width and crop_height should be reasonable (not too small or too large)
- DEFAULT BIAS: prefer single_crop unless there is strong evidence of multiple persistent people.
- CRITICAL DEBOUNCE: If multi_person_fraction < 0.3, ALWAYS use single_crop regardless of any other signal — a brief multi-person frame is noise (poster, reflection, frame-edge clip).
- If person_count=1: ALWAYS use single_crop. Never split a single person into multiple zones.
- If person_count=0: center_crop (static center fallback).
- If person_count=2 and spread > 0.3: split_screen_vertical
- If person_count=2 and spread <= 0.3: single_crop_wide containing both
- If person_count >= 3: split into equal zones (split_screen_thirds, grid_2x2)
- For split_screen_vertical with 2 people: top zone gets canvas_top=0, canvas_h=0.5; bottom gets canvas_top=0.5, canvas_h=0.5
- For split_screen_thirds with 3 people: each zone gets canvas_h=0.333
- For grid_2x2 with 4 people: four quadrants (canvas_w=0.5, canvas_h=0.5)
- If target is portrait (9:16): vertical split works best for 2+ people
- NEVER use split_screen when person_count=1 regardless of unique_ids_raw or max_simultaneous

Decide the best layout and call the decide_layout tool."""

    try:
        response = bedrock_client.invoke_model(
            modelId="anthropic.claude-3-haiku-20240307-v1:0",
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": prompt}],
                "tools": [LAYOUT_TOOL_SCHEMA],
                "tool_choice": {"type": "tool", "name": "decide_layout"},
            }),
        )

        result = json.loads(response["body"].read())

        # Extract tool use result — guaranteed structured JSON
        for block in result.get("content", []):
            if block.get("type") == "tool_use" and block.get("name") == "decide_layout":
                return block["input"]

        print("⚠️ Bedrock returned no tool_use block")
        return None

    except Exception as e:
        print(f"⚠️ Bedrock call failed: {e}")
        return None


def fallback_layout(detections: list[Detection], scene_stats: dict, target_ratio: str) -> dict:
    """
    Generate a reasonable layout without Bedrock.
    Used when Bedrock is unavailable or fails.
    """
    person_count = scene_stats["person_count"]
    spread = scene_stats.get("spread_value", 0)

    target_w, target_h = map(int, target_ratio.split(":"))
    target_ar = target_w / target_h  # e.g., 9/16 = 0.5625

    if person_count == 0:
        return {
            "layout_type": "center_crop",
            "zones": [{
                "zone_id": "full",
                "person_ids": [],
                "crop_cx": 0.5, "crop_cy": 0.5,
                "crop_width": min(1.0, target_ar),
                "crop_height": 1.0,
                "canvas_top": 0.0, "canvas_left": 0.0,
                "canvas_w": 1.0, "canvas_h": 1.0,
            }],
            "reasoning": "No person detected — using center crop.",
            "confidence": 0.5,
        }

    if person_count == 1:
        # Single person: crop centered on them
        person_dets = [d for d in detections if d.person_id == 0]
        if person_dets:
            avg_cx = sum(d.bbox.cx for d in person_dets) / len(person_dets)
            avg_cy = sum(d.bbox.cy for d in person_dets) / len(person_dets)
        else:
            avg_cx, avg_cy = 0.5, 0.5

        crop_h = min(1.0, 0.8)
        crop_w = crop_h * target_ar

        return {
            "layout_type": "single_crop",
            "zones": [{
                "zone_id": "full",
                "person_ids": [0],
                "crop_cx": max(crop_w / 2, min(1 - crop_w / 2, avg_cx)),
                "crop_cy": max(crop_h / 2, min(1 - crop_h / 2, avg_cy)),
                "crop_width": crop_w,
                "crop_height": crop_h,
                "canvas_top": 0.0, "canvas_left": 0.0,
                "canvas_w": 1.0, "canvas_h": 1.0,
            }],
            "reasoning": "Single person detected — following subject.",
            "confidence": 0.8,
        }

    if person_count == 2 and spread > 0.3:
        # Two people far apart: split screen
        persons = {}
        for d in detections:
            if d.person_id not in persons:
                persons[d.person_id] = []
            persons[d.person_id].append(d)

        zones = []
        person_ids_sorted = sorted(persons.keys())[:2]
        for i, pid in enumerate(person_ids_sorted):
            dets = persons[pid]
            avg_cx = sum(d.bbox.cx for d in dets) / len(dets)
            avg_cy = sum(d.bbox.cy for d in dets) / len(dets)
            avg_w = sum(d.bbox.width for d in dets) / len(dets)

            crop_h = 0.6
            crop_w = crop_h * target_ar

            zones.append({
                "zone_id": "top" if i == 0 else "bottom",
                "person_ids": [pid],
                "crop_cx": max(crop_w / 2, min(1 - crop_w / 2, avg_cx)),
                "crop_cy": max(crop_h / 2, min(1 - crop_h / 2, avg_cy)),
                "crop_width": crop_w,
                "crop_height": crop_h,
                "canvas_top": 0.0 if i == 0 else 0.5,
                "canvas_left": 0.0,
                "canvas_w": 1.0,
                "canvas_h": 0.5,
            })

        return {
            "layout_type": "split_screen_vertical",
            "zones": zones,
            "reasoning": f"Two people with spatial spread {spread:.2f} — split screen to keep both visible.",
            "confidence": 0.75,
        }

    # Default: wide crop containing all persons
    all_cx = [d.bbox.cx for d in detections]
    all_cy = [d.bbox.cy for d in detections]
    center_x = (min(all_cx) + max(all_cx)) / 2
    center_y = (min(all_cy) + max(all_cy)) / 2

    crop_h = min(1.0, 0.9)
    crop_w = crop_h * target_ar

    return {
        "layout_type": "single_crop_wide",
        "zones": [{
            "zone_id": "full",
            "person_ids": list(set(d.person_id for d in detections)),
            "crop_cx": max(crop_w / 2, min(1 - crop_w / 2, center_x)),
            "crop_cy": max(crop_h / 2, min(1 - crop_h / 2, center_y)),
            "crop_width": crop_w,
            "crop_height": crop_h,
            "canvas_top": 0.0, "canvas_left": 0.0,
            "canvas_w": 1.0, "canvas_h": 1.0,
        }],
        "reasoning": f"Multiple persons detected (spread: {spread:.2f}) — using wide crop to contain all.",
        "confidence": 0.7,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": "yolov8n-pose",
        "bedrock": "available" if bedrock_client else "unavailable",
    }


@app.post("/detect", response_model=DetectResponse)
def detect_subjects(req: DetectRequest):
    """
    Process a video URL:
    1. Run YOLO person detection on sampled frames
    2. Compute scene statistics from detections
    3. Call Bedrock Claude Haiku for intelligent layout decision
    4. Return detections + layout decision
    """
    try:
        cap = cv2.VideoCapture(req.video_url)

        if not cap.isOpened():
            raise HTTPException(status_code=400, detail=f"Cannot open video: {req.video_url}")

        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        vid_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        vid_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # ── Detection filtering thresholds ───────────────────────────────
        # MIN_CONFIDENCE: raised from 0.4 to cut TV/poster/reflection false positives.
        # MIN_BBOX_HEIGHT: kills people-on-screen (TVs, posters) that occupy <15% of frame height.
        # AR bounds: a real standing/sitting person sits comfortably between these.
        MIN_CONFIDENCE = 0.5
        MIN_BBOX_HEIGHT = 0.15
        MIN_BBOX_AR = 0.15
        MAX_BBOX_AR = 2.5
        # Tracker proximity threshold tuned for sample_every_n=3 (was 0.35 for sample_every_n=15).
        TRACKER_PROXIMITY_THRESHOLD = 0.12

        detections: list[Detection] = []
        frame_idx = 0

        # Track persons across frames (simple: assign by position proximity)
        last_known_persons: dict[int, dict] = {}  # person_id -> last bbox
        next_person_id = 0
        max_persons_in_single_frame = 0  # max in any single sampled frame
        sampled_frame_count = 0
        frames_with_2plus_persons = 0

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % req.sample_every_n == 0:
                results = model(frame, verbose=False, conf=MIN_CONFIDENCE)[0]

                frame_persons = []

                if results.boxes is not None and len(results.boxes) > 0:
                    for i, box in enumerate(results.boxes):
                        class_id = int(box.cls[0])
                        class_name = model.names[class_id]
                        conf = float(box.conf[0])

                        if class_name != "person" or conf < MIN_CONFIDENCE:
                            continue

                        xyxy = box.xyxy[0].tolist()
                        cx = ((xyxy[0] + xyxy[2]) / 2) / vid_width
                        cy = ((xyxy[1] + xyxy[3]) / 2) / vid_height
                        w = (xyxy[2] - xyxy[0]) / vid_width
                        h = (xyxy[3] - xyxy[1]) / vid_height

                        # Bbox sanity filtering — reject persons-on-TV / posters / artifacts
                        if h < MIN_BBOX_HEIGHT:
                            continue
                        ar = (w / h) if h > 0 else 0
                        if ar < MIN_BBOX_AR or ar > MAX_BBOX_AR:
                            continue

                        frame_persons.append({
                            "x1": xyxy[0], "y1": xyxy[1],
                            "x2": xyxy[2], "y2": xyxy[3],
                            "cx": cx, "cy": cy, "w": w, "h": h,
                            "conf": conf,
                        })

                # Assign person IDs by proximity to last known positions
                assigned = set()
                for person in frame_persons:
                    best_id = None
                    best_dist = TRACKER_PROXIMITY_THRESHOLD

                    for pid, last in last_known_persons.items():
                        if pid in assigned:
                            continue
                        dist = ((person["cx"] - last["cx"]) ** 2 + (person["cy"] - last["cy"]) ** 2) ** 0.5
                        if dist < best_dist:
                            best_dist = dist
                            best_id = pid

                    if best_id is not None:
                        person_id = best_id
                    else:
                        person_id = next_person_id
                        next_person_id += 1

                    assigned.add(person_id)
                    last_known_persons[person_id] = {"cx": person["cx"], "cy": person["cy"]}

                    detections.append(Detection(
                        time=round(frame_idx / fps, 3),
                        frame=frame_idx,
                        confidence=round(person["conf"], 3),
                        person_id=person_id,
                        bbox=BoundingBox(
                            x1=person["x1"], y1=person["y1"],
                            x2=person["x2"], y2=person["y2"],
                            cx=round(person["cx"], 4),
                            cy=round(person["cy"], 4),
                            width=round(person["w"], 4),
                            height=round(person["h"], 4),
                        ),
                    ))

                # Per-frame aggregates (after the per-person loop)
                sampled_frame_count += 1
                if len(frame_persons) >= 2:
                    frames_with_2plus_persons += 1
                if len(frame_persons) > max_persons_in_single_frame:
                    max_persons_in_single_frame = len(frame_persons)

            frame_idx += 1

        cap.release()

        # ── Compute scene stats ──────────────────────────────────────────
        multi_person_fraction = (
            frames_with_2plus_persons / sampled_frame_count if sampled_frame_count > 0 else 0.0
        )
        scene_stats = compute_scene_stats(
            detections,
            max_simultaneous=max_persons_in_single_frame,
            multi_person_fraction=multi_person_fraction,
            sampled_frame_count=sampled_frame_count,
        )

        # ── Build detection summary for Bedrock (sampled, compact) ────────
        detections_summary = []
        seen_times = set()
        for d in detections[::3]:  # every 3rd detection (~every 1.5s)
            t = round(d.time, 1)
            if t not in seen_times:
                seen_times.add(t)
                detections_summary.append({
                    "time": d.time,
                    "person_id": d.person_id,
                    "cx": d.bbox.cx,
                    "cy": d.bbox.cy,
                    "width": d.bbox.width,
                    "height": d.bbox.height,
                })

        # ── Call Bedrock for layout reasoning ────────────────────────────
        layout_raw = ask_bedrock_for_layout(
            detections_summary=detections_summary,
            scene_stats=scene_stats,
            source_ratio=req.source_ratio or "16:9",
            target_ratio=req.target_ratio or "9:16",
            transcription_text=req.transcription_text,
            file_duration=req.file_duration,
            has_audio=req.has_audio if req.has_audio is not None else True,
            video_width=vid_width,
            video_height=vid_height,
        )

        # Fallback if Bedrock is unavailable or failed
        if layout_raw is None:
            layout_raw = fallback_layout(detections, scene_stats, req.target_ratio or "9:16")

        layout_decision = LayoutDecision(**layout_raw)

        return DetectResponse(
            detections=detections,
            layout_decision=layout_decision,
            scene_stats=scene_stats,
            fps=fps,
            total_frames=total_frames,
            video_width=vid_width,
            video_height=vid_height,
            status="success",
        )

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Detection error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
