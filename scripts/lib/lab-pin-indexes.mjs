/** Reading package indexes and checksum files for the lab pin planners (see lab-pin-bumps.mjs). */
import { escapeRe, sha256Hex } from './lab-pin-constants.mjs';
import { coreVersion } from '../lab-pins-upstream.mjs';

// ── Package indexes and checksum files ─────────────────────────────────────

/** Every stanza for one package in a Debian Packages index. */
export function aptStanzas(packagesText, name) {
  return String(packagesText)
    .split(/\n\n+/)
    .filter((stanza) => new RegExp(`^Package: ${escapeRe(name)}$`, 'm').test(stanza))
    .map((stanza) => ({
      version: stanza.match(/^Version: (.+)$/m)?.[1]?.trim() ?? null,
      sha256: stanza.match(/^SHA256: ([0-9a-f]{64})$/m)?.[1] ?? null,
      filename: stanza.match(/^Filename: (.+)$/m)?.[1]?.trim() ?? null,
    }));
}

/**
 * Order two Debian version strings of one package in one suite by their
 * numeric runs (epoch, upstream, revision): `0.37.1-2~ubuntu…` is newer than
 * `0.37.1-1~ubuntu…`. Not dpkg's full algorithm, which these indexes never
 * need: within one suite of one publisher the strings differ only in numbers.
 */
export function compareDebian(a, b) {
  const pa = String(a).match(/\d+/g)?.map(Number) ?? [];
  const pb = String(b).match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] ?? -1) !== (pb[i] ?? -1)) return (pa[i] ?? -1) < (pb[i] ?? -1) ? -1 : 1;
  }
  return 0;
}

/**
 * The newest build of upstream version `core`: a publisher can rebuild a
 * release under a new Debian revision (0.37.1-1 → 0.37.1-2), and that is a
 * pin to move too. Throws on none, or on a pick without a SHA256.
 */
export function aptPick(packagesText, name, core) {
  const hits = aptStanzas(packagesText, name).filter((s) => coreVersion(s.version) === core);
  if (hits.length === 0) throw new Error(`${name} ${core} is not in the index`);
  const pick = hits.reduce((best, s) => (compareDebian(s.version, best.version) > 0 ? s : best));
  if (!pick.sha256) throw new Error(`${name} ${pick.version} carries no SHA256 in the index`);
  return pick;
}

/** The SHA256 an InRelease file lists for one index path (`stable/binary-amd64/Packages`). */
export function inReleaseSha256(inReleaseText, path) {
  const section = String(inReleaseText).split(/^SHA256:[ \t]*\r?$/m)[1] ?? '';
  for (const line of section.split('\n').slice(1)) {
    if (!/^\s/.test(line)) break;
    const [hash, , name] = line.trim().split(/\s+/);
    if (name === path) return hash;
  }
  return null;
}

/** The hex beside a file name in a `sha256sum`-format checksum file (`hexLength` 128 for a sha512sum one). */
export function sumsLine(sumsText, filename, hexLength = 64) {
  const re = new RegExp(`^([0-9a-f]{${hexLength}})\\s+\\*?(\\S+)$`);
  for (const line of String(sumsText).split('\n')) {
    const m = line.trim().match(re);
    if (m && m[2] === filename) return m[1];
  }
  return null;
}

/** The module zip's h1: hash from a sum.golang.org lookup. */
export function goSumHash(lookupText, module, version) {
  const m = String(lookupText).match(new RegExp(`^${escapeRe(module)} ${escapeRe(version)} (h1:[A-Za-z0-9+/=]+)$`, 'm'));
  return m ? m[1] : null;
}

/**
 * A Packages index read with its InRelease, the index's own hash checked
 * against the list. `verifyInRelease(text, url)`, when given, is awaited on
 * the InRelease text before anything is trusted from it, and throws to refuse
 * it: the bumps read these indexes for evidence over TLS alone, but a caller
 * that goes on to run what it downloads (record-docker-cli-fixture.mjs)
 * verifies the publisher's signature with it.
 */
export async function aptIndex(http, base, suitePath, component, { verifyInRelease } = {}) {
  const indexPath = `${component}/binary-amd64/Packages`;
  const packagesUrl = `${base}/${suitePath}/${indexPath}`;
  const inReleaseUrl = `${base}/${suitePath}/InRelease`;
  const [{ body }, inRelease] = await Promise.all([http.raw(packagesUrl), http.text(inReleaseUrl)]);
  if (verifyInRelease) await verifyInRelease(inRelease, inReleaseUrl);
  const listed = inReleaseSha256(inRelease, indexPath);
  const computed = sha256Hex(body);
  if (listed !== computed) {
    throw new Error(`${packagesUrl} hashes to ${computed}, but ${inReleaseUrl} lists ${listed ?? 'nothing'} for it`);
  }
  return { text: body.toString('utf8'), packagesUrl, inReleaseUrl, indexSha256: computed };
}
