/**
 * The Markdown report audit-published-pages.mjs writes beside its JSON
 * (moved out of that file by #1845): one table row per page, then the
 * defect classes with the pages each one was seen on.
 */

/** A table cell: backslashes first, then pipes, so neither breaks the row. */
function escapeCell(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

export function toMarkdown(records, meta) {
  const counts = { works: 0, empty: 0, defect: 0 };
  for (const r of records) counts[r.verdict] += 1;
  const lines = [
    `# Published pages audit — ${meta.startedAt.slice(0, 10)}`,
    '',
    `Base: ${meta.baseUrl} · sitemap entries: ${meta.sitemapTotal} (${meta.sitemapDuplicates} duplicate) · URLs crawled: ${records.length} · works ${counts.works} · empty ${counts.empty} · defect ${counts.defect}`,
    '',
    '| Path | HTTP | Verdict | Findings |',
    '| --- | ---: | --- | --- |',
  ];
  for (const r of records) {
    const cells = [...r.findings, ...r.notes.map((n) => `note: ${n}`)];
    lines.push(
      `| \`${r.path}\` | ${r.status ?? '—'} | **${r.verdict}** | ${escapeCell(cells.join('; ')) || '—'} |`
    );
  }
  lines.push('', '## Defect classes', '');
  const classes = new Map();
  for (const r of records) {
    if (r.verdict !== 'defect') continue;
    for (const finding of r.findings) {
      const key = finding
        .split(': ')[0]
        .replace(/\s+\d+$/, '')
        .replace(/ lacks .*$/, ' lacks provider name');
      if (!classes.has(key)) classes.set(key, []);
      classes.get(key).push(r.path);
    }
  }
  if (classes.size === 0) lines.push('None.');
  for (const [key, paths] of classes) {
    lines.push(
      `- **${key}** — ${paths.length} page(s): ${paths
        .slice(0, 12)
        .map((p) => `\`${p}\``)
        .join(', ')}${paths.length > 12 ? ', …' : ''}`
    );
  }
  return `${lines.join('\n')}\n`;
}
