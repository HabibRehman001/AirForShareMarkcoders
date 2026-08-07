#!/usr/bin/env bash
# Bring up local WireGuard server (wg0) using keys from repo-root .env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$ROOT/wireguard/wg0.conf"

if [[ ! -f "$CONF" ]]; then
  echo "Missing $CONF — generate it first (or ask the agent to recreate)."
  exit 1
fi

echo "Installing $CONF → /etc/wireguard/wg0.conf (needs sudo)"
sudo mkdir -p /etc/wireguard
sudo cp "$CONF" /etc/wireguard/wg0.conf
sudo chmod 600 /etc/wireguard/wg0.conf
sudo wg-quick down wg0 2>/dev/null || true
sudo wg-quick up wg0
sudo wg show
echo
echo "VPN server IP: 10.8.0.1"
echo "Share API should listen on 0.0.0.0:3001"
echo "Clients use wireguard/client.conf (Endpoint must be this PC's reachable IP)"
