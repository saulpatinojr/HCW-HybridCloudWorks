# ADR 0019: One Function App execution boundary

**Status:** Accepted
**Decision date:** 2026-08-18
**Owners:** Workload owner and architecture owner

## Context

ADR 0004 required three Flex Consumption apps — API, worker, labs broker — each with its own managed
identity, host storage, telemetry component, deployment artifact, and permission set. The implemented
system (`azurerm_function_app_flex_consumption.hcw`) runs everything in one app: the 59-route API,
timer/queue work behind per-timer feature flags with a master kill switch, and the labs surface as
three server-side-constrained endpoints. The environment is live with production data; this ADR
decides whether the divergence is a defect to fix or a decision to ratify.

## Purpose and decision drivers

- Operational cost at actual scale: three deployment pipelines, three host-storage accounts, and three
  telemetry components for one small workload triples the surface an operator must keep healthy.
- Cost ceiling (ADR 0015): three plans and three storage accounts carry fixed overheads.
- The original isolation motive — the semi-trusted labs boundary — was solved differently and better:
  VPS agents hold no database credential at all, authenticate with per-host Entra certificates, and
  can reach exactly three endpoints, each constrained server-side per caller (TODO.md, TODO T-401).

## Decision

Ratify the single Function App as the execution boundary. Least privilege is enforced **by contract**
— per-route guards, per-caller server-side constraints, per-timer feature flags — rather than by
process separation. Supersedes ADR 0004.

## Consequences and accepted risks

- One managed identity holds the union of the workload's data-plane permissions; a code-execution
  compromise in any route reaches everything that identity can. This is the accepted trade.
- One shared Application Insights component; per-boundary cost attribution is by operation name, not
  by resource.
- A worker stampede can compete with API latency on the same plan; Flex scale-out and the schedulers'
  kill switch are the mitigations.
- Splitting later is straightforward (apps are additive; identity grants shrink), so this decision is
  cheap to reverse — unlike its opposite.

## Alternatives considered

- **Implement the three-app split now** — rejected: state surgery and tripled operations for isolation
  the labs credential model already provides at the trust boundary that mattered.
- **Two apps (API + everything privileged)** — rejected: keeps most of the overhead while still
  sharing the highest-value permissions in the privileged app.

## Validation and revisit triggers

- Validated by the 2026-08-14 operator smoke run (guards, anonymous surface) and the route inventory
  tests.
- **Revisit** if: a scheduler workload measurably degrades API latency; a new integration needs a
  permission that would be dangerous in the shared identity; or labs job volume makes the in-app
  broker a noisy neighbour. The split returns worker-first.
- **The first trigger measurement is pending deployment** (measurement
  begins after the rule is applied and verified) (PLAT-10, #970):
  `alert-export-window-latency` in `infra/observability.tf` compares the API's
  P95 inside the nightly Cosmos export window (03:00 to 03:45 UTC) with the
  rest of the same UTC day, daily, and fires when the window's P95 is above
  1 s and above twice the day's, over at least 20 HTTP requests. Once it is
  live, a fire is this trigger met.

## Related decisions and references

- Supersedes [ADR 0004](../decisions/0004-functions-boundaries.md)
- [ADR 0012](../decisions/0012-asynchronous-workflows.md) (queue fabric still pending), [ADR 0018](../decisions/0018-as-built-plan-v02.md)
- TODO.md (labs credential model)
