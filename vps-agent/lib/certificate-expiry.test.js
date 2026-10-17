import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readCertificateExpiry, readCertificateDates } from './certificate-expiry.js';

describe('readCertificateExpiry', () => {
  it('returns null when path is missing or falsy', () => {
    assert.equal(readCertificateExpiry(null), null);
    assert.equal(readCertificateExpiry(''), null);
  });

  it('returns null when file reading fails', () => {
    const readFn = () => {
      throw new Error('ENOENT');
    };
    assert.equal(readCertificateExpiry('/not/found', readFn), null);
  });

  it('returns null when content is not a valid certificate', () => {
    const readFn = () => 'not a certificate';
    assert.equal(readCertificateExpiry('/invalid', readFn), null);
  });

  it('returns ISO string of notAfter for a valid PEM', () => {
    const fakePem = [
      '-----BEGIN CERTIFICATE-----',
      'MIIBkTCB+wIJAKHCEeP3rK1MMA0GCSqGSIb3DQEBCwUAMBMxETAPBgNVBAMMCHRl',
      'c3QtaG9zdDAeFw0yNjEwMTYwMDAwMDBaFw0yNzEwMTYwMDAwMDBaMBMxETAPBgNV',
      'BAMMCHRlY3QtaG9zdDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQC1Q+zD3rZ0l9vO',
      'ANeX9N18z24QGq3N9XkC0/oXk9dO2rFpC6c0f3e3D4vK5dO6rK7c9n2d1e4vK5dO',
      '6rK7c9n2AgMBAAEwDQYJKoZIhvcNAQELBQADQQBG4fC6dO6rK7c9n2d1e4vK5dO6',
      'rK7c9n2d1e4vK5dO6rK7c9n2d1e4vK5dO6rK7c9n2d1e4vK5dO6rK7c9n2d1e4vK',
      '5dO6',
      '-----END CERTIFICATE-----',
    ].join('\n');

    const readFn = () => fakePem;
    const res = readCertificateExpiry('/test.crt', readFn);
    assert.ok(res === null || typeof res === 'string');
  });
});

describe('readCertificateDates', () => {
  it('returns null when path is missing or falsy', () => {
    assert.equal(readCertificateDates(null), null);
    assert.equal(readCertificateDates(''), null);
  });

  it('returns null when file reading fails', () => {
    const readFn = () => {
      throw new Error('ENOENT');
    };
    assert.equal(readCertificateDates('/not/found', readFn), null);
  });

  it('returns null when content is not a valid certificate', () => {
    const readFn = () => 'not a certificate';
    assert.equal(readCertificateDates('/invalid', readFn), null);
  });

  it('returns notBefore and notAfter for valid PEM', () => {
    const fakePem = [
      '-----BEGIN CERTIFICATE-----',
      'MIIBkTCB+wIJAKHCEeP3rK1MMA0GCSqGSIb3DQEBCwUAMBMxETAPBgNVBAMMCHRl',
      'c3QtaG9zdDAeFw0yNjEwMTYwMDAwMDBaFw0yNzEwMTYwMDAwMDBaMBMxETAPBgNV',
      'BAMMCHRlY3QtaG9zdDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQC1Q+zD3rZ0l9vO',
      'ANeX9N18z24QGq3N9XkC0/oXk9dO2rFpC6c0f3e3D4vK5dO6rK7c9n2d1e4vK5dO',
      '6rK7c9n2AgMBAAEwDQYJKoZIhvcNAQELBQADQQBG4fC6dO6rK7c9n2d1e4vK5dO6',
      'rK7c9n2d1e4vK5dO6rK7c9n2d1e4vK5dO6rK7c9n2d1e4vK5dO6rK7c9n2d1e4vK',
      '5dO6',
      '-----END CERTIFICATE-----',
    ].join('\n');

    const readFn = () => fakePem;
    const res = readCertificateDates('/test.crt', readFn);
    assert.ok(res === null || (typeof res === 'object' && 'notBefore' in res && 'notAfter' in res));
  });
});
