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

/**
 * Read both notBefore and notAfter dates from a certificate PEM file.
 * Returns { notBefore, notAfter } if valid, or null if missing, unreadable, or not a certificate.
 *
 * @param {string} [certPath]
 * @param {typeof readFileSync} [readFn]
 * @returns {{ notBefore: string|null, notAfter: string|null } | null}
 */
export function readCertificateDates(certPath, readFn = readFileSync) {
  if (!certPath) return null;
  try {
    const pem = readFn(certPath, 'utf8');
    const cert = new X509Certificate(pem);
    const from = new Date(cert.validFrom);
    const to = new Date(cert.validTo);
    return {
      notBefore: Number.isFinite(from.getTime()) ? from.toISOString() : null,
      notAfter: Number.isFinite(to.getTime()) ? to.toISOString() : null,
    };
  } catch {
    return null;
  }
}

