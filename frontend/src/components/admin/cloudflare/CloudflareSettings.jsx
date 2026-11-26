/**
 * The Cloudflare page's Settings tab (#1905): every zone setting Cloudflare
 * reports, one row each, saved one at a time. An on/off setting is a switch,
 * a setting with a known list of values is a choice, a number is a number
 * box, and anything else is edited as JSON. A setting Cloudflare marks as not
 * editable (often because the plan does not include it) is shown and not
 * offered for change.
 *
 * Saving needs the super admin role (RoleGate). The Save button is disabled
 * while its request is out, and a setting that can lock visitors out asks
 * first (CAREFUL_SETTINGS).
 */
import React, { useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Save } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import RoleGate from '@/components/admin/RoleGate';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import { readCloudflareSettings, saveCloudflareSetting } from '@/lib/cloudflare';
import { whenText } from '@/components/admin/ai-engine/kodaView';
import { ReadGate, WRITE_REASON, useCloudflareRead, useCloudflareWrite } from './CloudflareParts';
import useCanWrite from './useCanWrite';
import {
  CAREFUL_SETTINGS,
  SETTING_CHOICES,
  parseSettingDraft,
  settingControl,
  settingDraft,
  settingLabel,
  settingMatches,
} from './cloudflareView';

const EMPTY = Object.freeze({ settings: [] });

const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50';

function Control({ setting, control, draft, onDraft, disabled }) {
  const label = settingLabel(setting.id);
  if (control === 'readonly') {
    return (
      <code className="block max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {draft}
      </code>
    );
  }
  if (control === 'switch') {
    return (
      <span className="inline-flex items-center gap-2 text-sm">
        <Switch
          checked={draft === 'on'}
          disabled={disabled}
          aria-label={label}
          onCheckedChange={(on) => onDraft(on ? 'on' : 'off')}
        />
        {draft}
      </span>
    );
  }
  if (control === 'select') {
    return (
      <select
        aria-label={label}
        className={SELECT_CLASS}
        value={draft}
        disabled={disabled}
        onChange={(event) => onDraft(event.target.value)}
      >
        {SETTING_CHOICES[setting.id].map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }
  if (control === 'number') {
    return (
      <Input
        aria-label={label}
        inputMode="numeric"
        className="h-9 w-40"
        value={draft}
        disabled={disabled}
        onChange={(event) => onDraft(event.target.value)}
      />
    );
  }
  return (
    <Textarea
      aria-label={label}
      className="font-mono text-xs min-h-[4.5rem]"
      value={draft}
      disabled={disabled}
      onChange={(event) => onDraft(event.target.value)}
    />
  );
}

function SettingRow({ setting, busy, canWrite, onSave }) {
  const control = settingControl(setting);
  const original = settingDraft(control, setting.value);
  const [draft, setDraft] = useState(original);
  const [confirming, setConfirming] = useState(false);
  // A newer value from Cloudflare (after any save) starts the row afresh.
  const [seen, setSeen] = useState(original);
  if (seen !== original) {
    setSeen(original);
    setDraft(original);
  }

  let problem = '';
  let value;
  try {
    value = control === 'readonly' ? undefined : parseSettingDraft(control, draft);
  } catch (err) {
    problem = err.message;
  }
  const changed = draft !== original;
  const careful = CAREFUL_SETTINGS[setting.id];

  const save = () => (careful ? setConfirming(true) : onSave(setting.id, value));

  return (
    <li
      className="py-3 grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-start"
      data-testid={`setting-${setting.id}`}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{settingLabel(setting.id)}</p>
        <p className="text-xs text-muted-foreground">
          <code>{setting.id}</code>
          {setting.modifiedOn ? ` · changed ${whenText(setting.modifiedOn)}` : ''}
        </p>
        {careful && (
          <p className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            {careful}
          </p>
        )}
      </div>
      <div className="min-w-0">
        <Control
          setting={setting}
          control={control}
          draft={draft}
          onDraft={setDraft}
          disabled={busy || !canWrite}
        />
        {control === 'readonly' && (
          <p className="mt-1 text-xs text-muted-foreground">
            Cloudflare does not allow this one to be changed on this zone’s plan.
          </p>
        )}
        {changed && problem && <p className="mt-1 text-xs text-destructive">{problem}</p>}
      </div>
      {control !== 'readonly' && (
        <RoleGate minRole="super_admin" reason={WRITE_REASON}>
          <Button
            size="sm"
            disabled={busy || !changed || Boolean(problem)}
            onClick={save}
            aria-label={`Save ${settingLabel(setting.id)}`}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            )}
            Save
          </Button>
        </RoleGate>
      )}
      <ConfirmModal
        open={confirming}
        title={`Change ${settingLabel(setting.id)}?`}
        description={`${careful} It changes for every visitor as soon as you confirm.`}
        confirmLabel="Change it"
        busy={busy}
        onConfirm={async () => {
          await onSave(setting.id, value);
          setConfirming(false);
        }}
        onCancel={() => setConfirming(false)}
      />
    </li>
  );
}

export default function CloudflareSettings() {
  const read = useCloudflareRead(readCloudflareSettings, EMPTY);
  const { busyIds, run } = useCloudflareWrite(read.refresh);
  const canWrite = useCanWrite();
  const [filter, setFilter] = useState('');
  const settings = useMemo(
    () =>
      [...(read.data?.settings ?? [])]
        .filter((setting) => typeof setting?.id === 'string')
        .sort((a, b) => a.id.localeCompare(b.id)),
    [read.data]
  );
  const shown = settings.filter((setting) => settingMatches(setting, filter));

  const onSave = (id, value) =>
    run(id, () => saveCloudflareSetting(id, value), `${settingLabel(id)} is saved in Cloudflare.`);

  return (
    <ReadGate read={read} label="The zone settings">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Zone settings</CardTitle>
          <CardDescription>
            Every setting Cloudflare reports for the zone. Change one, then press its Save; each
            setting is saved on its own, and a change reaches visitors within a minute or so. The
            ones marked with a warning can lock visitors out, so they ask first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            aria-label="Filter settings"
            placeholder="Filter, for example https or cache"
            className="mb-2 max-w-sm"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          {shown.length === 0 ? (
            <EmptyState
              compact
              variant={settings.length ? 'filtered' : 'empty'}
              title={
                settings.length
                  ? 'No setting matches that filter'
                  : 'Cloudflare reported no settings'
              }
            />
          ) : (
            <ul className="divide-y">
              {shown.map((setting) => (
                <SettingRow
                  key={setting.id}
                  setting={setting}
                  busy={busyIds.has(setting.id)}
                  canWrite={canWrite}
                  onSave={onSave}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </ReadGate>
  );
}
