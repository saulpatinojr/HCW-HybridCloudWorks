# ADR 0006: Use Entra ID for administrators only

**Status:** Accepted
**Decision date:** 2026-07-22
**Owners:** Workload owner and architecture owner

## Context

The public site is anonymous, while the administrative portal changes content, integrations, media,
and operational configuration. Firebase Auth must be removed without creating unnecessary public-user
identity scope.

## Purpose and decision drivers

Protect privileged workflows with the tenant's workforce identity while keeping public access simple.

## Decision

Use one Entra SPA registration, one API registration, and an admin app role or group. Public content
remains anonymous. Every admin API route validates issuer, audience, expiry, and authorization claims.

## Consequences and accepted risks

- Admin authorization moves from Firebase claims/allowlists to Entra governance.
- The admin bundle remains public; APIs protect all privileged data and actions.
- Public labs require quota and abuse controls rather than a public-user identity system.
- Bootstrap and break-glass access require explicit procedures.

## Alternatives considered

- Entra External ID for all visitors: rejected because public accounts are not required.
- Retain Firebase Auth: rejected because it preserves a GCP production dependency.
- Cloudflare Access as sole authorization: rejected because Azure APIs must enforce authorization.

## Validation and revisit triggers

Validate admin, non-admin, expired, wrong-audience, and revoked-token paths. Revisit if the site later
requires persistent public-user accounts.

### Validated 2026-09-12 (#522) — the tenant now matches this decision

This ADR has specified "one Entra SPA registration, one API registration" since it was accepted.
The tenant did not: the cutover put an SPA platform on the API's own registration, and three other
places in the repository (`verify-token.js` DECISION 3, `infra/variables.tf`, and
`scripts/lib/deploy-console.ps1`) described the two-registration model while the tenant ran one.

The divergence was reasoned, not accidental — one registration means the SPA requests a scope on its
own app, which consents automatically and removes the risk of a client id and an audience that
disagree. That risk is now caught before it ships: `assertDeployConfig` refuses a deploy build whose
Entra ids are not GUIDs (#516). The rationale is kept, struck through, in
`scripts/cutover/02-entra-spa-client.ps1`.

- **API (resource):** exposes `access_as_admin`, defines the `Admin` and `LabAgent` app roles, holds
  the role assignments, and is what `ENTRA_API_AUDIENCE` names. **Unchanged by the split** — its app
  id is not written anywhere in the repository: `scripts/cutover/01-entra-api.ps1` and the other
  Entra scripts look it up by the registration's name, `HCWSite API`, in the signed-in tenant
  (`scripts/lib/Resolve-EntraApiAppId.ps1`), and the redaction gate keeps a real id out of every
  tracked file ([#1540](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1540)).
- **SPA (client):** a separate registration, public client only, whose app id is the
  `VITE_ENTRA_CLIENT_ID` repository variable. It exposes nothing and holds no credentials.
- **Dev client:** a third registration carrying `http://localhost` redirect URIs, so the production
  one carries none (#521).

Microsoft's stated reason for the separation is permission inheritance: *"if the web API has a higher
set of permissions, then the client app doesn't inherit them."* One registration means one service
principal, so any credential or Graph permission added for API use is simultaneously available to a
browser-delivered public client.

**Observable afterwards:** `azp` (the client that asked) differs from `aud` (the API it is for) in
every access token. Admin → Health asserts it, so pointing `VITE_ENTRA_CLIENT_ID` back at the API
turns a verdict red on a page an admin already visits, rather than silently reverting the decision.

### Validated 2026-09-12 (#514)

**MFA is enforced by security defaults, not Conditional Access.** Checked against the live tenant:
security defaults are enabled in tenant properties, and Conditional Access is unavailable because the
tenant is not licensed for Entra ID P1. Three files previously stated Conditional Access —
`AdminAuthGuard.jsx`, `entraAuth.js` and this ADR — and all three were corrected.

Two consequences worth writing down rather than rediscovering:

- **Security defaults cannot be scoped or excepted.** There is no way to exempt a break-glass account,
  so a break-glass path has to survive MFA rather than bypass it.
- **Entra disables security defaults automatically the moment any Conditional Access policy is
  created.** If this tenant is ever licensed for P1 and someone writes their first policy, MFA stops
  being enforced everywhere it currently is unless that policy covers it. That is the revisit trigger:
  licensing P1 is not a free upgrade here, it is a change that requires replacing the MFA control
  before it takes effect.

**Continuous Access Evaluation is not available to this API and must not be declared.** CAE requires
that both the client and the resource be CAE-enabled, and CAE-enabled resources are Microsoft
first-party services; a custom Azure Functions API cannot be one. The revocation SLA is therefore the
60-second `admins/{oid}` cache in `lib/auth/roles.js`, which is tighter than CAE for the events this
application actually cares about. See the citation in that file.

## Related decisions and references

- [ADR 0004](../decisions/0004-functions-boundaries.md)
- [ADR 0007](../decisions/0007-static-first-frontend.md)
