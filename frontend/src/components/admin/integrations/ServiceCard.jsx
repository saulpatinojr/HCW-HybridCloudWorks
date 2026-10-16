/**
 * One service on the Services tab: what it is, where it lives, whether it
 * answers, what it does for the site, and the names of the keys it runs on.
 *
 * THE LAYOUT IS THE POINT OF THIS COMPONENT. Identity on the left, actions as
 * two icon buttons pinned to the top right, and the keys in their own bordered
 * subgroup below. A globe is a link out and a beaker is a test; neither needs
 * a word, and words were what made the row wrap.
 *
 * STATUS IS ONE WORD FROM ONE VOCABULARY (ADR 0033 §2): the badge beside the
 * name is lib/status.js's, the same word the Health page and the Overview
 * grid use for the same state. Under it, what the record says: when the test
 * last passed and last failed, which survives a reload because it is written
 * to `cms/integration-status` (useServiceTests).
 *
 * KEYS ARE NAMES AND LIGHTS HERE, NOTHING MORE (#570). Pasting, rotating and
 * generating moved to the Keys tab, which is where every key lives; a card
 * saying "PUBLER-API-KEY — Rejected" and linking there is the whole job. That
 * keeps one write path per key rather than two that look like different keys.
 * Disconnecting is said in the same place: this hub cannot delete a vault
 * secret, so a key-based service is disconnected by replacing or revoking its
 * key, and the card says so instead of offering a button that would lie.
 */

import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import IntegrationBadge from '@/components/admin/shared/IntegrationBadge';
import {
  AlertCircle,
  CheckCircle,
  ExternalLink,
  FlaskConical,
  Globe,
  KeyRound,
  Loader2,
} from 'lucide-react';
import { STATE_PRESENTATION, StateDot, relativeTime } from './StateDot';
import { resultStatus } from './integrationView';
import { persistedVerdict } from './integrationStatus';
import { DISCONNECT_NOTE } from './serviceRegistry';

export function TestResultLine({ result }) {
  if (!result) return null;
  return (
    <p
      className={`mt-3 flex items-start gap-1.5 text-xs ${
        result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
      }`}
    >
      {result.ok ? (
        <CheckCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 wrap-break-word">{result.message}</span>
    </p>
  );
}

/**
 * When the test last passed and last failed, from the persisted record.
 * `repeatsError` says the result line above already shows this very
 * sentence, so it is not printed twice.
 */
export function PersistedStatusLine({ record, repeatsError = false }) {
  if (!record || (!record.lastOkAt && !record.lastFailAt)) return null;
  return (
    <p className="mt-2 text-xs text-muted-foreground" data-testid="persisted-status">
      {record.lastOkAt ? (
        <span>
          Last worked{' '}
          <time dateTime={record.lastOkAt}>{relativeTime(record.lastOkAt) ?? record.lastOkAt}</time>
        </span>
      ) : (
        <span>Never recorded as working</span>
      )}
      {' · '}
      {record.lastFailAt ? (
        <span>
          Last failed{' '}
          <time dateTime={record.lastFailAt}>
            {relativeTime(record.lastFailAt) ?? record.lastFailAt}
          </time>
          {record.lastError && !repeatsError ? ` — ${record.lastError}` : ''}
        </span>
      ) : (
        <span>No failure recorded</span>
      )}
    </p>
  );
}

export function ServiceActions({ service, testing, onTest }) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {service.url && (
        <Button
          asChild
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          title={`Open ${service.name} — ${service.url}`}
        >
          <a href={service.url} target="_blank" rel="noopener noreferrer">
            <Globe className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{`Open ${service.name}`}</span>
          </a>
        </Button>
      )}
      {service.test && (
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={onTest}
          disabled={testing}
          title={testing ? 'Testing…' : `Test the ${service.name} connection`}
          aria-label={testing ? `Testing ${service.name}` : `Test ${service.name}`}
        >
          {testing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <FlaskConical className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      )}
    </div>
  );
}

function KeyRows({ items }) {
  return items.map((item) => (
    <li key={item.secret} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
      <StateDot state={item.state} />
      <code className="text-muted-foreground">{item.secret}</code>
      <span className="font-medium">
        {(STATE_PRESENTATION[item.state] ?? STATE_PRESENTATION.never).label}
      </span>
    </li>
  ));
}

const KEY_BOX = 'rounded-md border border-border/60 bg-muted/20 px-3 text-xs';

/**
 * One titled box per `keyGroups` entry: its keys, then the panel it names
 * (`panels[group.panel]`), so everything about one part of a service sits
 * together. The Hybrid Lab card is the one that has them: Coder (its two
 * keys and the lab host's automatic renewal) apart from Turnstile. A group
 * with neither keys nor a panel is not drawn, and a key no group names still
 * shows, in an untitled box after them, rather than vanishing.
 */
function KeyGroups({ items, groups, panels }) {
  const placed = new Set(groups.flatMap((group) => group.secrets ?? []));
  const rest = items.filter((item) => !placed.has(item.secret));
  return (
    <div className="mt-3 space-y-2">
      {groups.map((group) => {
        const groupItems = (group.secrets ?? [])
          .map((name) => items.find((item) => item.secret === name))
          .filter(Boolean);
        const panel = group.panel ? (panels?.[group.panel] ?? null) : null;
        if (!groupItems.length && !panel) return null;
        return (
          <section key={group.title} aria-label={group.title} className={`${KEY_BOX} pt-2`}>
            <p className="font-semibold">{group.title}</p>
            {groupItems.length ? (
              <ul className="divide-y divide-border/60">
                <KeyRows items={groupItems} />
              </ul>
            ) : null}
            {panel}
          </section>
        );
      })}
      {rest.length ? (
        <ul className={`divide-y divide-border/60 ${KEY_BOX}`}>
          <KeyRows items={rest} />
        </ul>
      ) : null}
    </div>
  );
}

function KeyNames({ items, groups, panels }) {
  if (groups?.length) return <KeyGroups items={items} groups={groups} panels={panels} />;
  if (!items.length) return null;
  return (
    <ul className={`mt-3 divide-y divide-border/60 ${KEY_BOX}`}>
      <KeyRows items={items} />
    </ul>
  );
}

/** What the service is for, as four short facts (ADR 0033 Platform). */
function ServiceFacts({ service }) {
  const rows = [
    ['Can do', service.capabilities?.length ? service.capabilities.join(' · ') : null],
    ['Used in', service.usedIn?.length ? service.usedIn.join(', ') : null],
    ['Data flow', service.dataDirection || null],
    ['Key reach', service.securityNote || null],
  ].filter(([, value]) => value);
  if (rows.length === 0) return null;
  return (
    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 wrap-break-word">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** Reconnect where a service has its own sign-in; otherwise how a key is disconnected. */
function ConnectionActions({ service, onOpenKeys }) {
  const hasKeys = (service.secrets ?? []).length > 0;
  if (!service.reconnectHref && !hasKeys) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-xs">
      {service.reconnectHref ? (
        <Button asChild size="sm" variant="outline">
          <a href={service.reconnectHref}>
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Reconnect in
            Recording Hub
          </a>
        </Button>
      ) : null}
      {hasKeys ? (
        <>
          {onOpenKeys ? (
            <Button size="sm" variant="outline" onClick={onOpenKeys}>
              <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Rotate or replace the
              key
            </Button>
          ) : null}
          <span className="min-w-0 flex-1 text-muted-foreground">{DISCONNECT_NOTE}</span>
        </>
      ) : null}
    </div>
  );
}

/**
 * The badge beside the name: this session's test if there is one, else the
 * persisted record's most recent verdict, else nothing — the key lights below
 * still say what they say.
 */
export function cardStatus(result, record) {
  if (result) return resultStatus(result);
  const verdict = persistedVerdict(record);
  return verdict ? resultStatus(verdict) : null;
}

export default function ServiceCard({
  service,
  result,
  record,
  testing,
  onTest,
  onOpenKeys,
  panels,
  children,
}) {
  const Icon = service.icon;
  const status = cardStatus(result, record);
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{service.name}</p>
            {status ? <StatusBadge status={status} size="xs" /> : null}
            <IntegrationBadge id={service.id} size="xs" />
            {result?.at && (
              <span className="text-xs text-muted-foreground">
                tested {relativeTime(result.at)}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{service.description}</p>
        </div>
        <ServiceActions service={service} testing={testing} onTest={onTest} />
      </div>

      <TestResultLine result={result} />
      <PersistedStatusLine
        record={record}
        repeatsError={Boolean(result && !result.ok && record?.lastError === result.message)}
      />
      {!service.test && service.untestedReason ? (
        <p className="mt-2 text-xs text-muted-foreground">No test: {service.untestedReason}</p>
      ) : null}
      <ServiceFacts service={service} />
      <KeyNames items={service.items ?? []} groups={service.keyGroups} panels={panels} />

      {service.credentialNote && (
        <p className="mt-3 text-xs text-muted-foreground">{service.credentialNote}</p>
      )}
      <ConnectionActions service={service} onOpenKeys={onOpenKeys} />
      {children}
    </Card>
  );
}
