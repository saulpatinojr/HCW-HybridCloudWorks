/**
 * What can be verified right now — checks that need someone to press a button.
 *
 * The other half of the Health page reads what the estate has already written
 * down. Nothing here exists until it is asked for: these run in the signed-in
 * admin's session, with the admin's own token, and answer questions no timer
 * can answer on its own.
 *
 * Three kinds live here, and they are the same kind underneath:
 *
 * - **Pipeline smoke tests** — fetch RSS, inspect a batch, build the digest.
 *   Moved off the old Ops Health page, where they sat among live metrics and
 *   read as status rather than as actions. They are on-demand checks that
 *   write real data, which is exactly what the rest of this file is.
 * - **Identity** — does this session's token carry the audience and the App
 *   Role the API enforces, and does the admin registry agree it is this
 *   principal? Done here instead of by copying a bearer token out of developer
 *   tools and decoding it by hand.
 * - **The Labs no-op probe** — submit one job the way the Labs console does,
 *   read it back, cancel it, with and without an Authorization header.
 *
 * These checks were built to answer two specific tickets, which they did; both
 * closed on 2026-09-07 on the evidence of their first run. The checks are
 * repeatable and the questions recur, so they stay — but a tool that outlives
 * the ticket it was built for should stop quoting the ticket, and this one no
 * longer does.
 *
 * ## What this never shows
 *
 * The token, `sub`, `oid`, `email`, `name`, `preferred_username` — any claim
 * that identifies the person. The token is acquired the same way every API
 * call acquires it (lib/entraAuth acquireApiToken), decoded in a local
 * variable, reduced to claim NAMES plus the handful of values the checks are
 * about (`aud`, `roles`, `exp`, `tid`), and dropped. Only that summary reaches
 * React state, the DOM, or the clipboard. The registry comparison — does the
 * `uid` the API names equal the token's `oid` — is a boolean computed here and
 * rendered as a boolean.
 *
 * ## What "expected" means
 *
 * The values the token is compared against come from `getAuthExpectations`,
 * which returns the audience and tenant the API's verifier is configured with
 * and the App Role value its guard looks for. Comparing against a constant
 * built into the frontend would only prove the frontend agrees with itself. If
 * that route refuses the token, the comparison is reported as unknown and the
 * refusal itself is shown — which is the audience-drift signal these checks
 * exist to catch.
 *
 * ## The Labs probe
 *
 * Submits one job exactly as the Labs console does in its default state — the
 * `shell-echo` smoke test with an empty payload — then reads the document back
 * and cancels it. Nothing sweeps `lab_jobs`, so a probe left `queued` would sit
 * until an agent claimed it; cancelling leaves it terminal, with `cancelledBy`
 * on the document as the reason. The unauthenticated probe repeats the same
 * request through a plain `fetch` with no Authorization header, so no token is
 * attached anywhere on that path.
 */

import React from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { FlaskConical, Loader2, ShieldCheck, ShieldOff } from 'lucide-react';
import {
  evaluateLabsProbe,
  evaluateUnauthenticatedProbe,
  LABS_PROBE_JOB,
  verdictStatus,
} from './identityVerdicts';
import { list } from './checkReport';

// The checks' halves live in their own modules; the page and the tests read them from here.
export { buildReport } from './checkReport';

export {
  LABS_PROBE_JOB,
  decodeJwtPayload,
  evaluateIdentity,
  evaluateLabsProbe,
  evaluateUnauthenticatedProbe,
  relativeExpiry,
  summarizeAdminStatus,
  summarizeToken,
  verdictStatus,
} from './identityVerdicts';
export {
  collectIdentity,
  messageOf,
  probeUnauthenticated,
  runLabsProbeSteps,
} from './sessionChecks';
export {
  ACTION_CONFIG,
  SmokeActionsCard,
  normalizeDigestError,
  useSmokeActions,
} from './smokeActions';

// ── Presentation ──────────────────────────────────────────────────────────────

export function Verdict({ pass, children }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <StatusBadge system={verdictStatus(pass)} size="xs" className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 text-sm sm:flex-row sm:gap-3">
      <span className="w-48 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 wrap-break-word font-mono text-xs leading-5">{children}</span>
    </div>
  );
}

function Note({ children }) {
  return (
    <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
      {children}
    </p>
  );
}

function Pending({ children }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {children}
    </p>
  );
}

function TokenClaimsBody({ identity }) {
  if (!identity) return <Pending>Reading the session…</Pending>;
  const { token, expectations } = identity;
  if (!token) return <p className="text-sm text-destructive">{identity.tokenError}</p>;
  return (
    <>
      <Row label="Claims present">{token.claimNames.join(', ')}</Row>
      <Row label="aud">{token.aud ?? '(absent)'}</Row>
      <Row label="azp">{token.azp ?? '(absent)'}</Row>
      <Row label="roles">{list(token.roleNames)}</Row>
      <Row label="scp">{list(token.scopes)}</Row>
      <Row label="ver">{token.tokenVersion ?? '(absent)'}</Row>
      <Row label="exp">{token.expiresLabel}</Row>
      <div className="space-y-1 pt-2">
        <Verdict pass={token.audienceMatches}>
          <code>aud</code> equals the API&apos;s configured audience
          {expectations?.expectedAudience ? ` (${expectations.expectedAudience})` : ''}
        </Verdict>
        <Verdict pass={token.hasAdminRole}>
          App Role <code>{expectations?.adminAppRole ?? 'Admin'}</code> present in{' '}
          <code>roles</code>
        </Verdict>
        <Verdict pass={token.hasRequiredScope}>
          Delegated scope <code>{expectations?.requiredScope ?? 'access_as_admin'}</code> present in{' '}
          <code>scp</code>
        </Verdict>
        <Verdict pass={token.tenantMatches}>
          <code>tid</code> equals the API&apos;s tenant
        </Verdict>
        <Verdict pass={token.versionMatches}>
          <code>ver</code> is {expectations?.requiredTokenVersion ?? '2.0'}
        </Verdict>
        <Verdict pass={token.clientIsSeparateFromApi}>
          <code>azp</code> differs from <code>aud</code> — the SPA and the API are separate
          registrations
        </Verdict>
        <Verdict pass={token.expired === null ? null : !token.expired}>Token not expired</Verdict>
      </div>
      {token.clientIsSeparateFromApi === false ? (
        <Note>
          One app registration is serving both the SPA and the API, which is what DECISION 3 in
          verify-token.js warns about and issue #522 exists to end. The delegated-scope check above
          is what makes it safe meanwhile: an ID token carries this <code>aud</code> and these{' '}
          <code>roles</code>, but never <code>scp</code>.
        </Note>
      ) : null}
    </>
  );
}

export function TokenClaimsCard({ identity }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" /> Token claims
        </CardTitle>
        <CardDescription>
          Decoded from the access token this app sends to the API, compared against what the API
          says it enforces. Values shown are configuration, not identity: <code>aud</code>,{' '}
          <code>azp</code>, <code>roles</code>, <code>scp</code>, <code>ver</code>, <code>exp</code>
          . Never <code>oid</code>, <code>email</code> or the token itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <TokenClaimsBody identity={identity} />
        {identity?.expectationsError ? (
          <Note>
            getAuthExpectations refused the token: {identity.expectationsError}. The comparisons
            above are unknown, and the refusal itself is the audience-drift signal this check exists
            to catch.
          </Note>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AdminRegistryBody({ identity }) {
  if (!identity) return null;
  const { admin, token } = identity;
  if (!admin) return <p className="text-sm text-destructive">{identity.adminError}</p>;
  return (
    <>
      <Row label="HTTP">{identity.adminHttp}</Row>
      <Row label="isAdmin">{String(admin.isAdmin)}</Row>
      <Row label="role">{admin.role ?? '(none)'}</Row>
      <Row label="active">{String(admin.active)}</Row>
      <Row label="permissions">{list(admin.permissions)}</Row>
      <div className="space-y-1 pt-2">
        <Verdict pass={admin.isAdmin}>Caller is an admin per the registry</Verdict>
        <Verdict pass={admin.uidMatchesToken}>
          Registry <code>uid</code> equals the token&apos;s <code>oid</code>
        </Verdict>
      </div>
      {token?.hasAdminRole && !admin.isAdmin ? (
        <Note>
          The token carries the role and the registry says no — that is a registry problem, not a
          token problem.
        </Note>
      ) : null}
    </>
  );
}

export function AdminRegistryCard({ identity }) {
  const container = identity?.expectations?.registryContainer ?? 'admins';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Admin registry</CardTitle>
        <CardDescription>
          <code>getCurrentAdminStatus</code>, answered from{' '}
          <code>
            {container}/{'{oid}'}
          </code>
          . Identifiers are compared, not shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <AdminRegistryBody identity={identity} />
      </CardContent>
    </Card>
  );
}

function LabsProbeResult({ labs }) {
  if (!labs) return null;
  const e = labs.enqueue || {};
  const verdict = evaluateLabsProbe(labs);
  if (labs.error) {
    return (
      <div className="space-y-1">
        <Row label="probe">{labs.error}</Row>
        <div className="pt-2">
          <Verdict pass={verdict.pass}>Authenticated no-op path — {verdict.reason}</Verdict>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Row label="enqueueLabJob">
        {e.error || `HTTP ${e.httpStatus} · ${e.type} · ${e.status} · ${e.jobId}`}
      </Row>
      {labs.read ? (
        <Row label="getLabJob">
          {labs.read.found ? `found · ${labs.read.status}` : labs.read.error || 'not found'}
        </Row>
      ) : null}
      {labs.cancel ? (
        <Row label="cancelLabJob">
          {labs.cancel.error || `HTTP ${labs.cancel.httpStatus} · ${labs.cancel.status}`}
        </Row>
      ) : null}
      {labs.final ? (
        <Row label="final status">
          {labs.final.error
            ? `read failed (${labs.final.error}) — state unknown`
            : labs.final.status || 'unknown — the closing read returned no status'}
        </Row>
      ) : null}
      <div className="pt-2">
        <Verdict pass={verdict.pass}>Authenticated no-op path — {verdict.reason}</Verdict>
      </div>
    </div>
  );
}

function UnauthenticatedResult({ unauth }) {
  if (!unauth) return null;
  const verdict = evaluateUnauthenticatedProbe(unauth);
  const detail = unauth.message ? ` · ${unauth.message}` : '';
  return (
    <div className="space-y-1">
      <Row label="no Authorization header">
        {unauth.error || `HTTP ${unauth.httpStatus}${detail}`}
      </Row>
      <div className="pt-2">
        <Verdict pass={verdict.pass}>Unauthenticated request refused — {verdict.reason}</Verdict>
      </div>
    </div>
  );
}

export function ProbeButton({ busy, icon: Icon, onClick, children }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={busy}>
      {busy ? (
        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="mr-2 h-3.5 w-3.5" />
      )}
      {children}
    </Button>
  );
}

export function LabsProbeCard({ labs, labsBusy, onLabs, unauth, unauthBusy, onUnauth }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <FlaskConical className="h-4 w-4 text-muted-foreground" /> Labs no-op probe
        </CardTitle>
        <CardDescription>
          Submits one <code>{LABS_PROBE_JOB.type}</code> job exactly as the Labs console does, reads
          the document back, then cancels it so nothing is left queued. The expected response is
          HTTP 200 with <code>{'{ jobId, type, status: "queued" }'}</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <ProbeButton busy={labsBusy} icon={FlaskConical} onClick={onLabs}>
            Run authenticated probe
          </ProbeButton>
          <ProbeButton busy={unauthBusy} icon={ShieldOff} onClick={onUnauth}>
            Run unauthenticated probe
          </ProbeButton>
        </div>
        <LabsProbeResult labs={labs} />
        <UnauthenticatedResult unauth={unauth} />
      </CardContent>
    </Card>
  );
}
