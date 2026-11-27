/**
 * The Cloudflare page's zone picker (#1911). The page looks after two zones:
 * the site's own and the lab's certificate zone. The names come from the
 * browser's mirror of the server's list (cloudflareLocks.js
 * MANAGED_ZONE_NAMES); the line saying what the picked zone is for comes
 * from the server's status answer for it, so it is written in one place.
 */
import React from 'react';
import { MANAGED_ZONE_NAMES } from './cloudflareLocks';

const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50';

export default function ZonePicker({ zone, role = '', onPick }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <label htmlFor="cloudflare-zone" className="text-sm font-medium">
        Zone
      </label>
      <select
        id="cloudflare-zone"
        className={SELECT_CLASS}
        value={zone}
        onChange={(event) => onPick(event.target.value)}
      >
        {MANAGED_ZONE_NAMES.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {role ? (
        <p className="text-sm text-muted-foreground" data-testid="zone-role">
          {role}
        </p>
      ) : null}
    </div>
  );
}
