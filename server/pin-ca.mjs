#!/usr/bin/env node
/**
 * pin-ca.mjs — print the line that pins the controller's certificate authority.
 *
 *   docker compose exec -T ndfc-mcp node /app/pin-ca.mjs
 *
 * Nexus Dashboard serves a certificate issued by its own per-cluster CA, so the
 * system trust store rejects it. This connects to NDFC_URL WITHOUT verifying
 * (that is the point: it is how the trust is established), walks to the top of
 * the chain the controller presents, and prints
 *
 *   NDFC_TLS_CA_PEM="-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"
 *
 * for your .env, with the certificate's subject, expiry and SHA-256
 * fingerprint on stderr. Compare the fingerprint with one obtained another way
 * if the network between you and the controller is not one you trust: pinning
 * whatever answers is trust on first use.
 *
 * Pin the CA, not the leaf: pinning Nexus Dashboard's leaf certificate fails
 * with SELF_SIGNED_CERT_IN_CHAIN. A controller with one self-signed
 * certificate is its own top of chain, and this prints that.
 */
import tls from "node:tls";

const raw = process.argv[2] || process.env.NDFC_URL;
if (!raw) {
  console.error("usage: pin-ca.mjs [https://controller]   (default: NDFC_URL)");
  process.exit(2);
}
const u = new URL(raw);
// SNI names a host, never an address: Node refuses an IP as servername.
const sni = /^[0-9.]+$|:/.test(u.hostname) ? {} : { servername: u.hostname };

const socket = tls.connect({ host: u.hostname, port: Number(u.port || 443), rejectUnauthorized: false, ...sni }, () => {
  let cert = socket.getPeerX509Certificate();
  const leaf = cert;
  const seen = new Set();
  while (cert && cert.issuerCertificate && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256);
    cert = cert.issuerCertificate;
  }
  socket.end();
  if (!cert) {
    console.error("the controller presented no certificate");
    process.exit(1);
  }
  const oneLine = (s) => String(s).replace(/\n/g, ", ");
  console.error(`controller:  ${u.origin}`);
  console.error(`leaf:        ${oneLine(leaf.subject)}`);
  console.error(`pinning:     ${oneLine(cert.subject)}${cert.fingerprint256 === leaf.fingerprint256 ? " (self-signed; it is its own CA)" : ""}`);
  console.error(`valid to:    ${cert.validTo}`);
  console.error(`sha256:      ${cert.fingerprint256}`);
  console.log(`NDFC_TLS_CA_PEM="${cert.toString().trim().replace(/\n/g, "\\n")}"`);
});
socket.setTimeout(10_000, () => socket.destroy(new Error("timed out")));
socket.on("error", (e) => {
  console.error(`could not read the certificate from ${u.origin}: ${e.message}`);
  process.exit(1);
});
