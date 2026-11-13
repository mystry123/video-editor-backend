# Adopt resources that were created by hand for the reframe VM, so Terraform
# manages them instead of creating duplicates. `terraform plan` must show these
# as "will be imported" with no destroy/replace.
#
# Deliberately NOT managed here (left as they are): the reframe VM and disk
# themselves, the `github` WIF pool + `shotline-reframe` provider, and the
# reframe-deployer SA and its bindings.

import {
  to = google_compute_address.reframe
  id = "projects/shotline-511017/regions/asia-south1/addresses/shotline-reframe-ip"
}

import {
  to = google_compute_firewall.reframe_https_from_backend
  id = "projects/shotline-511017/global/firewalls/allow-https-from-ec2-backend"
}

import {
  to = google_compute_firewall.reframe_http_acme
  id = "projects/shotline-511017/global/firewalls/allow-http-acme-shotline-reframe"
}

import {
  to = google_compute_firewall.reframe_iap_ssh
  id = "projects/shotline-511017/global/firewalls/allow-iap-ssh-shotline-reframe"
}
