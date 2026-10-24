/**
 * Every interview, checked and newest first.
 *
 * An interview is one `<slug>.json` file in this folder (format and an
 * example: docs/runbooks/add-an-interview.md). Adding a file adds the
 * interview; there is no list to edit. A file whose name starts with an
 * underscore is a draft and is not read.
 *
 * The files are read at build time and bundled with the Interviews page, so
 * the pre-render step has them without a fetch and the page works with no
 * network once it has loaded. Only the page reads this module. The Azure
 * landing page asks `available.js`, which reads file NAMES and nothing else,
 * whether to show its Interviews card: importing this module there would put
 * every interview's text in that page's bundle.
 *
 * A file that is not valid stops the build with a sentence naming the file
 * and the field (`normalizeInterview`), so a typo cannot ship as a blank page.
 */
import { normalizeInterview, sortInterviews } from '@/lib/interviews';

const files = import.meta.glob(['./*.json', '!./_*.json'], { eager: true, import: 'default' });

/** @type {ReadonlyArray<ReturnType<typeof normalizeInterview>>} */
export const interviews = Object.freeze(
  sortInterviews(
    Object.entries(files).map(([path, raw]) =>
      normalizeInterview(raw, path.replace(/^\.\//, '').replace(/\.json$/, ''))
    )
  )
);

/** One interview by its slug, or undefined. */
export const findInterview = (slug) => interviews.find((interview) => interview.slug === slug);
