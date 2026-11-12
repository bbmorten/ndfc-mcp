# ndfc-mcp — read-only Nexus Dashboard Fabric Controller tools. No npm
# dependencies: the controller is plain JSON over node:https.
#   server.mjs  MCP over HTTP          auth.mjs  API key (+ gateway assertions)
#   stdio.mjs   MCP over stdin/stdout  ndfc.mjs  the GET-only controller client
#   pin-ca.mjs  prints NDFC_TLS_CA_PEM tools.mjs the twelve tools and their rules
FROM node:22-bookworm-slim

RUN useradd -u 10001 -m ndfc && mkdir -p /app && chown -R ndfc /app
COPY server.mjs auth.mjs ndfc.mjs tools.mjs stdio.mjs pin-ca.mjs /app/

USER ndfc
ENV NDFC_MCP_PORT=3300 NODE_ENV=production
EXPOSE 3300
# Independent of the controller and the VPN: it says the server is up, not that
# the fabric is reachable (the tools say that, as error results).
HEALTHCHECK --interval=15s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NDFC_MCP_PORT||3300)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
