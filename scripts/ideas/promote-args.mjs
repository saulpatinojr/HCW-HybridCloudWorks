/** The command line of promote-idea.mjs: its flags and their values. */

/** Options that are on when given: option -> the field it sets. */
const FLAG_OPTIONS = { '--help': 'help', '-h': 'help', '--dry-run': 'dryRun' };
/** Options that take the next argument: option -> [the field it sets, what the value must be]. */
const VALUE_OPTIONS = { '--name': ['name', 'a value'], '--vault': ['vault', 'a folder'] };
/** Options that are refused with their own message. */
const RETIRED_OPTIONS = {
  '--out-dir': '--out-dir no longer exists: drafts go to <vault>/Drafts. Give your vault with --vault <folder> or set HCW_VAULT',
};

export function readArgs(argv) {
  const options = { note: null, name: undefined, vault: undefined, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const step = readArg(argv[index], argv[index + 1], options);
    if (step.error) return { error: step.error };
    index += step.consumed;
  }
  return { options };
}

/** One argument onto `options`: `{ consumed }`, how many arguments after it were its value, or `{ error }`. */
function readArg(arg, next, options) {
  if (Object.hasOwn(FLAG_OPTIONS, arg)) {
    options[FLAG_OPTIONS[arg]] = true;
    return { consumed: 0 };
  }
  if (Object.hasOwn(VALUE_OPTIONS, arg)) return readValue(arg, next, options);
  if (arg.startsWith('-')) return { error: RETIRED_OPTIONS[arg] ?? `unknown option ${arg}` };
  if (options.note !== null) return { error: 'give one note at a time' };
  options.note = arg;
  return { consumed: 0 };
}

function readValue(arg, value, options) {
  // The next argument is this option's value. A missing one, or another
  // option standing where the value should be, is a mistake to report, not
  // a path to guess (an empty folder name would resolve to the current folder).
  const [field, needs] = VALUE_OPTIONS[arg];
  if (!value || value.startsWith('-')) return { error: `${arg} needs ${needs}` };
  options[field] = value;
  return { consumed: 1 };
}
