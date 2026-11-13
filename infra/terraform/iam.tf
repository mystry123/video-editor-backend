# All bindings here are *_iam_member (additive): they never remove bindings
# that were granted by hand (e.g. the reframe deployer's).

# --- Runtime identity: the app VM (and the reframe VM) run as shotline-backend.
data "google_service_account" "backend" {
  account_id = "shotline-backend"
}

locals {
  backend_member = "serviceAccount:${data.google_service_account.backend.email}"
}

resource "google_storage_bucket_iam_member" "backend_media" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = local.backend_member
}

resource "google_storage_bucket_iam_member" "backend_renders" {
  bucket = google_storage_bucket.renders.name
  role   = "roles/storage.objectAdmin"
  member = local.backend_member
}

# V4 signed URLs on a VM have no key file: the client signs through the IAM
# Credentials signBlob API, which needs Token Creator on the SA itself.
resource "google_service_account_iam_member" "backend_self_sign" {
  service_account_id = data.google_service_account.backend.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.backend_member
}

resource "google_project_iam_member" "backend_logs" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = local.backend_member
}

# --- CI deployer: GitHub Actions (backend + frontend repos, main only). ---------

resource "google_service_account" "app_deployer" {
  account_id   = "app-deployer"
  display_name = "shotline-app GitHub deployer"
}

locals {
  app_deployer_member = "serviceAccount:${google_service_account.app_deployer.email}"
  repo_condition = join(" || ", [
    for r in var.app_repos : "assertion.repository == '${var.github_owner}/${r}'"
  ])
}

# Provider in the existing `github` pool (the pool was made by hand for reframe).
resource "google_iam_workload_identity_pool_provider" "app" {
  workload_identity_pool_id          = "github"
  workload_identity_pool_provider_id = "shotline-app"
  display_name                       = "shotline-app (backend+frontend)"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  attribute_condition = "(${local.repo_condition}) && assertion.ref == 'refs/heads/main'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "app_deployer_wif" {
  for_each           = toset(var.app_repos)
  service_account_id = google_service_account.app_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/github/attribute.repository/${var.github_owner}/${each.value}"
}

# What `gcloud compute ssh --tunnel-through-iap` needs, scoped as tightly as
# GCP allows: read the project, OS Login on this one VM, IAP only to its :22,
# and act-as the VM's SA (required to SSH into a VM that runs as an SA).
resource "google_project_iam_member" "app_deployer_project_read" {
  project = var.project_id
  role    = "projects/${var.project_id}/roles/reframeDeployerProjectRead" # compute.projects.get only
  member  = local.app_deployer_member
}

resource "google_compute_instance_iam_member" "app_deployer_oslogin" {
  for_each      = toset(["roles/compute.osLogin", "roles/compute.viewer"])
  instance_name = google_compute_instance.app.name
  zone          = var.zone
  role          = each.value
  member        = local.app_deployer_member
}

resource "google_project_iam_member" "app_deployer_iap" {
  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = local.app_deployer_member
  condition {
    title      = "iap-ssh-shotline-app-only"
    expression = "destination.ip == \"${google_compute_address.app_internal.address}\" && destination.port == 22"
  }
}

resource "google_service_account_iam_member" "app_deployer_act_as_backend" {
  service_account_id = data.google_service_account.backend.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.app_deployer_member
}
