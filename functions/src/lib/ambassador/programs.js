/**
 * The seed programs (ADR 0033 §4): the community programs materialised on
 * the first read of an empty container, and added to an existing one by
 * `ensureSeededPrograms` (steps.js) whenever a new entry appears here. Every
 * field is editable afterwards; the requirements are starting points and say
 * so, because each program publishes its own rules and changes them.
 *
 * The facts below are the program rules as published in 2026, read from the
 * program pages and the official application question lists (owner request
 * 2026-10-05). The questions are the programs' own; no answer is seeded.
 * Docker Captain, Docker-Sponsored Open Source, HashiCorp Ambassador, Coder
 * Champion and GitKraken Ambassador carry the rules their pages published on
 * 2026-10-20, each with its source named in the description; the Evidence
 * tab counts against those, not against a guess.
 *
 * NO PRIVATE LINK IS SEEDED. A program's contribution tracker
 * (`contributionTrackerUrl`) is often a document shared only with its
 * members, and this file is in a public repository, so the owner sets it on
 * Settings and it lives only in the stored program.
 */

const EDIT_NOTE = 'Edit to match the current program rules.';

/** One requirement row; the rule object is what the readiness arithmetic reads. */
const requirement = (id, label, description, { evidenceTypes, minCount, weight }) => ({
  id,
  label,
  description,
  evidenceTypes,
  minCount,
  weight,
});

/** One official application question, in the section the form puts it. */
const question = (id, section, prompt, kind, extra = {}) => ({
  id,
  section,
  prompt,
  kind,
  maxChars: null,
  options: [],
  allowOther: false,
  rows: [],
  maxItems: null,
  hint: '',
  required: false,
  ...extra,
});

const YES_NO_HINT = 'If yes, add one or more supporting activities or events below.';

// ── Microsoft MVP: the official application's sections ──────────────────────

const MVP_PROFILE = 'Profile Information';
const MVP_NETWORK = 'Online Influence & Network';
const MVP_QUESTIONS = 'Application Questions';
const MVP_TECHNOLOGY = 'Technology Area';
const MVP_EXPERTISE = 'Technical Expertise';

const MVP_AWARD_CATEGORIES = [
  'Azure AI Foundry',
  'Business Applications',
  'Cloud and Datacenter Management',
  'Data Platform',
  'Developer Technologies',
  'Internet of Things',
  'M365',
  'Microsoft Azure',
  'Security',
  'Windows Development',
  'Windows and Devices',
];

const MVP_AZURE_AREAS = [
  'Azure Application PaaS',
  'Azure Compute Infrastructure',
  'Azure Cost Resource & Configuration Management',
  'Azure HPC & AI Infrastructure',
  'Azure Hybrid & Migration',
  'Azure Infrastructure as Code',
  'Azure Innovation Hub',
  'Azure Integration PaaS',
  'Azure Kubernetes and Open Source',
  'Azure Networking',
  'Azure Solutions & Ecosystem',
  'Azure Storage',
  'Azure Well-Architected Resiliency & Observability',
  'PowerShell',
].map((area) => `Microsoft Azure: ${area}`);

const MVP_CDM_AREAS = [
  'Datacenter Management (Group Policy, System Center)',
  'Enterprise and Platform Security',
  'High Availability',
  'Hyper-V',
  'Linux on Hyper-V',
  'On-premises and Hybrid AKS Container Management',
  'On-Premises Networking',
  'On-Premises Storage',
  'Windows Server',
].map((area) => `Cloud and Datacenter Management: ${area}`);

const MVP_SECURITY_AREAS = [
  'Cloud Security',
  'Identity & Access',
  'Microsoft Intune',
  'Microsoft Purview',
  'Microsoft Security Copilot',
  'SIEM & XDR',
].map((area) => `Security: ${area}`);

const MVP_DEVELOPER_AREAS = [
  '.NET',
  'C++',
  'Developer Security',
  'Developer Tools',
  'DevOps',
  'Java',
  'Python',
  'Web Development',
].map((area) => `Developer Technologies: ${area}`);

/**
 * The technology areas grouped by award category, for the categories whose
 * published list is in hand; the other seven categories take a typed value
 * (`allowOther`) until their lists are added here.
 */
const MVP_TECHNOLOGY_AREAS = [
  ...MVP_AZURE_AREAS,
  ...MVP_CDM_AREAS,
  ...MVP_SECURITY_AREAS,
  ...MVP_DEVELOPER_AREAS,
];

const MVP_ACTIVITY_TYPES =
  'Activity types and the fields the form asks for: Speaker/Presenter (title, audience, description, private description, primary and additional technology areas, date, in-person attendees, livestream views, on-demand views, URL); Book/E-Book; Open Source/Project/Sample code/Tools; Product Feedback; Blog; Article; Online Support; Mentorship/Coaching; Webinar/Online Training/Video/Livestream; Podcast.';

const MVP_GATES = [
  ['feedback', 'Have you provided product feedback to Microsoft?'],
  ['speaker', 'Have you been a speaker or expert at technical events?'],
  ['events', 'Have you organised or executed technical community events?'],
  ['groups', 'Do you run or own user groups or meetups?'],
  ['content', 'Have you created technical content?'],
  ['support', 'Have you provided online support or moderation via forums?'],
  ['open-source', 'Have you contributed to open source projects in the last 12 months?'],
  ['mentorship', 'Have you provided technical mentorship?'],
];

const MVP_APPLICATION_QUESTIONS = [
  question('mvp-first-name', MVP_PROFILE, 'First name', 'profile'),
  question('mvp-last-name', MVP_PROFILE, 'Last name', 'profile'),
  question('mvp-email', MVP_PROFILE, 'Email', 'profile'),
  question('mvp-country', MVP_PROFILE, 'Country or region', 'profile'),
  question('mvp-city', MVP_PROFILE, 'City', 'profile'),
  question('mvp-networks', MVP_NETWORK, 'Social networks and websites', 'links', {
    options: [
      'LinkedIn',
      'Personal Website',
      'YouTube',
      'GitHub',
      'X',
      'Facebook',
      'Instagram',
      'Bluesky',
      'Mastodon',
      'Other',
    ],
    maxItems: 10,
    hint: 'One row per network: the network and its URL.',
  }),
  question(
    'mvp-influence',
    MVP_NETWORK,
    'How do you leverage your network and influence, both on and offline, to drive positive change?',
    'text',
    { maxChars: 1000 }
  ),
  question('mvp-company-type', MVP_QUESTIONS, 'What type of company do you work for?', 'choice', {
    options: [
      'Microsoft Partner',
      'Independent or self-employed',
      'Enterprise',
      'Small or medium business',
      'Public sector or education',
      'Non-profit',
      'Other',
    ],
  }),
  question('mvp-employer', MVP_QUESTIONS, 'Current Employer/Organization', 'text', {
    maxChars: 200,
  }),
  question('mvp-job-title', MVP_QUESTIONS, 'Job Title', 'text', { maxChars: 200 }),
  question(
    'mvp-mct',
    MVP_QUESTIONS,
    'Do you currently hold membership as a Microsoft Certified Trainer (MCT)?',
    'yesno'
  ),
  question(
    'mvp-previous',
    MVP_QUESTIONS,
    'Have you previously been awarded Microsoft MVP?',
    'yesno'
  ),
  question('mvp-why', MVP_QUESTIONS, 'Describe why you want to be an MVP', 'text', {
    maxChars: 1000,
  }),
  question(
    'mvp-student-ambassador',
    MVP_QUESTIONS,
    'Are you a current or former Microsoft Learn Student Ambassador or Microsoft Student Partner?',
    'yesno'
  ),
  question('mvp-award-category', MVP_TECHNOLOGY, 'Award Category', 'choice', {
    options: MVP_AWARD_CATEGORIES,
  }),
  question('mvp-technology-area', MVP_TECHNOLOGY, 'Primary Technology Area', 'choice', {
    options: MVP_TECHNOLOGY_AREAS,
    allowOther: true,
    hint: 'Grouped by award category where the published list is known (Microsoft Azure, Cloud and Datacenter Management, Security, Developer Technologies). For another category choose Other and type the area as the form lists it.',
  }),
  question('mvp-technology-areas-more', MVP_TECHNOLOGY, 'Additional Technology Areas', 'text', {
    maxChars: 500,
    hint: 'Comma separated, from the same list as the primary area.',
  }),
  ...MVP_GATES.map(([id, prompt]) =>
    question(`mvp-gate-${id}`, MVP_EXPERTISE, prompt, 'yesno', { hint: YES_NO_HINT })
  ),
  question(
    'mvp-activities',
    MVP_EXPERTISE,
    'Supporting activities and events from the past 12 months',
    'activities',
    { maxItems: 24, hint: MVP_ACTIVITY_TYPES }
  ),
  question(
    'mvp-help-others',
    MVP_EXPERTISE,
    'How do you use your knowledge and skills to help others?',
    'text',
    { maxChars: 1000 }
  ),
  question(
    'mvp-moving-forward',
    MVP_EXPERTISE,
    'How would you support the community with your technical knowledge and skills moving forward?',
    'text',
    { maxChars: 1000 }
  ),
];

// ── Microsoft Elevate Educator – Expert: the 2026-2027 question list ────────

const MIEE_ABOUT = 'About You';
const MIEE_LEARNING = 'Learning Paths';
const MIEE_TOOLS = 'How You Use Microsoft Tools';
const MIEE_AI = 'AI in Your Practice';

const MIEE_FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Rarely', 'Never'];

const MIEE_TOOL_ROWS = [
  'Microsoft Teams in an instructional environment',
  'Copilot Chat',
  'Microsoft 365 Copilot',
  'Copilot Agents',
  'Reading Coach / Reading Progress',
  'Math Coach / Math Progress',
  'Speaker Coach / Speaker Progress',
  'Immersive Reader',
  'Reflect',
  'Microsoft Forms',
  'Teach Module in the Microsoft 365 Copilot App',
  'Microsoft Study & Learn in the Microsoft 365 Copilot App',
  'OneNote',
  'Minecraft Education',
  'Sharing teaching and learning knowledge with colleagues',
];

const MIEE_PROFILE_FIELDS = [
  ['first-name', 'First name'],
  ['last-name', 'Last name'],
  ['personal-email', 'Personal email'],
  ['org-email', 'Organisation email'],
  ['org-name', 'Organisation name'],
  ['org-type', 'Organisation type'],
  ['address', 'Address'],
  ['city', 'City'],
  ['state', 'State or province'],
  ['country', 'Country or region'],
  ['website', 'Organisation website'],
  ['age-range', 'Age range taught'],
  ['role', 'Current role'],
  ['subjects', 'Subjects taught'],
];

const MIEE_APPLICATION_QUESTIONS = [
  ...MIEE_PROFILE_FIELDS.map(([id, prompt]) =>
    question(`miee-${id}`, MIEE_ABOUT, prompt, 'profile')
  ),
  question(
    'miee-school-program',
    MIEE_ABOUT,
    'Is your organisation a Showcase School, a Pathfinder School, or neither?',
    'choice',
    { options: ['Showcase School', 'Pathfinder School', 'Neither'] }
  ),
  question(
    'miee-path-general',
    MIEE_LEARNING,
    'Have you completed the Elevate Educator – Expert (General) learning path?',
    'yesno'
  ),
  question(
    'miee-path-ai',
    MIEE_LEARNING,
    'Have you completed the Elevate Educator – Expert (AI) learning path?',
    'yesno'
  ),
  question('miee-learn-url', MIEE_LEARNING, 'Share the URL to your achievements in Learn', 'url'),
  question('miee-frequency', MIEE_TOOLS, 'How often do you use each of the following?', 'scale', {
    rows: MIEE_TOOL_ROWS,
    options: MIEE_FREQUENCIES,
  }),
  question('miee-ai-tool', MIEE_AI, 'Select an AI tool that you use', 'choice', {
    options: [
      'Copilot Chat',
      'Microsoft 365 Copilot',
      'Microsoft Teach/Study/Learn in the Microsoft 365 Copilot App',
      'Minecraft Education + AI Worlds',
      'Microsoft Designer',
      'Copilot Agents',
    ],
  }),
  question(
    'miee-ai-example',
    MIEE_AI,
    'Share one example of how you used this AI tool in your role as an educator. What was created or improved, how did you adapt it for your context, and how did it support learners or colleagues?',
    'text',
    { maxChars: 2000 }
  ),
  question(
    'miee-ai-support',
    MIEE_AI,
    'How do you see Microsoft and this community supporting you in navigating AI in your role?',
    'text',
    { maxChars: 2000 }
  ),
];

// ── Microsoft Management Community: recognition by credits ──────────────────

const MANAGEMENT_TIERS = [
  ['Community Contributor', 10],
  ['Community Advocate', 20],
  ['Management Community Champion', 25],
  ['Management Community Influencer', 50],
  ['Management Community Leader', 75],
  ['Community Rockstar', 100],
];

const CREDIT_NOTE =
  'Credits as published for 2025: Survey 1, Focus Group or Design Exercise 3, Private Preview 3 to 6. Record each as manual evidence with its credits; readiness sums them.';


// ── MCT Regional Lead: the role requirements as the nominee answers them ─────
//
// Microsoft publishes the role's requirements and expectations ("MCT Regional
// Lead Team — Role Requirements & Expectations"), not the October form's
// questions: the form goes only to nominees. So the questions below are the
// document's own requirements and expectations, each asked as the thing a
// nominee must show or commit to. Edit them against the form when the
// invitation arrives; the answers are the applicant's and never seeded.

const RL_NOMINATION = 'Nomination and eligibility';
const RL_COMMUNITY = 'MCT community support';
const RL_EXPECTATIONS = 'Role expectations';

const MCT_REGIONAL_LEAD_QUESTIONS = [
  question(
    'rl-nominated-by',
    RL_NOMINATION,
    'Which current MCT Regional Lead nominated you, and in which country or region?',
    'text',
    {
      maxChars: 300,
      required: true,
      hint: 'A nomination by a current Regional Lead during September starts the process; an active Regional Lead may self-nominate.',
    }
  ),
  question(
    'rl-consecutive-years',
    RL_NOMINATION,
    'How many consecutive years have you held MCT status?',
    'choice',
    {
      options: ['2', '3', '4', '5 or more'],
      required: true,
      hint: 'Two consecutive years of MCT status are required to be nominated.',
    }
  ),
  question(
    'rl-certifications',
    RL_NOMINATION,
    'Which MCT-eligible Microsoft certifications do you hold? List each one.',
    'text',
    {
      maxChars: 1000,
      required: true,
      hint: 'Two or more MCT-eligible certifications are required. The Certifications hub is the record.',
    }
  ),
  question(
    'rl-lounge-activity',
    RL_COMMUNITY,
    'Describe your involvement in the MCT Lounge: discussions started or answered in the Community Café, and how you have helped distribute MCT Program Announcements.',
    'text',
    {
      maxChars: 2000,
      required: true,
      hint: 'Dated posts and threads make the strongest answer; the Evidence tab holds the log.',
    }
  ),
  question(
    'rl-community-support',
    RL_COMMUNITY,
    'What MCT community support activities have you led or taken part in — mentoring new trainers, promoting MCT career opportunities, local or virtual MCT events?',
    'activities',
    { maxItems: 12, required: true }
  ),
  question(
    'rl-regional-hub',
    RL_COMMUNITY,
    'How would you support and curate your Regional Hub: discussions on its forum, new or localised articles on its blog, events on its calendar?',
    'text',
    { maxChars: 2000 }
  ),
  question(
    'rl-commitments',
    RL_EXPECTATIONS,
    'Confirm you can meet the role expectations for the full one-year term (1 January to 31 December).',
    'scale',
    {
      rows: [
        'Review the Regional Lead Team channels weekly',
        'Attend the monthly Regional Lead meetings and periodic discussion sessions',
        'Monitor the MCT Community Café and answer MCT questions',
        'Promote the MCT Program Announcements blog',
        'Promote the Regional Hub among MCTs in your area',
        'Plan virtual or in-person local events',
      ],
      options: ['Yes', 'Partly', 'No'],
      required: true,
    }
  ),
  question(
    'rl-why',
    RL_EXPECTATIONS,
    'Why do you want to be an MCT Regional Lead, and what would MCTs in your region gain from it?',
    'text',
    { maxChars: 2000, required: true }
  ),
];

// ── GitKraken Ambassador: the published tiers and the check-in's focus ──────
//
// The tiers are the programme page's (https://www.gitkraken.com/ambassador,
// read 2026-10-20); the focus is what the quarterly check-in of 2026-10-08
// asked for, and stays as the recommended activities.

const GITKRAKEN_TIERS = [
  'Content Creator: 2+ pieces of content per quarter featuring or mentioning GitKraken (tutorials, videos, blog posts)',
  'Influencer: 2+ posts a quarter on X, LinkedIn, YouTube or Twitch',
  'Community Ambassador: 2+ reviews or helpful posts a quarter on Reddit, G2 or Quora',
  'Feature Tester',
  'Event Host: events for 30+ developers',
  'Programme-wide: follow the brand guidelines, show the GitKraken logo on your site and profiles, complete the quarterly check-in form',
];

const GITKRAKEN_FOCUS = [
  'Reviews of GitKraken on G2, Capterra and TrustRadius',
  'Creating and commenting on Reddit threads',
  'LinkedIn and Medium articles that use data: how much time was saved, how many commits',
  'Sharing GitKraken content, dropped weekly in the ambassadors’ Slack',
  'YouTube videos on the themed focus: Merge Conflicts, Dev AI Use, Commit Graph',
];

/** The one GitKraken requirement, worded for the revision that reads it. */
const gitkrakenQuarterly = (description) =>
  requirement('quarterly-content', 'Content pieces in a quarter', description, {
    evidenceTypes: [],
    minCount: 2,
    weight: 1,
  });

// ── Docker Captain: the three tracks (https://www.docker.com/community/captains/) ──

const DOCKER_CAPTAIN_TRACKS = [
  'Docker Advisor: a recommendation from a Docker engineering or product member',
  'Docker Thought Leader: 5,000 or more monthly views across blogs, social media or other online avenues',
  'Docker Community Contributor: five or more years of community leadership or aiding individuals online',
  'Sail the extra mile: several tracks, a Docker member or Captain who vouches, an underrepresented group, a region of interest, an innovative application',
];

/**
 * Docker Captain's counted rows since revision 2, with the evidence types
 * its hands-on row lists. Revision 3 (#1302) took `manual` off `labs`:
 * readiness (readiness.js) matches a row to a requirement by sourceModule
 * alone, and the monthly audience rows (lib/timers/ambassador-audience.js)
 * are manual, filed under `reach`, so with `manual` here two audience months
 * would read as "Hands-on material" met with no lab on file. Revision 2's
 * list keeps `manual` in SUPERSEDED_SEED_VALUES, so a stored, unedited
 * revision-2 seed is recognised and brought up.
 */
const dockerCaptainRequirements = (labsEvidenceTypes) => [
  requirement(
    'reach',
    'Monthly audience',
    `The Thought Leader track’s line: 5,000 or more monthly views across blogs, social media or other online avenues. One measured audience figure — the site’s monthly views, recorded as evidence with the number — meets it; the figure, not the row count, is what Docker reads. ${EDIT_NOTE}`,
    { evidenceTypes: ['manual'], minCount: 1, weight: 3 }
  ),
  requirement('content', 'Docker content', `Articles, guides and videos on Docker. ${EDIT_NOTE}`, {
    evidenceTypes: ['content', 'newsletter'],
    minCount: 4,
    weight: 2,
  }),
  requirement(
    'community',
    'Community leadership',
    `Helping people with Docker and leading in its community: questions answered, talks given, groups run. ${EDIT_NOTE}`,
    { evidenceTypes: ['manual', 'speaking'], minCount: 2, weight: 2 }
  ),
  requirement('labs', 'Hands-on material', `Labs, repositories, Compose examples. ${EDIT_NOTE}`, {
    evidenceTypes: labsEvidenceTypes,
    minCount: 2,
    weight: 1,
  }),
];

/**
 * Seed values a later seed replaced, by program id: the seed's `revisions`,
 * ascending, each the `revision` that landed and the `fields` it replaced
 * (the values the revision before it seeded). A stored seed below the last
 * revision whose field still equals a value recorded by any revision above
 * its own never had that field edited, so the backfill (steps.js) gives it
 * the current seed's value, once, and stamps `seedRevision` at the last
 * revision. A field the owner changed is left alone, and after the stamp
 * so is one the owner later sets back to an old value on purpose
 * (CodeRabbit on #1077). A program seeded fresh is stamped at creation.
 *
 * The whole history is kept, not only the last step, so a row that missed
 * a revision (seeded by #873, never read while revision 2 was current) is
 * still matched against the values it holds and corrected, rather than
 * stamped current with the guess kept (CodeRabbit on #1304).
 *
 * GitKraken Ambassador's first seed (#873) guessed its rules ("As published
 * 2026; edit to match"); revision 2 (#1077) took the quarterly check-in of
 * 2026-10-08 (two or more content pieces a quarter, logged on its tracker);
 * revision 3 (2026-10-20) words the same rule as the programme page's tiers.
 * Docker Captain's first seed guessed too; revision 2 (2026-10-20) carries
 * the tracks and the term from docker.com and the join form, with a `reach`
 * requirement that counts `manual` evidence; revision 3 (#1302) takes
 * `manual` off its `labs` requirement, so the monthly audience rows the
 * timer files under `reach` do not read as hands-on material
 * (`dockerCaptainRequirements` above says why). Microsoft MVP's revision 2
 * (#1302) adds `manual` to its `reach` requirement for the same rows. A
 * requirements list the owner edited is left as it is. The two window
 * revisions (MIEE, AWS Community Builders) move a window the year has passed
 * into the coming cycle; MIEE's description and its "apply before" line roll
 * with it, so the seed does not contradict its own window. MCT Regional
 * Lead's October 2026 window is open until 2026-10-31 and is not moved: a
 * stored row would show it a year away while it is live. It rolls to
 * October 2027 in November.
 *
 * FOR THE OWNER, BEHAVIOUR AND NOT A BUG: readiness (readiness.js) counts a
 * row that names no program (`programIds: []`) toward EVERY program, so a
 * general manual row the owner files by hand counts toward both `reach`
 * requirements as well. The audience timer's rows name their program and
 * count for that one only.
 */
/** One step of a seed's history: the revision that landed and the values it replaced. */
const revised = (revision, fields) => Object.freeze({ revision, fields: Object.freeze(fields) });

export const SUPERSEDED_SEED_VALUES = Object.freeze({
  'program-microsoft-mvp': Object.freeze({
    revisions: Object.freeze([
      // Revision 2 (#1302) added `manual` to `reach`, for the monthly audience rows.
      revised(2, {
        requirements: [
          requirement(
            'talks',
            'Speaking engagements',
            `Sessions delivered at conferences, user groups or online events. ${EDIT_NOTE}`,
            { evidenceTypes: ['speaking'], minCount: 4, weight: 3 }
          ),
          requirement(
            'articles',
            'Published content',
            `Articles, tutorials or documentation published publicly. ${EDIT_NOTE}`,
            { evidenceTypes: ['content', 'newsletter'], minCount: 6, weight: 3 }
          ),
          requirement(
            'depth',
            'Technical depth',
            `Certifications or labs that evidence depth in the award category. ${EDIT_NOTE}`,
            { evidenceTypes: ['certifications', 'labs'], minCount: 1, weight: 1 }
          ),
          requirement(
            'reach',
            'Audio and video',
            `Podcast episodes, recordings or Listen & Learn chapters. ${EDIT_NOTE}`,
            { evidenceTypes: ['listen-and-learn'], minCount: 2, weight: 1 }
          ),
        ],
      }),
    ]),
  }),
  'program-gitkraken-ambassador': Object.freeze({
    revisions: Object.freeze([
      // Revision 2 (#1077) replaced the first seed's guess (#873).
      revised(2, {
        description:
          'GitKraken Ambassadors: community advocates for GitKraken’s tools who create content, speak and support users around Git and developer tooling; benefits include licences and early access. Applications through the form on the programme page. As published 2026; edit to match.',
        criteria: ['Content', 'Speaking', 'Supporting users'],
        renewalCadence: 'annual',
        expirationRule: 'Reviewed annually. As published 2026; edit to match.',
        requirements: [
          requirement(
            'content',
            'Git and tooling content',
            `Articles, videos or posts on Git and developer tooling. ${EDIT_NOTE}`,
            { evidenceTypes: ['content'], minCount: 3, weight: 3 }
          ),
          requirement('talks', 'Speaking', `Sessions on Git workflows and tooling. ${EDIT_NOTE}`, {
            evidenceTypes: ['speaking'],
            minCount: 1,
            weight: 2,
          }),
          requirement('tutorials', 'Tutorials and labs', `Hands-on tutorials and labs. ${EDIT_NOTE}`, {
            evidenceTypes: ['labs', 'content'],
            minCount: 1,
            weight: 1,
          }),
        ],
        recommendedActivities: [
          'Publish Git workflow tutorials',
          'Answer questions in the GitKraken community',
        ],
      }),
      // Revision 3 (2026-10-20) replaced the check-in wording of 2026-10-08.
      revised(3, {
        description:
          'GitKraken Ambassadors: community advocates for GitKraken’s tools who create content, speak and support users around Git and developer tooling; benefits include licences and early access. Two or more content pieces a quarter keep a membership active, each logged on the program’s contribution tracker on that quarter’s tab (the program’s quarterly check-in, October 2026).',
        criteria: GITKRAKEN_FOCUS,
        requirements: [
          gitkrakenQuarterly(
            `At least 2 a quarter keep the membership active: a review, a Reddit thread, an article, a shared GitKraken post or a video, each logged on the contribution tracker. Readiness over one quarter’s dates is that quarter’s count. ${EDIT_NOTE}`
          ),
        ],
        recommendedActivities: [
          'Log each piece on the contribution tracker, on the quarter’s tab, when it is published',
          'In articles, use data: the time saved, the commits, the conflicts resolved',
          'Re-share the GitKraken content dropped weekly in the ambassadors’ Slack',
          'A YouTube video on one theme: Merge Conflicts, Dev AI Use or Commit Graph',
          'A review on G2, Capterra or TrustRadius',
        ],
      }),
    ]),
  }),
  'program-docker-captain': Object.freeze({
    revisions: Object.freeze([
      revised(2, {
        description:
          'Docker Captains: technology experts and leaders in the Docker community who share their knowledge. Selected by Docker.',
        applicationUrl: 'https://www.docker.com/community/captains/',
        eligibility: [
          'Demonstrated Docker expertise',
          'Regular public Docker content or speaking',
          'Not a Docker employee',
        ],
        criteria: ['Expertise', 'Community sharing', 'Consistency'],
        applicationWindow: {
          opens: null,
          closes: null,
          note: 'Selection by Docker; express interest through the program page.',
        },
        expirationRule: 'Reviewed annually.',
        requirements: [
          requirement('content', 'Docker content', `Articles and guides on Docker. ${EDIT_NOTE}`, {
            evidenceTypes: ['content', 'newsletter'],
            minCount: 4,
            weight: 3,
          }),
          requirement('talks', 'Docker talks', `Sessions on containers and Docker. ${EDIT_NOTE}`, {
            evidenceTypes: ['speaking'],
            minCount: 2,
            weight: 2,
          }),
          requirement(
            'labs',
            'Hands-on material',
            `Labs, repositories, Compose examples. ${EDIT_NOTE}`,
            { evidenceTypes: ['labs', 'manual'], minCount: 2, weight: 1 }
          ),
        ],
        recommendedActivities: [
          'Publish Docker Desktop and image-building guides',
          'Speak at a Docker community event',
        ],
      }),
      // Revision 3 (#1302) took `manual` off `labs`; the other rows are unchanged.
      revised(3, { requirements: dockerCaptainRequirements(['labs', 'manual']) }),
    ]),
  }),
  'program-microsoft-elevate-educator-expert': Object.freeze({
    revisions: Object.freeze([
      revised(2, {
        description:
          'Microsoft Elevate Educator – Expert, the programme formerly called Microsoft Innovative Educator Expert (MIEE): educators who use Microsoft tools and AI to change learning, selected each year through an application. The 2026-2027 application opens in May 2026 and closes 31 July 2026, with announcements in September 2026 (FAQ: aka.ms/EducatorFAQ). The questions below are the official 2026-2027 list; program rules as published 2026.',
        applicationWindow: {
          opens: '2026-05-01',
          closes: '2026-07-31',
          note: 'Applications May to 31 July 2026; announcements September 2026.',
        },
        recommendedActivities: [
          'Finish both Expert learning paths before the window opens',
          'Keep one worked AI example with what was created or improved',
          'Apply before 31 July 2026',
        ],
      }),
    ]),
  }),
  'program-aws-community-builders': Object.freeze({
    revisions: Object.freeze([
      revised(2, {
        applicationWindow: {
          opens: null,
          closes: null,
          note: 'Waitlist open now; the application cycle has opened once a year, in January. Edit to match.',
        },
      }),
    ]),
  }),
});

/** The revision a program's seed is at now: its last superseded step, or null without a history. */
export const currentSeedRevision = (programId) =>
  SUPERSEDED_SEED_VALUES[programId]?.revisions.at(-1).revision ?? null;

export const DEFAULT_PROGRAMS = Object.freeze([
  {
    id: 'program-microsoft-mvp',
    name: 'Microsoft MVP',
    provider: 'Microsoft',
    category: 'community-expert',
    description:
      'Microsoft Most Valuable Professional: recognises exceptional technical community leadership over the previous twelve months. Nomination by a Microsoft employee or an existing MVP. The application questions below mirror the official form (program rules as published 2026); up to 24 activities or events from the past 12 months may be tagged.',
    applicationUrl: 'https://mvp.microsoft.com/',
    eligibility: [
      'Nominated by a Microsoft full-time employee or a current MVP',
      'Community contributions in the twelve months before review',
      'Not a Microsoft employee',
    ],
    criteria: ['Impact', 'Quality', 'Breadth', 'Technical expertise'],
    applicationWindow: {
      opens: null,
      closes: null,
      note: 'Rolling nominations; reviewed monthly.',
    },
    renewalCadence: 'annual',
    expirationRule: 'Award year runs 1 July to 30 June; renewal reviews the prior year.',
    requirements: [
      requirement(
        'talks',
        'Speaking engagements',
        `Sessions delivered at conferences, user groups or online events. ${EDIT_NOTE}`,
        { evidenceTypes: ['speaking'], minCount: 4, weight: 3 }
      ),
      requirement(
        'articles',
        'Published content',
        `Articles, tutorials or documentation published publicly. ${EDIT_NOTE}`,
        { evidenceTypes: ['content', 'newsletter'], minCount: 6, weight: 3 }
      ),
      requirement(
        'depth',
        'Technical depth',
        `Certifications or labs that evidence depth in the award category. ${EDIT_NOTE}`,
        { evidenceTypes: ['certifications', 'labs'], minCount: 1, weight: 1 }
      ),
      requirement(
        'reach',
        'Audience and reach',
        `Podcast episodes, recordings or Listen & Learn chapters, and the monthly audience figure the site records (page views and podcast downloads). ${EDIT_NOTE}`,
        { evidenceTypes: ['listen-and-learn', 'manual'], minCount: 2, weight: 1 }
      ),
    ],
    recommendedActivities: [
      'Speak at two or more community events a quarter',
      'Publish one article a month on the award technology',
      'Keep every contribution dated and linked',
    ],
    applicationQuestions: MVP_APPLICATION_QUESTIONS,
  },
  {
    id: 'program-microsoft-mct',
    name: 'Microsoft Certified Trainer',
    provider: 'Microsoft',
    category: 'training',
    description:
      'MCT: the premier technical and instructional experts on Microsoft technologies. Requires a qualifying certification and instructional experience; renewed annually. The MCT Lounge on the Microsoft Tech Community is the community platform. A classes-delivered export (the Metrics That Matter CSV: class id, course, learning method, instructor, start and end date, location) is the evidence of delivery — import it on the Evidence tab as "MCT classes (Metrics That Matter CSV)". Program rules as published 2026.',
    applicationUrl: 'https://learn.microsoft.com/credentials/certifications/mct-certification',
    eligibility: [
      'Hold at least one qualifying Microsoft certification',
      'Demonstrate instructional skills (certification or verified experience)',
      'Pay the annual program fee',
      'Renew every year before the membership anniversary',
    ],
    criteria: ['Qualifying certification', 'Instructional competence', 'Classes delivered'],
    applicationWindow: { opens: null, closes: null, note: 'Apply any time; renew annually.' },
    renewalCadence: 'annual',
    expirationRule: 'Expires one year from enrolment unless renewed.',
    requirements: [
      requirement(
        'cert',
        'Qualifying certification',
        `An active, qualifying Microsoft certification. ${EDIT_NOTE}`,
        { evidenceTypes: ['certifications'], minCount: 1, weight: 4 }
      ),
      requirement(
        'teaching',
        'Instructional evidence',
        `Delivered training, workshops or sessions, including classes imported from the Metrics That Matter CSV. ${EDIT_NOTE}`,
        { evidenceTypes: ['speaking', 'listen-and-learn', 'manual'], minCount: 2, weight: 2 }
      ),
    ],
    recommendedActivities: [
      'Renew the qualifying certification before it lapses',
      'Export the classes-delivered report from Metrics That Matter and import it as evidence',
      'Stay active in the MCT Lounge on the Microsoft Tech Community',
      'Once Active: the MCT Regional Lead role opens as additional requirements',
    ],
  },
  {
    id: 'program-aws-community-hero',
    name: 'AWS Community Hero',
    provider: 'AWS',
    category: 'community-expert',
    description:
      'AWS Heroes: recognises individuals with an outsized impact on the AWS community through content, speaking and mentorship. By invitation.',
    applicationUrl: 'https://aws.amazon.com/developer/community/heroes/',
    eligibility: [
      'Sustained AWS community contributions',
      'Nominated by AWS or an existing Hero',
      'Not an AWS employee',
    ],
    criteria: ['Community impact', 'Consistency', 'Expertise'],
    applicationWindow: { opens: null, closes: null, note: 'Invitation only; no open application.' },
    renewalCadence: 'ongoing',
    expirationRule: 'Reviewed on an ongoing basis.',
    requirements: [
      requirement('talks', 'AWS talks', `Sessions on AWS topics. ${EDIT_NOTE}`, {
        evidenceTypes: ['speaking'],
        minCount: 4,
        weight: 3,
      }),
      requirement('content', 'AWS content', `Articles and tutorials on AWS. ${EDIT_NOTE}`, {
        evidenceTypes: ['content', 'newsletter'],
        minCount: 6,
        weight: 3,
      }),
      requirement('certs', 'AWS certifications', `Active AWS certifications. ${EDIT_NOTE}`, {
        evidenceTypes: ['certifications'],
        minCount: 2,
        weight: 1,
      }),
    ],
    recommendedActivities: [
      'Lead or speak at an AWS user group',
      'Publish re:Invent recap and deep-dive content',
    ],
  },
  {
    id: 'program-aws-ambassador',
    name: 'AWS Ambassador',
    provider: 'AWS',
    category: 'partner',
    description:
      'AWS Ambassador Program: for technical experts at AWS Partner Network organisations who share AWS knowledge publicly. Two levels for the Services Partner, Technical Leader persona (program rules as published 2026): Charter (Associate) — 2 Professional or Specialty certifications, 8 contributions a year, at least 4 of them thought leadership; Established — Solutions Architect Professional plus a Specialty, 12 contributions a year, 4 thought leadership (at least 2 blog or article) and 4 Capability Building or Customer Engagement contributions.',
    applicationUrl: 'https://aws.amazon.com/partners/ambassadors/',
    eligibility: [
      'Employed by an AWS Partner Network organisation (Services Partner)',
      'Charter level: 2 AWS Professional or Specialty certifications',
      'Established level: AWS Solutions Architect Professional plus a Specialty certification',
      'Public AWS contributions in the three categories below',
    ],
    criteria: [
      'Customer Engagement contributions',
      'Capability Building contributions',
      'Thought Leadership: Article, Blog, Podcast, Presentation, Vlog, Webinar, Whitepaper',
      'A blog post counts with its URL, at least 1,000 words of core content, level 200+ depth, original work, at most 2 authors and a clear company affiliation',
    ],
    applicationWindow: {
      opens: null,
      closes: null,
      note: 'Rolling, through the partner organisation.',
    },
    renewalCadence: 'annual',
    expirationRule: 'Annual requalification against the contribution counts of the level held.',
    requirements: [
      requirement(
        'certs',
        'Professional or Specialty certifications',
        `Charter level: 2 Professional or Specialty certifications; Established level: Solutions Architect Professional plus a Specialty. ${EDIT_NOTE}`,
        { evidenceTypes: ['certifications'], minCount: 2, weight: 3 }
      ),
      requirement(
        'contributions',
        'Contributions per year',
        `Every contribution in the three categories: Charter level 8 a year, Established level 12. ${EDIT_NOTE}`,
        {
          evidenceTypes: ['content', 'speaking', 'listen-and-learn', 'manual'],
          minCount: 8,
          weight: 3,
        }
      ),
      requirement(
        'thought-leadership',
        'Thought leadership',
        `Article, Blog, Podcast, Presentation, Vlog, Webinar or Whitepaper; at least 4 a year at either level, at least 2 of them blog or article at Established level. A blog post needs its URL, 1,000+ words of core content, level 200+ depth, original work, at most 2 authors and a clear company affiliation. ${EDIT_NOTE}`,
        { evidenceTypes: ['content', 'speaking', 'listen-and-learn'], minCount: 4, weight: 2 }
      ),
      requirement(
        'capability-customer',
        'Capability Building and Customer Engagement',
        `Established level only: 4 Capability Building or Customer Engagement contributions a year (workshops, enablement, customer sessions). Set the minimum to 0 while applying at Charter level. ${EDIT_NOTE}`,
        { evidenceTypes: ['manual', 'speaking', 'labs'], minCount: 4, weight: 1 }
      ),
    ],
    recommendedActivities: [
      'Track contributions by category against the level applied for',
      'Renew certifications ahead of the requalification date',
      'Keep each blog post over 1,000 words of core content with the company affiliation stated',
    ],
  },
  {
    id: 'program-github-star',
    name: 'GitHub Star',
    provider: 'GitHub',
    category: 'community-expert',
    description:
      'GitHub Stars: recognises developers who inspire and educate the community, through open source, content and events. Nomination based.',
    applicationUrl: 'https://stars.github.com/',
    eligibility: [
      'Nominated through the GitHub Stars site',
      'Public, sustained community contribution',
      'Not a GitHub or Microsoft employee',
    ],
    criteria: ['Inspiration', 'Education', 'Open source leadership'],
    applicationWindow: { opens: null, closes: null, note: 'Nominations open year-round.' },
    renewalCadence: 'annual',
    expirationRule: 'Reviewed annually.',
    requirements: [
      requirement(
        'content',
        'Educational content',
        `Articles, videos or courses on GitHub and developer workflow. ${EDIT_NOTE}`,
        { evidenceTypes: ['content', 'listen-and-learn', 'newsletter'], minCount: 6, weight: 3 }
      ),
      requirement('talks', 'Community talks', `Sessions and workshops. ${EDIT_NOTE}`, {
        evidenceTypes: ['speaking'],
        minCount: 3,
        weight: 2,
      }),
      requirement(
        'labs',
        'Open source and labs',
        `Repositories, labs and hands-on material. ${EDIT_NOTE}`,
        { evidenceTypes: ['labs', 'manual'], minCount: 2, weight: 2 }
      ),
    ],
    recommendedActivities: [
      'Maintain public repositories with clear READMEs',
      'Publish GitHub Actions and Copilot walkthroughs',
    ],
  },
  {
    id: 'program-docker-captain',
    name: 'Docker Captain',
    provider: 'Docker',
    category: 'community-expert',
    description:
      'Docker Captains: technical experts and community leaders who share Docker knowledge, give product feedback and hold a strong online presence with a significant audience. Applicants join through at least one track — Docker Advisor (a recommendation from a Docker engineering or product member), Docker Thought Leader (5,000 or more monthly views across blogs, social media or other online avenues) or Docker Community Contributor (five or more years of community leadership or aiding individuals online) — and may "sail the extra mile" through several tracks, a Docker member or Captain who vouches, an underrepresented group, a region of interest or an innovative application. A one-year term, renewed when the joining criteria are kept up with continuous contribution, evaluated by Docker at term end; no numeric content quota is published. Rolling applications through the Advocu join form; interviews have been reported a month or more after applying. Perks: beta access, a private Slack with Docker staff, an annual offsite, an education budget for Docker training and discounts on Docker Pro and partner products (not free seats or a pull-rate exemption). Program rules as published at docker.com/community/captains and the join form, read 2026-10-20.',
    applicationUrl: 'https://app.advocu.com/dockercaptains/join',
    eligibility: [
      '18 or older; open internationally',
      'Technical expertise in Docker and containers',
      'Active community involvement and thought leadership',
      'Product feedback to Docker',
      'A strong online presence with a significant audience',
      'Abide by Docker’s code of conduct',
      'At least one track: Docker Advisor, Docker Thought Leader or Docker Community Contributor (the criteria below)',
    ],
    criteria: DOCKER_CAPTAIN_TRACKS,
    applicationWindow: {
      opens: null,
      closes: null,
      note: 'Rolling applications through the Advocu join form; interviews reported a month or more after applying.',
    },
    renewalCadence: 'annual',
    expirationRule:
      'One-year term; renewal needs the joining criteria kept up and continuous contribution, evaluated by Docker at term end.',
    requirements: dockerCaptainRequirements(['labs']),
    recommendedActivities: [
      'Publish a monthly view figure for the site and record it as evidence',
      'Docker tutorials built from the lab images',
      'Answer questions in the Docker community Slack',
    ],
  },
  {
    id: 'program-vmware-vexpert',
    name: 'VMware vExpert',
    provider: 'Broadcom (VMware)',
    category: 'community-expert',
    description:
      'vExpert: recognises VMware community contributors — bloggers, speakers, book authors and community leaders — through an annual application.',
    applicationUrl: 'https://vexpert.vmware.com/',
    eligibility: [
      'Public VMware community contributions in the prior year',
      'Application in the annual window',
      'Any employer',
    ],
    criteria: ['Evangelist path', 'Customer path', 'Partner path'],
    applicationWindow: {
      opens: null,
      closes: null,
      note: 'Annual window, usually opening in the first quarter.',
    },
    renewalCadence: 'annual',
    expirationRule: 'Calendar-year award; apply again each cycle.',
    requirements: [
      requirement(
        'content',
        'VMware content',
        `Blog posts, podcasts and videos on VMware. ${EDIT_NOTE}`,
        { evidenceTypes: ['content', 'listen-and-learn', 'newsletter'], minCount: 6, weight: 3 }
      ),
      requirement('talks', 'VMware talks', `VMUG and conference sessions. ${EDIT_NOTE}`, {
        evidenceTypes: ['speaking'],
        minCount: 2,
        weight: 2,
      }),
      requirement('certs', 'VMware certifications', `Active VMware certifications. ${EDIT_NOTE}`, {
        evidenceTypes: ['certifications'],
        minCount: 1,
        weight: 1,
      }),
    ],
    recommendedActivities: [
      'Apply in the annual window',
      'Keep a dated log of VMUG sessions and posts',
    ],
  },
  {
    id: 'program-microsoft-elevate-educator-expert',
    name: 'Microsoft Elevate Educator – Expert (MIEE)',
    provider: 'Microsoft',
    category: 'education',
    description:
      'Microsoft Elevate Educator – Expert, the programme formerly called Microsoft Innovative Educator Expert (MIEE): educators who use Microsoft tools and AI to change learning, selected each year through an application. The 2027-2028 application is expected to open in May 2027 and close 31 July 2027, with announcements in September 2027, on the 2026 cycle’s pattern (FAQ: aka.ms/EducatorFAQ). The questions below are the official 2026-2027 list; program rules as published 2026.',
    applicationUrl: 'https://aka.ms/EducatorFAQ',
    eligibility: [
      'A Microsoft Elevate Educator – Explorer, or a returning Expert',
      'The Elevate Educator – Expert (General) learning path on Microsoft Learn',
      'The Elevate Educator – Expert (AI) learning path on Microsoft Learn',
      'The application asks for the URL of your Learn achievements',
    ],
    criteria: [
      'Regular use of Microsoft tools in teaching',
      'One worked example of an AI tool in practice',
      'Sharing teaching and learning knowledge with colleagues',
    ],
    applicationWindow: {
      opens: '2027-05-01',
      closes: '2027-07-31',
      note: 'Applications May to 31 July 2027, on the 2026 cycle’s pattern; announcements September 2027. Edit to match when the FAQ publishes the 2027-2028 dates.',
    },
    renewalCadence: 'annual',
    expirationRule: 'One school year; returning Experts apply again each cycle.',
    requirements: [
      requirement(
        'content',
        'Teaching and learning content',
        `Lessons, guides or posts on teaching with Microsoft tools. ${EDIT_NOTE}`,
        { evidenceTypes: ['content'], minCount: 2, weight: 2 }
      ),
      requirement(
        'sharing',
        'Sharing with colleagues',
        `Sessions, workshops or training delivered to other educators. ${EDIT_NOTE}`,
        { evidenceTypes: ['speaking'], minCount: 1, weight: 2 }
      ),
      requirement(
        'labs',
        'Hands-on examples',
        `Classroom examples, labs or worked activities with an AI tool. ${EDIT_NOTE}`,
        { evidenceTypes: ['labs'], minCount: 1, weight: 1 }
      ),
    ],
    recommendedActivities: [
      'Finish both Expert learning paths before the window opens',
      'Keep one worked AI example with what was created or improved',
      'Apply before 31 July 2027',
    ],
    applicationQuestions: MIEE_APPLICATION_QUESTIONS,
  },
  {
    id: 'program-gitkraken-ambassador',
    name: 'GitKraken Ambassador',
    provider: 'GitKraken',
    category: 'developer-advocacy',
    description:
      'GitKraken Ambassadors: community advocates for GitKraken’s tools, in the tiers the programme page publishes — Content Creator (2+ pieces of content per quarter featuring or mentioning GitKraken: tutorials, videos, blog posts), Influencer (2+ posts a quarter on X, LinkedIn, YouTube or Twitch), Community Ambassador (2+ reviews or helpful posts a quarter on Reddit, G2 or Quora), Feature Tester and Event Host (30+ developers). Programme-wide asks: follow the brand guidelines, show the GitKraken logo on your site and profiles, complete the quarterly check-in form. Perks: GitKraken Advanced, swag, a feature on the site, Slack access, monthly Git Togethers and early access. Each quarter’s pieces are logged on the program’s contribution tracker on that quarter’s tab (the quarterly check-in, October 2026). Program rules as published at gitkraken.com/ambassador, read 2026-10-20.',
    applicationUrl: 'https://www.gitkraken.com/ambassador',
    eligibility: [
      'Active content creation or community activity around Git and developer tooling',
      'An application through the form on the programme page',
    ],
    criteria: GITKRAKEN_TIERS,
    applicationWindow: { opens: null, closes: null, note: 'Rolling applications.' },
    renewalCadence: 'quarterly',
    expirationRule:
      'Active while 2 or more content pieces are logged on the contribution tracker each quarter; the program checks the tracker when the quarter ends.',
    requirements: [
      gitkrakenQuarterly(
        `The Content Creator tier: at least 2 pieces of content a quarter featuring or mentioning GitKraken — a tutorial, a video, a blog post, a review, a Reddit thread or a shared GitKraken post — each logged on the contribution tracker. Readiness over one quarter’s dates is that quarter’s count. The logo on the site and the quarterly check-in form are asked of every tier and are not counted here; the model counts evidence only. ${EDIT_NOTE}`
      ),
    ],
    recommendedActivities: [
      'Log each piece on the contribution tracker, on the quarter’s tab, when it is published',
      'Show the GitKraken logo on the site and on profiles, as the brand guidelines say',
      'Complete the quarterly check-in form when the quarter ends',
      'In articles, use data: the time saved, the commits, the conflicts resolved',
      'Re-share the GitKraken content dropped weekly in the ambassadors’ Slack',
      'A YouTube video on one theme: Merge Conflicts, Dev AI Use or Commit Graph',
      'A review on G2, Capterra or TrustRadius',
    ],
    upkeep: {
      period: 'quarter',
      minCount: 2,
      evidenceTypes: [],
      note: 'Two or more content pieces each quarter keep the membership active. Log each one on the contribution tracker, on that quarter’s tab; the program checks the tracker when the quarter ends.',
    },
  },
  {
    id: 'program-microsoft-management-community',
    name: 'Microsoft Management Community',
    provider: 'Microsoft',
    category: 'customer-connection',
    description:
      'The Microsoft Management Customer Connection Program: private communities for Intune, Windows and devices, the Windows Cloud Experience and Generative AI, where members take surveys, join focus groups and design exercises and test private previews. Recognition is by credits, with badges at each threshold across all private communities and a Top Monthly Partner/Customer Champion bonus (+5 credits, once, for 5 or more credits in a month). Program rules as published 2026.',
    applicationUrl: null,
    eligibility: [
      'Membership of a Microsoft Management private community',
      'Participation in surveys, focus groups, design exercises and private previews',
    ],
    criteria: [
      'Survey: 1 credit',
      'Focus Group or Design Exercise: 3 credits',
      'Private Preview: 3 to 6 credits',
      'Top Monthly Partner/Customer Champion: +5 credits once, for 5 or more credits in a month',
    ],
    applicationWindow: { opens: null, closes: null, note: 'Rolling; badges per calendar year.' },
    renewalCadence: 'annual',
    expirationRule: 'Badges are earned per calendar year; credits start again in January.',
    scoring: {
      unit: 'credits',
      tiers: MANAGEMENT_TIERS.map(([label, credits]) => ({ label, credits })),
    },
    requirements: MANAGEMENT_TIERS.map(([label, credits]) =>
      requirement(
        `tier-${credits}`,
        `${label} (${credits} credits)`,
        `${CREDIT_NOTE} ${EDIT_NOTE}`,
        {
          evidenceTypes: ['manual'],
          minCount: credits,
          weight: 1,
        }
      )
    ),
    recommendedActivities: [
      'Record each survey, focus group and preview as manual evidence with its credits',
      'Reach 5 credits in one month for the Top Monthly bonus',
    ],
  },
  {
    id: 'program-microsoft-mct-regional-lead',
    // Additional to MCT (owner request 2026-10-05): the card, the questions
    // and Start application appear only while the MCT membership is Active,
    // and MCT evidence counts here too (readiness.js, model.js programGate).
    parentProgramId: 'program-microsoft-mct',
    name: 'MCT Regional Lead',
    provider: 'Microsoft',
    category: 'training',
    description:
      'MCT Regional Lead: a one-year term role (1 January to 31 December) for around 100 MCTs a year who support their region’s MCT community. Nomination by a current Regional Lead in September, the application form in October, the team announced 1 December. Expectations: the weekly Regional Lead Teams channels, monthly meetings, MCT Lounge activity (Community Café, Program Announcements) and the Regional Hub (discussions, localised articles, local events). Program rules as published 2026.',
    applicationUrl: 'https://learn.microsoft.com/credentials/certifications/mct-certification',
    eligibility: [
      'Two consecutive years of MCT status',
      'Two or more MCT-eligible Microsoft certifications',
      'Evidence of MCT community support and active involvement in the MCT Lounge',
      'Nominated by a current Regional Lead',
    ],
    criteria: [
      'MCT Lounge activity (Community Café, Program Announcements)',
      'Regional Hub: discussions, localised articles, local events',
      'Weekly Regional Lead Teams channels and monthly meetings',
    ],
    applicationWindow: {
      opens: '2026-10-01',
      closes: '2026-10-31',
      note: 'Nominations in September; application form in October; team announced 1 December.',
    },
    renewalCadence: 'annual',
    expirationRule: 'One-year term, 1 January to 31 December; apply again each year.',
    requirements: [
      requirement(
        'lounge',
        'MCT Lounge activity',
        `Posts, answers and Community Café participation in the MCT Lounge, recorded by hand. ${EDIT_NOTE}`,
        { evidenceTypes: ['manual'], minCount: 4, weight: 3 }
      ),
      requirement(
        'local-events',
        'Local events',
        `Regional sessions, workshops or local events delivered. ${EDIT_NOTE}`,
        { evidenceTypes: ['speaking', 'labs'], minCount: 1, weight: 2 }
      ),
      requirement(
        'certs',
        'MCT-eligible certifications',
        `Two or more active MCT-eligible Microsoft certifications. ${EDIT_NOTE}`,
        { evidenceTypes: ['certifications'], minCount: 2, weight: 2 }
      ),
    ],
    recommendedActivities: [
      'Ask a current Regional Lead for a nomination in September',
      'Keep a dated log of MCT Lounge posts and Regional Hub articles',
      'Hold two consecutive years of MCT status before the window',
    ],
    applicationQuestions: MCT_REGIONAL_LEAD_QUESTIONS,
  },
  {
    id: 'program-aws-community-builders',
    name: 'AWS Community Builders',
    provider: 'AWS',
    category: 'community-expert',
    description:
      'AWS Community Builders: technical resources, education and networking for AWS enthusiasts and emerging thought leaders who share knowledge with the technical community. AWS subject matter experts run sessions on new services, on creating technical content and on growing its reach. The program accepts a limited number of members a year and welcomes every AWS builder. Program page as published October 2026, which offers a waitlist.',
    applicationUrl: 'https://builder.aws.com/community/community-builders',
    eligibility: [
      'Open to every AWS builder',
      'Join the waitlist from the program page; the form needs an AWS Builder ID sign-in',
    ],
    criteria: [
      'Content creation',
      'Community engagement',
      'Sharing knowledge with others',
      'No single criterion decides it (AWS, announcing the program)',
    ],
    applicationWindow: {
      opens: null,
      closes: null,
      note: 'Annual cycle; the 2026 applications closed 2026-01-21; the next cycle opens in January 2027 (waitlist on builder.aws.com)',
    },
    renewalCadence: 'annual',
    expirationRule: `A one-year membership; renewal looks at continued community engagement. ${EDIT_NOTE}`,
    requirements: [
      requirement('content', 'AWS content', `Public articles, videos or tutorials on AWS. ${EDIT_NOTE}`, {
        evidenceTypes: ['content', 'newsletter', 'listen-and-learn'],
        minCount: 4,
        weight: 3,
      }),
      requirement(
        'community',
        'Community engagement',
        `Talks, user groups, meetups, workshops or answering questions. ${EDIT_NOTE}`,
        { evidenceTypes: ['speaking', 'labs', 'manual'], minCount: 2, weight: 2 }
      ),
      requirement('certs', 'AWS certifications', `Not required; they show depth. ${EDIT_NOTE}`, {
        evidenceTypes: ['certifications'],
        minCount: 1,
        weight: 1,
      }),
    ],
    recommendedActivities: [
      'Join the waitlist now, from the program page',
      'Pick the category to apply in; the member list shows Containers, Serverless, AI Engineering, Security, Dev Tools, Data, Machine Learning, Networking and Content Delivery, and Cloud Operations',
      'Publish AWS content on public platforms in the months before the January cycle',
    ],
  },
  {
    id: 'program-docker-sponsored-oss',
    name: 'Docker-Sponsored Open Source',
    provider: 'Docker',
    // A sponsorship of a project, not a recognition of a person: the nearest
    // of the categories in use is the partner one AWS Ambassador carries.
    category: 'partner',
    description:
      'Docker-Sponsored Open Source (DSOS): Docker’s sponsorship for non-commercial open source projects published on Docker Hub. A sponsored project gets the verified badge, pull-rate-limit removal on its public images, a free one-year Docker Team subscription for its core contributors, Docker Scout on up to 100 repositories and pull analytics; it is renewable yearly, and a paid Docker subscription and DSOS are mutually exclusive. Rolling applications through the form linked from the application page. Program rules as published at docker.com/community/open-source/application and docs.docker.com (the dsos-program page), read 2026-10-20.',
    applicationUrl: 'https://www.docker.com/community/open-source/application/',
    eligibility: [
      'Shared in public repositories on Docker Hub',
      'Meets the Open Source Initiative definition of open source',
      'In active development on Docker Hub: updates within the past 6 months',
      'No pathway to commercialization: the organization must not seek to make a profit through services or by charging for higher tiers; accepting donations to sustain the effort is permissible',
    ],
    criteria: [
      'Public Docker Hub repositories under an OSI-approved licence',
      'Updates within the past six months',
      'Non-commercial: no paid tiers or services; donations allowed',
      'A paid Docker subscription and DSOS are mutually exclusive',
    ],
    applicationWindow: {
      opens: null,
      closes: null,
      note: 'Rolling; the application form is linked from the application page.',
    },
    renewalCadence: 'annual',
    expirationRule: 'Sponsorship for one year, renewable yearly against the same eligibility.',
    requirements: [
      requirement(
        'images',
        'Public Hub images under a licence',
        `Public Docker Hub images of the project, each with an OSI-approved licence. ${EDIT_NOTE}`,
        { evidenceTypes: ['labs', 'manual'], minCount: 1, weight: 3 }
      ),
      requirement(
        'activity',
        'Active development',
        `An update to the project on Docker Hub within the past six months, recorded by hand with its date. ${EDIT_NOTE}`,
        { evidenceTypes: ['manual'], minCount: 1, weight: 2 }
      ),
    ],
    recommendedActivities: [
      'Publish the lab images to a public Docker Hub namespace with the licence in the README',
      'Push an update at least every six months and record each as evidence',
      'Apply through the form on the application page',
    ],
  },
  {
    id: 'program-hashicorp-ambassador',
    name: 'HashiCorp Ambassador',
    provider: 'HashiCorp',
    category: 'community-expert',
    description:
      'HashiCorp Ambassadors: community members recognised each year for knowledge sharing, mentorship and kindness, through content creation, local events and productive, thoughtful feedback, with adherence to the HashiCorp Principles and community guidelines. Nominations come from community members and employees, and self-nomination is allowed; a submission must give specific examples from the preceding twelve months. The award expires each year and ambassadors reapply. Perks on the page: a care package, product release briefings, roadmap reviews, feedback sessions, and collaboration on blogs, videos, certification development and talks. Program rules as published at hashicorp.com/ambassador, read 2026-10-20.',
    applicationUrl: 'https://www.hashicorp.com/en/ambassador',
    eligibility: [
      'The three pillars: knowledge sharing, mentorship and kindness',
      'Contributions in content creation, local events or productive, thoughtful feedback',
      'Adherence to the HashiCorp Principles and community guidelines',
      'Specific examples from the preceding twelve months in the submission',
      'Self-nomination allowed; nominations also come from community members and employees',
    ],
    criteria: [
      'Knowledge sharing',
      'Mentorship',
      'Kindness',
      'Content creation',
      'Local events',
      'Productive, thoughtful feedback',
    ],
    applicationWindow: {
      opens: '2026-12-01',
      closes: '2027-01-05',
      note: 'Submissions open annually 1 December to 5 January; the submission form is only live inside the window; sign up for the notification form on the programme page.',
    },
    renewalCadence: 'annual',
    expirationRule: 'The award expires each year; ambassadors reapply in the next window.',
    requirements: [
      requirement(
        'content',
        'Terraform and HashiCorp content',
        `Articles, videos, newsletter issues or episodes on Terraform and the HashiCorp tools, from the preceding twelve months. ${EDIT_NOTE}`,
        { evidenceTypes: ['content', 'newsletter', 'listen-and-learn'], minCount: 3, weight: 3 }
      ),
      requirement(
        'mentorship',
        'Mentorship',
        `People mentored, workshops run or labs built for others, recorded by hand where no module holds them. ${EDIT_NOTE}`,
        { evidenceTypes: ['manual', 'speaking', 'labs'], minCount: 1, weight: 2 }
      ),
      requirement(
        'events',
        'Local events and talks',
        `A HashiCorp User Group, meetup or conference session. ${EDIT_NOTE}`,
        { evidenceTypes: ['speaking'], minCount: 1, weight: 1 }
      ),
      requirement(
        'feedback',
        'Product feedback',
        `Productive, thoughtful feedback to HashiCorp — issues, RFC comments, feedback sessions — recorded by hand. ${EDIT_NOTE}`,
        { evidenceTypes: ['manual'], minCount: 1, weight: 1 }
      ),
    ],
    recommendedActivities: [
      'File every Terraform contribution of the last twelve months with its URL and date',
      'One talk before December',
      'Sign the notification form on the programme page',
    ],
  },
  {
    id: 'program-coder-champion',
    name: 'Coder Champion',
    provider: 'Coder',
    category: 'developer-advocacy',
    description:
      'Coder Champions: Coder’s community advocates, self-nominated through the form linked from the programme page. The published criteria: take part in five community chats, star the Coder GitHub repository and help at least two people in #help on the Coder Discord. A year-long programme followed by quarterly activity audits, after which members advance, stay or move to an Alumni circle. Perks: a Discord badge, a swag box, a private kickoff with the Coder team and early roadmap access, plus a premium licence and Champions-only office hours (Coder’s community post of 2026-02-09). Program rules as published at coder.com/coder-champions and coder.com/community, read 2026-10-20.',
    applicationUrl: 'https://coder.com/coder-champions',
    eligibility: [
      'Participation in five community chats',
      'The Coder GitHub repository starred',
      'At least two people helped in #help on the Coder Discord',
      'Self-nomination through the form on the programme page',
    ],
    criteria: [
      'Five community chats',
      'Star the Coder GitHub repository',
      'Help two people in #help on the Coder Discord',
    ],
    applicationWindow: { opens: null, closes: null, note: 'Rolling; no cohort dates.' },
    renewalCadence: 'annual',
    expirationRule: 'Year-long programme; quarterly activity audits after the first year.',
    requirements: [
      requirement(
        'chats',
        'Community chats',
        `Coder community chats taken part in, one row each, recorded by hand with the date. ${EDIT_NOTE}`,
        { evidenceTypes: ['manual'], minCount: 5, weight: 2 }
      ),
      requirement(
        'help',
        'People helped in #help',
        `Questions answered in #help on the Coder Discord, one row per person helped. ${EDIT_NOTE}`,
        { evidenceTypes: ['manual'], minCount: 2, weight: 3 }
      ),
      requirement(
        'star',
        'Repository starred',
        `The Coder GitHub repository starred, recorded once by hand. ${EDIT_NOTE}`,
        { evidenceTypes: ['manual'], minCount: 1, weight: 1 }
      ),
      requirement(
        'templates',
        'Public Coder templates and labs',
        `Public Coder templates and the labs built on them. ${EDIT_NOTE}`,
        { evidenceTypes: ['labs'], minCount: 1, weight: 2 }
      ),
    ],
    recommendedActivities: [
      'Record each community chat as manual evidence on the day',
      'Answer two questions in #help on the Coder Discord and log each',
      'Publish the lab host’s Coder templates and file them as labs evidence',
    ],
  },
]);
