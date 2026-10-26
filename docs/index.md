# HybridCloudWorks Engineering

This is the engineering record behind
[hybridcloudworks.com](https://hybridcloudworks.com): how the site is built,
why it was built that way, and how it is operated. Every page here comes from
the `docs/` folder of the
[public repository](https://github.com/saulpatinojr/HCW-HybridCloudWorks),
reviewed through pull requests like the code and published on every merge.

## New here?

- **To use the site**, go to [hybridcloudworks.com](https://hybridcloudworks.com):
  platform hubs, the certification index, planning tools, the migration
  assessment and hands-on labs.
- **For a first look at how it works**, read
  [How HybridCloudWorks is built](architecture/how-it-is-built.md): one
  diagram, every component, a map of the repository and how a change reaches
  the live site.
- **To learn from it**, start with the
  [Naming convention](standards/naming-convention.md) page, written for someone
  who has never seen this estate.
- **To contribute or report a problem**, the repository's
  [README](repo/readme.md) has a short start, and open work is on the
  [HCW Work Board](https://github.com/users/saulpatinojr/projects/6).

The repository keeps two concise records beside this site:
[CHANGELOG.md](repo/changelog.md) for completed work, and
[TODO.md](repo/todo.md) for the accepted risks. Open work is tracked as
[GitHub issues](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues)
on the [HCW Work Board](https://github.com/users/saulpatinojr/projects/6).

## Engineering references

- [Architecture decision records](decisions/index.md)
- [Architecture review 2026-08](architecture/architecture-review-2026-08.md) — the six-layer
  review of record: 62 findings with evidence, failure mode and
  recommendation, plus the areas that came back sound
- [Deployment runbook](runbooks/deployment-runbook.md)
- [Admin sign-in rollback](runbooks/admin-signin-rollback.md) — what to do when
  nobody can sign in to `/admin`, and how to tell a configuration problem from
  the other things that look like one
- [Alerting and support](runbooks/alerting-and-support.md)
- [Copilot code review MCP servers](runbooks/copilot-code-review-mcp.md)
- [MCP servers — OAuth Connect](runbooks/mcp-oauth-connect.md) — signing the
  AI Engine in to Replicate's and Hostinger's hosted MCP servers, what each
  result means, and how the tokens are kept and renewed
- [Labs host access and Arc onboarding](runbooks/labs-host.md) — reaching the
  lab host from a desktop over SSH and VS Code, onboarding it to Azure Arc,
  what Connected looks like, and how to disconnect
- [IaC repository standard](standards/iac-repository-standard.md)
- [Naming convention](standards/naming-convention.md)
- [Variables and secrets](standards/variables-and-secrets.md)
- [Resource validation report](architecture/resource-validation-report.md)
- [Cost analysis](architecture/cost-analysis.md)

## Start here if you are not the owner

Most of this site is an operating record for one estate. One page is written
for a reader who has never seen it and uses generic resource names throughout,
so it is the best place to start:

- [Naming convention](standards/naming-convention.md) — a complete CAF scheme
  for an Azure Landing Zone, including the constraints that override it

The [runbooks](runbooks/deployment-runbook.md) name this estate's real
resources, because an operator cannot use them otherwise. They are published
for the same reason everything else here is — the reasoning is the point — but
the procedures are specific to one tenant, not a template.

## Historical records

The migration and cutover pages are retained as historical evidence for how the
current Azure platform was built. They are not active runbooks for starting a
new migration. Current code, the root SOP documents, and the deployment runbook
take precedence when they differ.
