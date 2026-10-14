/**
 * FinOps Foundation certification catalogue for /finops/education (#461,
 * item 11).
 *
 * Extracted from src/pages/finops/EducationPage.jsx, which carried the four
 * rows hard-coded with no record of when anyone had checked them. Verified
 * 2026-09-09 against learn.finops.org, where finops.org/certification/ now
 * redirects (301):
 *
 *   FinOps Certified Practitioner — listed, active, "Valid for 24 months",
 *     no formal prerequisites, self-paced course + exam $500, exam only $325
 *     (50 questions, 1 hour, 75% to pass).
 *     https://learn.finops.org/path/finops-certified-practitioner-self-paced
 *     https://learn.finops.org/finops-certified-practitioner-certification-exam
 *   FinOps Certified Professional — listed, active, Advanced, $500, "Valid
 *     for 24 Months"; enrolment requires a Practitioner or Engineer
 *     certification and six months of FinOps experience, and the exam
 *     requires the AI Value and Technology Value certifications plus a
 *     Professional Contribution.
 *     https://learn.finops.org/path/finops-certified-professional
 *   FinOps Certified Engineer — listed, active, Intermediate, "Self-paced +
 *     Exam Bundle: 10 hours; Exam only: 1 hour", exam only $325. This file
 *     used to call it "FinOps Engineer".
 *     https://learn.finops.org/page/finops-certified-engineer
 *   "FinOps for Platform Engineers" — no such certification is listed. The
 *     nearest thing, the "FinOps for Engineers" training course (a course,
 *     never a certification), reads "Not currently available" on
 *     https://learn.finops.org/path/finops-for-engineers and is absent from
 *     the catalogue. Kept as `retired` with that evidence rather than
 *     deleted; the Foundation publishes no retirement date for it. Its
 *     replacement on this page is the Engineer certification.
 *
 * The Foundation publishes no exam codes. `FOCP` is its own abbreviation
 * for the Practitioner credential (its badge assets are named `focpicon`);
 * the other `code` values are this site's labels, kept for the card layout
 * and the learning-path keys, not vendor identifiers.
 *
 * Re-verified 2026-09-09 (#469 item 2) against the Foundation's own catalogue
 * at https://learn.finops.org/, which lists SIX certifications. The three the
 * first pass left out are now carried, each with the Foundation's own price,
 * exam level and validity from the page cited on the row:
 *
 *   FinOps Certified FOCUS Analyst — $400, "Exam Level: Intermediate",
 *     self-paced with 12 months of access to course materials, "Duration
 *     6 hours (approximately)", "Your certification is valid for 24 months".
 *     For anyone who generates, ingests, interprets or analyses billing and
 *     usage datasets aligned to the FOCUS specification.
 *     https://learn.finops.org/finops-certified-focus-analyst-certification
 *   FinOps Certified: AI Value — $500, five modules (Introduction, Levels
 *     1-3 and the certification exam) tagged Beginner through Advanced,
 *     valid for 24 months. Designed for FinOps Practitioners, or anyone
 *     applying the Framework to AI spend.
 *     https://learn.finops.org/path/certified-finops-for-ai
 *   FinOps Certified: Technology Value — $500, "Exam Level: Intermediate",
 *     six modules (FinOps Scopes, Public Cloud, SaaS, Data Center, Data
 *     Cloud Platform and the exam), valid for 24 months. For Practitioners
 *     extending a practice beyond public cloud.
 *     https://learn.finops.org/path/technology-value
 *
 * The Foundation lists AI Value and Technology Value as requirements of the
 * Professional exam, which is why the Professional row already named them
 * before they were carried here.
 *
 * `level` IS THIS SITE'S VOCABULARY, not the Foundation's. The page filters
 * and colours on three values — Practitioner, Professional, Expert — and the
 * Foundation grades exams Beginner/Intermediate/Advanced, which do not line
 * up: it rates the *Practitioner* exam Intermediate. So the Foundation's own
 * grade is stated in each row's description and `level` carries the role, as
 * it already did for Engineer. All three new rows are `Professional`.
 *
 * The Engineer page states no validity of its own; its recertification exam
 * does — "The renewed certification is valid for 24 months from the date the
 * recertification exam is passed" — which is where that row's 24 months comes
 * from (https://learn.finops.org/finops-certified-engineer-recertification-exam,
 * read 2026-09-09). Every other row's page states it directly.
 *
 * `hours` is only set where the Foundation publishes a duration. It does so
 * for FOCUS Analyst (6) and not for AI Value or Technology Value, which it
 * sizes in modules; the card omits the badge rather than carrying a guess.
 *
 * Re-verified 2026-09-10 (#469 item 2, second pass) against the Foundation's
 * catalogue at https://learn.finops.org/, which still lists exactly these six
 * certifications at exactly these prices — Practitioner $500 / exam-only $325,
 * AI Value $500 over 5 modules, Technology Value $500 over 6 modules,
 * Professional $500 over 4 modules, FOCUS Analyst $400, Engineer $500 /
 * exam-only $325 — and still does not list "FinOps for Engineers" at all,
 * which is what keeps that row `retired`. Pages read again the same day:
 *
 *   https://learn.finops.org/finops-certified-focus-analyst-certification —
 *     "Exam Level: Intermediate", "Self-paced", "12 Month access to course
 *     materials", "Duration 6 hours (approximately)", "$400", "Your
 *     certification is valid for 24 months". Unchanged.
 *   https://learn.finops.org/path/certified-finops-for-ai — "$500", five
 *     modules, "Once you pass the FinOps Certified: AI Value exam: Valid for
 *     24 months". Unchanged.
 *   https://learn.finops.org/path/technology-value — "$500", six modules,
 *     "Valid for 24 months". Unchanged.
 *   https://learn.finops.org/path/finops-certified-practitioner-self-paced —
 *     "$500", "Exam-only $325", "Valid for 24 months". Unchanged.
 *   https://learn.finops.org/path/finops-certified-professional — "$500",
 *     "Valid for 24 Months", and the one row that changed: see below.
 *
 * THE PROFESSIONAL EXAM NOW REQUIRES THREE CERTIFICATIONS, not two. The
 * Professional path page lists, under "To access the FinOps Certified
 * Professional exam, learners must", holding a FinOps Certified: AI Value
 * certification, a FinOps Certified FOCUS Analyst certification and a FinOps
 * Certified: Technology Value certification, then completing the Professional
 * Contribution. The Foundation's own FAQ says the same in one sentence — "To
 * sit for the exam, you must hold active FinOps Certified FOCUS Analyst,
 * FinOps Certified: AI Value, and FinOps Certified: Technology Value
 * certifications" (https://www.finops.org/training-certification/training-faqs/).
 * FOCUS Analyst was not in that list on 2026-09-09 and the row said so; it is
 * now, and the row says so.
 *
 * One inconsistency in the Foundation's own copy, recorded rather than
 * resolved: FOCUS Analyst's certification page says the credential is valid
 * for 24 months, while its recertification page
 * (https://learn.finops.org/finops-certified-focus-analyst-recertification)
 * says "The renewed certification is valid for 12 months from the date the
 * recertification exam is passed". The row carries the 24 months the
 * certification page states, because that is the figure for earning it.
 *
 * `status` and any dates are read through `@/lib/certStatus` at render time;
 * `src/data/education-catalogues.test.js` fails when a dated row is past.
 *
 * DATA_AS_OF is 2026-09-10 and not 2026-09-11 on purpose: the checks above ran
 * at 2026-09-11T04:10Z, which is still 2026-09-10 on the local calendar that
 * `todayIso()` — and therefore the "is DATA_AS_OF in the future" assertion —
 * reads. The earlier of the two days is the one that is true for every viewer.
 */
export const DATA_AS_OF = '2026-09-10';

export const DATA_SOURCE = {
  label: 'FinOps Foundation training catalogue',
  url: 'https://learn.finops.org/',
};

export const certifications = [
  {
    id: 'focp',
    slug: 'focp',
    code: 'FOCP',
    title: 'FinOps Certified Practitioner',
    level: 'Practitioner',
    status: 'active',
    description:
      'Demonstrate foundational knowledge of FinOps principles, cloud cost management, the FOCUS 1.4 specification, allocation, and optimization patterns. The self-paced course plus exam is $500, the exam alone $325 (50 questions, one hour, 75% to pass), and the credential is valid for 24 months.',
    topics: ['Cloud Cost Management', 'FOCUS 1.4', 'Allocation', 'Optimization'],
    hours: 20,
    prepTime: '~4 weeks',
    featured: true,
    learnUrl: 'https://learn.finops.org/path/finops-certified-practitioner-self-paced',
  },
  {
    id: 'fopa',
    slug: 'fopa',
    code: 'FOPA',
    title: 'FinOps for Engineers',
    level: 'Practitioner',
    status: 'retired',
    replacement: { code: 'FOCE', slug: 'foce' },
    description:
      'A training course, not a certification, for engineers working with FinOps teams. The Foundation lists it as not currently available; the FinOps Certified Engineer credential covers this ground.',
    topics: ['Tagging', 'Budgets', 'Alerts', 'Showback', 'Chargeback'],
    hours: 15,
    prepTime: '~3 weeks',
    featured: false,
    learnUrl: 'https://learn.finops.org/path/finops-for-engineers',
  },
  {
    id: 'focb',
    slug: 'focb',
    code: 'FOCB',
    title: 'FinOps Certified Professional',
    level: 'Professional',
    status: 'active',
    description:
      'Lead FinOps strategy and governance across multi-cloud environments with benchmarking and executive-level reporting. Requires a Practitioner or Engineer certification and six months of FinOps experience, and the exam additionally requires active FOCUS Analyst, AI Value and Technology Value certifications plus a completed Professional Contribution. The Foundation rates it Advanced, prices it at $500, and the credential is valid for 24 months.',
    topics: ['Strategy', 'Governance', 'Multi-Cloud', 'Benchmarking'],
    hours: 40,
    prepTime: '~3 months',
    featured: false,
    learnUrl: 'https://learn.finops.org/path/finops-certified-professional',
  },
  {
    id: 'foce',
    slug: 'foce',
    code: 'FOCE',
    title: 'FinOps Certified Engineer',
    level: 'Professional',
    status: 'active',
    description:
      'Implement FinOps tooling, FOCUS 1.4 schema pipelines, and automation to operationalize cloud financial management. The Foundation rates it Intermediate, sizes the self-paced course plus exam at about ten hours, prices that bundle at $500 and the exam alone at $325, and the credential is valid for 24 months.',
    topics: ['FOCUS 1.4 Schema', 'Data Pipelines', 'FinOps Tooling', 'Automation'],
    hours: 10,
    prepTime: '~2 weeks',
    featured: false,
    learnUrl: 'https://learn.finops.org/page/finops-certified-engineer',
  },
  {
    id: 'fofa',
    slug: 'fofa',
    code: 'FOFA',
    title: 'FinOps Certified FOCUS Analyst',
    level: 'Professional',
    status: 'active',
    description:
      'Work with cloud cost and usage data in the vendor-neutral FOCUS 1.4 format — generating, ingesting, interpreting and analysing billing datasets across providers. The Foundation rates the exam Intermediate, prices it at $400, sizes the self-paced course at about six hours with twelve months of access, and the credential is valid for 24 months.',
    topics: [
      'FOCUS 1.4 Specification',
      'Billing Data',
      'Usage Datasets',
      'Vendor-Neutral Reporting',
    ],
    hours: 6,
    prepTime: '~1 week',
    featured: false,
    learnUrl: 'https://learn.finops.org/finops-certified-focus-analyst-certification',
  },
  {
    id: 'foav',
    slug: 'foav',
    code: 'FOAV',
    title: 'FinOps Certified: AI Value',
    level: 'Professional',
    status: 'active',
    description:
      'Apply the FinOps Framework to AI spend — cost allocation and anomaly detection for AI workloads, forecasting and budget governance, then workload and rate optimization, unit economics and cost-efficient system design. Five modules graded Beginner through Advanced, $500, valid for 24 months, and one of the two certifications the Professional exam requires.',
    topics: ['AI Cost Allocation', 'Training vs Inference', 'GPU Spend', 'Unit Economics'],
    prepTime: '~4 weeks',
    featured: false,
    learnUrl: 'https://learn.finops.org/path/certified-finops-for-ai',
  },
  {
    id: 'fotv',
    slug: 'fotv',
    code: 'FOTV',
    title: 'FinOps Certified: Technology Value',
    level: 'Professional',
    status: 'active',
    description:
      'Use FinOps Scopes to define what a practice covers, then apply the Framework across public cloud, data centre, SaaS and data cloud platforms — the categories where billing data, purchasing and capacity planning each behave differently. Six modules, exam rated Intermediate, $500, valid for 24 months, and the second certification the Professional exam requires.',
    topics: ['FinOps Scopes', 'Public Cloud', 'SaaS', 'Data Center', 'Data Cloud Platform'],
    prepTime: '~4 weeks',
    featured: false,
    learnUrl: 'https://learn.finops.org/path/technology-value',
  },
];
