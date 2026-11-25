/** The names of Node's file functions the analysis looks for. */

/** Node file functions whose first argument is a path the code depends on. */
export const READ_FUNCTIONS = new Set([
  'readFileSync',
  'readFile',
  'readdirSync',
  'readdir',
  'existsSync',
  'exists',
  'statSync',
  'stat',
  'lstatSync',
  'lstat',
  'createReadStream',
  'opendirSync',
  'opendir',
  'accessSync',
  'access',
  'openSync',
  'open',
  'readlinkSync',
  'readlink',
  'realpathSync',
  'realpath',
  'copyFileSync',
  'copyFile',
  'cpSync',
  'cp',
]);

/** Names that, on a call, almost certainly mean a file read even when the guard cannot tell where the function comes from. */
export const FILE_LOOKING_NAMES = new Set([
  'readFileSync',
  'readdirSync',
  'existsSync',
  'statSync',
  'lstatSync',
  'opendirSync',
  'accessSync',
  'openSync',
  'readlinkSync',
  'realpathSync',
  'copyFileSync',
  'cpSync',
  'statfsSync',
  'readSync',
  'readFile',
  'readdir',
  'createReadStream',
  'lstat',
  'opendir',
  'realpath',
  'readlink',
  'copyFile',
]);

/** The name a call is made under: readFileSync in readFileSync(x) and in fs.readFileSync(x). */
export function calledName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type !== 'MemberExpression') return '';
  if (!callee.computed) return callee.property.name;
  return callee.property.type === 'Literal' && typeof callee.property.value === 'string' ? callee.property.value : '';
}
