/**
 * Shared argument parsing and console logging for repository operations.
 *
 * The old version also contained Firestore, GCS, Blob, and migration-report
 * clients. Those one-shot migration clients were retired after the Azure data
 * import was completed; current scripts use their own narrow Azure clients.
 */

/**
 * Parse argv into flags and options.
 *
 * Accepts both `--name value` and `--name=value`, rejects unknown arguments,
 * and keeps an absent option distinct from an empty string.
 *
 * @param {string[]} argv
 * @param {{ flags: string[], options: string[] }} spec
 * @returns {{ flags: Record<string, boolean>, options: Record<string, string> }}
 */
export function parseArgs(argv, spec) {
  const flags = Object.fromEntries(spec.flags.map((name) => [name, false]));
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const { name, inline } = splitArg(argv[index]);

    if (spec.flags.includes(name)) {
      if (inline !== undefined) throw new Error(`--${name} is a flag and takes no value`);
      flags[name] = true;
      continue;
    }

    if (!spec.options.includes(name)) {
      throw new Error(`Unknown argument: --${name}`);
    }

    if (inline !== undefined) {
      options[name] = inline;
    } else {
      index += 1;
      options[name] = requireValue(name, argv[index]);
    }
  }

  return { flags, options };
}

/** `--name=value` or `--name` into its name and, when written with `=`, its value. */
function splitArg(arg) {
  if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
  const separator = arg.indexOf('=');
  if (separator === -1) return { name: arg.slice(2).trim(), inline: undefined };
  return { name: arg.slice(2, separator).trim(), inline: arg.slice(separator + 1) };
}

/** The value after `--name`, which must be there and must not be the next option. */
function requireValue(name, value) {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

/** Split a comma-separated option into a trimmed, non-empty list. */
export function splitList(value) {
  if (!value) return null;
  const list = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

const line = '═'.repeat(63);

export const log = {
  banner(title, details = []) {
    process.stdout.write(`${line}\n  ${title}\n${line}\n`);
    for (const detail of details) process.stdout.write(`  ${detail}\n`);
    process.stdout.write(`${line}\n\n`);
  },
  section(title) {
    process.stdout.write(`\n--- ${title} ---\n\n`);
  },
  info(message) {
    process.stdout.write(`${message}\n`);
  },
  ok(message) {
    process.stdout.write(`OK    ${message}\n`);
  },
  warn(message) {
    process.stdout.write(`WARN  ${message}\n`);
  },
  error(message) {
    process.stderr.write(`FAIL  ${message}\n`);
  },
};
