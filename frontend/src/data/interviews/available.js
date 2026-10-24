/**
 * Whether there is at least one interview to show, without loading any.
 *
 * `import.meta.glob` WITHOUT `eager` yields a loader per file, and only the
 * loaders' keys are read here, so the header's bundle holds a function per
 * file and none of their text: measured with a probe file on 2026-10-24, the
 * text appeared in one chunk of its own and not in the main entry. That is the
 * whole reason this is not `interviews.length` from `./index.js`, which would
 * carry every interview's text into the bundle every visitor downloads.
 *
 * Once an interview exists the pre-render step's own server build prints
 * Vite's `INEFFECTIVE_DYNAMIC_IMPORT` for each file here, because `./index.js`
 * also imports them statically. It is true and harmless: the browser build
 * keeps the file out of the main bundle anyway (above), and the server build
 * has no bundle size to protect.
 *
 * The pattern is the same as `./index.js`: files starting with an underscore
 * are drafts and are not counted.
 */
const loaders = import.meta.glob(['./*.json', '!./_*.json']);

export const hasInterviews = Object.keys(loaders).length > 0;
