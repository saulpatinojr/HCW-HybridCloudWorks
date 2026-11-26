/**
 * The Cloudflare page's Settings tab, its pure half (#1905): which control
 * each zone setting gets, what its text becomes when saved, and which
 * settings ask first. Re-exported from cloudflareView.js.
 */

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * Settings whose value is one of a fixed list, and the list. From Cloudflare's
 * zone settings reference (https://developers.cloudflare.com/api/, Zones →
 * Settings). A value the list does not hold falls back to the JSON editor
 * rather than being forced into a select.
 */
export const SETTING_CHOICES = Object.freeze({
  ssl: ['off', 'flexible', 'full', 'strict'],
  min_tls_version: ['1.0', '1.1', '1.2', '1.3'],
  // A select, not a switch, although two of its values are on and off:
  // `zrt` (0-RTT) is the third.
  tls_1_3: ['on', 'off', 'zrt'],
  security_level: ['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack'],
  cache_level: ['aggressive', 'basic', 'simplified'],
  polish: ['off', 'lossless', 'lossy'],
  pseudo_ipv4: ['off', 'add_header', 'overwrite_header'],
  origin_max_http_version: ['1', '2'],
});

/**
 * Settings that can lock visitors out or open the site up when they are
 * wrong. Saving one asks first, and the row says why. The owner-only ones
 * (cloudflareLocks.js) also show that an agent key may not change them.
 */
export const CAREFUL_SETTINGS = Object.freeze({
  ssl: 'How Cloudflare connects to the site. The wrong mode breaks HTTPS for every visitor.',
  always_use_https: 'Sends every visitor to HTTPS. Turning it off lets pages load unencrypted.',
  min_tls_version:
    'The oldest encryption a visitor’s browser may use. Too new locks out older browsers.',
  tls_1_3:
    'The newest encryption. Turning it off falls back to TLS 1.2, which adds one round trip when a connection is set up.',
  tls_1_2_only:
    'Allows only TLS 1.2. Browsers that only speak TLS 1.3 or older versions are locked out.',
  '0rtt':
    'Lets a returning visitor send a request before the connection is fully set up. Faster, but such a request can be replayed.',
  ciphers:
    'Which encryption methods Cloudflare accepts. A short or wrong list locks out browsers that need another.',
  security_header:
    'The HSTS header: browsers remember it for months, so a wrong value is slow to undo and can lock visitors out.',
  tls_client_auth:
    'Whether Cloudflare shows the site a certificate of its own. Turning it off weakens how the site checks who is calling.',
  security_level:
    'How suspicious Cloudflare is of visitors. "Under attack" shows every visitor a check page.',
  development_mode: 'Turns the cache off for three hours. The site is slower while it is on.',
});

/** A setting id as words: `always_use_https` is "Always use https". */
export function settingLabel(id) {
  const words = String(id ?? '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Which control a setting gets: read-only when Cloudflare says it cannot be
 * changed, a switch for on/off, a select for a known list, a number box for a
 * number, and the JSON editor for everything else.
 */
export function settingControl(setting) {
  if (setting?.editable === false) return 'readonly';
  const { id, value } = setting ?? {};
  if (typeof value === 'string' && SETTING_CHOICES[id]?.includes(value)) return 'select';
  if (value === 'on' || value === 'off') return 'switch';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  return 'json';
}

/** The text a control starts from. */
export function settingDraft(control, value) {
  if (control === 'json' || control === 'readonly') {
    return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  }
  return String(value ?? '');
}

/** What a control's text becomes when saved, or a sentence saying why it cannot be. */
export function parseSettingDraft(control, draft) {
  if (control === 'switch') {
    if (draft !== 'on' && draft !== 'off') throw new Error('Choose on or off.');
    return draft;
  }
  if (control === 'select') return String(draft);
  if (control === 'number') {
    const text = String(draft ?? '').trim();
    const number = Number(text);
    if (!text || !Number.isFinite(number)) throw new Error('Enter a number.');
    return number;
  }
  if (control === 'json') {
    try {
      return JSON.parse(String(draft ?? ''));
    } catch {
      throw new Error('This is not valid JSON. Check the quotes, commas and brackets.');
    }
  }
  throw new Error('This setting cannot be changed.');
}

/** Whether a setting's id or label holds the filter text. */
export function settingMatches(setting, filter) {
  const text = String(filter ?? '')
    .trim()
    .toLowerCase();
  if (!text) return true;
  return (
    setting.id.toLowerCase().includes(text) || settingLabel(setting.id).toLowerCase().includes(text)
  );
}
