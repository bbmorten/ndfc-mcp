# The VPN sidecar: OpenConnect, the open-source client for Cisco AnyConnect
# (and GlobalProtect, Pulse, Fortinet) VPN gateways. The ndfc-mcp container
# joins THIS container's network namespace, so the controller is reachable from
# the MCP server while the host's own routing is left alone.
#
# Cisco's own AnyConnect / Secure Client cannot be redistributed in an image;
# OpenConnect speaks the same protocol.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      openconnect vpnc-scripts iproute2 ca-certificates curl procps \
    && rm -rf /var/lib/apt/lists/*

COPY connect.sh /usr/local/bin/vpn-connect
COPY healthcheck.sh /usr/local/bin/vpn-healthcheck
# A checkout made on Windows without this repository's .gitattributes (a ZIP
# download, an old clone) has CRLF line endings, and a CRLF shebang stops the
# container with "no such file or directory". Strip them; LF files are unchanged.
RUN sed -i 's/\r$//' /usr/local/bin/vpn-connect /usr/local/bin/vpn-healthcheck \
    && chmod 0755 /usr/local/bin/vpn-connect /usr/local/bin/vpn-healthcheck

HEALTHCHECK --interval=5s --timeout=8s --start-period=45s --retries=3 CMD ["/usr/local/bin/vpn-healthcheck"]
ENTRYPOINT ["/usr/local/bin/vpn-connect"]
