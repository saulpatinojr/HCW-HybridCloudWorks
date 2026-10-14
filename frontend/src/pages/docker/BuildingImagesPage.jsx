/**
 * `/docker/building-images` (#772): the Docker hub's first focus area,
 * building container images, with the site's own lab image as the worked
 * example. Every statement about the image is read from the repository, not
 * remembered:
 *   lab-image/Dockerfile               — the stages, the FROM lines, USER, ENV,
 *                                        the mirror and the vendoring
 *   lab-image/versions.env             — BASE_IMAGE and BASE_DIGEST, every sum
 *   lab-image/smoke.sh                 — what the smoke test refuses and checks
 *   lab-image/README.md                — the measured mirror sizes, the local
 *                                        commands and what success prints
 *   .github/workflows/publish-lab-image.yml — the FROM check, the three jobs,
 *                                        `provenance: false`, the push and the
 *                                        attestation
 * Re-read them before changing a sentence here. A change to any of those files
 * that alters what this page says should change this page in the same PR.
 *
 * WHAT THE PAGE LEAVES OUT, ON PURPOSE. public-copy.test.js keeps the runner
 * image's registry name, digests written out, and the vendored modules' path
 * off every public page (owner request 2026-09-28), so the runner target is
 * described and not tagged, the commands build and run the `full` target, and
 * a digest is something a command prints rather than something the page
 * quotes. Nothing here needs an allowance in that test.
 *
 * Every command was written against those files on 2026-10-02 and is printed
 * for both shells. Git Bash rewrites an argument that looks like a Unix path
 * into a Windows one, so the bash lines that hand Docker a container path set
 * MSYS_NO_PATHCONV=1, as the lab image README does; elsewhere that variable
 * does nothing.
 */
import React from 'react';
import { routes, staticRoutes } from '@/lib/routeFactory';
import DockerGuide, { Code, Commands, GuideSection, PROSE } from './DockerGuide';

export const PAGE_TITLE = 'Building images';

/** The page's path, which the landing page links to. */
export const BUILDING_IMAGES_PATH = routes.buildingImages('docker');

const CANONICAL = `https://hybridcloudworks.com${BUILDING_IMAGES_PATH}`;

/** When the commands were last read against the files they describe. */
export const CHECKED_ON = Object.freeze({ iso: '2026-10-14', label: '14 October 2026' });

const REPO = 'https://github.com/saulpatinojr/HCW-HybridCloudWorks';

export const SOURCE_LINKS = Object.freeze({
  dockerfile: `${REPO}/blob/main/lab-image/Dockerfile`,
  versions: `${REPO}/blob/main/lab-image/versions.env`,
  smoke: `${REPO}/blob/main/lab-image/smoke.sh`,
  workflow: `${REPO}/blob/main/.github/workflows/publish-lab-image.yml`,
  multiStageDocs: 'https://docs.docker.com/build/building/multi-stage/',
  attestAction: 'https://github.com/actions/attest-build-provenance',
});

/** The published image, as the publish workflow names it. */
export const PUBLISHED_IMAGE = 'docker.io/hybridcloudworks/hcw-lab';

/** The local tag the build commands give the `full` target, as the Dockerfile's header does. */
export const LOCAL_TAG = 'hcw-lab:dev';

const both = (command) =>
  Object.freeze([
    Object.freeze({ shell: 'PowerShell', command }),
    Object.freeze({ shell: 'bash', command }),
  ]);

/**
 * Every command on the page, by section and in page order. Each section's
 * list is PowerShell first and bash second; a third line is a variant the
 * prose explains.
 */
export const COMMANDS = Object.freeze({
  clone: Object.freeze([
    Object.freeze({
      shell: 'PowerShell',
      command: `git clone ${REPO}.git; cd HCW-HybridCloudWorks`,
    }),
    Object.freeze({
      shell: 'bash',
      command: `git clone ${REPO}.git && cd HCW-HybridCloudWorks`,
    }),
  ]),
  build: Object.freeze([
    ...both(`docker build --target full -t ${LOCAL_TAG} lab-image`),
    Object.freeze({
      shell: 'bash (Apple silicon Mac)',
      command: `docker build --platform linux/amd64 --target full -t ${LOCAL_TAG} lab-image`,
    }),
  ]),
  fromLines: Object.freeze([
    Object.freeze({
      shell: 'PowerShell',
      command: "Select-String -Path lab-image/Dockerfile -Pattern '^FROM'",
    }),
    Object.freeze({ shell: 'bash', command: "grep -n '^FROM' lab-image/Dockerfile" }),
  ]),
  inspectBase: both('docker buildx imagetools inspect python:3.14.8-slim-trixie'),
  mirror: Object.freeze([
    Object.freeze({
      shell: 'PowerShell',
      command: `docker run --rm ${LOCAL_TAG} ls /opt/terraform/mirror/registry.terraform.io`,
    }),
    Object.freeze({
      shell: 'bash',
      command: `MSYS_NO_PATHCONV=1 docker run --rm ${LOCAL_TAG} ls /opt/terraform/mirror/registry.terraform.io`,
    }),
  ]),
  user: both(`docker run --rm ${LOCAL_TAG} id`),
  smoke: Object.freeze([
    Object.freeze({
      shell: 'PowerShell',
      command: `docker run --rm --network none -v "\${PWD}\\lab-image:/workspace:ro" ${LOCAL_TAG} bash /workspace/smoke.sh full`,
    }),
    Object.freeze({
      shell: 'bash',
      command: `MSYS_NO_PATHCONV=1 docker run --rm --network none -v "$(pwd -W 2>/dev/null || pwd)/lab-image:/workspace:ro" ${LOCAL_TAG} bash /workspace/smoke.sh full`,
    }),
  ]),
  verify: both(
    `gh attestation verify oci://${PUBLISHED_IMAGE}:latest --repo saulpatinojr/HCW-HybridCloudWorks`
  ),
  pull: both(`docker pull ${PUBLISHED_IMAGE}:latest`),
});

const DESCRIPTION =
  'Building a container image the careful way, with the image behind this site’s browser labs as the worked example: base images pinned by digest, two build targets from one Dockerfile, offline Terraform providers and modules, a non-root user, smoke tests, provenance attestations and publishing to Docker Hub.';

function SourceLink({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold underline underline-offset-4"
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export default function DockerBuildingImagesPage() {
  return (
    <DockerGuide
      pageId="docker-building-images"
      eyebrow="Docker · Images"
      title={PAGE_TITLE}
      description={DESCRIPTION}
      canonical={CANONICAL}
      intro={
        <>
          Every browser lab on this site runs in one container image, hcw-lab, and anyone can pull
          it. This guide reads its Dockerfile and the workflow that publishes it, one decision at a
          time: what each part does, why it is there, and the command that shows it working on your
          own machine.
        </>
      }
      checked={
        <>
          The commands on this page were last checked against the Dockerfile, versions.env and the
          publish workflow on <time dateTime={CHECKED_ON.iso}>{CHECKED_ON.label}</time>.
        </>
      }
      links={[
        { label: 'The Dockerfile on GitHub', href: SOURCE_LINKS.dockerfile, external: true },
        { label: 'The publish workflow on GitHub', href: SOURCE_LINKS.workflow, external: true },
        { label: 'Use the image in Docker Desktop', to: routes.desktop('docker') },
        { label: 'The article series on the Docker blog', to: routes.blog('docker') },
        { label: 'See the browser labs', to: staticRoutes.labs },
        { label: 'Back to the Docker hub', to: routes.landing('docker') },
      ]}
    >
      <GuideSection id="source" title="Get the source">
        <p className={PROSE}>
          Everything below is in the site’s public repository: the Dockerfile and its pinned
          versions under <Code>lab-image/</Code>, and the workflow under{' '}
          <Code>.github/workflows/</Code>. Clone it and work from its root, because every command
          here names <Code>lab-image</Code> as a relative path. You need Docker with BuildKit, which
          is the default builder in Docker Desktop and in Docker Engine 23 and later; the Dockerfile
          uses <Code>RUN --mount</Code> and <Code>COPY --chmod</Code>, which need it. You also need
          the <Code>buildx</Code> plugin for the <Code>docker buildx imagetools</Code> command
          below. Docker Desktop includes it; on Linux, Docker’s packages ship it separately as{' '}
          <Code>docker-buildx-plugin</Code>.
        </p>
        <Commands commands={COMMANDS.clone} testId="commands-clone" />
      </GuideSection>

      <GuideSection id="targets" title="One Dockerfile, two targets">
        <p className={PROSE}>
          The file has five stages. Three of them, <Code>fetch</Code>, <Code>vendor</Code> and{' '}
          <Code>mirror</Code>, only build: they download, verify and prepare, and nothing from them
          ships except what a later stage copies out. The other two are the images people use:
        </p>
        <ul className={`${PROSE} list-disc space-y-2 pl-5`}>
          <li>
            <Code>runner</Code> carries terraform, kubeconform, helm and ansible-core, the Terraform
            provider mirror and the vendored modules. It starts from the base image again and copies
            in only what the build stages produced, so curl, unzip and git, which <Code>fetch</Code>{' '}
            installs to do its work, are not in it.
          </li>
          <li>
            <Code>full</Code> is <Code>FROM runner</Code> plus the Azure CLI, kubectl, git, curl and
            jq, and the packages VS Code in the browser needs. Its default command is{' '}
            <Code>bash</Code>. This is the image the labs run and the one you pull.
          </li>
        </ul>
        <p className={PROSE}>
          <Code>--target</Code> picks which stage the build stops at, and BuildKit builds only the
          stages that stage depends on. This builds <Code>full</Code> and tags it locally;{' '}
          <Code>--target runner</Code> builds the smaller image the same way. The image is
          linux/amd64 only, because every binary the Dockerfile downloads is the linux_amd64 build,
          so on a Mac with Apple silicon add <Code>--platform linux/amd64</Code>, as in the third
          line, and the build runs under emulation.
        </p>
        <Commands commands={COMMANDS.build} testId="commands-build" />
        <p className={PROSE}>
          Docker’s own guide to the pattern is{' '}
          <SourceLink href={SOURCE_LINKS.multiStageDocs}>Multi-stage builds</SourceLink>.
        </p>
      </GuideSection>

      <GuideSection id="digest" title="Base images pinned by digest">
        <p className={PROSE}>
          Both stages that start from an image, <Code>fetch</Code> and <Code>runner</Code>, start
          from the official <Code>python:3.14.8-slim-trixie</Code> (CPython 3.14.8 on Debian 13),
          written as the tag, an <Code>@</Code>, and the image’s index digest. A tag can be moved to
          a different image at any time; a digest is the hash of the content, so it cannot. As the
          Dockerfile’s own header puts it, the tag beside the digest is documentation: Docker
          resolves the digest and ignores the tag. The other three stages start from an earlier
          stage, which this lists alongside them:
        </p>
        <Commands commands={COMMANDS.fromLines} testId="commands-from" />
        <p className={PROSE}>
          A <Code>FROM</Code> line cannot read a file, so the digest is written twice: in the
          Dockerfile, and as <Code>BASE_IMAGE</Code> and <Code>BASE_DIGEST</Code> in{' '}
          <SourceLink href={SOURCE_LINKS.versions}>versions.env</SourceLink>. The publish workflow’s
          first step reads every <Code>FROM</Code> and fails the build unless each one is an earlier
          stage or exactly that image and digest, tag included. A bare tag, a different digest or a{' '}
          <Code>--platform</Code> flag on the line all fail it.
        </p>
        <p className={PROSE}>
          To see what the tag points at today, ask the registry. The <Code>Digest</Code> line it
          prints is the value in the <Code>FROM</Code> lines unless Docker has rebuilt the tag since
          the pin was last moved, and if the two differ, the pin is doing its job: the build keeps
          the image it was tested with until someone moves it on purpose.
        </p>
        <Commands commands={COMMANDS.inspectBase} testId="commands-inspect" />
      </GuideSection>

      <GuideSection id="checksums" title="Every direct download checked against a pinned sum">
        <p className={PROSE}>
          Every version and checksum the Dockerfile pins lives in versions.env, which each step that
          downloads something sources before it starts. Each binary is checked with{' '}
          <Code>sha256sum -c</Code> straight after its download, and because the shell runs with{' '}
          <Code>set -eu</Code>, a sum that does not match fails the build rather than leaving an
          unverified binary in place. ansible-core and each package it depends on are fetched by pip
          in hash-checking mode with <Code>--only-binary=:all:</Code>, so nothing is built from
          source and nothing outside the list can be pulled in, and the <Code>runner</Code> stage
          installs them a second time from those same files with no package index at all. pip is
          then removed, so the image carries no pip command.
        </p>
        <p className={PROSE}>
          Packages installed with <Code>apt-get</Code> are the exception. Apart from the Azure CLI,
          whose version is pinned, their versions are not in versions.env, and they are checked by
          APT against the signed Debian and Microsoft package indexes rather than by{' '}
          <Code>sha256sum -c</Code>. The Microsoft signing key itself is checked against a pinned
          sum before APT is told to trust it.
        </p>
      </GuideSection>

      <GuideSection id="offline" title="Vendored for offline use">
        <p className={PROSE}>
          The lab’s own checks run with no network, so <Code>terraform init</Code> has to work
          without one. Two things make that possible.
        </p>
        <ul className={`${PROSE} list-disc space-y-2 pl-5`}>
          <li>
            <strong>A provider mirror.</strong> The <Code>mirror</Code> stage runs{' '}
            <Code>terraform providers mirror</Code> for azurerm (at a 5.x and a 4.x version), azapi,
            alz, random, modtm and time, checks each provider’s zip against its pinned sum, and then
            unpacks it. Unpacked matters: from a packed mirror <Code>terraform init</Code> copies
            each provider into <Code>.terraform</Code> (225 MB for azurerm), while from an unpacked
            one it links to the mirror and copies nothing, which leaves a 40 KB{' '}
            <Code>.terraform</Code> in the repository’s own measurement. A CLI config file then
            makes the mirror the only source, with no fallback to the registry, so an unmirrored
            provider fails at once instead of hanging on a registry it cannot reach.
          </li>
          <li>
            <strong>The Azure Verified Modules.</strong> Terraform has a provider mirror but no
            module mirror. So the image carries every Azure Verified Module the Landing Zone Builder
            emits, from each module’s release tarball and checked by SHA256, and every registry
            module those call. A script rewrites each call inside the copies from its registry
            source to a relative path, and a second <Code>terraform get</Code> proves nothing left
            in the tree reaches the registry.
          </li>
        </ul>
        <p className={PROSE}>
          The mirror is an ordinary directory, so you can look at it. This prints the two provider
          namespaces it holds, <Code>azure</Code> and <Code>hashicorp</Code>:
        </p>
        <Commands commands={COMMANDS.mirror} testId="commands-mirror" />
        <p className={PROSE}>
          Inside the container, <Code>TF_CLI_CONFIG_FILE=/dev/null terraform init</Code> sets the
          config aside for one command and uses the registry instead, which needs the network.
        </p>
      </GuideSection>

      <GuideSection id="non-root" title="Running as a non-root user">
        <p className={PROSE}>
          Both images end with <Code>USER 65534:65534</Code>, Debian’s <Code>nobody</Code>, and{' '}
          <Code>WORKDIR /workspace</Code>. The lab mounts <Code>/workspace</Code> read-only, so
          everything the tools write goes under <Code>/tmp</Code>: <Code>HOME</Code> is{' '}
          <Code>/tmp/home</Code>, and <Code>TMPDIR</Code>, Terraform’s data directory, and Helm’s
          and Ansible’s working files are all under <Code>/tmp/run</Code>. In the{' '}
          <Code>runner</Code> image <Code>nobody</Code> keeps its no-login shell. The{' '}
          <Code>full</Code> image switches back to root only to install its packages and to give{' '}
          <Code>nobody</Code> a bash shell and that home, because the browser workspaces run their
          terminal through the user’s own shell, and then drops back to 65534.
        </p>
        <Commands commands={COMMANDS.user} testId="commands-user" />
        <p className={PROSE}>
          The output begins <Code>uid=65534(nobody)</Code>.
        </p>
      </GuideSection>

      <GuideSection id="smoke" title="Smoke tests">
        <p className={PROSE}>
          A build that succeeds proves the files arrived, not that the tools work.{' '}
          <SourceLink href={SOURCE_LINKS.smoke}>smoke.sh</SourceLink> runs inside the image with{' '}
          <Code>lab-image</Code> mounted read-only and the network off, and it first refuses to pass
          if the network is reachable or the mount is writable, because an offline{' '}
          <Code>terraform init</Code> that had a network would prove nothing. Then it compares each
          tool’s version with versions.env, checks every mirrored provider and vendored module is on
          disk, and runs <Code>terraform init -backend=false</Code> and{' '}
          <Code>terraform validate</Code> against small configurations with no network. For{' '}
          <Code>full</Code> it also checks the extra tools and the user’s shell. From the repository
          root, after the build above:
        </p>
        <Commands commands={COMMANDS.smoke} testId="commands-smoke" />
        <p className={PROSE}>
          A passing run ends with <Code>smoke: passed (full)</Code> and exits 0. A failing check
          prints <Code>FAIL:</Code> with the tool’s output under it, and the script runs every
          remaining check before it exits 1, so one run shows everything that is wrong. The bash
          line asks Git Bash for a Windows-style path with <Code>pwd -W</Code> and falls back to{' '}
          <Code>pwd</Code> anywhere else.
        </p>
      </GuideSection>

      <GuideSection id="provenance" title="Provenance attestations">
        <p className={PROSE}>
          A provenance attestation is a signed record of where an image came from: which repository,
          which workflow file, which commit. The publish workflow makes one for each image it pushes
          with{' '}
          <SourceLink href={SOURCE_LINKS.attestAction}>actions/attest-build-provenance</SourceLink>,
          given the image’s name and digest and <Code>push-to-registry: true</Code>, so the
          attestation is stored in the registry beside the image. Only the jobs that publish are
          granted <Code>id-token: write</Code> and <Code>attestations: write</Code>, which the
          action needs to sign and store it.
        </p>
        <p className={PROSE}>
          The builds themselves set <Code>provenance: false</Code>, which turns off BuildKit’s own
          attestation. That keeps each pushed image a plain single manifest, whose digest is the one{' '}
          <Code>docker pull</Code> reports, while the record of how it was made comes from the
          action instead. You can check it with the GitHub CLI, signed in:
        </p>
        <Commands commands={COMMANDS.verify} testId="commands-verify" />
        <p className={PROSE}>
          A good result prints <Code>✓ Verification succeeded!</Code> and names{' '}
          <Code>.github/workflows/publish-lab-image.yml@refs/heads/main</Code> as the workflow that
          built it.
        </p>
      </GuideSection>

      <GuideSection id="publish" title="Publishing to Docker Hub">
        <p className={PROSE}>
          <SourceLink href={SOURCE_LINKS.workflow}>publish-lab-image.yml</SourceLink> has four jobs.
          The first two keep validation and publishing apart, so the code a pull request can change
          never runs with a token that can publish.
        </p>
        <ul className={`${PROSE} list-disc space-y-2 pl-5`}>
          <li>
            <strong>build</strong> runs on every pull request that touches the image, with a
            read-only token. It checks the <Code>FROM</Code> lines, builds both targets, and
            smoke-tests each one.
          </li>
          <li>
            <strong>publish</strong> runs only after <strong>build</strong> passes, and only on
            main. It builds both targets again, smoke-tests what it built, and pushes those exact
            images with <Code>docker push</Code>, tagged with the commit’s SHA and{' '}
            <Code>latest</Code>. It reads each digest back from the registry, attests it, and writes
            the digests to the run’s summary. This job alone can publish, and it signs in through an
            OIDC connection: Docker exchanges the run’s own short-lived identity token for a Docker
            token that lasts minutes, so no password or access token is stored anywhere.
          </li>
          <li>
            <strong>Every week</strong> the workflow also rebuilds both targets from main without
            the build cache, so the operating system packages the <Code>full</Code> image installs
            pick up their security fixes. It publishes the rebuild only when those packages have
            changed, tagged with the commit’s SHA and the date.
          </li>
        </ul>
        <p className={PROSE}>
          The result is <Code>{PUBLISHED_IMAGE}</Code>, public, so pulling it needs no sign-in, and
          it is the image the lab pages’ own <Code>docker run</Code> line pulls. The lab itself runs
          each image by its digest, never by a tag, so the last two jobs open a pull request that
          moves those digests to the images just published.
        </p>
        <Commands commands={COMMANDS.pull} testId="commands-pull" />
      </GuideSection>
    </DockerGuide>
  );
}
