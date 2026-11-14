#!/bin/sh
# The program OpenConnect runs in proxy mode (--script-tun --script=...).
# OpenConnect hands it the VPN packets on a socket instead of creating a tunnel
# interface; this script becomes ocproxy, which answers them with a userspace
# TCP/IP stack and serves each VPN_FORWARDS entry (lport:host:rport) on
# 127.0.0.1:<lport>. No interface, no route, no DNS change, no privilege.
set -u
if [ -z "${VPN_FORWARDS:-}" ]; then
  echo 'level=error msg="vpn-proxy-hook: VPN_FORWARDS is not set"' >&2
  exit 1
fi
# -k: keep idle connections alive, so the gateway does not drop a quiet session.
set -- ocproxy -k 30
for f in $VPN_FORWARDS; do
  set -- "$@" -L "$f"
done
echo "level=info msg=\"the VPN is up; forwarding on 127.0.0.1: $VPN_FORWARDS (address ${INTERNAL_IP4_ADDRESS:-unknown})\"" >&2
exec "$@"
