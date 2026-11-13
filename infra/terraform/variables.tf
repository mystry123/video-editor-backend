variable "project_id" {
  type    = string
  default = "shotline-511017"
}

variable "project_number" {
  type    = string
  default = "394238727487"
}

variable "region" {
  type    = string
  default = "asia-south1"
}

variable "zone" {
  type    = string
  default = "asia-south1-a"
}

variable "github_owner" {
  type    = string
  default = "mystry123"
}

# Repos whose main branch may deploy to the app VM.
variable "app_repos" {
  type    = list(string)
  default = ["video-editor-backend", "video-editor-frontend"]
}

# The VM runs the Remix frontend, the API, the BullMQ worker, Redis and (from
# Phase 3) Remotion renders, which use every core they get. 4 vCPU / 16 GB is
# the floor; raise to e2-standard-8 or c2d-standard-8 if renders are slow.
variable "app_machine_type" {
  type    = string
  default = "e2-standard-4"
}

variable "app_disk_gb" {
  type    = number
  default = 100
}

variable "media_bucket" {
  type    = string
  default = "shotline-media-prod"
}

variable "renders_bucket" {
  type    = string
  default = "shotline-renders-prod"
}

# The S3 media bucket was public-read; keep that unless the org policy
# (storage.publicAccessPrevention) forbids it — then set false and serve media
# through signed URLs.
variable "media_public_read" {
  type    = bool
  default = true
}

variable "cors_origins" {
  type = list(string)
  default = [
    "https://shotline.in",
    "https://www.shotline.in",
    "http://localhost:3000",
    "http://localhost:5173",
  ]
}
