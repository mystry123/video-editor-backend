# Fresh buckets: the S3 media is not migrated (decision 2026-11-14).

resource "google_storage_bucket" "media" {
  name                        = var.media_bucket
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  public_access_prevention    = var.media_public_read ? "inherited" : "enforced"
  force_destroy               = false

  cors {
    origin          = var.cors_origins
    method          = ["GET", "HEAD", "PUT", "POST"]
    response_header = ["Content-Type", "Content-Range", "Content-Length", "ETag", "Range", "x-goog-resumable"]
    max_age_seconds = 3600
  }

  # Unfinished multipart/resumable uploads otherwise keep billing forever.
  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }

  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket_iam_member" "media_public" {
  count  = var.media_public_read ? 1 : 0
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# Finished renders: private, served through signed URLs.
resource "google_storage_bucket" "renders" {
  name                        = var.renders_bucket
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  cors {
    origin          = var.cors_origins
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type", "Content-Range", "Content-Length", "ETag", "Range"]
    max_age_seconds = 3600
  }

  depends_on = [google_project_service.enabled]
}
