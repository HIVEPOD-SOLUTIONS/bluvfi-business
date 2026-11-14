#!/usr/bin/env bash
# One-time setup of an EC2 Ubuntu server (22.04 or 24.04) for Bluvfi Business. Run it on the server as the ubuntu user:
#
#   bash ec2-setup.sh app.example.com            # the live app
#   bash ec2-setup.sh demo.example.com --demo    # the hosted demo (no keys, no funds)
#
# It installs Docker and Caddy (HTTPS with a free Let's Encrypt certificate, renewed on its own), adds swap, and creates
# the folder the GitHub Actions deploy uses. Point the domain's DNS A record at this server's public IP first, and open
# ports 80 and 443 in the instance's security group. Safe to run again. Full guide: docs/DEPLOY.md
set -euo pipefail

DOMAIN="${1:-}"
MODE="${2:-}"
APP_DIR="${APP_DIR:-/home/ubuntu/bluvfi}"
APP_PORT="${APP_PORT:-3000}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: bash ec2-setup.sh <domain> [--demo]" >&2
  exit 1
fi

echo "== Docker"
if ! command -v docker >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io
fi
sudo systemctl enable --now docker

echo "== Caddy (HTTPS in front of the app)"
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y caddy
fi
# The app only listens on 127.0.0.1; Caddy is the one public door. Sign-in needs HTTPS (the session cookie is Secure).
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$APP_PORT
}
EOF
sudo systemctl enable caddy
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "== Swap (the build is done in CI, but zero-knowledge proving needs memory headroom)"
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== App folder $APP_DIR"
mkdir -p "$APP_DIR/data"
touch "$APP_DIR/.env.local" "$APP_DIR/docker.env"
chmod 600 "$APP_DIR/.env.local" "$APP_DIR/docker.env"
if [ "$MODE" = "--demo" ]; then
  grep -q '^BLUVFI_DEMO=' "$APP_DIR/docker.env" || echo 'BLUVFI_DEMO=1' >>"$APP_DIR/docker.env"
fi
# Caddy is one proxy hop in front of the app: rate limits then count each visitor's own address, not Caddy's.
grep -q '^BLUVFI_TRUSTED_PROXY_HOPS=' "$APP_DIR/docker.env" || echo 'BLUVFI_TRUSTED_PROXY_HOPS=1' >>"$APP_DIR/docker.env"
# The container runs as uid 1000 ("node").
sudo chown -R 1000:1000 "$APP_DIR/data" "$APP_DIR/.env.local"

echo
echo "Done. Next:"
if [ "$MODE" = "--demo" ]; then
  echo "  The hosted demo needs no settings. Run the Deploy workflow on GitHub (Actions > Deploy > Run workflow)."
else
  echo "  1. Put the live settings in $APP_DIR/.env.local (start from .env.example in the repo; BLUVFI_MASTER_KEY at least)."
  echo "  2. Run the Deploy workflow on GitHub (Actions > Deploy > Run workflow)."
fi
echo "  Then open https://$DOMAIN"
echo "  Back up $APP_DIR/data (the records) and keep BLUVFI_MASTER_KEY somewhere safe: the records are sealed with it."
