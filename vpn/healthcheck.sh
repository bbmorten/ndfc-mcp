#!/bin/sh
# Healthy = the tunnel interface exists, is up and has an address. With
# VPN_HEALTH_URL set (compose sets it to the controller's unauthenticated
# /version.json), also: that URL answers through the tunnel. -k because reach
# is the claim here; the MCP server does its own certificate check.
ip -o -4 addr show dev tun0 2>/dev/null | grep -q 'inet ' || exit 1
if [ -n "${VPN_HEALTH_URL:-}" ]; then
  curl -sk -m 5 -o /dev/null "$VPN_HEALTH_URL" || exit 1
fi
exit 0
