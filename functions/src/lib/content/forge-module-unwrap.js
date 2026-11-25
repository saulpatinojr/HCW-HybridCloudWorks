/**
 * forge-module-unwrap.js — the plain-markdown form of each kind of module,
 * for a module the forge's repair (forge-module-repair.js) has to turn back
 * into text. Nothing here does I/O.
 */

function linksModuleToMarkdown(content) {
  try {
    const parsed = JSON.parse(String(content || '').trim());
    const links = Array.isArray(parsed.links) ? parsed.links : [];
    return links
      .filter((link) => link && link.url)
      .map((link) => `- [${link.title || link.label || link.url}](${link.url})`)
      .join('\n');
  } catch {
    return '';
  }
}

/** Best-effort JSON body → object; null when it is not a usable object. */
function parseJsonBody(content) {
  try {
    const parsed = JSON.parse(String(content || '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const trimmed = (value) => String(value || '').trim();
export const listOf = (value) => (Array.isArray(value) ? value : []);
/** `label: value` when both are there, else whichever is. */
const pairText = (label, value) => (label && value ? `${label}: ${value}` : label || value);

/**
 * Plain-markdown fallback for each type of module that has to stop being a
 * module. Every content-carrying type needs an entry here: a type without
 * one silently drops the body, which is only acceptable for the purely
 * visual types (picture placeholders, video, spacer).
 */
const UNWRAPPERS = {
  text: (body) => body,
  fact: (body) => body,
  recommendation: (body) => body,
  code: (body) => (body.startsWith('```') ? body : `\`\`\`\n${body}\n\`\`\``),
  design: (body) => (body.startsWith('```') ? body : `\`\`\`mermaid\n${body}\n\`\`\``),
  links: (body) => linksModuleToMarkdown(body),
  pull_quote(body) {
    const parsed = parseJsonBody(body);
    const text = trimmed(parsed?.text);
    if (!text) return '';
    const attribution = trimmed(parsed?.attribution);
    return attribution ? `> ${text}\n>\n> ${attribution}` : `> ${text}`;
  },
  stat_board(body) {
    return listOf(parseJsonBody(body)?.stats)
      .map((stat) => ({
        label: trimmed(stat?.label),
        value: String(stat?.value ?? '').trim(),
      }))
      .filter((stat) => stat.label || stat.value)
      .map((stat) => `- ${pairText(stat.label, stat.value)}`)
      .join('\n');
  },
  comparison(body) {
    const parsed = parseJsonBody(body);
    const columns = listOf(parsed?.columns);
    const rows = listOf(parsed?.rows);
    if (columns.length < 2) return '';
    const line = (cells) => `| ${cells.map((cell) => String(cell ?? '').trim()).join(' | ')} |`;
    return [line(columns), line(columns.map(() => '---')), ...rows.map(line)].join('\n');
  },
  timeline(body) {
    return listOf(parseJsonBody(body)?.steps)
      .map((step) => ({
        title: trimmed(step?.title),
        body: trimmed(step?.body),
      }))
      .filter((step) => step.title || step.body)
      .map((step, i) => `${i + 1}. ${pairText(step.title, step.body)}`)
      .join('\n');
  },
  callout(body) {
    const parsed = parseJsonBody(body);
    const title = trimmed(parsed?.title);
    const calloutBody = trimmed(parsed?.body);
    if (!title) return calloutBody;
    return calloutBody ? `**${title}**: ${calloutBody}` : `**${title}**`;
  },
};

/** The plain-markdown form of a module of `type` with this body. */
export function unwrapModuleContent(type, content) {
  const body = trimmed(content);
  return Object.hasOwn(UNWRAPPERS, type) ? UNWRAPPERS[type](body) : '';
}
