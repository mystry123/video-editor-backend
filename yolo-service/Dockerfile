# yolo-service/Dockerfile
FROM python:3.11-slim

# Install system dependencies for OpenCV + ffmpeg
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the YOLO model during build (so first request is instant)
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n-pose.pt')"

COPY main.py .

EXPOSE 8000

# Use 2 workers for concurrent requests
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
