# Shotline on GCP

Production moved from AWS (account suspended 2026-11-14) to GCP project
`shotline-511017`, region `asia-south1`.

| Piece | Where |
|---|---|
| Frontend (Remix :3000), API (:4000), BullMQ worker, Redis, Caddy | VM `shotline-app` (pm2, user `shotline`, `/var/www/shotline`) |
| Reframe service | VM `shotline-reframe` (unchanged; its own repo + deploy) |
| Media / renders | GCS buckets `shotline-media-prod` (public read) / `shotline-renders-prod` (private) |
| Infra as code | `infra/terraform/` (state in `gs://shotline-511017-tfstate`) |
| Files installed on the VM | this folder, delivered through instance metadata by Terraform |

## Bootstrap (once)

From the Mac, signed in with `gcloud auth application-default login`:

```bash
gcloud storage buckets create gs://shotline-511017-tfstate --project shotline-511017 \
  --location asia-south1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://shotline-511017-tfstate --versioning
```

```bash
cd infra/terraform && terraform init && terraform plan
```

Read the plan: the 4 reframe resources must say **will be imported** (not
"replaced" or "destroyed"); everything else is a create. Then `terraform apply`.

## First-time setup on the VM (once, after apply)

```bash
gcloud compute ssh shotline-app --zone asia-south1-a --tunnel-through-iap
sudo tail -5 /var/log/shotline-bootstrap.log          # expect "== bootstrap done"
```

Give the VM read-only access to both repos (one deploy key per repo):

```bash
sudo -u shotline -H bash -c '
  for r in backend frontend; do
    ssh-keygen -t ed25519 -N "" -f ~/.ssh/deploy_$r -C shotline-app-$r
  done
  cat > ~/.ssh/config <<EOF
Host github-backend
  HostName github.com
  IdentityFile ~/.ssh/deploy_backend
Host github-frontend
  HostName github.com
  IdentityFile ~/.ssh/deploy_frontend
EOF
  ssh-keyscan github.com >> ~/.ssh/known_hosts
  cat ~/.ssh/deploy_*.pub'
```

Add each public key under the repo → Settings → Deploy keys (read-only), then:

```bash
sudo -u shotline -H bash -c '
  cd /var/www/shotline
  git clone git@github-backend:mystry123/video-editor-backend.git backend
  git clone git@github-frontend:mystry123/video-editor-frontend.git frontend'
```

Write `/var/www/shotline/backend/.env` and `/var/www/shotline/frontend/.env`
(owner `shotline`, mode 600). Changes from the EC2 values: GCS bucket vars
instead of `AWS_*`/`S3_BUCKET` (see the backend's `.env.example`),
`REDIS_HOST=127.0.0.1`, the reframe URL stays `https://reframe.shotline.in`,
and renders run on the worker: `REMOTION_SERVE_URL=/var/www/shotline/remotion-bundles/current`
(no `REMOTION_AWS_*`, `REMOTION_FUNCTION_NAME` or webhook vars any more).

Deploy the **frontend first**: its deploy builds the Remotion bundle that
renders use (`remotion-bundles/<sha>`, `current` → the live one; the last 4 are
kept so running renders keep theirs). Backend deploys pre-download Chrome.

First deploy of each app (also what CI runs):

```bash
sudo /usr/local/bin/shotline-deploy backend <sha-on-main>
sudo /usr/local/bin/shotline-deploy frontend <sha-on-main>
```

Then point `shotline.in`, `www.shotline.in` and `api.shotline.in` A records
(GoDaddy) at `terraform output app_ip`. Caddy gets certificates by itself once
DNS resolves.

## Day to day

- Logs: `sudo -u shotline pm2 logs`, deploy history `/var/www/shotline/deploys.log`,
  Caddy `journalctl -u caddy`.
- Changing a file in this folder: `terraform apply`, then on the VM
  `sudo google_metadata_script_runner startup` to install it.
- Deploy status: `sudo shotline-deploy --status <backend|frontend> <sha>`.
