// How a module's list-like content is written in the editor's one-textarea
// form, and read back. Used by moduleFormModel.js.

export function parseLinksInput(value = '') {
  return String(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (match) return { title: match[1], url: match[2] };
      return { title: line.replace(/^[-*]\s*/, ''), url: line.replace(/^[-*]\s*/, '') };
    });
}

export function linksToInput(links = []) {
  return links.map((link) => `- [${link.title || link.url}](${link.url})`).join('\n');
}

// stat_board form encoding: one stat per line, `value | label | sublabel?`.
export function parseStatsInput(value = '') {
  return String(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [statValue, label, sublabel] = line.split('|').map((part) => part.trim());
      const stat = { value: statValue || '', label: label || '' };
      if (sublabel) stat.sublabel = sublabel;
      return stat;
    });
}

export function statsToInput(stats = []) {
  return stats
    .map((stat) =>
      [stat.value, stat.label, stat.sublabel]
        .filter((part) => part !== undefined && part !== null && part !== '')
        .join(' | ')
    )
    .join('\n');
}

// comparison form encoding: first line = pipe-separated columns, then one row per line.
export function parseComparisonInput(value = '') {
  const lines = String(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const columns = (lines[0] || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  const rows = lines.slice(1).map((line) => line.split('|').map((part) => part.trim()));
  return { columns, rows };
}

export function comparisonToInput({ columns = [], rows = [] } = {}) {
  return [columns.join(' | '), ...rows.map((row) => (row || []).join(' | '))].join('\n');
}

// timeline form encoding: one step per line, `Title :: detail?`.
export function parseStepsInput(value = '') {
  return String(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [title, ...rest] = line.split('::');
      const step = { title: (title || '').trim() };
      const body = rest.join('::').trim();
      if (body) step.body = body;
      return step;
    });
}

export function stepsToInput(steps = []) {
  return steps
    .map((step) => (step.body ? `${step.title} :: ${step.body}` : step.title || ''))
    .join('\n');
}
