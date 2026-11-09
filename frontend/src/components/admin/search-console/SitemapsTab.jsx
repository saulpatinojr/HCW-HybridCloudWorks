/**
 * Sitemaps — the sitemaps Google knows for the site (a sitemap is the list of
 * page addresses the site hands to search engines), from Google's
 * `sitemaps.list`: when each was submitted and last read, whether Google has
 * processed it yet, its warnings and errors, and how many addresses it lists.
 *
 * Google's per-sitemap "indexed" count is marked "Deprecated; do not use" in
 * its API reference (https://developers.google.com/webmaster-tools/v1/sitemaps),
 * so it is not shown; the Indexing tab has the per-page answer instead.
 */
import React from 'react';
import EmptyState from '@/components/admin/shared/EmptyState';
import { fmtCount } from '@/lib/searchConsole';
import { Section, TABLE_CLASS, TD_CLASS, TH_CLASS, TONE_TEXT, WhenText } from './shared';

/** "web: 203, image: 40" from a sitemap's contents list. */
export function contentsText(contents) {
  const rows = Array.isArray(contents) ? contents.filter(Boolean) : [];
  if (rows.length === 0) return '—';
  return rows.map((row) => `${row.type ?? 'unknown'}: ${fmtCount(row.submitted)}`).join(', ');
}

/** The sitemap's state in words, worst first. */
function StateCell({ sitemap }) {
  const errors = Number(sitemap.errors) || 0;
  const warnings = Number(sitemap.warnings) || 0;
  const parts = [];
  if (errors) parts.push(<span key="e" className={TONE_TEXT.bad}>{`${errors} errors`}</span>);
  if (warnings) {
    parts.push(<span key="w" className={TONE_TEXT.warn}>{`${warnings} warnings`}</span>);
  }
  if (sitemap.isPending) {
    parts.push(
      <span key="p" className="text-muted-foreground">
        Not processed yet
      </span>
    );
  }
  if (parts.length === 0) return <span className={TONE_TEXT.ok}>Read without problems</span>;
  return <span className="flex flex-col">{parts}</span>;
}

export default function SitemapsTab({ report }) {
  const { sitemaps } = report;
  return (
    <div className="space-y-4 pt-4">
      <Section
        title="Sitemaps Google knows"
        description="Errors are problems with the sitemap file itself and stop Google reading it; warnings are usually about single addresses in it."
      >
        {sitemaps.length === 0 ? (
          <EmptyState
            compact
            title="Google lists no sitemap for this site."
            description="A sitemap is submitted in Search Console under Indexing, then Sitemaps. Without one, Google finds pages only by following links."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS} aria-label="Sitemaps">
              <thead>
                <tr>
                  <th className={TH_CLASS}>Sitemap</th>
                  <th className={TH_CLASS}>Submitted</th>
                  <th className={TH_CLASS}>Last read by Google</th>
                  <th className={TH_CLASS}>State</th>
                  <th className={TH_CLASS}>Addresses listed</th>
                </tr>
              </thead>
              <tbody>
                {sitemaps.map((sitemap) => (
                  <tr key={sitemap.path}>
                    <td className={`${TD_CLASS} break-all font-mono`}>{sitemap.path}</td>
                    <td className={TD_CLASS}>
                      <WhenText iso={sitemap.lastSubmitted} stacked />
                    </td>
                    <td className={TD_CLASS}>
                      <WhenText iso={sitemap.lastDownloaded} fallback="Not read yet" stacked />
                    </td>
                    <td className={TD_CLASS}>
                      <StateCell sitemap={sitemap} />
                    </td>
                    <td className={`${TD_CLASS} tabular-nums`}>{contentsText(sitemap.contents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
