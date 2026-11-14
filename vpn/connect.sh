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
#            VPN_MODE        tunnel (default) | proxy
#            VPN_FORWARDS    proxy mode, required: space-separated lport:host:rport
#
# Two modes.
#
#   tunnel  A tun0 interface with the gateway's routes, in this container's
#           network namespace (shared with the ndfc-mcp container). Needs
#           NET_ADMIN and /dev/net/tun. Nothing on the host is rerouted.
#
#   proxy   No interface, no route, no DNS change, NO PRIVILEGE: OpenConnect
#           hands the VPN packets to ocproxy (--script-tun), which serves each
#           VPN_FORWARDS entry as a TCP port on 127.0.0.1. The server is then
#           pointed at the forward (NDFC_URL=https://127.0.0.1:<lport>). For a
#           place that gives a container no capability, such as a Kubernetes
#           pod: the container runs as any user with every capability dropped,
#           and the pod's resolv.conf and routes stay the cluster's.
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
MODE="${VPN_MODE:-tunnel}"
case "$MODE" in
  tunnel)
    if [ ! -c /dev/net/tun ]; then
      log error "/dev/net/tun is missing: the container needs devices: [/dev/net/tun] and cap_add: [NET_ADMIN] (or VPN_MODE=proxy, which needs neither)"
      exit 1
    fi
    ;;
  proxy)
    if [ -z "${VPN_FORWARDS:-}" ]; then
      log error "VPN_MODE=proxy needs VPN_FORWARDS (lport:host:rport, space-separated): without a forward nothing reaches the VPN"
      exit 1
    fi
    # A port is a whole number from 1 to 65535: checked before the login, so a
    # typo never takes the gateway's one session for a forward that cannot work.
    port_ok() {
      case "$1" in ''|*[!0-9]*|0*|??????*) return 1 ;; esac
      [ "$1" -le 65535 ]
    }
    for f in $VPN_FORWARDS; do
      case "$f" in
        *[!0-9A-Za-z.:-]*|*:*:*:*) log error "VPN_FORWARDS entry is not lport:host:rport: $f"; exit 1 ;;
        *:*:*)
          fwd_lport=${f%%:*}; fwd_rport=${f##*:}; fwd_host=${f#*:}; fwd_host=${fwd_host%:*}
          if ! port_ok "$fwd_lport" || ! port_ok "$fwd_rport" || [ -z "$fwd_host" ]; then
            log error "VPN_FORWARDS entry is not lport:host:rport: $f"; exit 1
          fi
          ;;
        *) log error "VPN_FORWARDS entry is not lport:host:rport: $f"; exit 1 ;;
      esac
    done
    ;;
  *)
    log error "VPN_MODE must be tunnel or proxy, got: $MODE"
    exit 1
    ;;
esac

PROTOCOL="${VPN_PROTOCOL:-anyconnect}"
RETRY="${VPN_RETRY_SECONDS:-10}"

# Build the argument list without eval; the password is not part of it.
set -- --protocol="$PROTOCOL" --user="$VPN_USERNAME" --passwd-on-stdin --non-inter --reconnect-timeout=60
if [ "$MODE" = "proxy" ]; then
  # The hook becomes ocproxy; it reads VPN_FORWARDS from the environment.
  set -- "$@" --script-tun --script=/usr/local/bin/vpn-proxy-hook
else
  set -- "$@" --interface=tun0
fi
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
  log info "connecting to $VPN_SERVER as $VPN_USERNAME (protocol $PROTOCOL, mode $MODE, attempt $attempt)"
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
