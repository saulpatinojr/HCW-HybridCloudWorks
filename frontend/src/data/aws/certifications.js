/**
 * AWS certification catalogue — the single source for /aws/education and
 * /aws/education/:certSlug (#461).
 *
 * Until this file existed the landing page and the detail page each carried
 * their own twelve-item copy and both were stale in the same ways. Verified
 * 2026-09-09 against aws.amazon.com/certification (exam list, coming-soon
 * page, and the September 2026 Training and Certification blog):
 *
 *   SOA-C02 SysOps was replaced by SOA-C03 CloudOps Engineer on 2025-09-30.
 *   MLA-C01 last English test day 2026-09-28; MLA-C02 beta from 2026-09-29,
 *     GA 2027-01-14.
 *   SAP-C02 last test day 2026-11-16; SAP-C03 registration 2026-10-27,
 *     GA 2026-11-17.
 *   DVA-C02 last test day 2026-11-30; DVA-C03 registration 2026-10-27,
 *     GA 2026-12-01.
 *   ANS-C01 is being retired; last test day 2026-12-31, no successor.
 *   AWS Certified AI Business Strategist (AIB-C01) is a beta exam, open now.
 *
 * Re-verified row by row on 2026-09-10 for #469, against the per-exam pages
 * under aws.amazon.com/certification/<exam>/ (cloud-practitioner,
 * ai-practitioner, ai-business-strategist, solutions-architect-associate,
 * cloudops-engineer-associate, developer-associate, data-engineer-associate,
 * machine-learning-engineer-associate, generative-ai-developer-professional,
 * solutions-architect-professional, devops-engineer-professional,
 * security-specialty, advanced-networking-specialty), the September 2026
 * Training and Certification blog (/blogs/training-and-certification/
 * september-2026-new-offerings/), and the SCS-C03 announcement blog
 * (/blogs/training-and-certification/big-news-aws-expands-ai-certification-
 * portfolio-and-updates-security-certification/). What that turned up:
 *
 *   SCS-C02 was not current and had not been for nine months. The last day
 *     to take SCS-C02 was 2025-12-01 and SCS-C03 replaced it; the exam guide
 *     this file already linked is titled "AWS Certified Security - Specialty
 *     (SCS-C03)" and carries an appendix comparing SCS-C02 with SCS-C03.
 *     The row now reads SCS-C03, with `previousSlugs` keeping /scs-c02 alive
 *     the way SOA-C03 does for /soa-c02.
 *   Every other code, title, level and date above re-confirmed unchanged.
 *     AIB-C01 is still in beta (Business category, 85 questions / 170
 *     minutes, USD 50 beta and USD 100 standard, Early Adopter badge for
 *     passing by 2027-02-15) and AWS still publishes no beta end date, so
 *     the row carries none. SAA-C03 is still current — no SAA-C04 exists;
 *     only its Italian language version retires after 2026-12-31.
 *
 * One conflict, left unresolved on purpose. The SAP and DVA exam pages read
 * "The last day to take the current exam (SAP-C02) is November 17, 2026" and
 * "... (DVA-C02) is December 1, 2026" — each one day later than the same
 * announcement's own Key dates block, which reads "November 16, 2026 – Last
 * day to take SAP-C02 / November 17, 2026 – SAP-C03 GA delivery begins" and
 * "November 30, 2026 – Last day to take DVA-C02 / December 1, 2026 – DVA-C03
 * GA delivery begins". The blog's table is internally consistent and the
 * marketing blurb is not, so the file keeps the blog's dates. Likewise
 * MLA-C02's exam page now shows "TBD" for GA registration and GA delivery
 * while the blog still names 2027-01-14; the specific date is kept until AWS
 * contradicts it rather than merely stops repeating it. Both are worth a
 * second look the next time this file is opened.
 *
 * Second look, 2026-09-29 (#818): unchanged on all three pages. The SAP-C02
 * and DVA-C02 exam pages
 * (/certification/certified-solutions-architect-professional/,
 * /certification/certified-developer-associate/) still say November 17 and
 * December 1. The September blog's Key dates still say November 16 and
 * November 30, with GA delivery the day after. MLA-C02's exam page still
 * shows "TBD" for GA registration and delivery against the blog's
 * 2027-01-14. The blog's dates stay, for the reason above. At worst the site
 * calls each exam retired one day early, which sends nobody to book an exam
 * that has closed. The next look is due when registration opens on
 * 2026-10-27. warn-catalogue-due.yml first lists SAP-C02 and SAP-C03 in its
 * run on Monday 2026-11-02, fifteen days before their alarm.
 *
 * 2026-09-28, the last English test day for MLA-C01: re-read its exam page
 * (updated 2026-09-25), which still says "MLA-C01 in English is available
 * through September 28, 2026" and "MLA-C01 in Korean, Japanese, and
 * Simplified Chinese remains available until general availability of
 * MLA-C02". The row is now `retired` with `retiredDate` 2026-09-28, the last
 * day it could be taken in English. This catalogue and the site are in
 * English; its text names the three languages that continue. MLA-C02's GA is
 * still 2027-01-14 in the blog and still "TBD" on the exam page, so the
 * decision above stands.
 *
 * `status` and the dates are read through `@/lib/certStatus` at render time,
 * so a card says "Retired" the day after its last test date without anyone
 * editing this file; `src/data/education-catalogues.test.js` then fails until
 * the row is re-verified and updated, which is the intended reminder.
 *
 *
 * FULL RE-READ 2026-10-05 (owner request: review every Learn portal for exams
 * newly in beta or expired). All thirteen exam pages, the certification hub
 * (refreshed by AWS that same day), the September blog and the blog index
 * were live-fetched. No status or date here disagrees with AWS, no exam,
 * beta or version is missing (the hub lists exactly these thirteen; MLS-C01
 * retired 2026-03-31 and is rightly absent), and the two posts since
 * 2026-09-28 are microcredentials and Jam, not certifications. Two things
 * worth recording:
 *
 *   The one-day conflict above is closed, by AWS. Both exam pages were edited
 *     on 2026-10-02 and now read "The last day to take the current exam
 *     (SAP-C02) is November 16, 2026." and "… (DVA-C02) is November 30,
 *     2026." — the blog's dates, which this file kept. Nothing stored
 *     changes; the "second look" for SAP and DVA is no longer owed. The
 *     exam guides for SAP-C03 and DVA-C03 are still 404 until registration
 *     opens on 2026-10-27, so `studyGuideUrl: null` stays on both rows.
 *   MLA-C02 is as described: the exam page still says "TBD" for GA while the
 *     blog says 2027-01-14, so the rule above still holds. (Its comparison
 *     table prints the code as "ME1-C02"; the exam guide it links is titled
 *     MLA-C02, which is what the row carries.)
 *
 * Language-only retirements AWS now prints, none of which changes an
 * English-site status: CLF-C02 Italian and German after 2026-12-31; AIF-C01
 * Italian and German after 2026-10-15; SAA-C03 Italian after 2026-12-31;
 * SOA-C03 Simplified Chinese and Korean after 2026-11-19; DOP-C02 Korean
 * after 2026-12-31; SCS-C03 Simplified Chinese, Spanish (Latin America) and
 * Portuguese (Brazil) after 2026-12-31. aws.amazon.com/certification/
 * coming-soon/ is stale (its only content is the 2025 SOA change) and is not
 * a source. All sixteen rows were re-read, so `DATA_AS_OF` moves.
 *
 * RE-READ 2026-11-03 of SAP-C02 and SAP-C03, the two rows #1497 named (due to
 * fire on 2026-11-17), stored ahead of their days under rule 2 of
 * `deriveStatus` (src/lib/certStatus.js) with `statusReadDate` 2026-11-03:
 * each badge keeps its current status until AWS's day, so the alarm in
 * education-catalogues.test.js has nothing to fire on. Three pages read:
 *
 *   The September blog (/blogs/training-and-certification/september-2026-
 *     new-offerings/, dated 01 SEP 2026) is unchanged. Its SAP Key dates
 *     still read "October 27, 2026 – Registration opens (all languages) /
 *     November 16, 2026 – Last day to take SAP-C02 / November 17, 2026 –
 *     SAP-C03 GA delivery begins", and its body "The last day to take the
 *     current version of the exam (SAP-C02) will be November 16, 2026."
 *   The SAP exam page (/certification/certified-solutions-architect-
 *     professional/) no longer mentions SAP-C02 or a last test day at all.
 *     It now links the SAP-C03 exam prep plan on Skill Builder and the SAP-C03
 *     exam guide, and lists 75 questions in 180 minutes for USD 300 in
 *     English, Japanese, Korean, Portuguese (Brazil), Simplified Chinese and
 *     Spanish (Latin America). The page says nothing that contradicts the
 *     blog, so the blog's dates stay (the rule above).
 *   The SAP-C03 exam guide (docs.aws.amazon.com/aws-certification/latest/
 *     solutions-architect-professional-03/solutions-architect-professional-
 *     03.html) resolves now, registration having opened on 2026-10-27. Its
 *     H1 is "AWS Certified Solutions Architect - Professional (SAP-C03)" and
 *     it carries a "Comparison of SAP-C02 and SAP-C03" appendix; 65 scored
 *     and 10 unscored questions, passing score 720. The hub
 *     (/certification/) renders its five Professional cards from script, so
 *     a plain fetch shows them as "Loading"; it names no SAP date and still
 *     prints "(retires December 31, 2026)" on Advanced Networking.
 *
 *   SAP-C02 — `retired`, `expiryDate` 2026-11-16 kept, `retiredDate`
 *     2026-11-16; shows "Retiring" through 2026-11-16.
 *   SAP-C03 — `active`, `availableDate` 2026-11-17 kept; shows "Coming" until
 *     then. `studyGuideUrl` filled with the exam guide above.
 *   DVA-C03 — its exam guide (/aws-certification/latest/developer-associate-
 *     03/developer-associate-03.html) resolves too, so `studyGuideUrl` is
 *     filled; nothing else on the DVA rows was re-read. That guide's own note
 *     reads "Registration for the updated version of the exam (DVA-C03) opens
 *     December 1, 2026. The last day to take the current version of the exam
 *     (DVA-C02) is November 30, 2026." — a registration date the blog gives
 *     as October 27, 2026. The stored `registrationOpens` keeps the blog's
 *     date, by the rule above; the row's `longDescription` names both dates
 *     so a visitor is not told one as settled (CodeRabbit on #1529); and the
 *     DVA re-read due before 2026-12-01 should look at it again.
 *
 * Only these rows were re-read, so `DATA_AS_OF` stays.
 *
 * Field notes: `expiryDate` is the last day the exam can be taken;
 * `availableDate` the first GA day of a new version; `previousSlugs` keeps
 * old detail-page links resolving after a version bump.
 */
export const DATA_AS_OF = '2026-10-05';

export const DATA_SOURCE = {
  label: 'AWS Certification',
  url: 'https://aws.amazon.com/certification/',
};

export const certifications = [
  {
    id: 'clf-c02',
    slug: 'clf-c02',
    code: 'CLF-C02',
    title: 'AWS Certified Cloud Practitioner',
    level: 'Foundational',
    status: 'active',
    description:
      'Foundational cloud fluency across AWS services, billing, security, and global infrastructure.',
    longDescription:
      'Build foundational knowledge of cloud concepts and core AWS services. This entry-level certification is ideal for anyone beginning their AWS journey, covering cloud models, AWS services, pricing, SLAs, security, and global infrastructure.',
    topics: ['Cloud Concepts', 'AWS Services', 'Billing & Pricing', 'Security & Compliance'],
    hours: 10,
    prepTime: '~4 weeks',
    successRate: '82%',
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-cloud-practitioner/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/cloud-practitioner-02/cloud-practitioner-02.html',
    practiceUrl: 'https://skillbuilder.aws/search?searchText=cloud+practitioner+practice',
    microcredentialUrl: null,
    modules: [
      {
        title: 'Cloud Concepts',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/134/aws-cloud-practitioner-essentials',
      },
      {
        title: 'AWS Core Services Overview',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/134/aws-cloud-practitioner-essentials',
      },
      {
        title: 'Security & the Shared Responsibility Model',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/134/aws-cloud-practitioner-essentials',
      },
      {
        title: 'Billing, Pricing & Support Plans',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/134/aws-cloud-practitioner-essentials',
      },
    ],
    prerequisites: 'No prerequisites — recommended for beginners.',
    nextCerts: ['saa-c03', 'aif-c01'],
  },
  {
    id: 'aif-c01',
    slug: 'aif-c01',
    code: 'AIF-C01',
    title: 'AWS Certified AI Practitioner',
    level: 'Foundational',
    status: 'active',
    description: 'Understand generative AI, responsible AI, and core ML concepts on AWS.',
    longDescription:
      'Validate foundational knowledge of artificial intelligence, machine learning, and generative AI concepts and how they are applied using AWS services. Ideal for non-technical roles beginning their AI journey.',
    topics: ['Generative AI', 'Responsible AI', 'ML Basics', 'AWS AI Services'],
    hours: 15,
    prepTime: '~6 weeks',
    successRate: '78%',
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-ai-practitioner/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/ai-practitioner-01/ai-practitioner-01.html',
    practiceUrl: 'https://skillbuilder.aws/search?searchText=ai+practitioner+practice',
    microcredentialUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    modules: [
      {
        title: 'Introduction to Artificial Intelligence',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/19434/introduction-to-artificial-intelligence',
      },
      {
        title: 'Generative AI Essentials',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/17432/generative-ai-with-large-language-models',
      },
      {
        title: 'Responsible AI on AWS',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/18404/responsible-ai',
      },
      {
        title: 'AWS AI & ML Services Overview',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9459/amazon-sagemaker-getting-started',
      },
    ],
    prerequisites: 'No prerequisites. CLF-C02 recommended but not required.',
    nextCerts: ['mla-c02', 'aip-c01', 'aib-c01'],
  },
  {
    id: 'aib-c01',
    slug: 'aib-c01',
    code: 'AIB-C01',
    title: 'AWS Certified AI Business Strategist',
    level: 'Business',
    status: 'beta',
    description:
      'Validate the business judgment that takes AI from adoption to scale — identifying opportunities, evaluating investments, governing adoption, and scaling initiatives.',
    longDescription:
      'A beta exam for professionals who drive AI outcomes without writing code: product and program managers, sales and business development, line-of-business leaders, consultants, analysts, and marketers. 85 questions in 170 minutes at beta pricing (USD 50; USD 100 at GA). Earn it by February 15, 2027 for the additional Early Adopter badge.',
    topics: ['AI Opportunity', 'Investment Cases', 'AI Governance', 'Scaling Adoption'],
    hours: 15,
    prepTime: '~6 weeks',
    successRate: null,
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-ai-business-strategist/',
    studyGuideUrl: null,
    practiceUrl: 'https://skillbuilder.aws/search?searchText=ai+business+strategist',
    microcredentialUrl: null,
    modules: [],
    prerequisites:
      'No coding or AWS implementation experience required. AIF-C01 is a natural companion.',
    nextCerts: ['aif-c01'],
  },
  {
    id: 'saa-c03',
    slug: 'saa-c03',
    code: 'SAA-C03',
    title: 'AWS Certified Solutions Architect – Associate',
    level: 'Associate',
    status: 'active',
    description:
      'Design scalable, resilient, and cost-efficient architectures using core AWS services.',
    longDescription:
      'Validate your ability to design and implement scalable, highly available, and cost-efficient solutions on AWS. This is the most widely recognized AWS Associate certification, covering compute, storage, databases, networking, security, and architecture best practices.',
    topics: [
      'EC2 & Compute',
      'S3 & Storage',
      'VPC & Networking',
      'IAM & Security',
      'RDS & Databases',
      'CloudFormation',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: '74%',
    featured: true,
    learnUrl: 'https://aws.amazon.com/certification/certified-solutions-architect-associate/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html',
    practiceUrl:
      'https://skillbuilder.aws/search?searchText=solutions+architect+associate+practice',
    microcredentialUrl: null,
    modules: [
      {
        title: 'Designing Resilient Architectures',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9541/aws-certified-solutions-architect-associate-official-practice-question-set',
      },
      {
        title: 'High-Performing Architectures',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9541/aws-certified-solutions-architect-associate-official-practice-question-set',
      },
      {
        title: 'Secure Applications & Architectures',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9541/aws-certified-solutions-architect-associate-official-practice-question-set',
      },
      {
        title: 'Cost-Optimized Architectures',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9541/aws-certified-solutions-architect-associate-official-practice-question-set',
      },
    ],
    prerequisites: 'CLF-C02 recommended. 1+ year of hands-on AWS experience.',
    nextCerts: ['sap-c02', 'sap-c03', 'dop-c02', 'scs-c03'],
  },
  {
    id: 'soa-c03',
    slug: 'soa-c03',
    previousSlugs: ['soa-c02'],
    code: 'SOA-C03',
    title: 'AWS Certified CloudOps Engineer – Associate',
    level: 'Associate',
    status: 'active',
    description:
      'Deploy, manage, and operate scalable systems on AWS with a focus on monitoring and automation.',
    longDescription:
      'Validate your ability to deploy, manage, and operate workloads on AWS. Covers monitoring, automation, storage, security, and operational best practices for cloud engineers who manage and operate AWS environments. SOA-C03 replaced the SysOps Administrator – Associate exam (SOA-C02) on September 30, 2025; the CloudOps name applies to those who pass SOA-C03.',
    topics: [
      'Monitoring & Observability',
      'Automation',
      'Storage',
      'Networking',
      'Security & Compliance',
    ],
    hours: 35,
    prepTime: '~3 months',
    successRate: '72%',
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-cloudops-engineer-associate/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/sysops-administrator-associate-03/sysops-administrator-associate-03.html',
    practiceUrl: 'https://skillbuilder.aws/search?searchText=cloudops+engineer+practice',
    microcredentialUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    modules: [
      {
        title: 'Monitoring, Logging & Remediation',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9534/exam-prep-aws-certified-sysops-administrator-associate',
      },
      {
        title: 'Reliability & Business Continuity',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9534/exam-prep-aws-certified-sysops-administrator-associate',
      },
      {
        title: 'Deployment, Provisioning & Automation',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9534/exam-prep-aws-certified-sysops-administrator-associate',
      },
      {
        title: 'Security & Compliance',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9534/exam-prep-aws-certified-sysops-administrator-associate',
      },
    ],
    prerequisites: 'SAA-C03 recommended. 1+ year of AWS operations experience.',
    nextCerts: ['dop-c02'],
  },
  {
    id: 'dva-c02',
    slug: 'dva-c02',
    code: 'DVA-C02',
    title: 'AWS Certified Developer – Associate',
    level: 'Associate',
    status: 'expiring',
    expiryDate: '2026-11-30',
    replacement: { code: 'DVA-C03', slug: 'dva-c03' },
    description:
      'Develop and maintain applications on AWS with a focus on serverless and CI/CD patterns.',
    longDescription:
      'Validate your ability to develop, deploy, debug, and optimize cloud-native applications on AWS. Covers serverless architectures, CI/CD pipelines, DynamoDB, API Gateway, Lambda, and AWS SDKs. The last day to take DVA-C02 is November 30, 2026; DVA-C03 is delivered from December 1, 2026.',
    topics: ['Lambda & Serverless', 'API Gateway', 'DynamoDB', 'CodePipeline & CI/CD', 'SDK & CLI'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '73%',
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-developer-associate/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/developer-associate-02/developer-associate-02.html',
    practiceUrl: 'https://skillbuilder.aws/search?searchText=developer+associate+practice',
    microcredentialUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    modules: [
      {
        title: 'Development with AWS Services',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9543/exam-prep-aws-certified-developer-associate',
      },
      {
        title: 'Security & Authentication',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9543/exam-prep-aws-certified-developer-associate',
      },
      {
        title: 'Deployment & CI/CD',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9543/exam-prep-aws-certified-developer-associate',
      },
      {
        title: 'Troubleshooting & Optimization',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9543/exam-prep-aws-certified-developer-associate',
      },
    ],
    prerequisites: 'CLF-C02 recommended. 1+ year of development experience on AWS.',
    nextCerts: ['dva-c03', 'sap-c02', 'dop-c02'],
  },
  {
    id: 'dva-c03',
    slug: 'dva-c03',
    code: 'DVA-C03',
    title: 'AWS Certified Developer – Associate',
    level: 'Associate',
    status: 'upcoming',
    availableDate: '2026-12-01',
    registrationOpens: '2026-10-27',
    description:
      'The updated Developer – Associate exam, adding generative AI and agentic development to serverless and CI/CD patterns.',
    longDescription:
      'The next version of the Developer – Associate exam. Delivery begins December 1, 2026, the day after DVA-C02 retires. AWS gives two dates for registration: its September announcement says October 27, 2026, and the DVA-C03 exam guide says December 1, 2026, so check the exam page before booking. AWS has said the update reflects AI-related competencies alongside the existing serverless, CI/CD, and application development domains.',
    topics: ['Lambda & Serverless', 'API Gateway', 'DynamoDB', 'CI/CD', 'Generative AI'],
    hours: 40,
    prepTime: '~3 months',
    successRate: null,
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-developer-associate/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/developer-associate-03/developer-associate-03.html',
    practiceUrl: 'https://skillbuilder.aws/search?searchText=developer+associate+practice',
    microcredentialUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    modules: [],
    prerequisites: 'CLF-C02 recommended. 1+ year of development experience on AWS.',
    nextCerts: ['sap-c03', 'dop-c02'],
  },
  {
    id: 'dea-c01',
    slug: 'dea-c01',
    code: 'DEA-C01',
    title: 'AWS Certified Data Engineer – Associate',
    level: 'Associate',
    status: 'active',
    description: 'Design, build, and maintain data pipelines and data architecture on AWS.',
    longDescription:
      'Validate your expertise in designing, building, and maintaining data pipelines and data architecture on AWS using services like Glue, Kinesis, Redshift, and Lake Formation. Covers data ingestion, transformation, orchestration, and security.',
    topics: ['AWS Glue', 'Amazon Kinesis', 'Amazon Redshift', 'Lake Formation', 'Data Security'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '70%',
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-data-engineer-associate/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/data-engineer-associate-01/data-engineer-associate-01.html',
    practiceUrl: 'https://skillbuilder.aws/search?searchText=data+engineer+associate+practice',
    microcredentialUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    modules: [
      {
        title: 'Data Ingestion & Transformation',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/18924/exam-prep-aws-certified-data-engineer-associate',
      },
      {
        title: 'Data Store Management',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/18924/exam-prep-aws-certified-data-engineer-associate',
      },
      {
        title: 'Data Operations & Support',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/18924/exam-prep-aws-certified-data-engineer-associate',
      },
      {
        title: 'Data Security & Governance',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/18924/exam-prep-aws-certified-data-engineer-associate',
      },
    ],
    prerequisites: 'CLF-C02 recommended. Experience with data engineering concepts and SQL.',
    nextCerts: ['sap-c02'],
  },
  {
    id: 'mla-c01',
    slug: 'mla-c01',
    code: 'MLA-C01',
    title: 'AWS Certified Machine Learning Engineer – Associate',
    level: 'Associate',
    status: 'retired',
    retiredDate: '2026-09-28',
    replacement: { code: 'MLA-C02', slug: 'mla-c02' },
    description:
      'Implement ML solutions on AWS including model deployment, automation, and MLOps practices.',
    longDescription:
      'Validate your ability to implement, operationalize, and maintain ML solutions on AWS. Covers SageMaker, model deployment, MLOps pipelines, automation, and monitoring of production ML workloads. The last day to take MLA-C01 in English was September 28, 2026, and MLA-C02 is its successor. MLA-C01 remains available in Japanese, Korean and Simplified Chinese until MLA-C02 reaches general availability. Certifications already earned stay valid for their full three years.',
    topics: ['Amazon SageMaker', 'MLOps', 'Model Deployment', 'Automation', 'Monitoring'],
    hours: 40,
    prepTime: '~3 months',
    successRate: '71%',
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-machine-learning-engineer-associate/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-01/machine-learning-engineer-associate-01.html',
    practiceUrl: 'https://skillbuilder.aws/search?searchText=machine+learning+engineer+practice',
    microcredentialUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    modules: [
      {
        title: 'Data Preparation for ML',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9541/aws-certified-machine-learning-specialty-exam-prep',
      },
      {
        title: 'Model Development & Training',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9541/aws-certified-machine-learning-specialty-exam-prep',
      },
      {
        title: 'Model Deployment & Inference',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9541/aws-certified-machine-learning-specialty-exam-prep',
      },
      {
        title: 'MLOps & Monitoring',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9541/aws-certified-machine-learning-specialty-exam-prep',
      },
    ],
    prerequisites: 'AIF-C01 recommended. Experience with ML concepts and Python.',
    nextCerts: ['mla-c02'],
  },
  {
    id: 'mla-c02',
    slug: 'mla-c02',
    code: 'MLA-C02',
    title: 'AWS Certified Machine Learning Engineer – Associate',
    level: 'Associate',
    status: 'beta',
    betaStartDate: '2026-09-29',
    gaDate: '2027-01-14',
    registrationOpens: '2026-09-01',
    description:
      'The updated ML Engineer – Associate exam, in beta from September 29, 2026 with GA delivery on January 14, 2027.',
    longDescription:
      'The next version of the Machine Learning Engineer – Associate exam. Beta registration opened September 1, 2026 (English), beta delivery runs from September 29, 2026, and GA delivery begins January 14, 2027. AWS has said the update reflects evolving ML roles, including generative AI and agentic workloads, alongside SageMaker, MLOps, and production monitoring.',
    topics: ['Amazon SageMaker', 'MLOps', 'Generative AI', 'Model Deployment', 'Monitoring'],
    hours: 40,
    prepTime: '~3 months',
    successRate: null,
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-machine-learning-engineer-associate/',
    studyGuideUrl: null,
    practiceUrl: 'https://skillbuilder.aws/search?searchText=machine+learning+engineer+practice',
    microcredentialUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    modules: [],
    prerequisites: 'AIF-C01 recommended. Experience with ML concepts and Python.',
    nextCerts: ['aip-c01'],
  },
  {
    id: 'aip-c01',
    slug: 'aip-c01',
    code: 'AIP-C01',
    title: 'AWS Certified Generative AI Developer – Professional',
    level: 'Professional',
    status: 'active',
    description:
      'Design, build, and optimize generative AI solutions using Amazon Bedrock and AWS AI services.',
    longDescription:
      'Validate your expertise in designing, building, and optimizing generative AI solutions using Amazon Bedrock and related AWS AI services. Covers foundation model selection, RAG architectures, agents, guardrails, responsible AI, and performance optimization for production generative AI workloads.',
    topics: [
      'Amazon Bedrock',
      'Foundation Models',
      'RAG Architectures',
      'Bedrock Agents',
      'Guardrails & Responsible AI',
    ],
    hours: 40,
    prepTime: '~3 months',
    successRate: null,
    featured: false,
    learnUrl:
      'https://aws.amazon.com/certification/certified-generative-ai-developer-professional/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/ai-professional-01/ai-professional-01.html',
    practiceUrl:
      'https://skillbuilder.aws/search?searchText=generative+ai+developer+professional+practice',
    microcredentialUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    modules: [
      {
        title: 'Getting Started with Amazon Bedrock',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/17447/amazon-bedrock-getting-started',
      },
      {
        title: 'Building Generative AI Applications with Amazon Bedrock',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/17897/building-generative-ai-applications-using-amazon-bedrock',
      },
      {
        title: 'Designing RAG & Agent Architectures',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/17897/building-generative-ai-applications-using-amazon-bedrock',
      },
      {
        title: 'Responsible AI & Guardrails on Bedrock',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/18404/responsible-ai',
      },
    ],
    prerequisites:
      'AIF-C01 recommended. Experience with AWS AI services and application development.',
    nextCerts: [],
  },
  {
    id: 'sap-c02',
    slug: 'sap-c02',
    code: 'SAP-C02',
    title: 'AWS Certified Solutions Architect – Professional',
    level: 'Professional',
    status: 'retired',
    expiryDate: '2026-11-16',
    retiredDate: '2026-11-16',
    statusReadDate: '2026-11-03',
    replacement: { code: 'SAP-C03', slug: 'sap-c03' },
    description:
      'Advanced design of complex, multi-region, hybrid, and cost-optimized AWS architectures.',
    longDescription:
      'Validate advanced subject matter expertise in designing cost-effective, highly available, and secure AWS solutions at enterprise scale. Covers multi-account strategies, hybrid architectures, migrations, and complex networking. The last day to take SAP-C02 is November 16, 2026; SAP-C03 is delivered from November 17, 2026.',
    topics: [
      'Multi-Region Design',
      'Hybrid Architectures',
      'Migration Strategy',
      'Cost Optimization',
      'Advanced Networking',
    ],
    hours: 60,
    prepTime: '~6 months',
    successRate: '68%',
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-solutions-architect-professional/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-professional-02/solutions-architect-professional-02.html',
    practiceUrl:
      'https://skillbuilder.aws/search?searchText=solutions+architect+professional+practice',
    microcredentialUrl: null,
    modules: [
      {
        title: 'Organizational Complexity & Migrations',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9542/exam-prep-aws-certified-solutions-architect-professional',
      },
      {
        title: 'New Solutions Design',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9542/exam-prep-aws-certified-solutions-architect-professional',
      },
      {
        title: 'Continuous Improvement',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9542/exam-prep-aws-certified-solutions-architect-professional',
      },
      {
        title: 'Workload Acceleration',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9542/exam-prep-aws-certified-solutions-architect-professional',
      },
    ],
    prerequisites: 'SAA-C03 required. 2+ years of hands-on AWS architecture experience.',
    nextCerts: ['sap-c03'],
  },
  {
    id: 'sap-c03',
    slug: 'sap-c03',
    code: 'SAP-C03',
    title: 'AWS Certified Solutions Architect – Professional',
    level: 'Professional',
    status: 'active',
    availableDate: '2026-11-17',
    registrationOpens: '2026-10-27',
    statusReadDate: '2026-11-03',
    description:
      'The updated Solutions Architect – Professional exam, adding generative AI and agent architectures to enterprise-scale design.',
    longDescription:
      'The next version of the Solutions Architect – Professional exam. Registration opens October 27, 2026 and delivery begins November 17, 2026, the day after SAP-C02 retires. AWS has said the update reflects AI-related competencies alongside multi-account, hybrid, migration, and cost domains.',
    topics: [
      'Multi-Region Design',
      'Hybrid Architectures',
      'Migration Strategy',
      'Generative AI Architectures',
      'Cost Optimization',
    ],
    hours: 60,
    prepTime: '~6 months',
    successRate: null,
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-solutions-architect-professional/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-professional-03/solutions-architect-professional-03.html',
    practiceUrl:
      'https://skillbuilder.aws/search?searchText=solutions+architect+professional+practice',
    microcredentialUrl: null,
    modules: [],
    prerequisites: 'SAA-C03 required. 2+ years of hands-on AWS architecture experience.',
    nextCerts: [],
  },
  {
    id: 'dop-c02',
    slug: 'dop-c02',
    code: 'DOP-C02',
    title: 'AWS Certified DevOps Engineer – Professional',
    level: 'Professional',
    status: 'active',
    description: 'Implement and manage continuous delivery systems and methodologies on AWS.',
    longDescription:
      'Validate advanced expertise in provisioning, operating, and managing distributed application systems on AWS. Covers CI/CD pipelines, infrastructure as code, monitoring, incident management, and security automation.',
    topics: [
      'CI/CD Pipelines',
      'Infrastructure as Code',
      'Monitoring & Logging',
      'Incident Response',
      'Security Automation',
    ],
    hours: 55,
    prepTime: '~5 months',
    successRate: '67%',
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-devops-engineer-professional/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/devops-engineer-professional-02/devops-engineer-professional-02.html',
    practiceUrl: 'https://skillbuilder.aws/search?searchText=devops+engineer+professional+practice',
    microcredentialUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    modules: [
      {
        title: 'SDLC Automation',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9544/exam-prep-aws-certified-devops-engineer-professional',
      },
      {
        title: 'Configuration Management & IaC',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9544/exam-prep-aws-certified-devops-engineer-professional',
      },
      {
        title: 'Resilient Cloud Solutions',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9544/exam-prep-aws-certified-devops-engineer-professional',
      },
      {
        title: 'Monitoring & Logging',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9544/exam-prep-aws-certified-devops-engineer-professional',
      },
    ],
    prerequisites: 'DVA-C02 or SOA-C03 recommended. 2+ years of DevOps experience on AWS.',
    nextCerts: [],
  },
  {
    id: 'scs-c03',
    slug: 'scs-c03',
    previousSlugs: ['scs-c02'],
    code: 'SCS-C03',
    title: 'AWS Certified Security – Specialty',
    level: 'Specialty',
    status: 'active',
    description:
      'Secure AWS workloads with advanced IAM, encryption, and threat detection services.',
    longDescription:
      'Validate your expertise in securing AWS workloads and infrastructure. Covers advanced IAM strategies, data encryption, incident response, infrastructure security, and threat detection using GuardDuty, Macie, and Security Hub. SCS-C03 replaced SCS-C02 as the current version: the last day to take SCS-C02 was December 1, 2025. The update adds a dedicated focus on generative AI and machine learning security and splits Detection and Incident Response into separate domains.',
    topics: [
      'IAM & Identity',
      'KMS & Encryption',
      'GuardDuty & Threat Detection',
      'Macie & Data Security',
      'Security Hub',
    ],
    hours: 45,
    prepTime: '~4 months',
    successRate: '70%',
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-security-specialty/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/security-specialty-03/security-specialty-03.html',
    practiceUrl: 'https://skillbuilder.aws/search?searchText=security+specialty+practice',
    microcredentialUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    modules: [
      {
        title: 'Threat Detection & Incident Response',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9545/exam-prep-aws-certified-security-specialty',
      },
      {
        title: 'Security Logging & Monitoring',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9545/exam-prep-aws-certified-security-specialty',
      },
      {
        title: 'Infrastructure Security',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9545/exam-prep-aws-certified-security-specialty',
      },
      {
        title: 'Identity & Access Management',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9545/exam-prep-aws-certified-security-specialty',
      },
    ],
    prerequisites: 'SAA-C03 recommended. 5+ years of IT security experience, 2+ years on AWS.',
    nextCerts: ['sap-c02'],
  },
  {
    id: 'ans-c01',
    slug: 'ans-c01',
    code: 'ANS-C01',
    title: 'AWS Certified Advanced Networking – Specialty',
    level: 'Specialty',
    status: 'expiring',
    expiryDate: '2026-12-31',
    description:
      'Design and implement complex AWS networking architectures including hybrid connectivity.',
    longDescription:
      'Validate your expertise in designing and implementing AWS and hybrid IT network architectures at scale. Covers VPC design, Direct Connect, Transit Gateway, hybrid connectivity, DNS, and network security. AWS is retiring this exam: the last day to take it is December 31, 2026, and no successor has been announced.',
    topics: [
      'VPC Design',
      'Direct Connect',
      'Transit Gateway',
      'Route 53 & DNS',
      'Network Security',
    ],
    hours: 45,
    prepTime: '~4 months',
    successRate: '69%',
    featured: false,
    learnUrl: 'https://aws.amazon.com/certification/certified-advanced-networking-specialty/',
    studyGuideUrl:
      'https://docs.aws.amazon.com/aws-certification/latest/advanced-networking-specialty-01/advanced-networking-specialty-01.html',
    practiceUrl:
      'https://skillbuilder.aws/search?searchText=advanced+networking+specialty+practice',
    microcredentialUrl: null,
    modules: [
      {
        title: 'Network Design & Implementation',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9546/exam-prep-aws-certified-advanced-networking-specialty',
      },
      {
        title: 'Network Security & Compliance',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9546/exam-prep-aws-certified-advanced-networking-specialty',
      },
      {
        title: 'Network Management & Troubleshooting',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9546/exam-prep-aws-certified-advanced-networking-specialty',
      },
      {
        title: 'Hybrid Network Design',
        url: 'https://explore.skillbuilder.aws/learn/course/external/view/elearning/9546/exam-prep-aws-certified-advanced-networking-specialty',
      },
    ],
    prerequisites: 'SAA-C03 recommended. 5+ years of networking experience.',
    nextCerts: ['sap-c02'],
  },
];

/**
 * A certification by its current slug or any slug it used to have, so a link
 * minted for `/aws/education/soa-c02` still lands on SOA-C03.
 *
 * @param {string} slug
 * @returns {object|undefined}
 */
export function findCertificationBySlug(slug) {
  return certifications.find((c) => c.slug === slug || c.previousSlugs?.includes(slug));
}
