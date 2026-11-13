# Everything uses the project's `default` VPC (the reframe VM already lives there).
data "google_compute_network" "default" {
  name = "default"
}

resource "google_compute_address" "app" {
  name   = "shotline-app-ip"
  region = var.region
}

# Public web traffic to Caddy (80 for Let's Encrypt + redirect, 443 for the sites).
resource "google_compute_firewall" "app_web" {
  name          = "allow-web-shotline-app"
  network       = data.google_compute_network.default.name
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["shotline-app"]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

# SSH only through IAP (Google's tunnel range); no public port 22.
resource "google_compute_firewall" "app_iap_ssh" {
  name          = "allow-iap-ssh-shotline-app"
  network       = data.google_compute_network.default.name
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["shotline-app"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# --- Reframe VM (created by hand on 2026-10-08; adopted via imports.tf) -------

resource "google_compute_address" "reframe" {
  name   = "shotline-reframe-ip"
  region = var.region
}

# reframe.shotline.in (Caddy, 443) accepted only the EC2 backend. Point it at
# the new app VM's address instead.
resource "google_compute_firewall" "reframe_https_from_backend" {
  name          = "allow-https-from-ec2-backend"
  description   = "reframe.shotline.in HTTPS, only from the shotline-app VM"
  network       = data.google_compute_network.default.name
  direction     = "INGRESS"
  source_ranges = ["${google_compute_address.app.address}/32"]
  target_tags   = ["shotline-reframe"]
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
}

resource "google_compute_firewall" "reframe_http_acme" {
  name          = "allow-http-acme-shotline-reframe"
  network       = data.google_compute_network.default.name
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["shotline-reframe"]
  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
}

resource "google_compute_firewall" "reframe_iap_ssh" {
  name          = "allow-iap-ssh-shotline-reframe"
  network       = data.google_compute_network.default.name
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["shotline-reframe"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
