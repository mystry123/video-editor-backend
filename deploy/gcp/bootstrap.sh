#!/usr/bin/env bash
# Startup script for the shotline-app VM (Terraform: infra/terraform/compute.tf).
# Runs as root on every boot; every step is idempotent.
#
# Installs: Node 22 + pnpm + pm2, Redis (local, BullMQ), Caddy (HTTPS),
# ffmpeg, Chrome's runtime libraries (Remotion renders) and fonts.
# Writes, from instance metadata: the Caddyfile, the pm2 ecosystem file, the
# deploy scripts and the deployer's sudo rule.
#
# It does NOT clone the repos or write .env files — see deploy/gcp/README.md
# ("First-time setup"), done once by hand.
set -euo pipefail
exec > >(tee -a /var/log/shotline-bootstrap.log) 2>&1
echo "== bootstrap $(date -u +%FT%TZ)"

md() {
  curl -fsS -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

export DEBIAN_FRONTEND=noninteractive

# --- packages (first boot, or when something is missing) ----------------------
if [[ ! -f /var/lib/shotline-bootstrap.v1 ]]; then
  apt-get update -q
  apt-get install -yq ca-certificates curl gnupg git jq build-essential \
    redis-server ffmpeg debian-keyring debian-archive-keyring apt-transport-https \
    fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk fontconfig \
    libnss3 libdbus-1-3 libatk1.0-0t64 libatk-bridge2.0-0t64 libgbm1 libasound2t64 \
    libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 \
    libcairo2 libcups2t64 libdrm2 libxshmfence1

  # Node 22 (NodeSource)
  if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -yq nodejs
  fi
  corepack enable
  npm install -g pm2@6

  # Caddy (official repo)
  if ! command -v caddy >/dev/null; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -yq caddy
  fi

  touch /var/lib/shotline-bootstrap.v1
fi

# --- service user and layout (same paths as the EC2 box) ----------------------
id shotline >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/shotline --shell /bin/bash shotline
install -d -o shotline -g shotline /var/www/shotline /var/www/shotline/backups
install -d -o root -g root -m 755 /usr/local/lib/shotline

# --- Redis: local only; BullMQ needs noeviction --------------------------------
sed -i 's/^#\? *bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
sed -i 's/^#\? *maxmemory-policy .*/maxmemory-policy noeviction/' /etc/redis/redis.conf
grep -q '^maxmemory-policy' /etc/redis/redis.conf || echo 'maxmemory-policy noeviction' >> /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server

# --- files carried in instance metadata (source: deploy/gcp/) -----------------
md caddyfile > /etc/caddy/Caddyfile.new && mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

md ecosystem > /var/www/shotline/ecosystem.config.cjs
chown shotline:shotline /var/www/shotline/ecosystem.config.cjs

md app-deploy > /usr/local/lib/shotline/app-deploy
md deploy-entry > /usr/local/bin/shotline-deploy
chmod 755 /usr/local/lib/shotline/app-deploy /usr/local/bin/shotline-deploy

# The CI deployer (OS Login user sa_<id>) may run only the deploy entry point.
deployer="$(md deployer-user)"
printf '%s ALL=(root) NOPASSWD: /usr/local/bin/shotline-deploy\n' "$deployer" > /etc/sudoers.d/shotline-deploy.new
chmod 440 /etc/sudoers.d/shotline-deploy.new
visudo -cf /etc/sudoers.d/shotline-deploy.new && mv /etc/sudoers.d/shotline-deploy.new /etc/sudoers.d/shotline-deploy

# --- pm2 under systemd as `shotline` ------------------------------------------
if [[ ! -f /etc/systemd/system/pm2-shotline.service ]]; then
  env PATH="$PATH" pm2 startup systemd -u shotline --hp /home/shotline >/dev/null
fi
systemctl enable pm2-shotline

echo "== bootstrap done"
