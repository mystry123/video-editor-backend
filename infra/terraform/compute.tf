# Fixed internal IP so the deployer's IAP condition can name it.
resource "google_compute_address" "app_internal" {
  name         = "shotline-app-internal-ip"
  region       = var.region
  address_type = "INTERNAL"
  subnetwork   = "default"
}

# The app box: Caddy → Remix frontend (:3000) + API (:4000), BullMQ worker,
# local Redis — the same layout as the EC2 box, managed by pm2.
resource "google_compute_instance" "app" {
  name         = "shotline-app"
  machine_type = var.app_machine_type
  zone         = var.zone
  tags         = ["shotline-app"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.app_disk_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = "default"
    network_ip = google_compute_address.app_internal.address
    access_config {
      nat_ip = google_compute_address.app.address
    }
  }

  service_account {
    email  = data.google_service_account.backend.email
    scopes = ["cloud-platform"]
  }

  # bootstrap.sh reads these keys from the metadata server and installs them.
  # Editing a file under deploy/gcp/ + `terraform apply` updates the metadata
  # in place; re-run the startup script (or reboot) to install the change.
  metadata = {
    enable-oslogin = "TRUE"
    # Installs packages and the files below; idempotent, re-runs on boot.
    # (A metadata key, not metadata_startup_script, which would recreate the VM
    # on every change.)
    startup-script = file("${path.module}/../../deploy/gcp/bootstrap.sh")
    caddyfile      = file("${path.module}/../../deploy/gcp/Caddyfile")
    ecosystem      = file("${path.module}/../../deploy/gcp/ecosystem.config.cjs")
    app-deploy     = file("${path.module}/../../deploy/gcp/app-deploy")
    deploy-entry   = file("${path.module}/../../deploy/gcp/shotline-deploy")
    # OS Login username of a service account is sa_<unique id>.
    deployer-user = "sa_${google_service_account.app_deployer.unique_id}"
  }

  shielded_instance_config {
    enable_secure_boot = true
  }

  allow_stopping_for_update = true

  lifecycle {
    # Don't replace the box when Ubuntu publishes a newer image.
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }

  depends_on = [google_project_service.enabled]
}
