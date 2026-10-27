import React, { useCallback, useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Loader2, Activity, Zap, DollarSign } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import { aiEngine } from '@/lib/aiEngine';
import { hasKnownCost } from '@/lib/aiEngine/usage';

function fmtCost(usd) {
  if (!usd) return '$0.00';
  if (usd < 0.000001) return usd < 0.00000001 ? '<$0.00000001' : `$${usd.toFixed(8)}`;
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(ts) {
  if (!ts) return 'Never';
  const date = ts?.toDate ? ts.toDate() : new Date(ts);
  const secs = Math.floor((Date.now() - date) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return date.toLocaleDateString();
}

/**
 * Readable names for the `source` values ai/usage.js stamps.
 *
 * Exported so a test can hold it against the backend's own USAGE_SOURCES: a
 * source added there without a label here shows the raw slug on screen, which
 * is the same class of silent drift DEFAULT_PROVIDERS had.
 */
export const SOURCE_LABELS = {
  admin: 'Admin playground',
  // What the Playground sends today (aiEngine.chat's default source); 'admin' is the
  // older spelling, kept so historical rows still read as words.
  admin_playground: 'Admin playground',
  'listen-and-learn:script': 'Listen & Learn — script',
  'listen-and-learn:source-script': 'Listen & Learn — source-grounded script',
  'listen-and-learn:audio': 'Listen & Learn — audio',
  'podcast:script': 'Podcast transcript — script',
  'podcast:audio': 'Podcast transcript — audio',
  'podcast:sample': 'Podcast voice — live check',
  admin_test: 'AI Engine — Test',
  'ai-engine:probe': 'AI Engine — weekly check',
  // The Tasks tab's per-task Test (ADR 0034 slice 4): the same one-word
  // prompt, sent down a task's chain until a candidate answers.
  'ai-engine:task-test': 'AI Engine — task Test',
  // Replicate image generation (2026-10-05): one row per output image, priced per image.
  'images:cover': 'Cover images (Replicate)',
  'images:manual': 'Images made on the Images pages (Replicate)',
  // A router call whose site named no feature (ADR 0033); the call-sites
  // test keeps production code from writing it.
  'ai:unspecified': 'AI — task not named',
};

/**
 * The prefix the router stamps on the row it writes for every call
 * (functions/src/lib/ai/usage.js featureSource): `ai:<feature>`. The label
 * is the feature's catalogue entry, read from the API with the switches, so
 * a new feature never shows as a raw slug here.
 */
export const FEATURE_SOURCE_PREFIX = 'ai:';

/** A readable name for a usage row's `source`. */
export function labelForSource(source, catalogue = {}) {
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  if (typeof source === 'string' && source.startsWith(FEATURE_SOURCE_PREFIX)) {
    const feature = source.slice(FEATURE_SOURCE_PREFIX.length);
    return `AI — ${catalogue[feature]?.label || feature}`;
  }
  return source;
}

export default function AIEngineUsageTab() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [catalogue, setCatalogue] = useState({});

  // A failed read is said, with a retry. Until ADR 0033 this promise had no
  // catch and a 403 left the spinner turning forever.
  const load = useCallback(() => {
    aiEngine
      .getUsageRecords(200)
      .then((result) => setRecords(result))
      .catch((err) => setError(err?.message || 'Usage could not be read.'))
      .finally(() => setLoading(false));
    // Labels for the `ai:<feature>` rows; a failure here only leaves the slug.
    aiEngine
      .getAiFeatures?.()
      .then((answer) => setCatalogue(answer?.catalogue || {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const retry = () => {
    setLoading(true);
    setError(null);
    load();
  };

  const agg = aiEngine.aggregateByProvider(records);
  const chartData = Object.entries(agg).map(([provider, data]) => ({
    provider,
    tokens: data.tokens,
    cost: data.costUsd,
    calls: data.calls,
    unpriced: data.unpriced,
  }));

  // Grouped by what spent the money. Provider answers "which vendor"; this
  // answers "which task" — the audio and image rows carry their task as the
  // source too since ADR 0034 slice 5 — which is the question when one
  // vendor serves several and their rates differ by an order of magnitude.
  const sourceRows = Object.entries(aiEngine.aggregateBySource(records))
    .map(([source, data]) => ({
      source,
      tokens: data.tokens,
      cost: data.costUsd,
      calls: data.calls,
      estimated: data.estimated,
      unpriced: data.unpriced,
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  const totalTokens = records.reduce((sum, record) => sum + (record.totalTokens || 0), 0);
  const totalCost = records.reduce(
    (sum, record) => sum + (hasKnownCost(record) ? record.estimatedCostUsd : 0),
    0
  );
  const totalCalls = records.length;
  const unpricedCalls = records.filter((record) => !hasKnownCost(record)).length;

  if (error) {
    return (
      <EmptyState
        variant="error"
        title="Usage could not be read"
        description={error}
        onRetry={retry}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-lg">Usage & Cost</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Estimates for the last 200 recorded calls, not a provider invoice. Unknown costs are
          excluded from subtotals.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Total Calls', value: totalCalls.toLocaleString(), icon: Activity },
          { label: 'Total Tokens', value: fmtTokens(totalTokens), icon: Zap },
          {
            label: 'Est. Cost (USD)',
            value: fmtCost(totalCost),
            icon: DollarSign,
            note:
              unpricedCalls > 0
                ? `${unpricedCalls} call${unpricedCalls === 1 ? '' : 's'} with unknown cost excluded; subtotal is incomplete`
                : null,
          },
        ].map(({ label, value, icon: Icon, note }) => (
          <Card key={label}>
            <CardContent className="p-4 flex items-center gap-3">
              <Icon className="h-5 w-5 text-indigo-500 shrink-0" />
              <div>
                <p className="text-xs text-slate-500">{label}</p>
                <p className="text-lg font-bold">{value}</p>
                {note && <p className="text-xs text-amber-700 dark:text-amber-400">{note}</p>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tokens by Provider</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                <XAxis dataKey="provider" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => fmtTokens(value)} />
                <Tooltip
                  formatter={(value, name) => [
                    name === 'tokens' ? fmtTokens(value) : `$${value.toFixed(6)}`,
                    name === 'tokens' ? 'Tokens' : 'Est. Cost',
                  ]}
                  contentStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="tokens" fill="#6366f1" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Breakdown by Provider</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b">
                  <th className="text-left pb-1 font-medium">Provider</th>
                  <th className="text-right pb-1 font-medium">Calls</th>
                  <th className="text-right pb-1 font-medium">Tokens</th>
                  <th className="text-right pb-1 font-medium">Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {chartData
                  .sort((a, b) => b.tokens - a.tokens)
                  .map((row) => (
                    <tr
                      key={row.provider}
                      className="border-b border-slate-100 dark:border-slate-800"
                    >
                      <td className="py-1.5 font-medium">{row.provider}</td>
                      <td className="py-1.5 text-right text-slate-500">{row.calls}</td>
                      <td className="py-1.5 text-right">{fmtTokens(row.tokens)}</td>
                      <td className="py-1.5 text-right font-mono">
                        {fmtCost(row.cost)}
                        {row.unpriced > 0 && <span className="ml-1 text-amber-700">+ unknown</span>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {sourceRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Breakdown by Task</CardTitle>
            <p className="text-xs text-slate-500">
              What spent the money, rather than who was paid. Listen &amp; Learn audio is priced on
              an output rate an order of magnitude above text, so a run&apos;s cost sits almost
              entirely in one row.
            </p>
          </CardHeader>
          <CardContent>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b">
                  <th className="text-left pb-1 font-medium">Feature</th>
                  <th className="text-right pb-1 font-medium">Calls</th>
                  <th className="text-right pb-1 font-medium">Tokens</th>
                  <th className="text-right pb-1 font-medium">Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows.map((row) => (
                  <tr key={row.source} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 font-medium">
                      {labelForSource(row.source, catalogue)}
                      {row.unpriced > 0 && (
                        <span
                          className="ml-1.5 text-amber-700 dark:text-amber-400 font-normal"
                          title={`${row.unpriced} of ${row.calls} rows have unknown cost and are excluded from the subtotal`}
                        >
                          {row.unpriced} unpriced
                        </span>
                      )}
                      {row.estimated > 0 && (
                        // Derived counts must never be shown as billed ones.
                        <span
                          className="ml-1.5 text-slate-400 font-normal"
                          title={`${row.estimated} of ${row.calls} rows have token counts derived from audio duration rather than reported by the API`}
                        >
                          ~{row.estimated} est.
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right text-slate-500">{row.calls}</td>
                    <td className="py-1.5 text-right">{fmtTokens(row.tokens)}</td>
                    <td className="py-1.5 text-right font-mono">
                      {fmtCost(row.cost)}
                      {row.unpriced > 0 && <span className="ml-1 text-amber-700">+ unknown</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {records.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent Calls</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b">
                    <th className="text-left px-4 py-2 font-medium">Provider / Model</th>
                    <th className="text-left px-4 py-2 font-medium">Source</th>
                    <th className="text-right px-4 py-2 font-medium">Tokens</th>
                    <th className="text-right px-4 py-2 font-medium">Cost</th>
                    <th className="text-right px-4 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {records.slice(0, 20).map((record) => (
                    <tr
                      key={record.id}
                      className="border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    >
                      <td className="px-4 py-1.5 font-mono">
                        {record.provider}/{record.model}
                      </td>
                      <td className="px-4 py-1.5 text-slate-500">
                        {labelForSource(record.source, catalogue)}
                      </td>
                      <td className="px-4 py-1.5 text-right">
                        {fmtTokens(record.totalTokens || 0)}
                      </td>
                      <td className="px-4 py-1.5 text-right font-mono">
                        {!hasKnownCost(record) ? (
                          <span title="Cost is unknown; excluded from the subtotal">unpriced</span>
                        ) : (
                          fmtCost(record.estimatedCostUsd)
                        )}
                      </td>
                      <td className="px-4 py-1.5 text-right text-slate-400">
                        {timeAgo(record.timestamp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && records.length === 0 && (
        <EmptyState
          title="No usage logged yet"
          description="Every call through the AI router records a row here. The Playground is the quickest way to make the first one."
          onRetry={retry}
        />
      )}

      {loading && (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      )}
    </div>
  );
}
