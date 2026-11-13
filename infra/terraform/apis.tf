locals {
  services = [
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com", # signBlob for signed URLs, WIF token exchange
    "sts.googleapis.com",
    "iap.googleapis.com",
    "oslogin.googleapis.com",
    "storage.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}
