import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

/**
 * Read the notAfter date from a certificate PEM file.
 * Returns ISO string if valid, or null if missing, unreadable, or not a certificate.
 *
 * @param {string} [certPath]
 * @param {typeof readFileSync} [readFn]
 * @returns {string | null}
 */
export function readCertificateExpiry(certPath, readFn = readFileSync) {
  if (!certPath) return null;
  try {
    const pem = readFn(certPath, 'utf8');
    const cert = new X509Certificate(pem);
    const date = new Date(cert.validTo);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}
