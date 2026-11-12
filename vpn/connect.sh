#!/bin/sh
# Bring the VPN up with OpenConnect and keep it up.
#
# Required:  VPN_SERVER    host or host:port of the VPN gateway
#            VPN_USERNAME
#            VPN_PASSWORD  read from the environment, handed to OpenConnect on
#                          stdin — never on a command line, never logged
# Optional:  VPN_PROTOCOL    anyconnect (default) | gp | pulse | fortinet | nc | f5
#            VPN_AUTHGROUP   the AnyConnect group / tunnel-group, if the gateway asks
#            VPN_SERVERCERT  pin-sha256:… — pin a gateway whose certificate the
#                            system trust store rejects (OpenConnect prints the
#                            value to use when it refuses the certificate)
#            VPN_EXTRA_ARGS  more OpenConnect arguments, space-separated
#            VPN_RETRY_SECONDS  wait between attempts (default 10)
#
# The tunnel exists only inside this container's network namespace (shared with
# the ndfc-mcp container). Nothing on the host is rerouted.
set -u

log() { printf 'level=%s msg="%s"\n' "$1" "$2"; }

missing=""
[ -n "${VPN_SERVER:-}" ]   || missing="$missing VPN_SERVER"
[ -n "${VPN_USERNAME:-}" ] || missing="$missing VPN_USERNAME"
[ -n "${VPN_PASSWORD:-}" ] || missing="$missing VPN_PASSWORD"
if [ -n "$missing" ]; then
  log error "the VPN sidecar refuses to start; not set:$missing"
  exit 1
fi
if [ ! -c /dev/net/tun ]; then
  log error "/dev/net/tun is missing: the container needs devices: [/dev/net/tun] and cap_add: [NET_ADMIN]"
  exit 1
fi

PROTOCOL="${VPN_PROTOCOL:-anyconnect}"
RETRY="${VPN_RETRY_SECONDS:-10}"

# Build the argument list without eval; the password is not part of it.
set -- --protocol="$PROTOCOL" --user="$VPN_USERNAME" --passwd-on-stdin --non-inter --interface=tun0 --reconnect-timeout=60
[ -n "${VPN_AUTHGROUP:-}" ]  && set -- "$@" --authgroup="$VPN_AUTHGROUP"
[ -n "${VPN_SERVERCERT:-}" ] && set -- "$@" --servercert="$VPN_SERVERCERT"
if [ -n "${VPN_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2086  # word splitting is the documented behaviour of this variable
  set -- "$@" $VPN_EXTRA_ARGS
fi

child=""
stop() {
  log info "stopping the VPN"
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
  wait 2>/dev/null
  exit 0
}
trap stop TERM INT

attempt=0
while :; do
  attempt=$((attempt + 1))
  log info "connecting to $VPN_SERVER as $VPN_USERNAME (protocol $PROTOCOL, attempt $attempt)"
  # printf is a shell builtin: the password never appears in a process list.
  printf '%s\n' "$VPN_PASSWORD" | openconnect "$@" "$VPN_SERVER" &
  child=$!
  wait "$child"
  code=$?
  child=""
  log warn "the VPN session ended (openconnect exit $code); retrying in ${RETRY}s"
  sleep "$RETRY" &
  wait $!
done
