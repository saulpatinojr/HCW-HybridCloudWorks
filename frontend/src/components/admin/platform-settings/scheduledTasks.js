/**
 * Every scheduled task in the estate, for Platform Settings → Scheduled tasks.
 *
 * Four places run things on a clock, and nothing listed them together:
 *
 *   github     GitHub Actions workflows with a `schedule:` trigger
 *              (.github/workflows/*.yml), five-field cron, UTC
 *   functions  timers in the Function App (`app.timer(...)` under
 *              functions/src/functions), six-field NCRONTAB, UTC (#416)
 *   lab-host   systemd timers the Ansible playbook installs on the lab host
 *              (lab-host/ansible/roles/<role>/templates/*.timer.j2)
 *   claude     the daily Claude Code session that finishes what the
 *              scheduled jobs leave behind; it lives in the owner's Claude
 *              account, so nothing in the repository holds its schedule
 *
 * The schedules here are copied from those sources, and
 * scripts/scheduled-tasks-list.test.mjs reads the sources themselves: it
 * fails when a scheduled job is missing from this list, is listed with a
 * different schedule, or is listed but no longer exists. The plain-English
 * `does` and `leaves` lines are written by hand, because no source says them
 * in words a reader new to the estate can follow.
 *
 * This file imports nothing, so that test (in the scripts package) can load
 * it without the frontend's build setup.
 */

const REPO = 'https://github.com/saulpatinojr/HCW-HybridCloudWorks';

/** Where each group runs, in one plain line, and the clock its times are read on. */
export const SCHEDULE_GROUPS = Object.freeze([
  {
    id: 'github',
    label: 'GitHub Actions',
    clock: 'UTC',
    explain:
      'Workflows (automated jobs) in this repository that GitHub starts on a timer. GitHub can start a scheduled run a few minutes late, or skip one when it is busy. A failed run, or the pull request or issue one leaves, is picked up by the daily Claude session at the end of this page.',
  },
  {
    id: 'functions',
    label: 'Function App',
    clock: 'UTC',
    explain:
      'Timers inside the site’s own back end, the Function App func-site-prod-cus-01 (resource group rg-web-site-prod-cus). Each one fires on schedule but does its work only while its switch is on (the enabled_timers list in Terraform); switched off, it stops at once. The link opens the code that sets the schedule.',
  },
  {
    id: 'lab-host',
    label: 'Lab host',
    clock: 'lab host clock',
    explain:
      'Timers on the lab server, installed by its Ansible playbook (the scripted setup in lab-host/). Times are read on the lab host’s own clock, and most wait up to a few minutes more at random so they do not all start at once. A missed run, while the host was off, usually runs at the next start-up.',
  },
  {
    id: 'claude',
    label: 'Claude',
    clock: 'UTC',
    explain:
      'A scheduled Claude Code session. It lives in the owner’s Claude account, not in this repository, so it is listed and changed at claude.ai/code.',
  },
]);

const workflow = (file, name, schedules, does, leaves) => ({
  id: file,
  group: 'github',
  name,
  code: file,
  schedules,
  does,
  leaves,
  href: `${REPO}/actions/workflows/${file}`,
});

/** A Function App timer: [timer name, plain name, NCRONTAB schedule, the file that registers it]. */
const timer = ([id, name, schedule, file], does, leaves) => ({
  id,
  group: 'functions',
  name,
  code: id,
  schedules: [schedule],
  does,
  leaves,
  href: `${REPO}/blob/main/functions/src/functions/${file}`,
});

/** A lab host timer: [Ansible role, unit file, plain name, schedule line with defaults filled in]. */
const labTimer = ([role, unit, name, schedule], does, leaves) => ({
  id: unit,
  group: 'lab-host',
  name,
  code: unit,
  schedules: [schedule],
  does,
  leaves,
  href: `${REPO}/blob/main/lab-host/ansible/roles/${role}/templates/${unit}.j2`,
});

const PASS_FAIL = 'A pass or fail result on the run; a red run is the signal.';

/**
 * Every scheduled task. `schedules` is the exact text of each schedule line
 * in its source (a cron line, an NCRONTAB expression, or a systemd
 * `OnCalendar=`/`OnUnitActiveSec=` line with its defaults filled in).
 */
export const SCHEDULED_TASKS = Object.freeze([
  // ── GitHub Actions ─────────────────────────────────────────────────────────
  workflow(
    'addon-image-scout.yml',
    'Add-on images against Docker Scout',
    ['20 7 * * 3'],
    'Checks the add-on images the lab host runs against Docker Scout’s policies, and fails when one has a serious vulnerability that already has a fix.',
    PASS_FAIL
  ),
  workflow(
    'audit-published-pages.yml',
    'Audit published pages',
    ['0 6 * * 1'],
    'Opens every page in the live sitemap in a real browser and records whether each one works, is empty or is broken.',
    'A report file attached to the run.'
  ),
  workflow(
    'check-cloud-module-pins.yml',
    'Check cloud module pins',
    ['43 7 * * 3'],
    'Checks that every AWS and Google Cloud module version the Landing Zone Builder pins was really published.',
    'Opens an issue, or comments on the open one, when a pinned version is missing.'
  ),
  workflow(
    'check-drill-age.yml',
    'Check drill age',
    ['20 7 * * 1'],
    'Checks that the Cosmos DB restore drill (a timed practice restore of the database) has been run in the last 100 days.',
    'Opens an issue, or comments on the open one, while the drill is overdue.'
  ),
  workflow(
    'cloudflare-dns-audit.yml',
    'Cloudflare DNS audit',
    ['50 5 * * *'],
    'Checks that no DNS record in the production Cloudflare zone was changed outside the allowed list.',
    'Opens an issue, or comments on the open one, when it finds a change.'
  ),
  workflow(
    'cloudflare-ranges.yml',
    'Cloudflare Ranges',
    ['5 7 * * 2'],
    'Compares the Cloudflare addresses the site’s firewall lets in with the list Cloudflare publishes.',
    'Opens a pull request when Cloudflare’s list has changed.'
  ),
  workflow(
    'codeql.yml',
    'CodeQL',
    ['31 4 * * 1'],
    'Runs GitHub’s code scanning over the whole repository, so a newly published check also looks at code no pull request has touched.',
    'Alerts on the code scanning page.'
  ),
  workflow(
    'lab-supply-chain.yml',
    'Lab supply chain',
    ['45 6 * * 2'],
    'Checks whether the software the lab host pins has fallen behind, and whether the lab images carry known vulnerabilities.',
    'Opens a pull request to move the pins, and opens or comments on an issue for vulnerabilities.'
  ),
  workflow(
    'monitor-deploy-drift.yml',
    'Monitor delivery health',
    ['17 */4 * * *'],
    'Checks whether production has fallen behind main, and whether any workflow keeps failing.',
    'Opens or updates the workflow-health issue; a red run is also sent to Telegram by the Function App.'
  ),
  workflow(
    'monitor-functions-registered.yml',
    'Monitor Functions Registered',
    ['41 * * * *'],
    'Checks from outside that the Function App still has every function registered (the failure where every page answers “not found”).',
    PASS_FAIL
  ),
  workflow(
    'monitor-unresolved-secrets.yml',
    'Monitor Unresolved Secrets',
    ['29 */6 * * *'],
    'Checks that the site’s Key Vault references still reach their secrets.',
    PASS_FAIL
  ),
  workflow(
    'publish-content-manifest.yml',
    'Publish Content Manifest',
    ['15 6 * * *'],
    'Fetches the list of published articles from the Function App and updates the file the site’s build turns into static pages.',
    'Opens a pull request that merges itself once its checks pass, which deploys the site.'
  ),
  workflow(
    'publish-lab-image.yml',
    'Publish lab image',
    ['20 5 * * 2'],
    'Rebuilds, tests and publishes the two lab images to Docker Hub, so they pick up the week’s security updates.',
    'New images on Docker Hub.'
  ),
  workflow(
    'remove-ci-access-windows.yml',
    'Remove CI Access Windows',
    ['11 * * * *'],
    'Removes the short-lived firewall openings a deploy run left behind when it stopped before closing them.',
    'Removes the leftover rules; the run’s summary says what it removed.'
  ),
  workflow(
    'update-avm-versions.yml',
    'Update AVM Versions',
    ['30 6 * * 2'],
    'Checks the Azure Verified Module versions the Landing Zone Builder pins against the Terraform Registry.',
    'Opens a pull request when a module has a newer release.'
  ),
  workflow(
    'update-learn-catalogue.yml',
    'Update Learn Catalogue',
    ['30 6 * * 1'],
    'Refreshes the Azure certification catalogue and study guide outlines from Microsoft Learn.',
    'Opens a pull request when either changed.'
  ),
  workflow(
    'update-version-floors.yml',
    'Update Version Floors',
    ['30 6 * * 3'],
    'Reads the newest release of every runtime, operating system and base image the repository uses.',
    'Opens a pull request when a minimum version moves; it may need hand edits for exact pins.'
  ),
  workflow(
    'verify-alert-state.yml',
    'Verify Alert Rule State',
    ['53 7 * * 1'],
    'Reads the live state of every Azure alert rule Terraform declares, and fails when one is missing, switched off or not wired to its action group.',
    PASS_FAIL
  ),
  workflow(
    'warn-catalogue-due.yml',
    'Warn Catalogue Due',
    ['0 7 * * 1'],
    'Warns three weeks before a row of the Learn catalogue goes out of date.',
    'Opens, updates or closes an issue.'
  ),

  // ── Function App ───────────────────────────────────────────────────────────
  timer(
    ['publishScheduledContent', 'Publish scheduled content', '0 */15 * * * *', 'schedulers.js'],
    'Publishes every article whose scheduled time has come.'
  ),
  timer(
    ['syncSocialCalendarScheduled', 'Sync the social calendar', '0 */5 * * * *', 'schedulers.js'],
    'Reads posts back from Publer (the social posting service) into the social calendar.'
  ),
  timer(
    ['checkAgentHealth', 'Check lab agent health', '0 */5 * * * *', 'schedulers.js'],
    'Marks lab agents that stopped reporting; once an hour it also checks lab drift, the Coder status token, the delivery monitor and the Cost page’s budgets.',
    'A Telegram message when something goes red or comes back.'
  ),
  timer(
    ['healthPulse', 'Health pulse', '0 2-59/5 * * * *', 'schedulers.js'],
    'Runs every check the back end can make on its own and records the results.',
    'Fresh results and a heartbeat on the Health page.'
  ),
  timer(
    [
      'sweepVisitorSessions',
      'Sweep visitor lab sessions',
      '0 */2 * * * *',
      'visitor-session-sweep.js',
    ],
    'Ends visitor lab sessions that are past their hour, and retries Coder clean-ups that have not been confirmed.'
  ),
  timer(
    ['platformJobSweeper', 'Re-queue stuck jobs', '0 */15 * * * *', 'jobs-sweeper.js'],
    'Puts back on the queue any background job that has sat waiting too long because its message was lost.'
  ),
  timer(
    ['brainIndexReconcile', 'Second Brain index', '0 */15 * * * *', 'brain-http.js'],
    'Carries on an unfinished rebuild of the Second Brain search index, and starts a full rebuild once a day.'
  ),
  timer(
    ['labCanary', 'Lab canary', '0 20 */1 * * *', 'schedulers.js'],
    'Sends one small real job to the lab host, waits for it to finish, records the result and deletes the job.',
    'The lab canary result on the Health page.'
  ),
  timer(
    ['syncRssFeeds', 'Sync RSS feeds', '0 0 */2 * * *', 'schedulers.js'],
    'Reads the news feeds the site follows and stores new items.'
  ),
  timer(
    ['fetchPodcastFeeds', 'Fetch podcast feeds', '0 30 */2 * * *', 'schedulers.js'],
    'Reads the podcast feeds listed on the Audio tab and stores new episodes.'
  ),
  timer(
    [
      'cleanupSoftDeletedContent',
      'Delete old soft-deleted content',
      '0 0 */4 * * *',
      'schedulers.js',
    ],
    'Permanently deletes content that was soft-deleted (marked for deletion) more than seven days ago. Only counts until its delete switch is on.'
  ),
  timer(
    ['monitorPublishingPipeline', 'Publishing watchdog', '0 0 */6 * * *', 'schedulers.js'],
    'Looks for articles stuck part-way through publishing.'
  ),
  timer(
    ['fetchBlogListings', 'Fetch blog listings', '0 15 */6 * * *', 'schedulers.js'],
    'Reads the blog listing pages the site follows for new posts. Skips itself while the Firecrawl key is a placeholder.'
  ),
  timer(
    ['refreshPlaudToken', 'Refresh sign-in tokens', '0 0 */12 * * *', 'schedulers.js'],
    'Renews the sign-in tokens of Plaud and of every tool server connected through OAuth.'
  ),
  timer(
    ['syncSearchConsole', 'Sync Search Console', '0 10 0,12 * * *', 'schedulers.js'],
    'Refreshes what Google knows about each public page, the search traffic and the sitemaps.',
    'Fresh figures on the Search Console page.'
  ),
  timer(
    ['cleanupTempStorage', 'Clean temporary storage', '0 0 0 * * *', 'schedulers.js'],
    'Deletes old temporary files from storage. Only counts until its delete switch is on.'
  ),
  timer(
    ['refreshToolServiceCache', 'Refresh cloud pricing', '0 0 2 * * *', 'cloud-tools-jobs.js'],
    'Queues the job that refreshes the cloud prices the Cloud Tools pages show.'
  ),
  timer(
    ['cosmosExportScheduler', 'Nightly database export', '0 0 3 * * *', 'cosmos-export.js'],
    'Starts one export job per Cosmos DB container, copying the data to storage outside the database account, and runs the yearly content archive’s daily check.',
    'Export files in storage.'
  ),
  timer(
    ['forgeScheduled', 'Auto-Forge drafts', '0 30 3 * * *', 'schedulers.js'],
    'Drafts and grades new articles from approved ideas, when Auto-Forge is also switched on in Forge Memory.',
    'New drafts waiting for review.'
  ),
  timer(
    ['cleanupRejectedContent', 'Retire rejected content', '0 0 4 * * *', 'schedulers.js'],
    'Soft-deletes content rejected more than a day ago, and removes the speaker’s details from talk proposals that were not accepted once their cycle is over.'
  ),
  timer(
    [
      'cleanupUnusedCertImages',
      'Clean unused certification images',
      '0 0 5 * * *',
      'schedulers.js',
    ],
    'Deletes certification images that nothing uses any more. Only counts until its delete switch is on.'
  ),
  timer(
    [
      'ambassadorAudienceMonthly',
      'Ambassador audience figures',
      '0 45 6 * * *',
      'ambassador-audience.js',
    ],
    'Records last month’s page views (Cloudflare) and podcast downloads (Podbean) as evidence in the Ambassador hub. Daily, but only the first run of a month does any work.',
    'One evidence row per programme each month.'
  ),
  timer(
    ['generateReviewerDigest', 'Reviewer digest', '0 0 7 * * *', 'schedulers.js'],
    'Builds the daily digest of what is waiting for review.'
  ),
  timer(
    ['sendReminders', 'Send reminders', '0 0 13 * * *', 'schedulers.js'],
    'Says each dated reminder from the Reminders tab on Telegram, after updating the credential register’s renewal dates.',
    'Telegram messages.'
  ),
  timer(
    ['labsWeeklyRollup', 'Labs day roll-up', '0 55 23 * * *', 'labs-jobs.js'],
    'Folds the day’s lab figures into one record, which the newsletter’s “Lab this week” section reads.'
  ),
  timer(
    ['reVerifyCertifications', 'Re-check certifications', '0 0 0 * * 0', 'schedulers.js'],
    'Re-checks the certifications shown on the About page against their issuers and republishes them.'
  ),
  timer(
    ['checkLiveLinks', 'Check live links', '0 0 6 * * 1', 'schedulers.js'],
    'Checks the links in published content for ones that no longer work.'
  ),
  timer(
    ['probeAiProviders', 'Test AI providers', '0 15 6 * * 1', 'schedulers.js'],
    'Runs the AI Engine’s Test against every provider with a key, and refreshes the list of models each one offers.',
    'Results on the AI Engine provider cards.'
  ),
  timer(
    ['buildWeeklyNewsletter', 'Build the weekly newsletter', '0 0 13 * * 1', 'schedulers.js'],
    'Builds a draft of the week’s newsletter and sends its link on Telegram. It never sends the newsletter: that stays a press of Approve on the Drafts tab.',
    'A newsletter draft.'
  ),
  timer(
    ['scrapeSkillsHubRss', 'Skills Hub feed', '0 0 9 * * 5', 'schedulers.js'],
    'Reads the Microsoft Skills Hub feed for new items.'
  ),

  // ── Lab host ───────────────────────────────────────────────────────────────
  labTimer(
    ['portainer', 'hcw-portainer-check.timer', 'Portainer check', 'OnUnitActiveSec=15min'],
    'Reads Portainer (the container dashboard on the lab host) and reports what it sees to the site’s Health page through the lab agent.'
  ),
  labTimer(
    [
      'workspace_reach',
      'hcw-workspace-reach.timer',
      'Workspace reach check',
      'OnUnitActiveSec=15min',
    ],
    'Starts a throwaway container shaped like a lab workspace and checks that it can still reach Coder and the lab repository.',
    'A failed run raises the lab unit-failed alert.'
  ),
  labTimer(
    ['hardening', 'hcw-playbook-drift.timer', 'Playbook drift check', 'OnCalendar=*-*-* 03:00:00'],
    'Runs the lab host’s playbook in check mode (changing nothing) to see whether the host has drifted from it.',
    'A warning in the host’s system log when it has.'
  ),
  labTimer(
    ['coder', 'coder-postgres-backup.timer', 'Coder database backup', 'OnCalendar=*-*-* 03:30:00'],
    'Dumps Coder’s PostgreSQL database, keeping seven days on the host, and uploads the dump to Azure Storage when backups are on.',
    'A dump file under /var/backups/coder.'
  ),
  labTimer(
    ['backups', 'hcw-vault-backup.timer', 'Vault snapshot', 'OnCalendar=*-*-* 03:45:00'],
    'Takes a snapshot of the lab’s Vault (its secret store), keeping seven days on the host, and uploads it to Azure Storage.',
    'A snapshot file under /var/backups/vault.'
  ),
  labTimer(
    [
      'labs_agent',
      'hcw-cert-expiry-check.timer',
      'Certificate expiry check',
      'OnCalendar=*-*-* 04:00:00',
    ],
    'Checks the lab agent’s and Vault’s certificates and warns when one expires soon.',
    'A warning in the host’s system log.'
  ),
  labTimer(
    ['hardening', 'hcw-reboot-when-idle.timer', 'Reboot when idle', 'OnCalendar=*-*-* 04:30:00'],
    'Reboots the host when an update asked for it, but only with nobody signed in and no job running; otherwise it asks again the next night.'
  ),
  labTimer(
    ['coder', 'hcw-coder-automation.timer', 'Coder automation', 'OnCalendar=*-*-* 05:45:00'],
    'Renews the site’s read-only Coder status token, deletes the old ones, renews its own credential and reports to the site.'
  ),
  labTimer(
    ['hardening', 'hcw-held-upgradable.timer', 'Held packages report', 'OnCalendar=*-*-* 07:15:00'],
    'Reports packages held back from upgrading, and a reboot that is still waiting.',
    'A line in the host’s system log.'
  ),

  // ── Claude ─────────────────────────────────────────────────────────────────
  {
    id: 'claude-daily-finish',
    group: 'claude',
    name: 'Daily: finish what the scheduled jobs left',
    code: 'Claude Code scheduled task',
    schedules: ['13 9 * * *'],
    does: 'A Claude Code session that picks up what the jobs above leave behind (a failed run, an update pull request that needs hand edits, an issue they opened), fixes, finishes and merges it under the repository’s rules, and reports to the owner. It lives in the owner’s Claude account, not in this repository.',
    leaves: 'A report to the owner, and merged fixes.',
    href: 'https://claude.ai/code',
  },
]);
