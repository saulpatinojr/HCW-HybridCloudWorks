# HCW Second Brain desktop plugin

Windows desktop companion for the private workspace in HCW admin. Preview and
enroll selected Markdown notes, edit them in either place, and keep generated
website references separate from editable notes. Sync runs while Obsidian is
open. Simultaneous edits produce recovery copies instead of silent overwrites.

From this directory:

Build and test with Node.js 26.10 or newer. The packaged plugin runs inside
Obsidian's desktop runtime; it does not require a separate Node installation.

```powershell
npm ci --ignore-scripts
npm test
npm run build
```

Copy the contents of `dist` into `.obsidian/plugins/hcw-second-brain` in a
separate test vault, then enable it under Community plugins. Copy the tenant,
desktop client and API audience from HCW admin → Second Brain → Home. Sign in
through the system browser using the owner account and choose notes to enroll.
No API secret or general admin token is required.

Authored notes sync both ways. Editing `HCW/Site` reference copies creates
recoverable working notes and does not change website articles or drafts.
Review `HCW/Conflicts` after a collision and archive resolved recovery notes.
Unselected files are untouched. Rename events preserve enrolled identities.

The MSAL cache is encrypted with Windows DPAPI under LOCALAPPDATA, outside the
vault. The fixed packaged helper uses stdin/stdout, never credential arguments
or an execution-policy override. Encryption failure pauses synchronization.
Local note and plugin-state files follow the device/OneDrive permissions.

Use **Sync now** to retry after reconnecting. Status shows pending operations,
the last completed cycle, and failure state. Sign out to clear the selected
account's cache. Signing out or removing the plugin retains note files.

The API feature, owner identity, desktop registration, and `brain_sync` scope
must be configured before sign-in can work. See the
[rollout runbook](../docs/runbooks/second-brain.md). The engine tests use fake
files/API; `cache.test.mjs` additionally verifies actual encryption on Windows.
