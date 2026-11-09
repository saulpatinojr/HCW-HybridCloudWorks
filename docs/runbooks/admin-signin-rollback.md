# Admin sign-in rollback

**What this is for:** nobody can sign in to `/admin`, and you want the previous
Entra configuration back. The public site is unaffected by everything on this
page — it is anonymous and does not touch Entra.

**Time:** about five minutes, most of it the frontend deploy.

---

## First: is it actually the configuration?

Do not roll anything back until the portal has told you what is wrong. Admin →
Health decodes the caller's own token in the browser and compares it against
what the API reports it enforces, so it distinguishes the cases that look
identical from outside.

Open <https://hybridcloudworks.com/admin/health> and read the **Token claims**
card.

| What you see | What it means | Roll back? |
| --- | --- | --- |
| `aud` verdict FAIL | The token is for a different API than the one validating it | **Yes** — configuration |
| `azp` equals `aud` | One registration is serving both halves again | **Yes** — the variable has reverted |
| Delegated scope FAIL | The SPA is requesting the wrong scope | **Yes** — configuration |
| App Role FAIL, registry says not admin | An assignment was removed | **No** — re-assign the role |
| "Could not verify your access" | The check did not run | **No** — read the message; a session problem is not a configuration one |
| Everything PASS but a feature errors | Not sign-in at all | **No** |

If you cannot reach Health because sign-in itself fails, the browser console
carries the reason — `AuthCallbackPage` logs it there deliberately rather than
rendering it.

---

## The rollback, in order

The order matters. Step 1 is what makes step 2 work; doing them the other way
round produces a deploy that cannot complete a sign-in.

### 1. Restore the redirect URIs on the API registration

**Only needed when rolling back to the API app id.** They were cleared on
2026-09-12 once the split was verified, so they are not there now — and a
frontend pointed at that registration would fail at the redirect.

This step cannot be a workflow. The GitHub deploy identity is a user-assigned
managed identity holding Azure RBAC and no Entra directory rights, deliberately:
`infra/oidc.tf` explains that Azure Owner does not grant the ability to write an
app registration, and granting CI Application Administrator so a rollback is one
click would hand every future workflow run that power permanently. It needs a
human with directory permission.

PowerShell, signed in as Application Administrator, Cloud Application
Administrator or Global Administrator:

```powershell
./scripts/rollback/restore-admin-signin.ps1 -WhatIf
```

Read its Preflight before going on: the `tenant       :` line is the tenant
`az` is signed in to, and the script works in that tenant. If it is not the
site's own tenant, stop and sign in to the right one (`az login --tenant`
with the tenant's domain name, then `--allow-no-subscriptions`), because the
script finds the API registration by name and a same-named registration in
another directory would satisfy it. The real run asks you to confirm the
registration *and* the tenant together; say no if either is wrong.

```powershell
./scripts/rollback/restore-admin-signin.ps1
```

The script needs no identifiers from you. It reads the tenant from the `az`
sign-in and finds the API registration by its name, `HCWSite API`, in that
tenant (the lookup is `scripts/lib/Resolve-EntraApiAppId.ps1`; it stops if no
registration or more than one has that name). Neither value is in this page
or in the script, because the redaction gate rejects a real GUID in any tracked
file of this public repository, and the working agreement rejects placeholders
in a line meant to be pasted. Looking them up satisfies both. If you ever need
to point it at a particular registration or tenant, pass the `-ApiAppId` and
`-TenantId` parameters (the script's help lists them), or set `HCW_API_APP_ID`
and `HCW_TENANT_ID` in the shell first.

It reads the registration back after writing, so a PATCH that silently did
nothing fails here rather than three steps later. **It prints the client id to
use in step 2.**

### 2. Point the site at the old client id, then deploy it

Change the repository variable **before** you deploy, not after. Since
2026-11-09 any merge that changes `frontend/` deploys the site by itself, with
nobody approving it, and the daily content-manifest pull request is one of
those merges
([#1613](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1613)).
Every such deploy builds the site with the `VITE_ENTRA_CLIENT_ID` repository
variable (a setting of the repository that the build reads). So while the
variable still holds the broken id, the next merge puts the broken sign-in back
within the day, without anyone choosing to.

1. **Set the variable to the id step 1 printed** (PowerShell). The command asks
   for the value at a prompt; paste the id there:

   ```powershell
   gh variable set VITE_ENTRA_CLIENT_ID --repo saulpatinojr/HCW-HybridCloudWorks
   ```

   You should see `✓ Updated variable VITE_ENTRA_CLIENT_ID for saulpatinojr/HCW-HybridCloudWorks`.
   Read it back; it should print the id step 1 printed:

   ```powershell
   gh variable get VITE_ENTRA_CLIENT_ID --repo saulpatinojr/HCW-HybridCloudWorks
   ```

   If `gh` says you lack permission, the owner's account can do it, or on the
   [Actions variables page](https://github.com/saulpatinojr/HCW-HybridCloudWorks/settings/variables/actions)
   with the pencil next to `VITE_ENTRA_CLIENT_ID`. If nobody who can change it
   is reachable, deploy anyway (the next item) and get the variable changed
   as soon as someone is: until then, any frontend merge undoes the rollback.

2. **Deploy.** Changing a variable starts no deploy, so start one at
   <https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/deploy-azure-frontend.yml>:
   **Run workflow** → set **`entra_client_id_override`** to the same client
   id. Leave everything else alone. With the variable already changed the
   override changes nothing in the build, but it makes the run log a warning
   naming the id it built with, so what happened is recorded in the run
   rather than in somebody's memory. The build still validates it:
   `assertDeployConfig` refuses anything that is not a GUID, so a mistyped id
   fails the build instead of shipping a sign-in that cannot work.

3. **Check that your run ends green.** If another Deploy Frontend run is
   already in progress (a merge to `main` starts one by itself), let it
   finish. Only one deploy runs at a time, so yours waits in the queue and
   uploads after it, which means yours is the one that stays. If a second
   merge starts a run while yours is still queued, GitHub cancels the queued
   one and yours shows **Cancelled**. That newer run builds with the variable
   you changed, so it deploys the old id too; let it finish green. If you
   could not change the variable, that newer run brings the broken id back:
   start yours again the same way once it has finished.

**The override alone does not persist.** It applies to that one build; the
next deploy reads `VITE_ENTRA_CLIENT_ID` again. That is deliberate — an
emergency should not silently become the configuration — and it is why the
variable comes first.

### 3. Make it permanent, or undo it

Once the incident is over, one of these:

- **Keeping the rollback:** the `VITE_ENTRA_CLIENT_ID` repository variable
  already holds the id step 1 printed (step 2 set it), so reopen
  [#522](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/522) —
  the split is then undone and ADR 0006 no longer matches the tenant, which is
  the state that whole issue existed to end.
- **Going forward again:** fix the cause, set `VITE_ENTRA_CLIENT_ID` back to
  the new registration's id (the same `gh variable set` line as step 2), then
  dispatch a normal deploy with the input blank, and re-clear the API
  registration's redirect URIs (the command is in
  [#530](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/530)).

---

## Verifying the rollback worked

Sign in from a clean browser profile, then Admin → Health:

- `aud` is unchanged either way — it is the API, and a rollback does not move it.
- `azp` is now **equal to** `aud`. That is the tell: one registration is serving
  both halves again, which is what the rollback restores.
- The verdict **"`azp` differs from `aud`"** will read **FAIL**, correctly. On a
  rolled-back configuration that is the expected state, not a new problem.
- Everything else — scope, tenant, token version, App Role, registry — should
  still PASS. If any of those fail, the rollback is not the fix and step 1 of
  this page applies again.

---

## What this page does not cover

**The API.** Nothing here touches the Function App or its token validation.
`ENTRA_API_AUDIENCE` is the API's own client id and does not change in either
direction — if you find yourself editing it during a rollback, stop, because
that is not what broke.

**A functions rollback.** Different workflow, different runbook: revert the
commit and dispatch `deploy-functions.yml`.

**Entra being down.** If sign-in fails because Microsoft is failing, none of this
helps and the only thing to do is wait. Health's "Could not verify your access"
card is the distinction: a configuration problem names a claim, an outage does
not.
