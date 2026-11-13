output "app_ip" {
  description = "Point shotline.in, www.shotline.in and api.shotline.in A records here (GoDaddy)."
  value       = google_compute_address.app.address
}

output "app_internal_ip" {
  value = google_compute_address.app_internal.address
}

output "deployer_service_account" {
  description = "GitHub Actions `service_account` for the deploy workflows."
  value       = google_service_account.app_deployer.email
}

output "wif_provider" {
  description = "GitHub Actions `workload_identity_provider`."
  value       = google_iam_workload_identity_pool_provider.app.name
}

output "media_bucket" {
  value = google_storage_bucket.media.name
}

output "renders_bucket" {
  value = google_storage_bucket.renders.name
}
