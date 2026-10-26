// Microsoft Azure Certifications — sourced from the official Certifications Poster and Microsoft Learn.
// Verified by hand against the Learn credentials browse API
// (https://learn.microsoft.com/api/contentbrowser/search/credentials) and the credential-retirement page
// (https://learn.microsoft.com/en-us/credentials/support/credential-retirement) on the date below.
// Last manual sync: 2026-10-26
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

export const DATA_AS_OF = '2026-10-26';

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

// status: 'active' | 'beta' | 'expiring' | 'retired'
// Updated by scripts/update-applied-skills.mjs from Microsoft Learn API and the Certifications poster.
export const certifications = [
  {
    id: 'ab-100',
    slug: 'ab-100',
    code: 'AB-100',
    officialCode: 'AB-100',
    title: 'Agentic AI Business Solutions Architect',
    level: 'Expert',
    status: 'active',
    description: 'Architect AI agent solutions across Microsoft 365 Copilot and Power Platform.',
    longDescription:
      'Validate expertise designing enterprise-scale agentic AI solutions using Microsoft 365 Copilot, Copilot Studio, and Power Platform for business transformation.',
    topics: ['Agentic AI', 'Copilot Studio', 'M365 Copilot', 'Power Platform', 'AI Architecture'],
    hours: 60,
    prepTime: '~5 months',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/agentic-ai-business-solutions-architect/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-100',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ab-100',
    modules: [],
    appliedSkills: [],
    prerequisites: 'AI and Power Platform architecture experience.',
    nextCerts: [],
  },
  {
    id: 'ab-210',
    slug: 'ab-210',
    code: 'AB-210',
    officialCode: 'AB-210',
    title: 'Dynamics 365 Sales AI Consultant Associate',
    level: 'Associate',
    status: 'active',
    betaEndDate: '2026-06-30',
    gaDate: '2026-06-01',
    description: 'Configure AI-powered sales capabilities in Dynamics 365 Sales.',
    longDescription:
      'Certification covering AI-enhanced Dynamics 365 Sales features including Copilot for Sales, conversation intelligence, and predictive scoring.',
    topics: [
      'Dynamics 365 Sales',
      'Copilot for Sales',
      'AI Insights',
      'Conversation Intelligence',
      'Predictive Scoring',
    ],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-sales-ai-consultant-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-210',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ab-210',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Dynamics 365 Sales experience.',
    nextCerts: [],
  },
  {
    id: 'ab-250',
    slug: 'ab-250',
    code: 'AB-250',
    officialCode: 'AB-250',
    title: 'Dynamics 365 Contact Center AI Engineer Associate',
    level: 'Associate',
    status: 'active',
    betaEndDate: '2026-07-31',
    gaDate: '2026-08-01',
    description: 'Design and implement AI-powered contact center solutions with Dynamics 365.',
    longDescription:
      'Certification for engineers building AI contact center solutions using Dynamics 365 Contact Center with Copilot and Azure AI Services.',
    topics: ['Dynamics 365 Contact Center', 'Copilot', 'AI Routing', 'Omnichannel', 'Azure AI'],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-contact-center-ai-engineer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-250',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ab-250',
    modules: [],
    appliedSkills: [],
    prerequisites: 'MS-721 or contact center experience.',
    nextCerts: [],
  },
  {
    id: 'ab-400',
    slug: 'ab-400',
    code: 'AB-400',
    officialCode: 'AB-400',
    title: 'Extending Microsoft Power Platform Solutions with Code and AI',
    level: 'Associate',
    status: 'active',
    availableDate: '2026-10-16',
    statusReadDate: '2026-10-12',
    description:
      'The Power Platform Developer exam under its new number, from October 16, 2026: code-first Power Platform solutions with AI.',
    longDescription:
      'PL-400 becomes AB-400 on October 16, 2026. Registration for PL-400 closes that day and opens for AB-400 alone; anyone registered for PL-400 by then can still take it through October 30, 2026. The certification earned is unchanged — Microsoft Certified: Power Platform Developer Associate. Microsoft announced the renumbering on September 15, 2026; registration for AB-400 is open now.',
    topics: [
      'Custom Connectors',
      'PCF Controls',
      'Plugins',
      'Power Apps Component Framework',
      'Azure Integration',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/power-platform-developer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-400',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications',
    modules: [],
    appliedSkills: [],
    prerequisites: 'PL-200 or equivalent Power Platform experience; development experience.',
    nextCerts: ['ab-100'],
  },
  {
    id: 'ab-410',
    slug: 'ab-410',
    code: 'AB-410',
    officialCode: 'AB-410',
    title: 'Intelligent Applications Builder Associate',
    level: 'Associate',
    status: 'active',
    betaEndDate: '2026-05-30',
    gaDate: '2026-06-01',
    description: 'Build intelligent applications integrating AI into business workflows.',
    longDescription:
      'Covers building AI-integrated apps using Azure AI Services, Copilot extensibility, and Power Platform.',
    topics: [
      'Azure AI Services',
      'Copilot Extensibility',
      'Power Platform',
      'AI Integration',
      'Low-Code AI',
    ],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/intelligent-applications-builder-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-410',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ab-410',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Application development or Power Platform experience.',
    nextCerts: [],
  },
  {
    id: 'ab-620',
    slug: 'ab-620',
    code: 'AB-620',
    officialCode: 'AB-620',
    title: 'AI Agent Builder Associate',
    level: 'Associate',
    status: 'active',
    betaEndDate: '2026-05-30',
    gaDate: '2026-06-01',
    description: 'Build autonomous AI agents using Microsoft Copilot Studio and Azure AI.',
    longDescription:
      'A new certification for professionals who build AI agents using Microsoft Copilot Studio, Azure AI Foundry, and related tools.',
    topics: ['Copilot Studio', 'Azure AI Foundry', 'AI Agents', 'Power Platform', 'Connectors'],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/ai-agent-builder-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-620',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ab-620',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Power Platform or Azure AI experience recommended.',
    nextCerts: [],
  },
  {
    id: 'ab-650',
    slug: 'ab-650',
    code: 'AB-650',
    officialCode: 'AB-650',
    title: 'Administering Microsoft 365 and AI Services',
    level: 'Associate',
    status: 'beta',
    description:
      'Administer Microsoft 365 tenants, workloads, and AI services, including Microsoft 365 Copilot and agents.',
    longDescription:
      'Configure, manage, secure, and govern Microsoft 365 tenants, workloads, and AI services — Microsoft 365 Copilot, agents, and connected AI capabilities — at enterprise scale. Earns Microsoft 365 Certified: Microsoft 365 and AI Services Administrator Associate, in beta on Microsoft Learn.',
    topics: [
      'Microsoft 365 Tenants',
      'Governance & Security',
      'Microsoft 365 Copilot',
      'AI Services',
      'Microsoft Graph PowerShell',
    ],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/ai-services-administrator-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-650',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ab-650',
    modules: [],
    appliedSkills: [],
    prerequisites:
      'Microsoft 365 workloads and Microsoft Entra ID experience; familiarity with Defender XDR and Microsoft Graph PowerShell.',
    nextCerts: [],
  },
  {
    id: 'ab-730',
    slug: 'ab-730',
    code: 'AB-730',
    officialCode: 'AB-730',
    title: 'AI Business Professional',
    level: 'Fundamentals',
    status: 'active',
    description:
      'Foundational AI knowledge for business professionals leveraging Microsoft AI tools.',
    longDescription:
      'Validate foundational understanding of AI capabilities and how to apply Microsoft AI tools — Copilot, Azure AI, and Power Platform AI — to drive business outcomes.',
    topics: [
      'AI Concepts',
      'Microsoft Copilot',
      'AI Business Value',
      'Responsible AI',
      'Power Platform AI',
    ],
    hours: 8,
    prepTime: '~3 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/ai-business-professional/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-730',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ab-730',
    modules: [],
    appliedSkills: [],
    prerequisites: 'No prerequisites.',
    nextCerts: ['ab-731'],
  },
  {
    id: 'ab-731',
    slug: 'ab-731',
    code: 'AB-731',
    officialCode: 'AB-731',
    title: 'AI Transformation Leader',
    level: 'Associate',
    status: 'active',
    description: 'Lead AI transformation initiatives and drive adoption of Microsoft AI solutions.',
    longDescription:
      'Validate expertise leading AI adoption and transformation using Microsoft AI solutions — strategy, change management, governance, and measuring business impact.',
    topics: [
      'AI Strategy',
      'Change Management',
      'AI Governance',
      'Business Impact',
      'Responsible AI',
    ],
    hours: 20,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/ai-transformation-leader/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-731',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ab-731',
    modules: [],
    appliedSkills: [],
    prerequisites: 'AB-730 recommended. Leadership experience.',
    nextCerts: [],
  },
  {
    id: 'ab-900',
    slug: 'microsoft-365-copilot-and-agent-administration-fundamentals',
    code: 'AB-900',
    officialCode: 'AB-900',
    title: 'Microsoft Certified: Microsoft 365 Copilot and Agent Administration Fundamentals',
    level: 'Fundamentals',
    status: 'active',
    description:
      'Microsoft 365 Copilot and Agent Administration Fundamentals validates role-based Microsoft cloud skills.',
    longDescription:
      'Microsoft 365 Copilot and Agent Administration Fundamentals validates skills for Microsoft cloud and AI workloads using official Microsoft certification requirements.',
    topics: ['Microsoft 365 Copilot and Agent Administration Fundamentals'],
    hours: 10,
    prepTime: '~4 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/copilot-and-agent-administration-fundamentals/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-900',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ab-900',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Review the official Microsoft Learn certification page for prerequisites.',
    nextCerts: [],
  },
  {
    id: 'ai-102',
    slug: 'ai-102',
    code: 'AI-102',
    officialCode: 'AI-102',
    title: 'Designing and Implementing a Microsoft Azure AI Solution',
    level: 'Associate',
    status: 'retired',
    expiryDate: '2026-06-30',
    replacedBy: 'ai-103',
    description: 'Build AI solutions using Azure AI Services, AI Search, and Azure OpenAI.',
    longDescription:
      'Validate ability to build AI solutions on Azure. Retiring June 30, 2026 — replaced by AI-103 (Azure AI Apps and Agents Developer Associate).',
    topics: ['Azure AI Services', 'NLP', 'Computer Vision', 'Azure OpenAI', 'AI Search'],
    hours: 45,
    prepTime: '~3 months',
    successRate: '72%',
    learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/azure-ai-engineer/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ai-102',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ai-102',
    modules: [
      {
        title: 'Get started with Azure AI Services',
        url: 'https://learn.microsoft.com/en-us/training/modules/introduction-to-azure-ai/',
      },
      {
        title: 'Develop NLP solutions with Azure AI Language',
        url: 'https://learn.microsoft.com/en-us/training/modules/analyze-text-with-text-analytics-service/',
      },
      {
        title: 'Develop Generative AI Solutions with Azure OpenAI Service',
        url: 'https://learn.microsoft.com/en-us/training/modules/explore-azure-openai/',
      },
      {
        title: 'Implement knowledge mining with Azure AI Search',
        url: 'https://learn.microsoft.com/en-us/training/modules/introduction-to-azure-search/',
      },
    ],
    appliedSkills: [
      {
        code: 'APL-1006',
        title: 'Build a natural language processing solution with Azure AI Language',
        url: 'https://learn.microsoft.com/en-us/credentials/applied-skills/build-natural-language-solution-azure-ai/',
      },
      {
        code: 'APL-1007',
        title: 'Develop generative AI solutions with Azure OpenAI Service',
        url: 'https://learn.microsoft.com/en-us/credentials/applied-skills/develop-generative-ai-solutions-with-azure-openai-service/',
      },
    ],
    prerequisites: 'AI-900 recommended. Programming experience (C# or Python).',
    nextCerts: ['ai-103'],
  },
  {
    id: 'ai-103',
    slug: 'ai-103',
    code: 'AI-103',
    officialCode: 'AI-103',
    title: 'Azure AI Apps and Agents Developer Associate',
    level: 'Associate',
    status: 'active',
    betaEndDate: '2026-05-07',
    betaDiscount: '80% off first 300 — Code: AI103Claxton',
    gaDate: '2026-06-01',
    description: 'Design and build AI apps and agents using Azure AI and Azure OpenAI Service.',
    longDescription:
      'The next-generation Azure AI Developer certification — covers building AI apps and autonomous agents using Azure AI Services, Azure OpenAI, LangChain, Semantic Kernel, and Azure AI Foundry. Replaces AI-102.',
    topics: [
      'Azure AI Foundry',
      'Azure OpenAI',
      'AI Agents',
      'Semantic Kernel',
      'RAG Patterns',
      'Responsible AI',
    ],
    hours: 45,
    prepTime: '~3 months',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-ai-apps-and-agents-developer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ai-103',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ai-103',
    modules: [],
    appliedSkills: [
      {
        code: 'APL-1007',
        title: 'Develop generative AI solutions with Azure OpenAI Service',
        url: 'https://learn.microsoft.com/en-us/credentials/applied-skills/develop-generative-ai-solutions-with-azure-openai-service/',
      },
    ],
    prerequisites: 'Programming experience. AI-901 or AI-900 recommended.',
    nextCerts: [],
  },
  {
    id: 'ai-200',
    slug: 'azure-ai-cloud-developer-associate',
    code: 'AI-200',
    officialCode: 'AI-200',
    title: 'Microsoft Certified: Azure AI Cloud Developer Associate',
    level: 'Associate',
    status: 'active',
    description: 'Azure AI Cloud Developer Associate validates role-based Microsoft cloud skills.',
    longDescription:
      'Azure AI Cloud Developer Associate validates skills for Microsoft cloud and AI workloads using official Microsoft certification requirements.',
    topics: ['Application development', 'Artificial intelligence'],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-ai-cloud-developer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ai-200',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ai-200',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Review the official Microsoft Learn certification page for prerequisites.',
    nextCerts: [],
  },
  {
    id: 'ai-300',
    slug: 'ai-300',
    code: 'AI-300',
    officialCode: 'AI-300',
    title: 'Machine Learning Operations (MLOps) Engineer Associate',
    level: 'Associate',
    status: 'active',
    betaEndDate: '2026-06-30',
    gaDate: '2026-07-01',
    description: 'Design and implement MLOps pipelines for machine learning models on Azure.',
    longDescription:
      'Certification validating expertise implementing MLOps practices including model training, deployment, monitoring, and governance using Azure ML and Databricks.',
    topics: ['MLOps', 'Azure ML', 'Model Monitoring', 'Responsible AI', 'CI/CD for ML'],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/operationalizing-machine-learning-and-generative-ai-solutions/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ai-300',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ai-300',
    modules: [],
    appliedSkills: [],
    prerequisites: 'DP-100 or ML engineering experience.',
    nextCerts: [],
  },
  {
    id: 'ai-500',
    slug: 'ai-500',
    code: 'AI-500',
    officialCode: 'AI-500',
    title: 'Designing and Implementing Multi-Agent AI Solutions',
    level: 'Expert',
    status: 'active',
    description:
      'Design, build, and operate production-ready multi-agent AI solutions with Microsoft Foundry and Azure.',
    longDescription:
      'Expert-level exam for practitioners who architect, develop, evaluate, secure, and deploy scalable multi-agent AI systems using Microsoft Foundry, Microsoft Agent Framework, MCP, and Azure services. Earns Microsoft Certified: Multi-Agent AI Solutions Expert; out of beta and generally available on Microsoft Learn since September 2026.',
    topics: [
      'Multi-Agent Architecture',
      'Microsoft Foundry',
      'Agent Framework',
      'MCP',
      'Evaluation & Monitoring',
      'Governance',
    ],
    hours: 60,
    prepTime: '~10 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/multi-agent-ai-solutions-expert/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ai-500',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ai-500',
    modules: [],
    appliedSkills: [],
    prerequisites:
      'AI and ML development experience, agentic systems in production, Python, and Azure compute, network, storage, and data services.',
    nextCerts: [],
  },
  {
    id: 'ai-900',
    slug: 'ai-900',
    code: 'AI-900',
    officialCode: 'AI-900',
    title: 'Microsoft Azure AI Fundamentals',
    level: 'Fundamentals',
    status: 'retired',
    expiryDate: '2026-06-30',
    replacedBy: 'ai-901',
    description: 'Core concepts of AI and machine learning on Azure.',
    longDescription:
      'Validate foundational AI and ML knowledge on Azure. Retiring June 30, 2026 — replaced by AI-901 which covers generative AI and the latest Azure AI capabilities.',
    topics: ['AI Workloads', 'ML Principles', 'Computer Vision', 'NLP'],
    hours: 12,
    prepTime: '~4 weeks',
    successRate: '80%',
    learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/azure-ai-fundamentals/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ai-900',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ai-900',
    modules: [
      {
        title: 'Get started with AI on Azure',
        url: 'https://learn.microsoft.com/en-us/training/modules/get-started-ai-fundamentals/',
      },
      {
        title: 'Explore visual tools for ML',
        url: 'https://learn.microsoft.com/en-us/training/modules/create-classification-model-azure-machine-learning-designer/',
      },
      {
        title: 'Explore computer vision in Microsoft Azure',
        url: 'https://learn.microsoft.com/en-us/training/modules/analyze-images-computer-vision/',
      },
      {
        title: 'Explore natural language processing',
        url: 'https://learn.microsoft.com/en-us/training/modules/analyze-text-with-text-analytics-service/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'No prerequisites. AZ-900 recommended.',
    nextCerts: ['ai-103', 'ai-901'],
  },
  {
    id: 'ai-901',
    slug: 'ai-901',
    code: 'AI-901',
    officialCode: 'AI-901',
    title: 'Microsoft Azure AI Fundamentals (New)',
    level: 'Fundamentals',
    status: 'active',
    betaEndDate: '2026-05-06',
    betaDiscount: '80% off first 300 — Code: AI901Medford',
    gaDate: '2026-06-01',
    description:
      'Refreshed AI fundamentals exam covering generative AI and latest Azure AI services.',
    longDescription:
      'The refreshed AI Fundamentals certification replaces AI-900 and covers generative AI concepts, Azure OpenAI Service, and the latest Microsoft AI tools.',
    topics: ['Generative AI', 'Azure OpenAI', 'AI Workloads', 'ML Principles', 'Responsible AI'],
    hours: 12,
    prepTime: '~4 weeks',
    successRate: null,
    learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/azure-ai-fundamentals/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ai-901',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ai-901',
    modules: [],
    appliedSkills: [],
    prerequisites: 'No prerequisites.',
    nextCerts: ['ai-103'],
  },
  {
    id: 'az-104',
    slug: 'az-104',
    code: 'AZ-104',
    officialCode: 'AZ-104',
    title: 'Microsoft Azure Administrator',
    level: 'Associate',
    status: 'active',
    description: 'Manage Azure subscriptions, resources, and cloud infrastructure.',
    longDescription:
      'Master the essential skills needed to manage cloud services on Microsoft Azure — compute, networking, storage, security, and monitoring.',
    topics: ['Identity & Governance', 'Compute', 'Networking', 'Storage', 'Monitoring & Backup'],
    hours: 45,
    prepTime: '~3 months',
    successRate: '78%',
    learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/azure-administrator/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-104',
    modules: [
      {
        title: 'Manage Azure identities and governance',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-active-directory/',
      },
      {
        title: 'Implement and manage storage',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-storage-fundamentals/',
      },
      {
        title: 'Deploy and manage Azure compute resources',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-compute-fundamentals/',
      },
      {
        title: 'Implement and manage virtual networking',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-networking-fundamentals/',
      },
      {
        title: 'Monitor and maintain Azure resources',
        url: 'https://learn.microsoft.com/en-us/training/modules/intro-to-azure-monitor/',
      },
    ],
    appliedSkills: [
      {
        code: 'APL-1002',
        title: 'Deploy and configure Azure Monitor',
        url: 'https://learn.microsoft.com/en-us/credentials/applied-skills/deploy-and-configure-azure-monitor/',
      },
      {
        code: 'APL-1003',
        title: 'Secure storage for Azure Files and Azure Blob Storage',
        url: 'https://learn.microsoft.com/en-us/credentials/applied-skills/secure-storage-azure-files-azure-blob-storage/',
      },
    ],
    prerequisites: 'AZ-900 recommended. 6+ months Azure experience.',
    nextCerts: ['az-305', 'az-700', 'az-802'],
  },
  {
    id: 'az-120',
    slug: 'az-120',
    code: 'AZ-120',
    officialCode: 'AZ-120',
    title: 'Planning and Administering Microsoft Azure for SAP Workloads',
    level: 'Specialty',
    status: 'active',
    description: 'Architect and administer SAP solutions on Microsoft Azure.',
    longDescription:
      'Validate expertise planning, migrating, and administering SAP on Azure — infrastructure, SAP HANA, high availability, and disaster recovery.',
    topics: [
      'SAP on Azure',
      'Migration Planning',
      'Compute & Storage',
      'SAP HANA',
      'High Availability',
    ],
    hours: 50,
    prepTime: '~4 months',
    successRate: '68%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-for-sap-workloads-specialty/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-120',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-120',
    modules: [
      {
        title: 'Planning for SAP Workloads on Microsoft Azure',
        url: 'https://learn.microsoft.com/en-us/training/paths/plan-sap-workloads/',
      },
      {
        title: 'Migrating SAP Workloads to Azure',
        url: 'https://learn.microsoft.com/en-us/training/paths/migrate-sap-workloads-azure/',
      },
      {
        title: 'Administering SAP Workloads on Azure',
        url: 'https://learn.microsoft.com/en-us/training/paths/administer-sap-workloads-azure/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'AZ-104 and SAP HANA or SAP NetWeaver experience.',
    nextCerts: [],
  },
  {
    id: 'az-140',
    slug: 'az-140',
    code: 'AZ-140',
    officialCode: 'AZ-140',
    title: 'Configuring and Operating Azure Virtual Desktop',
    level: 'Associate',
    status: 'active',
    description: 'Plan, deliver, and manage virtual desktop experiences on Azure.',
    longDescription:
      'Validate your skills in planning, delivering, managing, and monitoring Azure Virtual Desktop environments and remote apps.',
    topics: ['AVD Architecture', 'Networking', 'Storage', 'Access Management', 'Monitoring'],
    hours: 35,
    prepTime: '~3 months',
    successRate: '72%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-virtual-desktop-specialty/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-140',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-140',
    modules: [
      {
        title: 'Plan an Azure Virtual Desktop implementation',
        url: 'https://learn.microsoft.com/en-us/training/modules/plan-azure-virtual-desktop-implementation/',
      },
      {
        title: 'Implement an AVD infrastructure',
        url: 'https://learn.microsoft.com/en-us/training/modules/implement-manage-networking-azure-virtual-desktop/',
      },
      {
        title: 'Manage access and security',
        url: 'https://learn.microsoft.com/en-us/training/modules/manage-access-azure-virtual-desktop/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'AZ-104 or equivalent. Azure networking and virtualization experience.',
    nextCerts: ['az-305'],
  },
  {
    id: 'az-204',
    slug: 'az-204',
    code: 'AZ-204',
    officialCode: 'AZ-204',
    title: 'Developing Solutions for Microsoft Azure',
    level: 'Associate',
    status: 'retired',
    expiryDate: '2026-07-31',
    replacedBy: 'azure-ai-cloud-developer-associate',
    description: 'Design, build, test, and maintain cloud solutions on Azure.',
    longDescription:
      'Validate your ability to design and build cloud-native solutions on Azure. Retiring July 31, 2026 — check Microsoft Learn for successor exams.',
    topics: ['Compute Solutions', 'Azure Storage', 'Security', 'API Management', 'Event-Based'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '74%',
    learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/azure-developer/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-204',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-204',
    modules: [
      {
        title: 'Implement Azure App Service web apps',
        url: 'https://learn.microsoft.com/en-us/training/modules/host-a-web-app-with-azure-app-service/',
      },
      {
        title: 'Implement containerized solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/intro-to-containers/',
      },
      {
        title: 'Implement Azure security',
        url: 'https://learn.microsoft.com/en-us/training/modules/intro-to-azure-key-vault/',
      },
      {
        title: 'Connect to and consume Azure services',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-event-grid/',
      },
    ],
    appliedSkills: [],
    prerequisites: '1+ year professional development experience.',
    nextCerts: ['az-305', 'az-400'],
  },
  {
    id: 'az-305',
    slug: 'az-305',
    code: 'AZ-305',
    officialCode: 'AZ-305',
    title: 'Microsoft Azure Solutions Architect Expert',
    level: 'Expert',
    status: 'active',
    description: 'Design comprehensive Azure solutions and enterprise-scale architecture.',
    longDescription:
      'Validate advanced expertise designing cloud and hybrid solutions on Azure — identity, governance, compute, storage, and networking at enterprise scale.',
    topics: [
      'Identity & Governance',
      'Compute Architecture',
      'Storage Design',
      'Network Design',
      'Migration',
    ],
    hours: 60,
    prepTime: '~6 months',
    successRate: '71%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-solutions-architect/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-305',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-305',
    modules: [
      {
        title: 'Design identity, governance, and monitoring solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/design-identity-governance-monitor-solutions/',
      },
      {
        title: 'Design data storage solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/design-data-storage-solution-for-non-relational-data/',
      },
      {
        title: 'Design business continuity solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/design-solution-for-backup-disaster-recovery/',
      },
      {
        title: 'Design infrastructure solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/design-compute-solution/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'AZ-104 required. AZ-204 recommended. Advanced Azure experience.',
    nextCerts: [],
  },
  {
    id: 'az-400',
    slug: 'az-400',
    code: 'AZ-400',
    officialCode: 'AZ-400',
    title: 'Azure DevOps Engineer Expert',
    level: 'Expert',
    status: 'active',
    description: 'Implement CI/CD pipelines and combine DevOps practices on Azure.',
    longDescription:
      'Validate advanced expertise combining people, processes, and technology to continuously deliver valuable products — covering CI/CD, IaC, monitoring, and security integration.',
    topics: [
      'CI/CD Pipelines',
      'Infrastructure as Code',
      'Security Integration',
      'Monitoring',
      'Automation',
    ],
    hours: 65,
    prepTime: '~6 months',
    successRate: '69%',
    learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/devops-engineer/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-400',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-400',
    modules: [
      {
        title: 'Get started on a DevOps transformation journey',
        url: 'https://learn.microsoft.com/en-us/training/paths/az-400-get-started-devops-transformation-journey/',
      },
      {
        title: 'Implement CI with Azure Pipelines and GitHub Actions',
        url: 'https://learn.microsoft.com/en-us/training/paths/az-400-implement-ci-azure-pipelines-github-actions/',
      },
      {
        title: 'Design and implement a release strategy',
        url: 'https://learn.microsoft.com/en-us/training/paths/az-400-design-implement-release-strategy/',
      },
      {
        title: 'Implement security and validate code bases for compliance',
        url: 'https://learn.microsoft.com/en-us/training/paths/az-400-implement-security-validate-code-bases-compliance/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'AZ-104 or AZ-204 required. DevOps experience highly recommended.',
    nextCerts: [],
  },
  {
    id: 'az-500',
    slug: 'az-500',
    code: 'AZ-500',
    officialCode: 'AZ-500',
    title: 'Microsoft Azure Security Engineer',
    level: 'Associate',
    status: 'retired',
    expiryDate: '2026-08-31',
    replacedBy: 'cloud-and-ai-security-engineer-associate',
    description: 'Implement and manage security across Azure workloads.',
    longDescription:
      'Validate ability to implement security controls across Azure infrastructure. Retiring August 31, 2026 — check Microsoft Learn for the successor exam.',
    topics: ['Identity & Access', 'Platform Protection', 'Data & App Security', 'Security Ops'],
    hours: 50,
    prepTime: '~4 months',
    successRate: '75%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-security-engineer/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-500',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-500',
    modules: [
      {
        title: 'Manage identity and access',
        url: 'https://learn.microsoft.com/en-us/training/modules/secure-azure-active-directory/',
      },
      {
        title: 'Secure networking',
        url: 'https://learn.microsoft.com/en-us/training/modules/secure-and-isolate-with-nsg-and-service-endpoints/',
      },
      {
        title: 'Secure compute, storage, and databases',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-well-architected-security/',
      },
      {
        title: 'Manage security operations',
        url: 'https://learn.microsoft.com/en-us/training/modules/intro-to-azure-defender/',
      },
    ],
    appliedSkills: [
      {
        code: 'APL-1005',
        title: 'Configure SIEM security operations using Microsoft Sentinel',
        url: 'https://learn.microsoft.com/en-us/credentials/applied-skills/configure-siem-security-operations-using-microsoft-sentinel/',
      },
    ],
    prerequisites: 'AZ-104 or equivalent. Networking and virtualization knowledge.',
    nextCerts: ['az-305'],
  },
  {
    id: 'az-700',
    slug: 'az-700',
    code: 'AZ-700',
    officialCode: 'AZ-700',
    title: 'Designing and Implementing Azure Networking Solutions',
    level: 'Associate',
    status: 'active',
    description: 'Design and implement core Azure networking infrastructure.',
    longDescription:
      'Validate skills in designing and implementing Azure networking — virtual networks, load balancing, routing, hybrid connectivity, and network security.',
    topics: ['Hybrid Connectivity', 'Routing', 'Load Balancing', 'Azure DNS', 'Private Access'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '73%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-network-engineer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-700',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-700',
    modules: [
      {
        title: 'Design and implement Azure VNets',
        url: 'https://learn.microsoft.com/en-us/training/modules/introduction-to-azure-virtual-networks/',
      },
      {
        title: 'Design and implement hybrid networking',
        url: 'https://learn.microsoft.com/en-us/training/modules/design-implement-hybrid-networking/',
      },
      {
        title: 'Design and implement Azure ExpressRoute',
        url: 'https://learn.microsoft.com/en-us/training/modules/design-implement-azure-expressroute/',
      },
      {
        title: 'Load balancing in Azure',
        url: 'https://learn.microsoft.com/en-us/training/modules/load-balancing-https-traffic-azure/',
      },
    ],
    appliedSkills: [
      {
        code: 'APL-1001',
        title: 'Configure secure access to your workloads using Azure networking',
        url: 'https://learn.microsoft.com/en-us/credentials/applied-skills/configure-secure-workloads-use-azure-virtual-networking/',
      },
    ],
    prerequisites: 'AZ-104 or equivalent networking knowledge.',
    nextCerts: ['az-305'],
  },
  {
    id: 'az-800',
    slug: 'az-800',
    code: 'AZ-800',
    officialCode: 'AZ-800',
    title: 'Administering Windows Server Hybrid Core Infrastructure',
    level: 'Associate',
    status: 'retired',
    retiredDate: '2026-09-30',
    expiryDate: '2026-09-30',
    replacedBy: 'az-802',
    description: 'Administer Windows Server in on-premises, hybrid, and IaaS workloads.',
    longDescription:
      'Validate your ability to configure and manage Windows Server on-premises, hybrid, and IaaS platform workloads including AD DS, identity, storage, and compute. Microsoft retired this exam on September 30, 2026; AZ-802 replaces it.',
    topics: ['Active Directory', 'Windows Server', 'Hybrid Identity', 'Storage', 'Virtualization'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '71%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/windows-server-hybrid-administrator/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-800',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-800',
    modules: [
      {
        title: 'Deploy and manage AD DS in on-premises and cloud environments',
        url: 'https://learn.microsoft.com/en-us/training/modules/deploy-manage-active-directory-domain-services/',
      },
      {
        title: 'Manage Windows Servers in a hybrid environment',
        url: 'https://learn.microsoft.com/en-us/training/modules/deploy-azure-arc-enabled-servers/',
      },
      {
        title: 'Manage virtual machines and containers',
        url: 'https://learn.microsoft.com/en-us/training/modules/hyper-v-replica/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'Windows Server and Active Directory experience.',
    nextCerts: ['az-305'],
  },
  {
    id: 'az-801',
    slug: 'windows-server-hybrid-administrator',
    code: 'AZ-801',
    officialCode: 'AZ-801',
    title: 'Microsoft Certified: Windows Server Hybrid Administrator Associate',
    level: 'Associate',
    status: 'retired',
    retiredDate: '2026-09-30',
    expiryDate: '2026-09-30',
    replacedBy: 'az-802',
    description:
      'Windows Server Hybrid Administrator Associate validates role-based Microsoft cloud skills.',
    longDescription:
      'Windows Server Hybrid Administrator Associate validates skills for Microsoft cloud and AI workloads using official Microsoft certification requirements. Microsoft retired this exam on September 30, 2026; AZ-802 replaces it.',
    topics: [],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/windows-server-hybrid-administrator/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-801',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-801',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Review the official Microsoft Learn certification page for prerequisites.',
    nextCerts: [],
  },
  {
    id: 'az-802',
    slug: 'az-802',
    code: 'AZ-802',
    officialCode: 'AZ-802',
    title: 'Administering Windows Server',
    level: 'Associate',
    status: 'active',
    description: 'The single Windows Server exam that replaces the AZ-800 and AZ-801 pair.',
    longDescription:
      'Deploy, implement, manage, and troubleshoot Windows Server as a workload in on-premises, cloud, and hybrid environments — identity, security, compute, networking, storage, and monitoring. AZ-800 and AZ-801 retire on September 30, 2026; the credential is being renamed Windows Server Administrator Associate.',
    topics: [
      'AD DS',
      'Hybrid Windows Server',
      'Virtual Machines',
      'Networking',
      'Storage & File Services',
      'Security',
      'Monitoring',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/windows-server-hybrid-administrator/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-802',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-802',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Windows Server and Active Directory Domain Services experience.',
    nextCerts: ['az-305'],
  },
  {
    id: 'az-900',
    slug: 'az-900',
    code: 'AZ-900',
    officialCode: 'AZ-900',
    title: 'Microsoft Azure Fundamentals',
    level: 'Fundamentals',
    status: 'active',
    featured: true,
    description: 'Foundational knowledge of cloud concepts and Azure core services.',
    longDescription:
      'Demonstrate foundational knowledge of cloud concepts and Microsoft Azure. Covers cloud models, Azure services, pricing, SLAs, and governance — the ideal entry point for any Azure career path.',
    topics: ['Cloud Concepts', 'Azure Services', 'Pricing & SLAs', 'Governance & Compliance'],
    hours: 10,
    prepTime: '~4 weeks',
    successRate: '82%',
    learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/azure-fundamentals/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-900',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-900',
    modules: [
      {
        title: 'Describe cloud concepts',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-cloud-compute/',
      },
      {
        title: 'Describe Azure architecture and services',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-core-azure-services/',
      },
      {
        title: 'Describe Azure management and governance',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-cost-management-azure/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'No prerequisites — ideal for beginners.',
    nextCerts: ['az-104', 'ai-901', 'dp-900', 'sc-900'],
  },
  {
    id: 'dp-300',
    slug: 'dp-300',
    code: 'DP-300',
    officialCode: 'DP-300',
    title: 'Administering Microsoft Azure SQL Solutions',
    level: 'Associate',
    status: 'active',
    description: 'Administer cloud and on-premises relational databases built on SQL Server.',
    longDescription:
      'Validate your ability to manage and administer Azure SQL Database, Azure SQL Managed Instance, and SQL Server on Azure VMs.',
    topics: [
      'Azure SQL Database',
      'SQL Managed Instance',
      'SQL Server on Azure',
      'High Availability',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '72%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-database-administrator-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/dp-300',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=dp-300',
    modules: [
      {
        title: 'Introduction to Azure SQL',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-sql-intro/',
      },
      {
        title: 'Deploy and configure servers, instances, and databases',
        url: 'https://learn.microsoft.com/en-us/training/modules/deploy-azure-sql-database/',
      },
      {
        title: 'Monitor and optimize operational resources',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-performance-monitoring/',
      },
    ],
    appliedSkills: [
      {
        code: 'APL-1008',
        title: 'Migrate SQL Server workloads to Azure SQL Database',
        url: 'https://learn.microsoft.com/en-us/credentials/applied-skills/migrate-sql-workloads-azure-sql-database/',
      },
    ],
    prerequisites: 'DP-900 recommended. SQL Server experience.',
    nextCerts: [],
  },
  {
    id: 'dp-420',
    slug: 'dp-420',
    code: 'DP-420',
    officialCode: 'DP-420',
    title: 'Designing and Implementing Cloud-Native Applications Using Azure Cosmos DB',
    level: 'Associate',
    status: 'active',
    description: 'Design and implement cloud-native applications with Azure Cosmos DB.',
    longDescription:
      'Validate expertise designing and implementing data models, data distribution strategies, and solutions using Azure Cosmos DB for NoSQL. From October 6, 2026 the certification is Microsoft Certified: Azure Cosmos DB AI Developer Associate (until then Azure Cosmos DB Developer Specialty), and the exam is updated the same day.',
    topics: [
      'Cosmos DB for NoSQL',
      'Data Modeling',
      'Indexing',
      'Query Optimization',
      'Change Feed',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '70%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-cosmos-db-developer-specialty/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/dp-420',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=dp-420',
    modules: [
      {
        title: 'Get started with Azure Cosmos DB for NoSQL',
        url: 'https://learn.microsoft.com/en-us/training/modules/introduction-to-azure-cosmos-db-sql-api/',
      },
      {
        title: 'Plan and implement Azure Cosmos DB for NoSQL',
        url: 'https://learn.microsoft.com/en-us/training/modules/choose-azure-cosmos-db-api/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'Developer experience with NoSQL databases.',
    nextCerts: [],
  },
  {
    id: 'dp-600',
    slug: 'dp-600',
    code: 'DP-600',
    officialCode: 'DP-600',
    title: 'Implementing Analytics Solutions Using Microsoft Fabric',
    level: 'Associate',
    status: 'active',
    description: 'Implement end-to-end analytics solutions using Microsoft Fabric.',
    longDescription:
      'Validate expertise implementing analytics solutions using Microsoft Fabric including lakehouses, data pipelines, and semantic models.',
    topics: ['Microsoft Fabric', 'Lakehouse', 'Data Pipelines', 'Semantic Models', 'Power BI'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '73%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/fabric-analytics-engineer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/dp-600',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=dp-600',
    modules: [],
    appliedSkills: [],
    prerequisites: 'DP-900 or PL-300 recommended.',
    nextCerts: [],
  },
  {
    id: 'dp-700',
    slug: 'dp-700',
    code: 'DP-700',
    officialCode: 'DP-700',
    title: 'Implementing Data Engineering Solutions Using Microsoft Fabric',
    level: 'Associate',
    status: 'active',
    description: 'Implement data engineering solutions using Microsoft Fabric.',
    longDescription:
      'Validate expertise implementing data engineering in Microsoft Fabric — lakehouses, data ingestion, transformation, and orchestration.',
    topics: ['Microsoft Fabric', 'Data Ingestion', 'Transformation', 'Orchestration', 'Lakehouse'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '72%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/fabric-data-engineer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/dp-700',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=dp-700',
    modules: [],
    appliedSkills: [],
    prerequisites: 'DP-900 or DP-203 recommended.',
    nextCerts: [],
  },
  {
    id: 'dp-750',
    slug: 'dp-750',
    code: 'DP-750',
    officialCode: 'DP-750',
    title: 'Azure Databricks Data Engineer Associate',
    level: 'Associate',
    status: 'active',
    betaEndDate: '2026-06-30',
    gaDate: '2026-07-01',
    description: 'Implement data engineering solutions using Azure Databricks.',
    longDescription:
      'Certification validating expertise implementing data engineering pipelines and solutions using Azure Databricks and Delta Lake.',
    topics: ['Azure Databricks', 'Delta Lake', 'Spark', 'Data Pipelines', 'MLflow'],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/implementing-data-engineering-solutions-using-azure-databricks/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/dp-750',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=dp-750',
    modules: [],
    appliedSkills: [],
    prerequisites: 'DP-203 or data engineering experience.',
    nextCerts: [],
  },
  {
    id: 'dp-800',
    slug: 'dp-800',
    code: 'DP-800',
    officialCode: 'DP-800',
    title: 'SQL AI Developer Associate',
    level: 'Associate',
    status: 'active',
    betaEndDate: '2026-06-30',
    gaDate: '2026-07-01',
    description: 'Build AI-powered solutions using SQL and Azure AI Services.',
    longDescription:
      'Certification for developers building intelligent applications with SQL Server, Azure SQL, and integrated Azure AI capabilities.',
    topics: ['Azure SQL', 'AI Integration', 'Vector Search', 'SQL Development', 'Azure OpenAI'],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/developing-ai-enabled-database-solutions/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/dp-800',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=dp-800',
    modules: [],
    appliedSkills: [],
    prerequisites: 'SQL development experience.',
    nextCerts: [],
  },
  {
    id: 'dp-900',
    slug: 'dp-900',
    code: 'DP-900',
    officialCode: 'DP-900',
    title: 'Microsoft Azure Data Fundamentals',
    level: 'Fundamentals',
    status: 'active',
    description: 'Core data concepts and Azure data services fundamentals.',
    longDescription:
      'Demonstrate foundational knowledge of core data concepts and Azure data services — covering relational, non-relational, and analytics workloads.',
    topics: ['Relational Data', 'Non-Relational Data', 'Analytics Workloads', 'Azure Databases'],
    hours: 10,
    prepTime: '~4 weeks',
    successRate: '81%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-data-fundamentals/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/dp-900',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=dp-900',
    modules: [
      {
        title: 'Explore core data concepts',
        url: 'https://learn.microsoft.com/en-us/training/modules/explore-core-data-concepts/',
      },
      {
        title: 'Explore relational data in Azure',
        url: 'https://learn.microsoft.com/en-us/training/modules/explore-relational-data-offerings/',
      },
      {
        title: 'Explore non-relational data in Azure',
        url: 'https://learn.microsoft.com/en-us/training/modules/explore-non-relational-data-stores-azure/',
      },
      {
        title: 'Explore analytics in Azure',
        url: 'https://learn.microsoft.com/en-us/training/modules/explore-data-analytics-scale/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'Basic data familiarity. AZ-900 recommended.',
    nextCerts: ['dp-700', 'dp-300', 'dp-420'],
  },
  {
    id: 'mb-230',
    slug: 'mb-230',
    code: 'MB-230',
    officialCode: 'MB-230',
    title: 'Dynamics 365 Customer Service Functional Consultant',
    level: 'Associate',
    status: 'active',
    description: 'Configure Dynamics 365 Customer Service solutions for organizations.',
    longDescription:
      'Validate expertise implementing customer service solutions using Dynamics 365 Customer Service, Omnichannel, and related Power Platform capabilities.',
    topics: [
      'Dynamics 365 Customer Service',
      'Omnichannel',
      'Power Virtual Agents',
      'SLAs',
      'Knowledge Management',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '73%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-functional-consultant-customer-service-v3/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/mb-230',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=mb-230',
    modules: [],
    appliedSkills: [],
    prerequisites: 'PL-900 recommended.',
    nextCerts: [],
  },
  {
    id: 'mb-240',
    slug: 'd365-functional-consultant-field-service',
    code: 'MB-240',
    officialCode: 'MB-240',
    title: 'Microsoft Certified: Dynamics 365 Field Service Functional Consultant Associate',
    level: 'Associate',
    status: 'retired',
    expiryDate: '2026-06-30',
    description:
      'Dynamics 365 Field Service Functional Consultant Associate validates role-based Microsoft cloud skills.',
    longDescription:
      'Dynamics 365 Field Service Functional Consultant Associate validates skills for Microsoft cloud and AI workloads using official Microsoft certification requirements.',
    topics: ['Business applications'],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-functional-consultant-field-service/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/mb-240',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=mb-240',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Review the official Microsoft Learn certification page for prerequisites.',
    nextCerts: [],
  },
  {
    id: 'mb-280',
    slug: 'mb-280',
    code: 'MB-280',
    officialCode: 'MB-280',
    title: 'Dynamics 365 Customer Experience Analyst Associate',
    level: 'Associate',
    status: 'retired',
    expiryDate: '2026-07-31',
    replacedBy: 'ab-210',
    description: 'Analyze and improve customer experience using Dynamics 365 and Power Platform.',
    longDescription:
      'Validate expertise using Dynamics 365 and Power Platform to analyze customer journeys and improve customer experience. Retiring July 31, 2026.',
    topics: [
      'Customer Insights',
      'Dynamics 365',
      'Power Platform',
      'Customer Journeys',
      'Analytics',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '72%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-customer-experience-analyst-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/mb-280',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=mb-280',
    modules: [],
    appliedSkills: [],
    prerequisites: 'PL-900 recommended.',
    nextCerts: [],
  },
  {
    id: 'mb-310',
    slug: 'mb-310',
    code: 'MB-310',
    officialCode: 'MB-310',
    title: 'Dynamics 365 Finance Functional Consultant Associate',
    level: 'Associate',
    status: 'active',
    description: 'Configure and use Dynamics 365 Finance for financial management.',
    longDescription:
      'Validate expertise implementing and configuring Dynamics 365 Finance for core financial processes including general ledger, accounts payable/receivable, and financial reporting.',
    topics: ['Dynamics 365 Finance', 'General Ledger', 'AP/AR', 'Budgeting', 'Financial Reporting'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '71%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-functional-consultant-financials/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/mb-310',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=mb-310',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Finance background recommended.',
    nextCerts: [],
  },
  {
    id: 'mb-330',
    slug: 'mb-330',
    code: 'MB-330',
    officialCode: 'MB-330',
    title: 'Dynamics 365 Supply Chain Management Functional Consultant',
    level: 'Associate',
    status: 'active',
    description: 'Configure Dynamics 365 Supply Chain Management solutions.',
    longDescription:
      'Validate expertise implementing supply chain management solutions using Dynamics 365, including inventory, procurement, manufacturing, and logistics. Microsoft expects MB-330 to retire in December 2026, succeeded by AB-330 (Supply Chain Management AI Consultant Associate; beta expected November 2026); no date is published yet.',
    topics: [
      'Inventory Management',
      'Procurement',
      'Manufacturing',
      'Logistics',
      'Warehouse Management',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '70%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-functional-consultant-supply-chain-management/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/mb-330',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=mb-330',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Supply chain experience recommended.',
    nextCerts: [],
  },
  {
    id: 'mb-335',
    slug: 'mb-335',
    code: 'MB-335',
    officialCode: 'MB-335',
    title: 'Dynamics 365 Supply Chain Management Functional Consultant Expert',
    level: 'Expert',
    status: 'retired',
    expiryDate: '2026-06-30',
    description: 'Advanced supply chain management solutions using Dynamics 365.',
    longDescription:
      'Validate advanced expertise in Dynamics 365 Supply Chain Management. Retiring June 30, 2026.',
    topics: [
      'Advanced SCM',
      'Dynamics 365',
      'Manufacturing',
      'Asset Management',
      'IoT Intelligence',
    ],
    hours: 60,
    prepTime: '~5 months',
    successRate: '68%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-supply-chain-management-functional-consultant-expert/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/mb-335',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=mb-335',
    modules: [],
    appliedSkills: [],
    prerequisites: 'MB-330 required.',
    nextCerts: [],
  },
  {
    id: 'mb-500',
    slug: 'mb-500',
    code: 'MB-500',
    officialCode: 'MB-500',
    title: 'Dynamics 365 Finance and Operations Apps Developer Associate',
    level: 'Associate',
    status: 'active',
    description:
      'Develop customizations and extensions for Dynamics 365 Finance and Operations apps.',
    longDescription:
      'Validate expertise developing, testing, and deploying customizations for Dynamics 365 Finance and Operations applications using X++ and related developer tools.',
    topics: ['X++ Development', 'Dynamics 365 F&O', 'Extensions', 'Integration', 'Testing'],
    hours: 50,
    prepTime: '~4 months',
    successRate: '70%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-finance-and-operations-apps-developer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/mb-500',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=mb-500',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Development experience. Finance & Operations knowledge.',
    nextCerts: [],
  },
  {
    id: 'mb-700',
    slug: 'mb-700',
    code: 'MB-700',
    officialCode: 'MB-700',
    title: 'Dynamics 365: Finance and Operations Apps Solution Architect Expert',
    level: 'Expert',
    status: 'retired',
    expiryDate: '2026-06-30',
    description: 'Architect enterprise-scale Dynamics 365 Finance and Operations solutions.',
    longDescription:
      'Validate advanced expertise designing Dynamics 365 Finance and Operations implementations. Retiring June 30, 2026.',
    topics: [
      'Solution Architecture',
      'Dynamics 365 F&O',
      'Integration',
      'Data Migration',
      'Governance',
    ],
    hours: 60,
    prepTime: '~5 months',
    successRate: '67%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-finance-and-operations-apps-solution-architect-expert/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/mb-700',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=mb-700',
    modules: [],
    appliedSkills: [],
    prerequisites: 'MB-310 or MB-330 + MB-500 recommended.',
    nextCerts: [],
  },
  {
    id: 'mb-800',
    slug: 'mb-800',
    code: 'MB-800',
    officialCode: 'MB-800',
    title: 'Dynamics 365 Business Central Functional Consultant Associate',
    level: 'Associate',
    status: 'active',
    description: 'Configure and manage Dynamics 365 Business Central for SMB customers.',
    longDescription:
      'Validate expertise setting up and configuring Dynamics 365 Business Central — finance, manufacturing, sales, and purchasing for small to medium businesses.',
    topics: [
      'Business Central',
      'Finance Setup',
      'Manufacturing',
      'Sales & Purchasing',
      'Reporting',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '72%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-business-central-functional-consultant-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/mb-800',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=mb-800',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Business process knowledge. PL-900 recommended.',
    nextCerts: [],
  },
  {
    id: 'mb-820',
    slug: 'mb-820',
    code: 'MB-820',
    officialCode: 'MB-820',
    title: 'Dynamics 365 Business Central Developer Associate',
    level: 'Associate',
    status: 'active',
    description: 'Develop extensions and customizations for Dynamics 365 Business Central.',
    longDescription:
      'Validate expertise developing AL extensions, integrations, and customizations for Dynamics 365 Business Central.',
    topics: ['AL Development', 'Business Central Extensions', 'APIs', 'Integration', 'Testing'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '71%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/d365-business-central-developer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/mb-820',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=mb-820',
    modules: [],
    appliedSkills: [],
    prerequisites: 'MB-800 recommended. Development experience.',
    nextCerts: [],
  },
  {
    id: 'md-102',
    slug: 'md-102',
    code: 'MD-102',
    officialCode: 'MD-102',
    title: 'Microsoft 365 Endpoint Administrator',
    level: 'Associate',
    status: 'active',
    description:
      'Deploy and manage devices and client applications in a Microsoft 365 environment.',
    longDescription:
      'Validate expertise planning and executing endpoint deployment strategy using Microsoft 365 technologies, including Intune, Autopilot, and Microsoft Defender for Endpoint.',
    topics: [
      'Intune',
      'Autopilot',
      'Windows Deployment',
      'Compliance Policies',
      'Defender for Endpoint',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '74%',
    learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/modern-desktop/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/md-102',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=md-102',
    modules: [],
    appliedSkills: [],
    prerequisites: 'MS-900 recommended. Windows and Intune experience.',
    nextCerts: ['ms-102'],
  },
  {
    id: 'ms-102',
    slug: 'ms-102',
    code: 'MS-102',
    officialCode: 'MS-102',
    title: 'Microsoft 365 Administrator Expert',
    level: 'Expert',
    status: 'expiring',
    expiryDate: '2026-11-30',
    replacedBy: 'ab-650',
    description: 'Administer Microsoft 365 tenants, including identity, compliance, and security.',
    longDescription:
      'Validate expertise administering Microsoft 365 environments — tenant management, identity, security, compliance, and Microsoft 365 service integration. Retires November 30, 2026; Microsoft recommends AB-650 (Microsoft 365 and AI Services Administrator Associate) in its place.',
    topics: ['Tenant Management', 'Identity', 'Security', 'Compliance', 'Microsoft 365 Services'],
    hours: 60,
    prepTime: '~5 months',
    successRate: '70%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/m365-administrator-expert/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ms-102',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ms-102',
    modules: [],
    appliedSkills: [],
    prerequisites: 'MD-102 or MS-900 + experience required.',
    nextCerts: [],
  },
  {
    id: 'ms-700',
    slug: 'ms-700',
    code: 'MS-700',
    officialCode: 'MS-700',
    title: 'Managing Microsoft Teams',
    level: 'Associate',
    status: 'active',
    description: 'Manage Microsoft Teams environments including voice, meetings, and apps.',
    longDescription:
      'Validate expertise managing Microsoft Teams configurations including governance, security, compliance, lifecycle management, and Teams Phone.',
    topics: [
      'Teams Governance',
      'Meetings & Calling',
      'Teams Phone',
      'Apps & Integrations',
      'Security',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '73%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/m365-teams-administrator-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ms-700',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ms-700',
    modules: [],
    appliedSkills: [],
    prerequisites: 'MS-900 recommended.',
    nextCerts: ['ms-102'],
  },
  {
    id: 'ms-721',
    slug: 'ms-721',
    code: 'MS-721',
    officialCode: 'MS-721',
    title: 'Collaboration Communications Systems Engineer',
    level: 'Associate',
    status: 'active',
    description: 'Plan and configure Microsoft Teams Phone and related collaboration systems.',
    longDescription:
      'Validate expertise designing, configuring, and troubleshooting Teams Phone, including direct routing, operator connect, and Teams Rooms.',
    topics: ['Teams Phone', 'Direct Routing', 'Operator Connect', 'Teams Rooms', 'Call Quality'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '72%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/m365-collaboration-communications-systems-engineer/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ms-721',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=ms-721',
    modules: [],
    appliedSkills: [],
    prerequisites: 'MS-700 recommended.',
    nextCerts: ['ms-102'],
  },
  {
    id: 'pl-200',
    slug: 'pl-200',
    code: 'PL-200',
    officialCode: 'PL-200',
    title: 'Microsoft Power Platform Functional Consultant',
    level: 'Associate',
    status: 'retired',
    expiryDate: '2026-08-31',
    replacedBy: 'ab-410',
    description: 'Configure and extend Power Platform components to build business solutions.',
    longDescription:
      'Validate skills configuring Microsoft Dataverse, Power Apps, Power Automate, and Power Virtual Agents. Retiring August 31, 2026.',
    topics: ['Dataverse', 'Power Apps', 'Power Automate', 'Power BI', 'AI Builder'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '73%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/power-platform-functional-consultant-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/pl-200',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=pl-200',
    modules: [],
    appliedSkills: [],
    prerequisites: 'PL-900 recommended.',
    nextCerts: ['ab-100'],
  },
  {
    id: 'pl-300',
    slug: 'pl-300',
    code: 'PL-300',
    officialCode: 'PL-300',
    title: 'Microsoft Power BI Data Analyst',
    level: 'Associate',
    status: 'active',
    description: 'Enable businesses to maximize the value of their data assets with Power BI.',
    longDescription:
      'Validate expertise designing and building scalable data models, cleaning and transforming data, and enabling advanced analytic capabilities in Power BI.',
    topics: [
      'Power BI Desktop',
      'Data Modeling',
      'DAX',
      'Reports & Dashboards',
      'Power BI Service',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '74%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/data-analyst-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/pl-300',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=pl-300',
    modules: [],
    appliedSkills: [],
    prerequisites: 'PL-900 recommended. Data analysis experience.',
    nextCerts: [],
  },
  {
    id: 'pl-400',
    slug: 'pl-400',
    code: 'PL-400',
    officialCode: 'PL-400',
    title: 'Microsoft Power Platform Developer',
    level: 'Associate',
    status: 'retired',
    expiryDate: '2026-10-30',
    replacedBy: 'ab-400',
    statusReadDate: '2026-10-12',
    description: 'Design, develop, secure, and troubleshoot Power Platform solutions.',
    longDescription:
      'Validate expertise developing custom Power Platform components, connectors, and integrations using code-first approaches and Azure services. PL-400 becomes AB-400 on October 16, 2026: registration for PL-400 closes that day, and anyone registered by then can take it through October 30, 2026. The certification earned, Power Platform Developer Associate, is unchanged.',
    topics: [
      'Custom Connectors',
      'PCF Controls',
      'Plugins',
      'Power Apps Component Framework',
      'Azure Integration',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '71%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/power-platform-developer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/pl-400',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=pl-400',
    modules: [],
    appliedSkills: [],
    prerequisites: 'PL-200 recommended. Development experience.',
    nextCerts: ['ab-100'],
  },
  {
    id: 'pl-500',
    slug: 'pl-500',
    code: 'PL-500',
    officialCode: 'PL-500',
    title: 'Microsoft Power Automate RPA Developer',
    level: 'Associate',
    status: 'retired',
    expiryDate: '2026-06-30',
    description: 'Design and implement Robotic Process Automation solutions with Power Automate.',
    longDescription:
      'Validate expertise building RPA solutions using Power Automate Desktop flows. Retiring June 30, 2026.',
    topics: ['Desktop Flows', 'RPA', 'UI Automation', 'Power Automate', 'Process Automation'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '72%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/power-automate-rpa-developer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/pl-500',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=pl-500',
    modules: [],
    appliedSkills: [],
    prerequisites: 'PL-900 and development experience.',
    nextCerts: [],
  },
  {
    id: 'pl-600',
    slug: 'pl-600',
    code: 'PL-600',
    officialCode: 'PL-600',
    title: 'Microsoft Power Platform Solution Architect Expert',
    level: 'Expert',
    status: 'retired',
    expiryDate: '2026-06-30',
    description: 'Lead successful implementations of Microsoft Power Platform solutions.',
    longDescription:
      'Validate expertise designing Power Platform and Dynamics 365 solutions at scale. Retiring June 30, 2026.',
    topics: ['Solution Architecture', 'Dataverse', 'Security', 'Integration', 'ALM'],
    hours: 60,
    prepTime: '~5 months',
    successRate: '69%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/power-platform-solution-architect-expert/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/pl-600',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=pl-600',
    modules: [],
    appliedSkills: [],
    prerequisites: 'PL-200 or PL-400 required. 1+ year solution architect experience.',
    nextCerts: [],
  },
  {
    id: 'pl-900',
    slug: 'pl-900',
    code: 'PL-900',
    officialCode: 'PL-900',
    title: 'Microsoft Power Platform Fundamentals',
    level: 'Fundamentals',
    status: 'active',
    description:
      'Foundational knowledge of Microsoft Power Platform capabilities and business value.',
    longDescription:
      'Demonstrate foundational knowledge of Power Platform — Power BI, Power Apps, Power Automate, and Power Virtual Agents.',
    topics: ['Power BI', 'Power Apps', 'Power Automate', 'Power Virtual Agents'],
    hours: 10,
    prepTime: '~4 weeks',
    successRate: '81%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/power-platform-fundamentals/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/pl-900',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=pl-900',
    modules: [],
    appliedSkills: [],
    prerequisites: 'No prerequisites.',
    nextCerts: ['pl-300', 'pl-400'],
  },
  {
    id: 'sc-100',
    slug: 'sc-100',
    code: 'SC-100',
    officialCode: 'SC-100',
    title: 'Microsoft Cybersecurity Architect Expert',
    level: 'Expert',
    status: 'active',
    description: 'Design Zero Trust strategy and architecture across Microsoft security solutions.',
    longDescription:
      "Validate advanced expertise designing and evolving the cybersecurity strategy to protect an organization's mission and business processes across Zero Trust, GRC, security operations, and data/application security.",
    topics: ['Zero Trust', 'GRC', 'Security Operations', 'Identity Architecture', 'Data Security'],
    hours: 60,
    prepTime: '~6 months',
    successRate: '70%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/cybersecurity-architect-expert/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/sc-100',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=sc-100',
    modules: [],
    appliedSkills: [],
    prerequisites: 'SC-200, SC-300, or SC-400 required.',
    nextCerts: [],
  },
  {
    id: 'sc-200',
    slug: 'sc-200',
    code: 'SC-200',
    officialCode: 'SC-200',
    title: 'Microsoft Security Operations Analyst',
    level: 'Associate',
    status: 'active',
    description: 'Investigate, respond to, and hunt for threats using Microsoft Sentinel.',
    longDescription:
      'Validate your ability to reduce organizational risk by rapidly remediating active attacks, advising on improvements to threat protection practices, and referring violations of organizational policies.',
    topics: ['Microsoft Sentinel', 'Microsoft Defender XDR', 'Threat Hunting', 'Incident Response'],
    hours: 45,
    prepTime: '~3 months',
    successRate: '73%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/security-operations-analyst/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/sc-200',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=sc-200',
    modules: [
      {
        title: 'Mitigate threats using Microsoft Defender XDR',
        url: 'https://learn.microsoft.com/en-us/training/modules/introduction-to-microsoft-365-threat-protection/',
      },
      {
        title: 'Mitigate threats using Microsoft Defender for Cloud',
        url: 'https://learn.microsoft.com/en-us/training/modules/intro-to-azure-defender/',
      },
      {
        title: 'Mitigate threats using Microsoft Sentinel',
        url: 'https://learn.microsoft.com/en-us/training/modules/intro-to-azure-sentinel/',
      },
    ],
    appliedSkills: [
      {
        code: 'APL-1005',
        title: 'Configure SIEM security operations using Microsoft Sentinel',
        url: 'https://learn.microsoft.com/en-us/credentials/applied-skills/configure-siem-security-operations-using-microsoft-sentinel/',
      },
    ],
    prerequisites: 'SC-900 recommended. Security operations experience.',
    nextCerts: [],
  },
  {
    id: 'sc-300',
    slug: 'sc-300',
    code: 'SC-300',
    officialCode: 'SC-300',
    title: 'Microsoft Identity and Access Administrator',
    level: 'Associate',
    status: 'active',
    description:
      'Design, implement, and operate identity and access management using Microsoft Entra.',
    longDescription:
      'Validate expertise designing and implementing identity and access management using Microsoft Entra ID — including SSO, MFA, Conditional Access, entitlement management, and privileged identity.',
    topics: ['Microsoft Entra ID', 'SSO', 'MFA', 'Conditional Access', 'Privileged Identity'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '74%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/identity-and-access-administrator/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/sc-300',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=sc-300',
    modules: [
      {
        title: 'Implement identities in Microsoft Entra ID',
        url: 'https://learn.microsoft.com/en-us/training/modules/explore-basic-services-identity-types/',
      },
      {
        title: 'Implement authentication and access management',
        url: 'https://learn.microsoft.com/en-us/training/modules/manage-user-accounts-licenses-microsoft-365/',
      },
      {
        title: 'Implement access management for applications',
        url: 'https://learn.microsoft.com/en-us/training/modules/implement-app-registration/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'SC-900 recommended. Identity management experience.',
    nextCerts: [],
  },
  {
    id: 'sc-401',
    slug: 'sc-401',
    code: 'SC-401',
    officialCode: 'SC-401',
    title: 'Information Security Administrator Associate',
    level: 'Associate',
    status: 'active',
    description: 'Implement information security solutions using Microsoft Purview.',
    longDescription:
      'Validate expertise implementing and managing information security controls, insider risk policies, and compliance solutions using Microsoft Purview and related tools.',
    topics: [
      'Microsoft Purview',
      'Insider Risk',
      'Information Barriers',
      'eDiscovery',
      'Compliance',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '73%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/information-security-administrator/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/sc-401',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=sc-401',
    modules: [],
    appliedSkills: [],
    prerequisites: 'SC-900 recommended.',
    nextCerts: ['sc-100'],
  },
  {
    id: 'sc-500',
    slug: 'cloud-and-ai-security-engineer-associate',
    code: 'SC-500',
    officialCode: 'SC-500',
    title: 'Microsoft Certified: Cloud and AI Security Engineer Associate',
    level: 'Associate',
    status: 'active',
    description:
      'Cloud and AI Security Engineer Associate validates role-based Microsoft cloud skills.',
    longDescription:
      'Cloud and AI Security Engineer Associate validates skills for Microsoft cloud and AI workloads using official Microsoft certification requirements.',
    topics: ['Security', 'Cloud security', 'Artificial intelligence', 'Generative AI'],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/cloud-and-ai-security-engineer-associate/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/sc-500',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=sc-500',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Review the official Microsoft Learn certification page for prerequisites.',
    nextCerts: [],
  },
  {
    id: 'sc-730',
    slug: 'cybersecurity-business-professional',
    code: 'SC-730',
    officialCode: 'SC-730',
    title: 'Microsoft Certified: Cybersecurity Business Professional',
    level: 'Associate',
    status: 'retired',
    description: 'Withdrawn: Microsoft decided not to release this certification after its beta.',
    longDescription:
      'Microsoft ran SC-730 as a beta for business professionals and then, citing learner feedback, decided not to move forward with releasing it. No retirement date was published; the Learn page is hidden from the catalogue.',
    topics: [],
    hours: 35,
    prepTime: '~6 weeks',
    successRate: null,
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/cybersecurity-business-professional/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/sc-730',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=sc-730',
    modules: [],
    appliedSkills: [],
    prerequisites: 'Review the official Microsoft Learn certification page for prerequisites.',
    nextCerts: [],
  },
  {
    id: 'sc-900',
    slug: 'sc-900',
    code: 'SC-900',
    officialCode: 'SC-900',
    title: 'Microsoft Security, Compliance, and Identity Fundamentals',
    level: 'Fundamentals',
    status: 'active',
    description: 'Foundational knowledge of security, compliance, and identity across Microsoft.',
    longDescription:
      'Validate your knowledge of security, compliance, and identity concepts and related Microsoft cloud services — ideal for business stakeholders and IT professionals beginning their security journey.',
    topics: [
      'Security Concepts',
      'Identity & Access',
      'Microsoft Compliance',
      'Microsoft Defender',
    ],
    hours: 10,
    prepTime: '~4 weeks',
    successRate: '79%',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/security-compliance-and-identity-fundamentals/',
    studyGuideUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/sc-900',
    practiceUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=sc-900',
    modules: [
      {
        title: 'Describe security and compliance concepts',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-security-concepts-methodologies/',
      },
      {
        title: 'Describe Microsoft Entra capabilities',
        url: 'https://learn.microsoft.com/en-us/training/modules/explore-basic-services-identity-types/',
      },
      {
        title: 'Describe Microsoft security solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-security-capabilities-of-azure/',
      },
      {
        title: 'Describe Microsoft compliance solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-compliance-management-capabilities-microsoft/',
      },
    ],
    appliedSkills: [],
    prerequisites: 'General familiarity with Microsoft cloud.',
    nextCerts: ['sc-200', 'sc-300', 'sc-401'],
  },
];

// Applied Skills — sourced from official Applied Skills Poster
// Updated by scripts/update-applied-skills.mjs from Microsoft Learn API, detail pages, and the Applied Skills poster.
// status: 'active' | 'expiring' | 'retired'
export const appliedSkills = [
  {
    id: 'accelerate-app-development-by-using-github-copilot',
    slug: 'accelerate-app-development-by-using-github-copilot',
    code: 'APL-AADGC',
    officialCode: 'applied-skill.accelerate-app-development-by-using-github-copilot',
    title: 'Accelerate AI-assisted development by using GitHub Copilot',
    area: 'DevTools',
    level: 'Intermediate',
    status: 'active',
    description:
      'Validate hands-on skills for Accelerate AI-assisted development by using GitHub Copilot.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/accelerate-app-development-by-using-github-copilot/',
  },
  {
    id: 'apl-administer-ad-domain',
    slug: 'administer-active-directory-domain-services',
    code: 'APL-AD',
    officialCode: 'applied-skill.administer-active-directory-domain-services',
    title: 'Administer Active Directory Domain Services',
    area: 'Security',
    level: 'Intermediate',
    status: 'active',
    description:
      'Administer on-premises and hybrid Active Directory Domain Services — users, groups, GPOs, replication, and trust relationships.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/administer-active-directory-domain-services/',
  },
  {
    id: 'apl-load-testing',
    slug: 'automate-azure-load-testing-by-using-github-actions',
    code: 'APL-LT',
    officialCode: 'applied-skill.automate-azure-load-testing-by-using-github-actions',
    title: 'Automate Azure Load Testing by using GitHub Actions',
    area: 'DevTools',
    level: 'Intermediate',
    status: 'active',
    description:
      'Integrate Azure Load Testing into CI/CD pipelines using GitHub Actions to automate performance and scale testing.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/automate-azure-load-testing-by-using-github-actions/',
  },
  {
    id: 'apl-1006',
    slug: 'build-natural-language-solution-azure-ai',
    code: 'APL-1006',
    officialCode: 'applied-skill.build-natural-language-solution-azure-ai',
    title: 'Build a natural language processing solution with Azure AI Language',
    area: 'AI',
    level: 'Intermediate',
    status: 'retired',
    expiryDate: '2026-06-30',
    description:
      'Use Azure AI Language to analyze text, extract key information, classify documents, and build conversational NLP solutions.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/build-natural-language-solution-azure-ai/',
  },
  {
    id: 'build-ai-powered-solutions-by-using-microsoft-azure-database-for-postgresql',
    slug: 'build-ai-powered-solutions-by-using-microsoft-azure-database-for-postgresql',
    code: 'APL-BAPSD',
    officialCode:
      'applied-skill.build-ai-powered-solutions-by-using-microsoft-azure-database-for-postgresql',
    title: 'Build AI-powered solutions by using Microsoft Azure Database for PostgreSQL',
    area: 'Data',
    level: 'Intermediate',
    status: 'active',
    description:
      'Validate hands-on skills for Build AI-powered solutions by using Microsoft Azure Database for PostgreSQL.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/build-ai-powered-solutions-by-using-microsoft-azure-database-for-postgresql/',
  },
  {
    id: 'build-an-agent-in-microsoft-copilot-studio',
    slug: 'build-an-agent-in-microsoft-copilot-studio',
    code: 'APL-BAACS',
    officialCode: 'applied-skill.build-an-agent-in-microsoft-copilot-studio',
    title: 'Build an agent in Microsoft Copilot Studio',
    area: 'AI Business',
    level: 'Intermediate',
    status: 'active',
    description: 'Validate hands-on skills for Build an agent in Microsoft Copilot Studio.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/build-an-agent-in-microsoft-copilot-studio/',
  },
  {
    id: 'apl-postgres',
    slug: 'configure-and-migrate-to-azure-database-for-postgresql',
    code: 'APL-PG',
    officialCode: 'applied-skill.configure-and-migrate-to-azure-database-for-postgresql',
    title: 'Configure and migrate to Azure Database for PostgreSQL',
    area: 'Data',
    level: 'Intermediate',
    status: 'active',
    description:
      'Configure Azure Database for PostgreSQL Flexible Server and migrate on-premises PostgreSQL workloads to Azure.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/configure-and-migrate-to-azure-database-for-postgresql/',
  },
  {
    id: 'apl-1001',
    slug: 'configure-secure-workloads-use-azure-virtual-networking',
    code: 'APL-1001',
    officialCode: 'applied-skill.configure-secure-workloads-use-azure-virtual-networking',
    title: 'Configure secure access to your workloads using Azure networking',
    area: 'Networking',
    level: 'Intermediate',
    status: 'active',
    description:
      'Implement network security controls for Azure workloads using VNets, NSGs, Azure Firewall, and Private Endpoints.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/configure-secure-workloads-use-azure-virtual-networking/',
  },
  {
    id: 'apl-copilot-studio-agents',
    slug: 'create-agents-in-microsoft-copilot-studio',
    code: 'APL-CSA',
    officialCode: 'applied-skill.create-agents-in-microsoft-copilot-studio',
    title: 'Create agents in Microsoft Copilot Studio',
    area: 'AI Business',
    level: 'Intermediate',
    status: 'retired',
    expiryDate: '2026-07-08',
    description:
      'Build and publish AI agents using Microsoft Copilot Studio with topics, actions, and knowledge sources.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/create-agents-in-microsoft-copilot-studio/',
  },
  {
    id: 'apl-power-automate',
    slug: 'create-and-manage-automated-processes-with-power-automate',
    code: 'APL-PAT',
    officialCode: 'applied-skill.create-and-manage-automated-processes-with-power-automate',
    title: 'Create and manage automated processes by using Power Automate',
    area: 'AI Business',
    level: 'Intermediate',
    status: 'active',
    description:
      'Build cloud flows, desktop flows, and AI-powered automations using Microsoft Power Automate to streamline business processes.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/create-and-manage-automated-processes-with-power-automate/',
  },
  {
    id: 'apl-power-apps-canvas',
    slug: 'create-manage-canvas-apps-power-apps',
    code: 'APL-PAC',
    officialCode: 'applied-skill.create-manage-canvas-apps-power-apps',
    title: 'Create and manage canvas apps with Power Apps',
    area: 'AI Business',
    level: 'Intermediate',
    status: 'active',
    description:
      'Design and build canvas apps in Microsoft Power Apps connecting to data sources and embedding logic with Power Fx.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/create-manage-canvas-apps-power-apps/',
  },
  {
    id: 'apl-power-apps-model-driven',
    slug: 'create-and-manage-model-driven-apps-with-power-apps-and-dataverse',
    code: 'APL-PAMD',
    officialCode: 'applied-skill.create-and-manage-model-driven-apps-with-power-apps-and-dataverse',
    title: 'Create and manage model-driven apps with Power Apps and Dataverse',
    area: 'AI Business',
    level: 'Intermediate',
    status: 'retired',
    expiryDate: '2026-06-30',
    description:
      'Build model-driven applications using Microsoft Power Apps and Dataverse with forms, views, and business rules.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/create-and-manage-model-driven-apps-with-power-apps-and-dataverse/',
  },
  {
    id: 'apl-defender-xdr',
    slug: 'defend-against-cyberthreats-with-microsoft-defender-xdr',
    code: 'APL-XDR',
    officialCode: 'applied-skill.defend-against-cyberthreats-with-microsoft-defender-xdr',
    title: 'Defend against cyberthreats with Microsoft Defender XDR',
    area: 'Security',
    level: 'Intermediate',
    status: 'active',
    description:
      'Use Microsoft Defender XDR to detect, investigate, and respond to multi-domain cyberthreats across identities, endpoints, and email.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/defend-against-cyberthreats-with-microsoft-defender-xdr/',
  },
  {
    id: 'apl-1002',
    slug: 'deploy-and-configure-azure-monitor',
    code: 'APL-1002',
    officialCode: 'applied-skill.deploy-and-configure-azure-monitor',
    title: 'Deploy and configure Azure Monitor',
    area: 'Operations',
    level: 'Intermediate',
    status: 'active',
    description:
      'Deploy and configure Azure Monitor to collect, analyze, and act on telemetry from Azure and on-premises environments.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/deploy-and-configure-azure-monitor/',
  },
  {
    id: 'apl-deploy-cloud-native',
    slug: 'deploy-cloud-native-apps-using-azure-container-apps',
    code: 'APL-CN',
    officialCode: 'applied-skill.deploy-cloud-native-apps-using-azure-container-apps',
    title: 'Deploy cloud-native apps using Azure Container Apps',
    area: 'Containers',
    level: 'Intermediate',
    status: 'active',
    description:
      'Deploy and scale cloud-native microservices applications using Azure Container Apps with DAPR and KEDA.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/deploy-cloud-native-apps-using-azure-container-apps/',
  },
  {
    id: 'apl-gen-ai-chat-app',
    slug: 'build-a-generative-ai-chat-app',
    code: 'APL-GAIC',
    officialCode: 'applied-skill.build-a-generative-ai-chat-app',
    title: 'Develop a Generative AI Chat App Using the Microsoft Foundry SDK',
    area: 'AI',
    level: 'Intermediate',
    status: 'active',
    description:
      'Build a generative AI chat application using Azure OpenAI Service, Azure AI Search, and RAG patterns for grounded responses.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/build-a-generative-ai-chat-app/',
  },
  {
    id: 'develop-an-agent-with-integrated-tools',
    slug: 'develop-an-agent-with-integrated-tools',
    code: 'APL-DAATO',
    officialCode: 'applied-skill.develop-an-agent-with-integrated-tools',
    title: 'Develop an agent with integrated tools',
    area: 'AI',
    level: 'Intermediate',
    status: 'active',
    description: 'Validate hands-on skills for Develop an agent with integrated tools.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/develop-an-agent-with-integrated-tools/',
  },
  {
    id: 'develop-data-driven-applications-by-using-microsoft-azure-sql-database',
    slug: 'develop-data-driven-applications-by-using-microsoft-azure-sql-database',
    code: 'APL-DDDAS',
    officialCode:
      'applied-skill.develop-data-driven-applications-by-using-microsoft-azure-sql-database',
    title: 'Develop data-driven applications by using Microsoft Azure SQL Database',
    area: 'Data',
    level: 'Intermediate',
    status: 'active',
    description:
      'Validate hands-on skills for Develop data-driven applications by using Microsoft Azure SQL Database.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/develop-data-driven-applications-by-using-microsoft-azure-sql-database/',
  },
  {
    id: 'apl-enhance-agents-autonomous',
    slug: 'enhance-agents-with-autonomous-capabilities',
    code: 'APL-EAA',
    officialCode: 'applied-skill.enhance-agents-with-autonomous-capabilities',
    title: 'Enhance agents with autonomous capabilities',
    area: 'AI Business',
    level: 'Intermediate',
    status: 'active',
    description:
      'Extend AI agents with autonomous planning, memory, and tool-use capabilities using Azure AI Foundry and Semantic Kernel.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/enhance-agents-with-autonomous-capabilities/',
  },
  {
    id: 'generate-reports-with-ai-research-agents',
    slug: 'generate-reports-with-ai-research-agents',
    code: 'APL-GRARA',
    officialCode: 'applied-skill.generate-reports-with-ai-research-agents',
    title: 'Generate reports with AI research agents',
    area: 'AI Business',
    level: 'Beginner',
    status: 'active',
    description: 'Validate hands-on skills for Generate reports with AI research agents.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/generate-reports-with-ai-research-agents/',
  },
  {
    id: 'get-started-developing-agents-in-microsoft-foundry',
    slug: 'get-started-developing-agents-in-microsoft-foundry',
    code: 'APL-GSDAF',
    officialCode: 'applied-skill.get-started-developing-agents-in-microsoft-foundry',
    title: 'Get started developing agents in Microsoft Foundry',
    area: 'AI',
    level: 'Beginner',
    status: 'active',
    description: 'Validate hands-on skills for Get started developing agents in Microsoft Foundry.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/get-started-developing-agents-in-microsoft-foundry/',
  },
  {
    id: 'apl-azure-mgmt-tasks',
    slug: 'get-started-with-azure-management-tasks',
    code: 'APL-AMT',
    officialCode: 'applied-skill.get-started-with-azure-management-tasks',
    title: 'Get started with Azure management tasks',
    area: 'Operations',
    level: 'Beginner',
    status: 'active',
    description:
      'Perform core Azure management tasks including resource groups, RBAC, tags, policies, and cost management.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/get-started-with-azure-management-tasks/',
  },
  {
    id: 'apl-csharp-classes',
    slug: 'get-started-with-classes-properties-and-methods-in-c-sharp',
    code: 'APL-CS',
    officialCode: 'applied-skill.get-started-with-classes-properties-and-methods-in-c-sharp',
    title: 'Get started with classes, properties, and methods in C#',
    area: 'DevTools',
    level: 'Beginner',
    status: 'active',
    description:
      'Understand object-oriented fundamentals in C# — classes, constructors, properties, and methods for .NET development.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/get-started-with-classes-properties-and-methods-in-c-sharp/',
  },
  {
    id: 'apl-cloud-security-monitoring',
    slug: 'get-started-with-cloud-security-and-monitoring-tasks',
    code: 'APL-CSM',
    officialCode: 'applied-skill.get-started-with-cloud-security-and-monitoring-tasks',
    title: 'Get started with cloud security and monitoring tasks',
    area: 'Security',
    level: 'Beginner',
    status: 'active',
    description:
      'Learn foundational cloud security and monitoring concepts using Microsoft Azure tools and best practices.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/get-started-with-cloud-security-and-monitoring-tasks/',
  },
  {
    id: 'apl-entra-identities',
    slug: 'get-started-with-identities-and-access-using-microsoft-entra',
    code: 'APL-EID',
    officialCode: 'applied-skill.get-started-with-identities-and-access-using-microsoft-entra',
    title: 'Get started with identities and access using Microsoft Entra',
    area: 'Security',
    level: 'Beginner',
    status: 'active',
    description:
      'Configure identity and access management fundamentals using Microsoft Entra ID — users, groups, MFA, and Conditional Access.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/get-started-with-identities-and-access-using-microsoft-entra/',
  },
  {
    id: 'apl-fabric-data-warehouse',
    slug: 'work-with-data-warehouses-using-microsoft-fabric',
    code: 'APL-FDW',
    officialCode: 'applied-skill.work-with-data-warehouses-using-microsoft-fabric',
    title: 'Implement a data warehouse in Microsoft Fabric',
    area: 'Data',
    level: 'Intermediate',
    status: 'retired',
    expiryDate: '2026-06-30',
    description:
      'Design and implement a cloud-scale data warehouse using Microsoft Fabric, including data ingestion, modeling, and querying.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/work-with-data-warehouses-using-microsoft-fabric/',
  },
  {
    id: 'apl-fabric-real-time',
    slug: 'implement-a-real-time-intelligence-solution-with-microsoft-fabric',
    code: 'APL-FRT',
    officialCode: 'applied-skill.implement-a-real-time-intelligence-solution-with-microsoft-fabric',
    title: 'Implement a Real-Time Intelligence solution with Microsoft Fabric',
    area: 'Data',
    level: 'Intermediate',
    status: 'active',
    description:
      'Build real-time analytics solutions using Microsoft Fabric Real-Time Intelligence including KQL databases and event streams.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/implement-a-real-time-intelligence-solution-with-microsoft-fabric/',
  },
  {
    id: 'apl-purview-dlp',
    slug: 'implement-information-protection-and-data-loss-prevention-by-using-microsoft-purview',
    code: 'APL-PDLP',
    officialCode:
      'applied-skill.implement-information-protection-and-data-loss-prevention-by-using-microsoft-purview',
    title: 'Implement information protection and data loss prevention by using Microsoft Purview',
    area: 'Security',
    level: 'Intermediate',
    status: 'active',
    description:
      'Configure sensitivity labels, DLP policies, and information protection in Microsoft Purview to safeguard organizational data.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/implement-information-protection-and-data-loss-prevention-by-using-microsoft-purview/',
  },
  {
    id: 'apl-purview-compliance',
    slug: 'implement-retention-ediscovery-and-communication-compliance-in-microsoft-purview',
    code: 'APL-PRC',
    officialCode:
      'applied-skill.implement-retention-ediscovery-and-communication-compliance-in-microsoft-purview',
    title: 'Implement retention, eDiscovery, and Communication Compliance in Microsoft Purview',
    area: 'Security',
    level: 'Intermediate',
    status: 'active',
    description:
      'Configure retention policies, eDiscovery cases, and communication compliance in Microsoft Purview for regulatory requirements.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/implement-retention-ediscovery-and-communication-compliance-in-microsoft-purview/',
  },
  {
    id: 'apl-devops-pipeline-security',
    slug: 'implement-security-through-pipeline-using-devops',
    code: 'APL-DOPS',
    officialCode: 'applied-skill.implement-security-through-pipeline-using-devops',
    title: 'Implement security through a pipeline using Azure DevOps',
    area: 'Security',
    level: 'Intermediate',
    status: 'active',
    description:
      'Implement DevSecOps practices in Azure Pipelines including secret scanning, dependency checks, and secure deployments.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/implement-security-through-pipeline-using-devops/',
  },
  {
    id: 'integrate-model-context-protocol-tools-with-agents-in-microsoft-foundry',
    slug: 'integrate-model-context-protocol-tools-with-agents-in-microsoft-foundry',
    code: 'APL-TMCPO',
    officialCode:
      'applied-skill.integrate-model-context-protocol-tools-with-agents-in-microsoft-foundry',
    title: 'Integrate model context protocol tools with agents in Microsoft Foundry',
    area: 'AI',
    level: 'Intermediate',
    status: 'active',
    description:
      'Validate hands-on skills for Integrate model context protocol tools with agents in Microsoft Foundry.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/integrate-model-context-protocol-tools-with-agents-in-microsoft-foundry/',
  },
  {
    id: 'manage-github-secret-scanning-by-using-github-copilot',
    slug: 'manage-github-secret-scanning-by-using-github-copilot',
    code: 'APL-MGSSG',
    officialCode: 'applied-skill.manage-github-secret-scanning-by-using-github-copilot',
    title: 'Manage GitHub secret scanning by using GitHub Copilot',
    area: 'DevTools',
    level: 'Intermediate',
    status: 'active',
    description:
      'Validate hands-on skills for Manage GitHub secret scanning by using GitHub Copilot.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/manage-github-secret-scanning-by-using-github-copilot/',
  },
  {
    id: 'apl-1008',
    slug: 'migrate-sql-workloads-azure-sql-database',
    code: 'APL-1008',
    officialCode: 'applied-skill.migrate-sql-workloads-azure-sql-database',
    title: 'Migrate SQL Server workloads to Azure SQL Database',
    area: 'Data',
    level: 'Intermediate',
    status: 'active',
    description:
      'Plan and execute SQL Server migrations to Azure SQL Database using Azure Database Migration Service and compatibility assessment.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/migrate-sql-workloads-azure-sql-database/',
  },
  {
    id: 'prepare-security-and-compliance-to-support-microsoft-365-copilot',
    slug: 'prepare-security-and-compliance-to-support-microsoft-365-copilot',
    code: 'APL-PSCS3',
    officialCode: 'applied-skill.prepare-security-and-compliance-to-support-microsoft-365-copilot',
    title: 'Prepare security and compliance to support Microsoft 365 Copilot',
    area: 'Security',
    level: 'Intermediate',
    status: 'retired',
    expiryDate: '2026-06-30',
    description:
      'Validate hands-on skills for Prepare security and compliance to support Microsoft 365 Copilot.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/prepare-security-and-compliance-to-support-microsoft-365-copilot/',
  },
  {
    id: 'protect-information-in-microsoft-365-copilot-by-using-microsoft-purview',
    slug: 'protect-information-in-microsoft-365-copilot-by-using-microsoft-purview',
    code: 'APL-PM3CP',
    officialCode:
      'applied-skill.protect-information-in-microsoft-365-copilot-by-using-microsoft-purview',
    title: 'Protect information in Microsoft 365 Copilot by using Microsoft Purview',
    area: 'Security',
    level: 'Intermediate',
    status: 'active',
    description:
      'Validate hands-on skills for Protect information in Microsoft 365 Copilot by using Microsoft Purview.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/protect-information-in-microsoft-365-copilot-by-using-microsoft-purview/',
  },
  {
    id: 'resolve-github-issues-by-using-github-copilot',
    slug: 'resolve-github-issues-by-using-github-copilot',
    code: 'APL-RGIGC',
    officialCode: 'applied-skill.resolve-github-issues-by-using-github-copilot',
    title: 'Resolve GitHub issues by using GitHub Copilot',
    area: 'DevTools',
    level: 'Intermediate',
    status: 'active',
    description: 'Validate hands-on skills for Resolve GitHub issues by using GitHub Copilot.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/resolve-github-issues-by-using-github-copilot/',
  },
  {
    id: 'apl-secure-ai-cloud',
    slug: 'secure-ai-solutions-in-the-cloud',
    code: 'APL-SAIC',
    officialCode: 'applied-skill.secure-ai-solutions-in-the-cloud',
    title: 'Secure AI solutions in the cloud',
    area: 'Security',
    level: 'Intermediate',
    status: 'active',
    description:
      'Apply security controls and responsible AI practices to protect AI workloads deployed in Azure and Microsoft cloud services.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/secure-ai-solutions-in-the-cloud/',
  },
  {
    id: 'secure-azure-services-and-workloads-with-microsoft-defender-for-cloud-regulatory-compliance-controls',
    slug: 'secure-azure-services-and-workloads-with-microsoft-defender-for-cloud-regulatory-compliance-controls',
    code: 'APL-SSWDC',
    officialCode:
      'applied-skill.secure-azure-services-and-workloads-with-microsoft-defender-for-cloud-regulatory-compliance-controls',
    title:
      'Secure Azure services and workloads with Microsoft Defender for Cloud regulatory compliance controls',
    area: 'Security',
    level: 'Intermediate',
    status: 'active',
    description:
      'Validate hands-on skills for Secure Azure services and workloads with Microsoft Defender for Cloud regulatory compliance controls.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/secure-azure-services-and-workloads-with-microsoft-defender-for-cloud-regulatory-compliance-controls/',
  },
  {
    id: 'apl-1003',
    slug: 'secure-storage-azure-files-azure-blob-storage',
    code: 'APL-1003',
    officialCode: 'applied-skill.secure-storage-azure-files-azure-blob-storage',
    title: 'Secure storage for Azure Files and Azure Blob Storage',
    area: 'Storage',
    level: 'Intermediate',
    status: 'active',
    description:
      'Configure secure access and protect data in Azure Files and Azure Blob Storage using encryption, access policies, and network controls.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/secure-storage-azure-files-azure-blob-storage/',
  },
  {
    id: 'apl-ai-chat-workflows',
    slug: 'streamline-business-workflows-with-ai-chat',
    code: 'APL-ACW',
    officialCode: 'applied-skill.streamline-business-workflows-with-ai-chat',
    title: 'Streamline business workflows with AI chat',
    area: 'AI Business',
    level: 'Beginner',
    status: 'active',
    description:
      'Automate and streamline business workflows using AI chat capabilities in Microsoft 365 Copilot and Copilot Studio.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/streamline-business-workflows-with-ai-chat/',
  },
];

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
