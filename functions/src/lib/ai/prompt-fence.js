/**
 * prompt-fence.js — the delimiters that separate instruction from material in
 * a prompt, and the one function that keeps material from closing them.
 *
 * WHY THIS IS ITS OWN MODULE. The fence was born in
 * `listen-and-learn/article-script.js` (#435) and was reused from there by the
 * AI router for source grounding (#433). That import pulled the whole article
 * module — and its own imports, `script.js` and `public-reads.js` — into the
 * router's module graph, which every function that touches a model loads on
 * cold start, and it made the generic router depend on one feature. Copilot's
 * review of PR #445 named both. So the fence lives here, with NO imports of its
 * own, and both sides import it. `article-script.js` re-exports the three names
 * unchanged, because other Listen & Learn modules import them from there.
 *
 * WHAT THE FENCE IS FOR. Text a model is asked to work from — an article, a
 * fetched page, a transcript — is untrusted input even when it is our own:
 * ContentForge drafts from external sources, an article about prompt injection
 * would quote the very phrases the prompt guards against, and a web page can
 * say anything. The defence has two halves. The prompt states that everything
 * between the markers is data, never instruction — that sentence belongs to
 * each prompt, beside its other rules. And the material itself passes through
 * one of the two functions below, so it cannot write a marker of its own,
 * because a fence the source can close is not a fence.
 *
 * WHAT THE FUNCTIONS PROMISE, AND WHAT THEY DO NOT. After either function the
 * text holds neither marker, whatever went in (#1826 has the reasoning, and
 * the test file beside this one has the table of hostile inputs). That is
 * all. The fence makes an instruction hidden in the material easy for a model
 * to tell from ours; it does not make a model ignore it. So every caller also
 * checks the model's answer before it is stored or shown, and no caller lets
 * an answer publish, delete or send anything by itself.
 *
 * WHAT WAS WRONG BEFORE #1826. The first version replaced each whole marker
 * once, taking one bracket off each side. Text with FOUR brackets round the
 * words (`<<<<END ARTICLE>>>>`) therefore came out holding a real marker: the
 * replacement built one.
 *
 * The delimiter names keep their ARTICLE spelling: they are exported under
 * those names from `article-script.js`, and the marker text is part of prompts
 * that tests pin. A rename would be churn with no safety gained.
 */

export const ARTICLE_OPEN = '<<<BEGIN ARTICLE>>>';
export const ARTICLE_CLOSE = '<<<END ARTICLE>>>';

// Characters that are drawn like `<` or `>` but are not them (the full-width
// and small forms). A model reads them as brackets, so they count as brackets.
const LESS = '<\\uFF1C\\uFE64';
const GREATER = '>\\uFF1E\\uFE65';
// Characters that take no space on the page (zero-width spaces and joiners,
// direction marks, the soft hyphen). One of them between two brackets would
// split a run for this code while still reading as one run.
const UNSEEN = '\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF';

/** How much text may sit between the brackets of a marker shape (a marker has 11 or 13 characters there). */
const SHAPE_INNER_MAX = 80;

// Three or more opening brackets in a row, unseen characters between them or not.
const OPENING_RUN = new RegExp(`(?:[${LESS}][${UNSEEN}]*){3,}`, 'g');
// What must follow an opening run to make a marker shape: up to
// SHAPE_INNER_MAX characters on the same line with no bracket among them,
// then three or more closing brackets. Sticky (`y`): it is only ever tried at
// the place an opening run ended, so it never searches.
const INNER_THEN_CLOSING_RUN = new RegExp(`([^${LESS}${GREATER}\\r\\n]{0,${SHAPE_INNER_MAX}})(?:[${GREATER}][${UNSEEN}]*){3,}`, 'y');

const UNSEEN_ANYWHERE = new RegExp(`[${UNSEEN}]`, 'g');
const LOOKS_LIKE_LESS = new RegExp(`[${LESS.slice(1)}]`, 'g');
const LOOKS_LIKE_GREATER = new RegExp(`[${GREATER.slice(1)}]`, 'g');

/**
 * One pass over the text: every marker shape loses brackets until it has two
 * on each side. Everything else is copied as it is.
 */
function breakMarkerShapes(text) {
  let out = '';
  let copied = 0;
  OPENING_RUN.lastIndex = 0;
  for (let run = OPENING_RUN.exec(text); run; run = OPENING_RUN.exec(text)) {
    INNER_THEN_CLOSING_RUN.lastIndex = OPENING_RUN.lastIndex;
    const rest = INNER_THEN_CLOSING_RUN.exec(text);
    if (rest) {
      out += `${text.slice(copied, run.index)}<<${rest[1]}>>`;
      copied = INNER_THEN_CLOSING_RUN.lastIndex;
      OPENING_RUN.lastIndex = copied;
    }
  }
  return out + text.slice(copied);
}

/**
 * Material for a fence, made unable to write a marker. For text that may
 * hold code: an article, a draft, a transcript.
 *
 * THE RULE. A "marker shape" is three or more `<`, then up to 80 characters
 * on the same line with no bracket among them, then three or more `>`. Both
 * markers are that shape (the test pins it). Every such shape is cut to two
 * brackets on each side, so `<<<END ARTICLE>>>` and `<<<<<END ARTICLE>>>>>`
 * both become `<<END ARTICLE>>`: the words stay, so a reader can still see
 * what the source contained. Look-alike brackets count as brackets, unseen
 * characters between brackets do not split a run, and the words between the
 * brackets do not matter, so letter case and near-spellings are covered too.
 *
 * WHY IT CANNOT BUILD A MARKER. The only change it makes is to shorten the
 * two bracket runs of a shape to exactly two; it never joins two runs,
 * because the characters on either side of a run stay where they were. A
 * marker left in the result would need three brackets on each side, so both
 * of its runs would be ones this function did not touch, with untouched text
 * between them: the marker would have been in the input as it stands, where
 * the pass would have found and cut it. One pass is therefore enough. It is
 * still repeated until nothing changes, as a second lock: if the pattern is
 * ever edited so that one pass is no longer enough, the result is still safe.
 *
 * WHAT IT LEAVES ALONE. Brackets that are not a marker shape, because the
 * material is often code and a rewritten draft must keep it: a heredoc or
 * here-string (`<<<EOF`, `cat <<<"$x"`), a merge conflict's `<<<<<<<` and
 * `>>>>>>>` lines (they are on different lines), an interpreter's `>>>`
 * prompt, nested generics (`a<b<c<d>>>`), and one or two brackets anywhere.
 * What does change is a single line that has both runs with no bracket
 * between them, such as `print("<<<" + s + ">>>")`, which loses one bracket
 * from each run.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function fenceArticleText(text) {
  let out = String(text || '');
  for (let before = null; before !== out; ) {
    before = out;
    out = breakMarkerShapes(out);
  }
  return out;
}

/**
 * The stricter form, for text that is prose and never code: a web page's
 * words, a name, a title, a bio. Unseen characters are removed, look-alike
 * brackets become plain ones, and EVERY run of three or more `<` or `>` is
 * cut to two, whether or not it is part of a marker shape. Nothing with
 * three brackets in a row is left, so nothing that even begins like a marker
 * is left. A single pass is enough: a run of any length becomes exactly two,
 * and two runs are never joined, because the character between them stays.
 *
 * Do not use it on code: it would turn `<<<EOF` into `<<EOF`.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function fencePlainText(text) {
  const plain = String(text || '')
    .replace(UNSEEN_ANYWHERE, '')
    .replace(LOOKS_LIKE_LESS, '<')
    .replace(LOOKS_LIKE_GREATER, '>')
    .replace(/<{3,}/g, '<<')
    .replace(/>{3,}/g, '>>');
  return fenceArticleText(plain);
}
