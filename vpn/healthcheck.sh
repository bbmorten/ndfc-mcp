#!/bin/sh
# Tunnel mode: healthy = the tunnel interface exists, is up and has an address. With
# VPN_HEALTH_URL set (compose sets it to the controller's unauthenticated
# /version.json), also: that URL answers through the tunnel. -k because reach
# is the claim here; the MCP server does its own certificate check.
if [ "${VPN_MODE:-tunnel}" = "proxy" ]; then
  # Proxy mode has no interface. Healthy = ocproxy runs and every forward
  # accepts a connection on 127.0.0.1. (That the far end answers is what
  # VPN_HEALTH_URL adds, e.g. https://127.0.0.1:<lport>/version.json.)
  # A forward that works HOLDS the connection open (the far end waits for the
  # client to speak), so curl runs into its time limit: exit 28 is "accepted",
  # like 0. Anything else (7: refused) is a forward that does not listen.
  pgrep -x ocproxy >/dev/null 2>&1 || exit 1
  for f in ${VPN_FORWARDS:-}; do
    curl -s --connect-timeout 2 -m 1 -o /dev/null "telnet://127.0.0.1:${f%%:*}" </dev/null
    case $? in 0|28) ;; *) exit 1 ;; esac
  done
else
  ip -o -4 addr show dev tun0 2>/dev/null | grep -q 'inet ' || exit 1
fi
if [ -n "${VPN_HEALTH_URL:-}" ]; then
  curl -sk -m 5 -o /dev/null "$VPN_HEALTH_URL" || exit 1
fi
exit 0
