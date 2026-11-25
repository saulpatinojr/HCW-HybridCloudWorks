// Microsoft Azure Certifications — sourced from the official Certifications Poster and Microsoft Learn.
// Verified by hand against the Learn credentials browse API
// (https://learn.microsoft.com/api/contentbrowser/search/credentials) and the credential-retirement page
// (https://learn.microsoft.com/en-us/credentials/support/credential-retirement) on the date below.
// Last manual sync: 2026-11-23
//
// THE GITHUB EXAMS ARE NOT CARRIED HERE (#496, owner decision 2026-09-11).
// GH-100, GH-200, GH-300, GH-500, GH-600 and GH-900 used to sit in this file as
// well as src/data/github/certifications.js. /education renders every catalogue
// side by side and so showed GH-200 twice on one screen, Fundamentals under
// Azure and Associate under GitHub. Four of the six contradicted, not one:
// GH-100 and GH-500 are Professional in the GitHub catalogue, GH-200 and GH-300
// Associate; five of the six sat at Fundamentals here, which is a batch default
// rather than a verified rung.
//
// The GitHub catalogue won because this one cannot be made correct: LEVEL_META
// below has Fundamentals, Associate, Expert and Specialty, so Professional has
// no rung here at all and GH-100 and GH-500 could not be stated truthfully
// whatever was typed. The GitHub file was verified per exam against each Learn
// page three times (#461, twice under #469) and records which vendor pages are
// unreliable. Booking on Microsoft Learn is a real fact about these exams; it
// did not make a second copy of the rows worth keeping.
//
// So: GitHub exams belong to /github/education. Do not re-add them here.
//
// AZ-800 AND AZ-801 RE-READ 2026-10-01 (#770), the day after their last test
// day. Both exam pages now read "This exam was retired on September 30, 2026.
// You will no longer be able to earn or renew this certification after this
// date." (on 2026-09-29 they said "These exams will retire on September 30,
// 2026, at 5:00 PM Central Standard Time"), so Microsoft retired them as
// announced, on the announced day:
//   https://learn.microsoft.com/en-us/credentials/certifications/exams/az-800/
//   https://learn.microsoft.com/en-us/credentials/certifications/exams/az-801/
// Both rows are now `retired` with `retiredDate` 2026-09-30. `expiryDate`
// 2026-09-30 stays on them, as on every other retired row in this file: the
// Azure badge and the detail page's notice print a retired row's date from
// `expiryDate`, and without it the detail page would say "Withdrawn by
// Microsoft", which is not what happened. `replacedBy: 'az-802'` stays because
// the replacement is live: the AZ-802 exam page has a "Schedule exam" section,
// English, "Retirement date: none", and the credential page both rows point at
// now lists "Required exams: AZ-802":
//   https://learn.microsoft.com/en-us/credentials/certifications/exams/az-802/
//   https://learn.microsoft.com/en-us/credentials/certifications/windows-server-hybrid-administrator/
// Only these rows were re-read, so `DATA_AS_OF` and the sync line above are
// deliberately unchanged.

/**
 * The day this file was last checked against Microsoft. The Azure education
 * pages render it where they used to claim a weekly refresh, and statuses are
 * derived from the dates at render time (src/lib/certStatus.js) so a date that
 * passes between syncs cannot keep showing "Expiring" or "Beta".
 */
//
// FULL RE-READ 2026-10-05 (owner request: "review and update all Learn portals
// … as new tests are in beta/expired"). Every row was checked against its
// Microsoft Learn credential page (a retirement shows there as a top Warning
// block; "Schedule exam" confirmed through the Pearson VUE examUid link), the
// credential-retirement page, the credentials browse API and the Skills Hub
// blog. Most single-exam /exams/<code>/ URLs now redirect to the credential
// page, so that page is the source where the exam page is gone. What moved:
//
//   AI-500 — `active`. The exam page H1 is now "Exam AI-500: Designing and
//     Implementing Multi-Agent AI Solutions" with no "(beta)" (AB-650's still
//     carries it), the credential H1 "Microsoft Certified: Multi-Agent AI
//     Solutions Expert" likewise, "Retirement date: none", Schedule exam
//     present; the page's updated_at is 2026-09-29. Microsoft announced "Beta
//     in July 2026. Generally available in September 2026." and published no
//     day, so no `gaDate` is stored.
//     https://learn.microsoft.com/en-us/credentials/certifications/exams/ai-500/
//   PL-400 — `expiring`, `expiryDate` 2026-10-30, `replacedBy: 'ab-400'`. The
//     exam page: "PL-400 is transitioning to AB-400 … October 16, 2026:
//     Registration for PL-400 closes, and registration opens exclusively for
//     AB-400." and "Learners who register for PL-400 on or before October 16
//     can continue to schedule and take the exam through October 30, 2026."
//     The Skills Hub post of 2026-09-15: "While the exam number is changing,
//     the certification earned remains unchanged." So the credential (Power
//     Platform Developer Associate) continues under the new code.
//     https://learn.microsoft.com/en-us/credentials/certifications/exams/pl-400/
//     https://techcommunity.microsoft.com/blog/skills-hub-blog/updates-to-azure-cosmos-db-and-power-platform-developer-certifications/4528353
//   AB-400 — added, `upcoming` with `availableDate` 2026-10-16: "The updated
//     AB-400 exam will be available beginning October 16, 2026, and
//     registration is available today." Not a beta. English, "Retirement
//     date: none". The row turns `active` on the day by itself.
//     https://learn.microsoft.com/en-us/credentials/certifications/exams/ab-400/
//   MS-102 — `replacedBy: 'ab-650'`: the June 2026 credentials roundup names
//     "Microsoft 365 Certified: AI Services Administrator Associate (Exam
//     AB-650)" as the recommended new certification. Status and date agree:
//     "This exam will retire on November 30, 2026, at 11:59 PM Central
//     Standard Time."
//   DP-420 — nothing stored changes today. The credential page: "The updated
//     certification will be Microsoft Certified: Azure Cosmos DB AI Developer
//     Associate. This change will go into effect on October 6, 2026." and
//     "Updated exam available: October 6, 2026". The row's `level` Associate
//     is one day early; the title and slug follow on or after 2026-10-06 —
//     re-check that /azure-cosmos-db-developer-specialty/ still resolves then
//     (200 today). A timeline entry dated 2026-10-06 records it.
//   MB-330 — nothing stored changes. The June roundup: retirement "Expected in
//     December 2026", successor "Supply Chain Management AI Consultant
//     Associate (Exam AB-330)", "Beta expected in November 2026". Months only,
//     no page for AB-330 yet (404), so no date and no row — re-check in
//     November. The `longDescription` says so.
//   AB-650 — still `beta` ("Exam AB-650: Administering Microsoft 365 and AI
//     Services (beta)"). Microsoft said "Generally available in October 2026"
//     and the row has no `betaEndDate`, so the label will not flip on its own:
//     re-read before the next sync.
//   Retired rows gain the successor the June roundup names: AZ-204 → AI-200,
//     AZ-500 → SC-500, PL-200 → AB-410, MB-280 → AB-210.
//   learnUrl — twelve rows pointed at Learn slugs that now 404 (AB-900,
//     AZ-700, MB-230, MB-280, MB-310, MB-330, MB-500, MB-700, MB-800, MB-820,
//     MS-700, MS-721) and ten AB/AI/DP rows at the bare browse root; every one
//     now carries the live credential page, each fetched 200 on the day. The
//     site's own slugs are unchanged — a slug is our route, not Microsoft's.
//
// Nothing on the retirement page dated 2026-09-01..2027-06-30 is missing: the
// only scheduled item is MS-102. The GA days Microsoft published for AB-210,
// AB-410, AB-620 and AB-250 are months, not days; their stored `gaDate`s are
// earlier than the stored `betaEndDate`s and are left as they were because an
// `active` row reads neither. All 62 rows were re-read, so `DATA_AS_OF` moves.
//
// RE-READ 2026-10-12 of AB-400 and PL-400, the two rows #1091 named, stored
// ahead of their days under rule 2 of `deriveStatus` (src/lib/certStatus.js)
// with `statusReadDate` 2026-10-12: each badge keeps its current status until
// the vendor's day, so the alarm in education-catalogues.test.js has nothing
// to fire on.
//   AB-400 — `active`, `availableDate` 2026-10-16 kept; shows "Coming" until
//     then. Exam page, unchanged since 2026-10-05: "The updated AB-400 exam
//     will be available beginning October 16, 2026, and registration is
//     available today." The study guide's H1 is still "Exam AB-400: Extending
//     Microsoft Power Platform Solutions with Code and AI".
//     https://learn.microsoft.com/en-us/credentials/certifications/exams/ab-400/
//     https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-400
//   PL-400 — `retired`, `expiryDate` 2026-10-30 kept; shows "Retiring" through
//     then. Exam page, unchanged: "Learners who register for PL-400 on or
//     before October 16 can continue to schedule and take the exam through
//     October 30, 2026."
//     https://learn.microsoft.com/en-us/credentials/certifications/exams/pl-400/
// Only these rows were re-read, so `DATA_AS_OF` and the sync line above are
// deliberately unchanged.
//
// RE-READ 2026-11-23 of MS-102, the Azure row #1737 named (due to fire on
// 2026-12-01), stored ahead of its day the same way, with `statusReadDate`
// 2026-11-23.
//   MS-102 — `retired`, `expiryDate` 2026-11-30 kept; shows "Retiring" through
//     then. Exam page (updated_at 2026-10-30), the date unchanged: "This exam
//     will retire on November 30, 2026, at 11:59 PM Central Standard Time."
//     The same page's "Schedule exam" box still prints "Retirement date:
//     none" and still offers booking; the warning at the top is the dated
//     statement, so the stored date follows it.
//     https://learn.microsoft.com/en-us/credentials/certifications/exams/ms-102/
// Only this row was re-read, so `DATA_AS_OF` is unchanged.

export const DATA_AS_OF = '2026-11-23';

/**
 * The page a reader can check this catalogue's freshness claim against.
 *
 * Every other catalogue has exported one since #461; this file did not, and
 * `education-catalogues.test.js` asserted it for the other seven only, so the
 * omission never failed a build. `EducationIndexPage` carried a documented
 * `??` fallback to this same URL so the freshness line would still name a
 * vendor — that fallback is gone with #496, and this export is what it stood
 * in for.
 *
 * The browse page rather than the `contentbrowser/search/credentials` API the
 * header names: both are Microsoft, but only one of them is a page a reader
 * can open and read.
 */
export const DATA_SOURCE = {
  label: 'Microsoft Learn credentials',
  url: 'https://learn.microsoft.com/en-us/credentials/browse/?credential_types=certification',
};

export const LEVEL_META = {
  Fundamentals: {
    badge: 'bg-sky-500/20 border-sky-500/40 text-sky-300',
    accent: 'border-l-sky-500',
    accentFull: 'from-sky-900/30',
    dot: 'bg-sky-500',
    glow: 'rgba(14,165,233,0.15)',
    label: 'Fundamentals',
  },
  Associate: {
    badge: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
    accent: 'border-l-emerald-500',
    accentFull: 'from-emerald-900/30',
    dot: 'bg-emerald-500',
    glow: 'rgba(16,185,129,0.15)',
    label: 'Associate',
  },
  Expert: {
    badge: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
    accent: 'border-l-violet-500',
    accentFull: 'from-violet-900/30',
    dot: 'bg-violet-500',
    glow: 'rgba(139,92,246,0.15)',
    label: 'Expert',
  },
  Specialty: {
    badge: 'bg-amber-500/20 border-amber-500/40 text-amber-300',
    accent: 'border-l-amber-500',
    accentFull: 'from-amber-900/30',
    dot: 'bg-amber-500',
    glow: 'rgba(245,158,11,0.15)',
    label: 'Specialty',
  },
};

// The certification and applied-skill rows live in generated/certifications.js,
// which scripts/update-applied-skills.mjs rewrites from Microsoft Learn each
// week (#1845 moved them there). They are re-exported here so every import of
// this file is unchanged. DATA_AS_OF above stays in this file, and the script
// stamps it on every run.
export { certifications, appliedSkills } from './generated/certifications.js';

// Timeline events — hand-maintained. The three entries added on 2026-09-09 (mb-240-retire,
// az-800-az-801-retire, ms-102-retire) and the two added on 2026-10-05 (dp-420-rename,
// pl-400-ab-400) cite the Microsoft Learn pages they were verified against; every earlier entry keeps its original Skills Hub blog sourceUrl and was not
// re-verified. This array is NOT written by the Friday Skills Hub RSS scraper
// (functions/src/lib/timers/skills-hub.js). That timer writes the certEvents container, which
// the Azure education page reads through GET /api/public/cert-events and merges over these
// entries by id at render time (src/lib/certEvents.js, #461 item 4). These stay as the
// fallback when that list is empty or unreachable, and are what the pre-rendered HTML carries.
export const timelineEvents = [
  {
    id: 'ai-103-beta',
    date: '2026-04-16',
    type: 'beta_launch',
    certCode: 'AI-103',
    title: 'AI-103 Beta Exam Live',
    description:
      'Azure AI Apps and Agents Developer Associate beta launched. First 300 get 80% off — Code: AI103Claxton. Beta closes May 7, 2026.',
    sourceUrl: 'https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog',
  },
  {
    id: 'ai-901-beta',
    date: '2026-04-16',
    type: 'beta_launch',
    certCode: 'AI-901',
    title: 'AI-901 Beta Exam Live',
    description:
      'Refreshed Azure AI Fundamentals exam (AI-901) replaces AI-900. Beta closes May 6, 2026. Code: AI901Medford for 80% off.',
    sourceUrl: 'https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog',
  },
  {
    id: 'ai-900-retire',
    date: '2026-06-30',
    type: 'retirement',
    certCode: 'AI-900',
    title: 'AI-900 Retires',
    description: 'Azure AI Fundamentals (AI-900) exam retires. Replaced by AI-901.',
    sourceUrl: 'https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog',
  },
  {
    id: 'ai-102-retire',
    date: '2026-06-30',
    type: 'retirement',
    certCode: 'AI-102',
    title: 'AI-102 Retires',
    description: 'Azure AI Engineer Associate (AI-102) retires. Replaced by AI-103.',
    sourceUrl: 'https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog',
  },
  {
    id: 'ai-103-ga',
    date: '2026-06-01',
    type: 'ga_launch',
    certCode: 'AI-103',
    title: 'AI-103 Goes Live',
    description:
      'Azure AI Apps and Agents Developer Associate exits beta and becomes generally available.',
    sourceUrl: 'https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog',
  },
  {
    id: 'ai-901-ga',
    date: '2026-06-01',
    type: 'ga_launch',
    certCode: 'AI-901',
    title: 'AI-901 Goes Live',
    description:
      'Refreshed Azure AI Fundamentals (AI-901) exits beta and becomes generally available.',
    sourceUrl: 'https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog',
  },
  {
    id: 'ab-620-beta',
    date: '2026-04-01',
    type: 'beta_launch',
    certCode: 'AB-620',
    title: 'AB-620 Beta Exam Live',
    description: 'AI Agent Builder Associate (AB-620) enters beta. GA expected June 2026.',
    sourceUrl: 'https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog',
  },
  {
    id: 'ab-410-beta',
    date: '2026-04-01',
    type: 'beta_launch',
    certCode: 'AB-410',
    title: 'AB-410 Beta Exam Live',
    description:
      'Intelligent Applications Builder Associate (AB-410) enters beta. GA expected June 2026.',
    sourceUrl: 'https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog',
  },
  {
    id: 'az-204-retire',
    date: '2026-07-31',
    type: 'retirement',
    certCode: 'AZ-204',
    title: 'AZ-204 Retires',
    description: 'Developing Solutions for Microsoft Azure (AZ-204) retires July 31, 2026.',
    sourceUrl: 'https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog',
  },
  {
    id: 'az-500-retire',
    date: '2026-08-31',
    type: 'retirement',
    certCode: 'AZ-500',
    title: 'AZ-500 Retires',
    description: 'Azure Security Engineer Associate (AZ-500) retires August 31, 2026.',
    sourceUrl: 'https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog',
  },
  {
    id: 'mb-240-retire',
    date: '2026-06-30',
    type: 'retirement',
    certCode: 'MB-240',
    title: 'MB-240 Retires',
    description:
      'Dynamics 365 Field Service Functional Consultant Associate retires with no direct replacement.',
    sourceUrl: 'https://learn.microsoft.com/en-us/credentials/support/credential-retirement',
  },
  {
    id: 'az-800-az-801-retire',
    date: '2026-09-30',
    type: 'retirement',
    certCode: 'AZ-800',
    title: 'AZ-800 & AZ-801 Retire',
    description:
      'Both Windows Server Hybrid Administrator exams retire at 5:00 PM Central. Replaced by the single exam AZ-802.',
    sourceUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/exams/az-800/',
  },
  {
    id: 'ms-102-retire',
    date: '2026-11-30',
    type: 'retirement',
    certCode: 'MS-102',
    title: 'MS-102 Retires',
    description:
      'Microsoft 365 Certified: Administrator Expert and exam MS-102 retire; the certification can no longer be earned or renewed after this date.',
    sourceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/m365-administrator-expert/',
  },
  {
    id: 'dp-420-rename',
    date: '2026-10-06',
    type: 'update',
    certCode: 'DP-420',
    title: 'DP-420 Becomes Azure Cosmos DB AI Developer Associate',
    description:
      'The certification is renamed Microsoft Certified: Azure Cosmos DB AI Developer Associate (from Azure Cosmos DB Developer Specialty) and the exam is updated the same day. No action is required of current holders.',
    sourceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-cosmos-db-developer-specialty/',
  },
  {
    id: 'pl-400-ab-400',
    date: '2026-10-16',
    type: 'update',
    certCode: 'PL-400',
    title: 'PL-400 Becomes AB-400',
    description:
      'Registration for PL-400 closes and opens exclusively for AB-400; PL-400 registrations made by this day can be taken through October 30, 2026. The Power Platform Developer Associate certification is unchanged.',
    sourceUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/exams/pl-400/',
  },
];
