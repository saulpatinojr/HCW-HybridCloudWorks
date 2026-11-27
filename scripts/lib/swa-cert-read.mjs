/**
 * The TLS read behind scripts/check-swa-certificates.mjs (#1929).
 *
 * One handshake with the Static Web App's default host, asking for one site
 * name by SNI (the name a client sends so the server knows which certificate
 * to show). Node's normal certificate checks stay on: the chain must lead to
 * a certificate authority Node trusts, the certificate must be in date, and
 * it must cover the name asked for (tls.checkServerIdentity). A certificate
 * that fails one of those ends the handshake with an error code, and that
 * code is the verdict. A certificate that passes is read for its end date.
 *
 * So the answer is one of:
 *   { cert }              the handshake succeeded; `cert` is
 *                         getPeerCertificate()'s description of it;
 *   { refused: reason }   Node refused the certificate; `reason` is one of
 *                         the fixed reason codes in REFUSALS below;
 * and a thrown error when the handshake could not be made at all (no
 * connection, a timeout, a code that is not a certificate refusal). Only
 * that last kind is tried again.
 */
import { connect as tlsConnect } from 'node:tls';

const PORT = 443;
const ATTEMPTS = 3;
const RETRY_MS = 5_000;
const TIMEOUT_MS = 15_000;

/**
 * Node's (OpenSSL's) refusal codes, each to one fixed reason. The reason
 * codes are this script's own words, so they can go in the issue's state
 * line; the certificate's own text never does.
 */
const REASON_OF = {
  CERT_HAS_EXPIRED: 'expired',
  CERT_NOT_YET_VALID: 'not-yet-valid',
  ERR_TLS_CERT_ALTNAME_INVALID: 'name-mismatch',
  HOSTNAME_MISMATCH: 'name-mismatch',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'untrusted',
  UNABLE_TO_GET_ISSUER_CERT: 'untrusted',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'untrusted',
  SELF_SIGNED_CERT_IN_CHAIN: 'untrusted',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'untrusted',
  CERT_UNTRUSTED: 'untrusted',
  CERT_REJECTED: 'untrusted',
  CERT_REVOKED: 'untrusted',
  CERT_SIGNATURE_FAILURE: 'untrusted',
  CERT_CHAIN_TOO_LONG: 'untrusted',
  INVALID_CA: 'untrusted',
  INVALID_PURPOSE: 'untrusted',
  UNABLE_TO_DECRYPT_CERT_SIGNATURE: 'untrusted',
  UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY: 'untrusted',
  ERROR_IN_CERT_NOT_BEFORE_FIELD: 'untrusted',
  ERROR_IN_CERT_NOT_AFTER_FIELD: 'untrusted',
};

/** The fixed reason for a refusal code, or null when the code is not one. */
export function refusalReason(code) {
  return Object.hasOwn(REASON_OF, code) ? REASON_OF[code] : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One handshake. Resolves with { cert } or { refused }, rejects when no
 * handshake could be made.
 */
export function readOnce({ host, servername, port = PORT, timeoutMs = TIMEOUT_MS, connect = tlsConnect }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host, port, servername, ALPNProtocols: ['http/1.1'] });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`no answer within ${timeoutMs / 1000} seconds`)));
    socket.once('error', (error) => {
      const reason = refusalReason(error?.code);
      if (reason) finish(null, { refused: reason });
      else finish(error);
    });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (cert && Object.keys(cert).length > 0) finish(null, { cert });
      else finish(new Error('the server sent no certificate'));
    });
  });
}

/**
 * readOnce, tried up to `attempts` times with a pause between, so one
 * dropped connection is not reported as an unreadable certificate. A
 * refusal is an answer, not a failure, and is not tried again.
 */
export async function readCertificate({ attempts = ATTEMPTS, retryMs = RETRY_MS, wait = sleep, ...options }) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readOnce(options);
    } catch (error) {
      last = error;
      if (attempt < attempts) await wait(retryMs);
    }
  }
  throw last;
}
