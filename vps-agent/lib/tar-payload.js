/**
 * The parser for a `tar` lab payload (#675), split out of docker-runner.js
 * by job (#1845); docker-runner.js re-exports everything here.
 *
 * The parser is deliberately not a dependency and not the host's `tar`: it
 * accepts regular files and directories only, refuses absolute paths, `..`
 * segments, symlinks, hard links and every extension header, and bounds the
 * entry count and the unpacked size, because the archive is untrusted input
 * that reached this host from the API and the job directory is the one place
 * on the host it may touch. Node built-ins only.
 */

import zlib from 'node:zlib';

/** Bounds on an unpacked `tar` payload. The API caps the encoded payload at 64 KB. */
export const TAR_MAX_ENTRIES = 512;
export const TAR_MAX_BYTES = 8 * 1024 * 1024;

const readOctal = (buf, start, length) => {
  const text = buf.toString('latin1', start, start + length).replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error('tar payload: a header field is not octal (base-256 sizes are not supported)');
  }
  return parseInt(text, 8);
};

const readString = (buf, start, length) =>
  buf.toString('utf8', start, start + length).replace(/\0.*$/s, '');

/**
 * Normalise and vet one archive path. Returns the relative POSIX path, or
 * throws. Anything that could name a location outside the job directory —
 * an absolute path, a `..` segment, a backslash, a NUL — is refused outright
 * rather than normalised away, because a payload that carries one is not a
 * chart or a Terraform root, whatever else it is.
 */
export function vetTarPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('tar payload: an entry has no name');
  if (raw.includes('\0') || raw.includes('\\')) {
    throw new Error(`tar payload: refusing entry with a NUL or backslash in its name`);
  }
  let p = raw;
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/+$/, '');
  if (p === '' || p === '.') return '';
  if (p.startsWith('/')) throw new Error(`tar payload: refusing absolute path ${JSON.stringify(raw)}`);
  const segments = p.split('/');
  if (segments.some((s) => s === '..' || s === '' || s === '.')) {
    throw new Error(`tar payload: refusing path ${JSON.stringify(raw)}`);
  }
  return segments.join('/');
}

/** The tar typeflags a payload may carry, and what each becomes. */
const TAR_ENTRY_TYPES = { 0: 'file', '\0': 'file', 5: 'dir' };

/**
 * Read one 512-byte tar header. Returns null at the end-of-archive marker,
 * otherwise the entry's name (with the ustar prefix joined on), typeflag
 * and data size.
 */
function readTarHeader(buf, offset) {
  const header = buf.subarray(offset, offset + 512);
  if (header.every((b) => b === 0)) return null;
  let name = readString(header, 0, 100);
  if (header.toString('latin1', 257, 263) === 'ustar\0') {
    const prefix = readString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
  }
  return { name, typeflag: String.fromCharCode(header[156]), size: readOctal(header, 124, 12) };
}

/**
 * Map a typeflag to 'file' or 'dir', or throw. Every other entry type is an
 * error: there is no legitimate reason for a lab payload to carry a symlink,
 * a hard link, a device node, or a pax or GNU long-name extension, and each
 * of those is a way to write somewhere other than the job directory or to
 * smuggle a path past `vetTarPath`.
 */
function tarEntryType({ name, typeflag }) {
  const type = TAR_ENTRY_TYPES[typeflag];
  if (!type) {
    const shown = typeflag === '\0' ? '\\0' : typeflag;
    throw new Error(
      `tar payload: refusing entry ${JSON.stringify(name)} of type '${shown}' (only regular files and directories are accepted)`
    );
  }
  return type;
}

function assertTarBounds(entryCount, totalBytes) {
  if (entryCount > TAR_MAX_ENTRIES) {
    throw new Error(`tar payload: more than ${TAR_MAX_ENTRIES} entries`);
  }
  if (totalBytes > TAR_MAX_BYTES) {
    throw new Error(`tar payload: unpacked size exceeds ${TAR_MAX_BYTES} bytes`);
  }
}

/**
 * Parse a (ustar or GNU) tar buffer into regular files and directories,
 * each path vetted by `vetTarPath` and the whole bounded by `assertTarBounds`.
 *
 * @returns {{ path: string, type: 'file'|'dir', data: Buffer }[]}
 */
export function parseTar(buf) {
  const entries = [];
  let offset = 0;
  let total = 0;
  while (offset + 512 <= buf.length) {
    const header = readTarHeader(buf, offset);
    if (header === null) break;
    const dataStart = offset + 512;
    const dataEnd = dataStart + header.size;
    if (dataEnd > buf.length) throw new Error('tar payload: truncated archive');
    offset = dataStart + Math.ceil(header.size / 512) * 512;

    const type = tarEntryType(header);
    const vetted = vetTarPath(header.name);
    if (vetted === '') continue; // the archive's own root, "./"
    entries.push({
      path: vetted,
      type,
      data: type === 'dir' ? Buffer.alloc(0) : buf.subarray(dataStart, dataEnd),
    });
    total += header.size;
    assertTarBounds(entries.length, total);
  }
  return entries;
}

/** Decode a `tar` payload string: base64, then gunzip if it is gzipped. */
export function decodeTarPayload(payload) {
  if (typeof payload !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(payload)) {
    throw new Error('tar payload: expected base64');
  }
  let buf = Buffer.from(payload.replace(/\s+/g, ''), 'base64');
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = zlib.gunzipSync(buf, { maxOutputLength: TAR_MAX_BYTES });
    } catch (err) {
      throw new Error(`tar payload: gunzip failed (${err.code || err.message})`);
    }
  }
  return buf;
}
