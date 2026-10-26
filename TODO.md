# TODO

**The accepted-risk record for the HybridCloudWorks website, and the index to
where the open work lives.** Engineering work, owner decisions, production
approvals, credentials, external access and live-environment operations are
GitHub issues; verified completion belongs in [CHANGELOG.md](CHANGELOG.md), and
the required-inputs inventory is [Required-Inputs](docs/standards/required-inputs.md) on
the docs site.

**Open work is tracked in GitHub issues as of 2026-09-05.** Owner decision:
the remaining items were moved to the issues list so they can be worked from
there, and this file now holds only what is not work — the accepted risks
below, which are decisions to live with something and must stay written down —
plus the pointers that follow. The tracked findings (`T-` items), the attack
sequence and the owner-decision record all closed by 2026-09-05 and moved to
the changelog.

## Where the open items live

The board: https://github.com/users/saulpatinojr/projects/6 (the HCW Work Board, public) — every open
issue, with a Priority (`P1 now` / `P2 next` / `P3 later` / `Gated`). The
issues list behind it: https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues

| Label | Meaning |
| --- | --- |
| `owner-gated` | Needs the owner: a credential, a console action, or a spend decision |
| `live-check` | Needs an authorized operator against the deployed estate; several come due only on an external trigger and stay open as standing checklists |
| `podcast` | Podcast hosting, generation and the podcast pages |

| Item | Issue |
| --- | --- |
| Audio pipeline parent: every component shipped and verified 2026-09-09; the three remaining secrets (`ELEVENLABS-API-KEY`, `PODBEAN-CLIENT-ID`, `PODBEAN-CLIENT-SECRET`) wait on the ElevenLabs purchase and on the owner creating the Podbean developer app (the show moved to Podbean on 2026-10-13, ADR 0029 §1c), owner-gated | [#432](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/432) |
| The Hybrid Lab host: the Hostinger VPS as the on-premises half of a hybrid estate (Terraform via the Hostinger provider, Ansible, Azure Arc, live status page); seven sub-issues #660–#666, ADR 0032 is #660 | [#656](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/656) |
| Landing Zone Builder: an interactive page that assembles an Azure landing zone component by component and emits AVM-based Terraform; seven sub-issues #667–#673 | [#657](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/657) |
| `hcw-lab` image and the Docker agentic sandbox: one digest-pinned toolchain image for the lab pages, Coder and `vps-agent`, plus a sandbox recipe; five sub-issues #674–#678 | [#658](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/658) |
| Browser labs on Coder: Docker Compose on the lab host, GitHub OAuth as the learner boundary, a status proxy and `/education/labs`; five sub-issues #679–#683 | [#659](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/659) |

This table lists parent issues only; their sub-issues are on the board and
under each parent's "Sub-issues" section. It is refreshed in the pull request
that opens or closes a parent, so a parent missing here is a documentation
finding, not a sign the work was dropped.

**Owner decision 2026-09-18: #432 was the only issue left open on that date.**
The board was reduced to it then. The five other issues open at the time
(#501, #567, #588, #611, #613) were closed with a comment on each recording
what was still outstanding, so the residual — owner steps, one live check, the
untouched host-storage read investigation on #611, the remaining Qlty rows on
#588 — lives on those closing comments rather than in a tracker. Reopen the
issue if any of it is picked up again; this file does not carry it. The four
sponsor-integration parents above were opened on 2026-09-24.

`GEMINI-API-KEY` already covers Listen & Learn speech; nothing to provide.

## Accepted risks

A decision to live with a finding rather than fix it. An accepted risk with no
record is indistinguishable from an unfixed one: the next reviewer re-raises it,
or someone "fixes" it without knowing it was a choice.

| Risk | Accepted | Reasoning, and what compensates |
| --- | --- | --- |
| **Log-based alerts sleep when the ingestion cap binds.** If daily volume ever again reaches the 0.25 GB cap, `function_http_5xx` and `function_response_time` stop evaluating from cap-hit until the 08:00 UTC reset — a partial failure in that window surfaces the next morning. Accepted with the T-719 decision | Owner, 2026-09-02 | A personal content site with RTO 8 h does not need same-hour paging on partial failures. The exposure was daily and unrecorded while host verbosity pinned the cap; after the verbosity cut the cap is headroom and the window should not recur. Compensating controls: the T-519 edge probe pages on unreachability twelve times an hour on a pipeline the cap cannot touch, and `logs_daily_cap` alerts at 80% of quota before the blindness starts |
| **Microsoft-managed keys, no private endpoints, no infrastructure encryption, no Flex zone redundancy.** Qlty security findings CKV2_AZURE_1 (x2), CKV_AZURE_100, CKV2_AZURE_33, CKV2_AZURE_32, CKV_AZURE_59, CKV_AZURE_101, AZU-0061 (x2), CKV_AZURE_212, CKV_AZURE_225 | Owner, 2026-09-14 | Each is paid, one-way, or both, for a single-region site on a USD 150 budget. Data services sit behind service firewalls with default Deny that admit only the Functions subnet. Purge protection went **on** in the same decision, which retires the purge-protection risk ADR 0021 accepted. Host storage blob reads are not logged, because at about 573,000 a day they would trip the 0.25 GB/day log cap. Full record: [ADR 0031](docs/decisions/0031-security-scanner-owner-decisions.md) |
| **`cloudflare_origin_secret` is a real shared-secret value in Terraform state.** Raised as T-723, 2026-08-28 | Recorded 2026-08-28 | Unavoidable rather than chosen: Terraform configures the Cloudflare end of the origin handshake, so the value has to pass through it. It was simply never written down, which is the part that is fixed here. **Rotation consequence, which is the reason this needs a record:** the value must change in three places in one window — the HCP Terraform workspace variable, Key Vault `CF-ORIGIN-SECRET`, and the Cloudflare transform rule Terraform writes — and a mismatch throws on *every anonymous request*, so a partial rotation is a full outage of the public API rather than a degradation. The companion exposure — the azapi read-back exporting the whole live app-settings map into state — is not accepted but *bounded*: it is safe only while every secret-shaped setting is a Key Vault reference, and `functions/src/functions/app-settings-secrets.test.js` now fails CI if one is not |
| **The Cosmos recovery objectives are untested by a restore — until the first drill runs.** RTO 8 h / RPO 24 h were approved and the nightly out-of-account export is proven (first run 2026-09-09 03:00 UTC: 53 containers, 1,951 documents, 33.7 MiB gzip, event and alert wired), but no restore has been performed or timed. Closed #231 and #455 | Owner, 2026-09-09; drill approved 2026-10-06 | On 2026-09-09 the owner decided the export run and the three reads confirming it were the tests needed, and that no drill was wanted. On 2026-10-06 the owner approved the estate review's critical list (finding PLAT-1), which runs the drill once per `docs/runbooks/cosmos-restore.md` and records it in that page's Drills table; this row is deleted when that row exists. Until then the objectives remain targets rather than measurements. Compensating: the copy is written nightly, and `alert-cosmos-export-daily-prod-cus` evaluates once a day over a two-day window, so a missed run pages at the first daily evaluation after two days without a completion (up to three days after the last run); `scripts/restore-cosmos-export.mjs --dry-run` counts what a restore would touch with no scratch account; §6 of the runbook stays paste-ready. ADR 0011 was amended the same day so one objective pair stands everywhere |
| **AddOn panes may run `allow-scripts allow-same-origin` cross-origin frames with `allow-downloads`.** A row that names `downloads` ([ADR 0035](docs/decisions/0035-addon-pane-model.md) decisions 3 and 9) gets `allow-scripts allow-same-origin allow-forms allow-downloads`, one flag more than the labs pane, so the visitor can save the report bundle and the sample file from inside the frame. The migration row names it; the add-on keeps its "Copy report" control as the fallback. The network assessment, cloud assessment and Cloud Crawler rows also name `downloads` and `clipboard-write`, a Permissions Policy grant of write access to the clipboard for their own origin only, which their "Copy report" button uses (read access is not granted); the first two have had it since 2026-10-24, and Cloud Crawler's row has it from its flip ([#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357), where the pane's code was read to confirm it saves and copies a report and never asks to navigate) | Accepted 2026-10-10: decision 9 of ADR 0035 confirmed by the owner in [#1044](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1044) | Accepted because the frame is always another origin (scripts plus same-origin cannot lift a cross-origin sandbox), the add-on holds no site credential and the site sends it nothing, `frame-src` names each add-on origin exactly (no `*.lab` wildcard, `csp.test.js`), the image is the site's own by digest, and the download is the visitor's own report. Compensating: the pane mounts only on the server-side status read, a 30-second watchdog, and the end-of-run privilege checks on the host |
| **The Static Web App deploy still uses its deployment token.** `deploy-azure-frontend.yml` publishes the site with the token `Azure/static-web-apps-deploy` takes, not a token-free login. Closed #834 | Owner, 2026-10-03 | The token is isolated rather than removed. The `deploy` job signs in with GitHub OIDC as the federated `github_deploy` identity, reads the token just in time through the custom `HCW Static Web App Deployer` role (`listSecrets` on the one site and nothing else), and uses it for one run: no stored secret, `main` only, and a production approval required. Microsoft still labels the deployment token the recommended policy, and its identity-token example ([build configuration, Security](https://learn.microsoft.com/azure/static-web-apps/build-configuration#security), read 2026-10-03) still passes `azure_static_web_apps_api_token` next to `github_id_token`, so the "GitHub" policy would not remove the token. What remains: the token is long-lived on the Azure side, is an attribute in Terraform state, and anyone holding `listSecrets` on the site can read it and deploy until it is reset. Compensating control: reset the deployment token every 90 days, or at once on any suspicion; nothing stores it, so a reset breaks nothing and the next run reads the new value. Revisit when Microsoft documents a token-free deploy |
| **`@azure/msal-node` is forced to 7.1.1 by an npm `overrides` entry, past the major version `@azure/identity` declares.** `@azure/identity` 4.14.0 asks for `^6.0.0`; `functions/`, `scripts/` and `vps-agent/` each carry `"@azure/msal-node": "7.1.1"` under `overrides` so [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) (High, fixed in 7.1.0) is closed. Closed Dependabot alerts #163, #164, #165 | Owner, 2026-10-24 | The owner chose to close the alerts now rather than wait for `@azure/identity` to support msal-node 7. The combination is not one Microsoft has published as supported. Compensating: the managed-identity path was run against a stand-in App Service identity endpoint on both versions in all three packages with identical results, and every test suite passes. Not tested: the real endpoint, Azure Arc on the lab host, and the CI workload-identity login. **Remove the three entries** when a released `@azure/identity` declares msal-node `^7`; Dependabot will then propose that bump on its own. If sign-in breaks after a deploy (the delivery monitor goes red, or a Key Vault or Cosmos call returns an authentication error), revert this change and redeploy: the old lock files pin 6.0.1 |

## Handling rules

- Never paste secret values, private keys, access tokens, or personal data into
  this file, issues, logs, or the Wiki.
- An open item is an issue, and every open issue is on the board at
  https://github.com/users/saulpatinojr/projects/6. The board has no auto-add for new issues
  (its built-in workflows add sub-issues only), so whoever opens an issue adds
  it (`gh project item-add 6 --owner saulpatinojr --url` followed by the
  issue's URL) and sets its Priority. This file does not carry work; when something
  new is found, open an issue and, if it is a decision to live with a finding,
  record it under Accepted risks here.
- A missing credential is not an engineering task. Record its name, owner, and
  approved storage location only.
- Historical migration pages and the two archived plans are evidence, not
  current instructions for restoring Firebase services.

---

Completed items are removed from this file after the corresponding regular
entry is present in `CHANGELOG.md`; item numbers are not reused.
