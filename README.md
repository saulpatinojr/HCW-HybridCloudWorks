# HybridCloudWorks

[![CI](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/ci.yml)
[![CodeQL](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/codeql.yml)
[![Docs site](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/docs-pages.yml/badge.svg?branch=main)](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/docs-pages.yml)
[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/saulpatinojr/HCW-HybridCloudWorks?utm_source=oss&utm_medium=github&utm_campaign=saulpatinojr%2FHCW-HybridCloudWorks&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)](https://coderabbit.ai)
[![Maintainability](https://qlty.sh/gh/saulpatinojr/projects/HCW-HybridCloudWorks/maintainability.svg)](https://qlty.sh/gh/saulpatinojr/projects/HCW-HybridCloudWorks)
[![Code Coverage](https://qlty.sh/gh/saulpatinojr/projects/HCW-HybridCloudWorks/coverage.svg)](https://qlty.sh/gh/saulpatinojr/projects/HCW-HybridCloudWorks)

[![hybridcloudworks.com](https://img.shields.io/website?url=https%3A%2F%2Fhybridcloudworks.com&label=hybridcloudworks.com)](https://hybridcloudworks.com)
[![Docs](https://img.shields.io/website?url=https%3A%2F%2Fdocs.hybridcloudworks.com&label=docs)](https://docs.hybridcloudworks.com)
[![Work board](https://img.shields.io/badge/work%20board-HCW%20Work%20Board-0969da?logo=github)](https://github.com/users/saulpatinojr/projects/6)
[![Open issues](https://img.shields.io/github/issues/saulpatinojr/HCW-HybridCloudWorks?label=open%20issues)](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues)
[![License: Apache-2.0](https://img.shields.io/github/license/saulpatinojr/HCW-HybridCloudWorks)](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/saulpatinojr/HCW-HybridCloudWorks)](https://github.com/saulpatinojr/HCW-HybridCloudWorks/commits/main)

HybridCloudWorks is a website for cloud architects, engineers and learners,
live at [hybridcloudworks.com](https://hybridcloudworks.com). It
brings architecture guidance, certification study material, planning tools,
assessments and hands-on labs for Azure, AWS, Google Cloud, VMware, GitHub,
FinOps, Terraform, Docker and Ansible together in one place.

This repository is the source for all of it, and it is public so that anyone
can see how the site works, report a problem or suggest an improvement.

## What you can do on the site

- **Learn a platform.** Each platform has its own hub with news, articles and
  learning paths, and the [certification index](https://hybridcloudworks.com/education)
  lays out every certification track the site follows, level by level.
- **Plan.** Compare [list prices](https://hybridcloudworks.com/tools/comparison)
  for the same service on AWS, Azure and Google Cloud, refreshed daily; weigh
  options with the [decision matrix](https://hybridcloudworks.com/tools/decisions);
  and assemble an Azure landing zone in the
  [Landing Zone Builder](https://hybridcloudworks.com/tools/landing-zone),
  which explains each part, redraws the diagram as you go, and lets you
  download the Terraform it becomes.
- **Assess.** Upload an export of your Azure estate and get an assessment back:
  a staged plan with example automation and runbooks from the
  [migration assessment](https://hybridcloudworks.com/tools/migration), the
  topology, segmentation and exposure of your network from the
  [network assessment](https://hybridcloudworks.com/tools/network-assessment),
  or a scored review against reliability, security, cost and operations
  criteria from the
  [cloud assessment](https://hybridcloudworks.com/tools/cloud-assessment).
  Nothing you upload is kept beyond two hours. A check of what is built against
  your architecture decisions is on the way.
- **Practise.** Run [hands-on labs](https://hybridcloudworks.com/education/labs)
  in your browser, or on your own machine with one `docker run` line.

## Start here

| If you want to | Go to |
| --- | --- |
| Look around the site | [hybridcloudworks.com](https://hybridcloudworks.com) |
| Prepare for a certification | [Certification index](https://hybridcloudworks.com/education) |
| Try a lab | [Labs](https://hybridcloudworks.com/education/labs) |
| Plan an Azure landing zone | [Landing Zone Builder](https://hybridcloudworks.com/tools/landing-zone) |
| Assess an Azure estate for migration | [Migration assessment](https://hybridcloudworks.com/tools/migration) |
| Assess your Azure network or your whole estate | [Network assessment](https://hybridcloudworks.com/tools/network-assessment), [Cloud assessment](https://hybridcloudworks.com/tools/cloud-assessment) |
| Report a problem or suggest something | [Open an issue](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/new/choose) |
| See what is being worked on | [HCW Work Board](https://github.com/users/saulpatinojr/projects/6) |
| Ask a question or get help | [SUPPORT](.github/SUPPORT.md) |
| Read how the site is built and run | [docs.hybridcloudworks.com](https://docs.hybridcloudworks.com) |

## How it is built, briefly

The pages are served by Azure Static Web Apps, and one Azure Functions app
serves the site's data and runs its background jobs. The labs and the
assessment tools run on a separate lab host. Everything is defined as code in
this repository, every change is reviewed and tested before it merges, and
nothing reaches the live site without a person approving it.

The full picture is on the documentation site, which is built from the
[`docs/`](docs/) folder:

- [How HybridCloudWorks is built](docs/architecture/how-it-is-built.md): the
  architecture diagram, every component, a map of this repository, how to run
  each part locally, and how changes are tested and delivered.
- [Architecture decisions](docs/decisions/index.md): why each choice was made.
- [Runbooks](docs/runbooks/deployment-runbook.md): how the platform is
  operated.

## Contributing

Contributions and suggestions are welcome. To try the website locally you
need Git and Node.js 26:

```shell
git clone https://github.com/saulpatinojr/HCW-HybridCloudWorks.git
cd HCW-HybridCloudWorks/frontend
npm ci
npm test
npm run dev
```

Vite prints the local address to open. The other parts of the repository,
and what each needs, are in
[Run it locally](docs/architecture/how-it-is-built.md#run-it-locally).

Before your first pull request, read [CONTRIBUTING](.github/CONTRIBUTING.md).
In short:

- Work is tracked as
  [GitHub issues](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues)
  and on the [HCW Work Board](https://github.com/users/saulpatinojr/projects/6).
- Every change arrives as a pull request that follows the template, with its
  checks green.
- Narrative documentation goes under `docs/`, not beside the code.
  [CHANGELOG.md](CHANGELOG.md) records completed work and [TODO.md](TODO.md)
  the accepted risks.

Everyone taking part follows the [code of conduct](.github/CODE_OF_CONDUCT.md).

## Security

Report a vulnerability privately, as [SECURITY](.github/SECURITY.md)
describes, never in a public issue.

## Licence

The code is licensed under the Apache License, Version 2.0; the text is in
[LICENSE](LICENSE). [NOTICE](NOTICE) carries the copyright line and explains
that third-party names, logos and marks, such as the vendor logos under
`frontend/public/icons/providers/` and `frontend/src/assets/brands/`, belong
to their owners and are not licensed under Apache-2.0. Other third-party
material, such as the fonts under `frontend/public/fonts/`, keeps its own
licence terms.
