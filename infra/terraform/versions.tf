terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # State lives in a GCS bucket created once by hand (see README "Bootstrap").
  backend "gcs" {
    bucket = "shotline-511017-tfstate"
    prefix = "shotline"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
