/**
 * Services tab — one group at a time (#570).
 *
 * A row of group buttons (Communication, Content, Education, …) picks which
 * group's cards show. The group is in the URL as `?group=`, so a link can open
 * straight onto one. Each card carries its description, its docs link, its
 * test, what it is for, and the names and lights of the keys it uses; the keys
 * themselves are changed on the Keys tab, and the card says so where a reader
 * would look for Disconnect.
 *
 * Loads its own credential status. When that read fails the cards still
 * render — every one has a link and most have a test, and neither needs the
 * lights — and the error says why the key lines are missing. The persisted
 * test record (ADR 0033) is the page's, asked for once on first mount.
 */

import React, { useEffect } from 'react';
import { buildIntegrationView } from './integrationView';
import { SERVICES, SERVICE_GROUPS } from './serviceRegistry';
import ServiceCard from './ServiceCard';
import CloudPricingRefresh from './CloudPricingRefresh';
import CoderAutomation from './CoderAutomation';
import SessionizeSetting, { useSpeakerId } from './SessionizeSetting';
import StreamYardOnAirPanel from './StreamYardOnAirPanel';
import useSecretStatus from './useSecretStatus';
import { TabError, TabLoading } from './TabNotice';

/**
 * A filter, not a second tab widget: a group of toggle buttons (aria-pressed).
 * The hub's tab bar is the page's one tabs pattern.
 */
function GroupPicker({ groups, active, onChange }) {
  return (
    <div role="group" aria-label="Service groups" className="flex flex-wrap gap-2">
      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          aria-pressed={active === group.id}
          onClick={() => onChange(group.id)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            active === group.id
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          {group.title}
          <span className="ml-1.5 text-muted-foreground">{group.cards.length}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The panels a card's `keyGroups` may name, each drawn inside its group's
 * box (ServiceCard). Built only for a card that names one, so a card
 * without key groups never loads what it would not show.
 */
const KEY_GROUP_PANELS = { coderAutomation: CoderAutomation };

function panelsFor(service) {
  const names = (service.keyGroups ?? []).map((group) => group.panel).filter(Boolean);
  if (!names.length) return undefined;
  return Object.fromEntries(
    names
      .filter((name) => KEY_GROUP_PANELS[name])
      .map((name) => {
        const Panel = KEY_GROUP_PANELS[name];
        return [name, <Panel key={name} />];
      })
  );
}

function LooseKeysNote({ count, onOpenKeys }) {
  if (!count) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {count} more key{count === 1 ? '' : 's'} in this group belong to no single service.{' '}
      <button
        type="button"
        onClick={onOpenKeys}
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        See them on the Keys tab
      </button>
      .
    </p>
  );
}

export default function IntegrationsServices({ group, onGroupChange, onOpenKeys, tests }) {
  const { data, loading, error, reload } = useSecretStatus();
  const { speakerId, setSpeakerId, loading: loadingSpeaker } = useSpeakerId();
  const { ensurePersisted } = tests;
  useEffect(() => {
    ensurePersisted?.();
  }, [ensurePersisted]);

  const { serviceGroups } = buildIntegrationView({
    services: SERVICES,
    groups: SERVICE_GROUPS,
    sections: data?.sections ?? [],
    secrets: data?.secrets ?? [],
  });
  // A group only counts if it has a card; loose keys alone live on Keys.
  const pickable = serviceGroups.filter((entry) => entry.cards.length > 0);
  const active = pickable.find((entry) => entry.id === group) ?? pickable[0];

  return (
    <div className="space-y-4">
      {loading && !data ? <TabLoading>Reading key status…</TabLoading> : null}
      <TabError
        message={error && `Key status could not be read, so the cards show no key lines: ${error}`}
        onRetry={reload}
      />

      <GroupPicker groups={pickable} active={active?.id} onChange={onGroupChange} />

      {active ? (
        <section className="space-y-3" aria-label={active.title}>
          <div>
            <h2 className="text-lg font-semibold">{active.title}</h2>
            <p className="text-sm text-muted-foreground">{active.blurb}</p>
          </div>
          {active.cards.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              result={tests.results[service.id]}
              record={tests.persisted?.[service.id]}
              testing={tests.testing.has(service.id)}
              onTest={() => tests.runTest(service, speakerId.trim())}
              onOpenKeys={onOpenKeys}
              panels={panelsFor(service)}
            >
              {service.setting === 'sessionizeSpeakerId' ? (
                <SessionizeSetting
                  speakerId={speakerId}
                  setSpeakerId={setSpeakerId}
                  loading={loadingSpeaker}
                />
              ) : null}
              {service.action === 'refreshCloudPricing' ? (
                // Re-running the test after the job is what puts the new
                // refreshed-at line on the card; the button itself only writes.
                <CloudPricingRefresh onRefreshed={() => tests.runTest(service)} />
              ) : null}
              {service.action === 'streamyardOnAir' ? (
                <StreamYardOnAirPanel onTested={() => tests.runTest(service)} />
              ) : null}
            </ServiceCard>
          ))}
          <LooseKeysNote count={active.loose.length} onOpenKeys={onOpenKeys} />
        </section>
      ) : null}
    </div>
  );
}
