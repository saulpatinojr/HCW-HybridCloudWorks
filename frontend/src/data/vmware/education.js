/**
 * vmware education data.
 *
 * Extracted from src/pages/vmware/EducationPage.jsx when that page moved onto the
 * shared EducationTemplate.
 *
 * Certification catalogue verified 2026-09-09 (#461) against Broadcom's VMware
 * certification pages and exam guides:
 *   VCP-VVF Administrator 2V0-16.25, VCP-VCF Administrator 2V0-17.25 and
 *   VCP-VCF Architect 2V0-13.25 (Broadcom certification pages);
 *   VCAP-VCF Administrator 3V0-11.26, Architect 3V0-12.26 and Support
 *   3V0-13.26 — the role-based VCAPs whose exam guides Broadcom dated
 *   August 18, 2026 — replace the VCAP-DCV Deploy entry this file used to
 *   carry, which no longer appears on Broadcom's certification path.
 *   VCTA-DCV is the Data Center Virtualization track named in Broadcom's
 *   VCTA FAQ; Broadcom publishes no per-track VCTA page today.
 *
 * Re-verified 2026-09-10 (#469 item 1) against Broadcom's certification index,
 * https://www.broadcom.com/support/education/vmware/certification, which today
 * groups its career certifications as thirteen under VMware Cloud Foundation,
 * one VCDX, two under Application Networking & Security, and two under
 * "VMware Legacy Certifications" (VCP-DCV 2V0-21.23, VCP-NV 2V0-41.24). Every
 * exam code this file carries still appears there, on the title it carries:
 *   VCP-VVF Administrator 2V0-16.25, VCP-VCF Administrator 2V0-17.25,
 *   VCP-VCF Architect 2V0-13.25, VCAP-VCF Administrator 3V0-11.26,
 *   VCAP-VCF Architect 3V0-12.26 and VCAP-VCF Support 3V0-13.26.
 * The three VCAP rows now link to their own Broadcom pages rather than the
 * index — /vcap-vcf-administrator9, /vcap-vcf-architect9 and
 * /vcap-vcf-support9, the URLs the index itself links them by. VCP-VVF's
 * title gained the "VMware" that Broadcom puts in front of the product name.
 *
 * VCTA IS GONE, and that is the one substantive change. Broadcom's index
 * lists no VMware Certified Technical Associate certification at any level —
 * not under VCF, not under Legacy — and VCTA-DCV 2024 (1V0-21.20) appears in
 * https://docs.broadcom.com/doc/vmware-retired-exams-certifications-and-badges
 * under "Inactive or Retired Exams ... no longer attainable for new
 * candidates". The row is therefore `retired` and points at that document.
 * No `retiredDate`: Broadcom publishes the retirement in a list without a date
 * against this entry, and a guessed date here would be worse than none.
 * No `replacement` either — Broadcom names no associate-level successor, and
 * VCP-VVF is a Professional credential rather than a like-for-like swap.
 *
 * KNOWN GAP, deliberately left for #469 rather than guessed at: Broadcom's
 * thirteen VCF certifications include seven this file does not carry — VCP-VCF
 * Support (2V0-15.25), VCP-VVF Support (2V0-18.25) and the five subject VCAPs,
 * Automation (3V0-21.25), Operations (3V0-22.25), Storage (3V0-23.25), VKS
 * (3V0-24.25) and Networking (3V0-25.25) — plus VCDX and the two ANS VCPs.
 * Their titles and exam codes are on the index above, but `hours` and
 * `prepTime` are this site's own study estimates and inventing fourteen of
 * them is exactly the confidently-wrong entry this catalogue exists to avoid.
 *
 * `status` and any dates are read through `@/lib/certStatus` at render time;
 * `src/data/education-catalogues.test.js` fails when a dated row is past.
 *
 * DATA_AS_OF is 2026-09-10 and not 2026-09-11 on purpose: the checks above ran
 * at 2026-09-11T04:10Z, which is still 2026-09-10 on the local calendar that
 * `todayIso()` — and therefore the "is DATA_AS_OF in the future" assertion —
 * reads. The earlier of the two days is the one that is true for every viewer.
 */
import { resourceRow, titledModules } from '../educationRows.js';

export const DATA_AS_OF = '2026-09-10';

export const DATA_SOURCE = {
  label: 'Broadcom VMware certification',
  url: 'https://www.broadcom.com/support/education/vmware/certification',
};

export const levelMeta = {
  Foundational: {
    badge: 'bg-sky-500/20 border-sky-500/40 text-sky-300',
    accent: 'border-l-sky-500',
    dot: 'bg-sky-500',
    label: 'Foundational',
  },
  Professional: {
    badge: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
    accent: 'border-l-emerald-500',
    dot: 'bg-emerald-500',
    label: 'Professional',
  },
  Advanced: {
    badge: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
    accent: 'border-l-violet-500',
    dot: 'bg-violet-500',
    label: 'Advanced',
  },
};

export const filterLevels = ['All', 'Foundational', 'Professional', 'Advanced'];

export const certifications = [
  {
    id: 'vcta-dcv',
    slug: 'vcta-dcv',
    code: 'VCTA-DCV',
    title: 'VMware Certified Technical Associate – Data Center Virtualization',
    level: 'Foundational',
    status: 'retired',
    description:
      'The associate-level entry point to virtualization concepts, vSphere navigation, basic VM administration and troubleshooting. Broadcom lists no VCTA certification of any track on its certification index, and carries VCTA-DCV 2024 (exam 1V0-21.20) among the inactive exams no longer attainable for new candidates. No date is published against the entry and no associate-level successor is named.',
    topics: ['vSphere Basics', 'VM Management', 'Storage & Network Intro', 'Troubleshooting'],
    hours: 15,
    prepTime: '~4 weeks',
    featured: false,
    learnUrl: 'https://docs.broadcom.com/doc/vmware-retired-exams-certifications-and-badges',
  },
  {
    id: 'vcp-vvf',
    slug: 'vcp-vvf',
    code: 'VCP-VVF',
    examCode: '2V0-16.25',
    title: 'VMware Certified Professional – VMware vSphere Foundation Administrator',
    level: 'Professional',
    status: 'active',
    description:
      'Deploy, manage, and support private cloud environments built on VMware vSphere Foundation — vSphere, vSAN and VCF Operations without the full Cloud Foundation stack.',
    topics: ['vSphere', 'vSAN', 'VCF Operations', 'Lifecycle'],
    hours: 35,
    prepTime: '~3 months',
    featured: false,
    learnUrl:
      'https://www.broadcom.com/support/education/vmware/certification/vcp-vvf-administrator',
  },
  {
    id: 'vcp-vcf',
    slug: 'vcp-vcf',
    code: 'VCP-VCF',
    examCode: '2V0-17.25',
    title: 'VMware Certified Professional – VMware Cloud Foundation Administrator',
    level: 'Professional',
    status: 'active',
    description:
      'Validate expertise in configure, deploy, manage, and scale a software-defined data center using VMware Cloud Foundation.',
    topics: ['vSphere SDDC', 'vSAN Integration', 'NSX Networking', 'SDDC Manager'],
    hours: 40,
    prepTime: '~3 months',
    featured: true,
    learnUrl:
      'https://www.broadcom.com/support/education/vmware/certification/vcp-vcf-administrator',
  },
  {
    id: 'vcp-vcf-arch',
    slug: 'vcp-vcf-arch',
    code: 'VCP-VCF-ARCH',
    examCode: '2V0-13.25',
    title: 'VMware Certified Professional – VMware Cloud Foundation Architect',
    level: 'Professional',
    status: 'active',
    description:
      'Demonstrate architect-level knowledge designing secure, robust, and highly available multi-site VMware Cloud Foundation topologies.',
    topics: ['Topologies Design', 'Capacity Planning', 'Availability', 'Multi-Region VCF'],
    hours: 45,
    prepTime: '~4 months',
    featured: false,
    learnUrl: 'https://www.broadcom.com/support/education/vmware/certification/vcp-vcf-architect',
  },
  {
    id: 'vcap-vcf-admin',
    slug: 'vcap-vcf-admin',
    code: 'VCAP-VCF-ADMIN',
    examCode: '3V0-11.26',
    title: 'VMware Certified Advanced Professional – VMware Cloud Foundation Administrator',
    level: 'Advanced',
    status: 'active',
    description:
      'Manage, maintain, and scale multi-region VCF 9 private clouds — lifecycle management, workload domains, VCF Automation and Operations, NSX VPCs, and vSphere Kubernetes Service.',
    topics: ['VCF 9 Operations', 'VCF Automation', 'NSX VPCs', 'VKS'],
    hours: 60,
    prepTime: '~6 months',
    featured: false,
    learnUrl:
      'https://www.broadcom.com/support/education/vmware/certification/vcap-vcf-administrator9',
  },
  {
    id: 'vcap-vcf-arch',
    slug: 'vcap-vcf-arch',
    code: 'VCAP-VCF-ARCH',
    examCode: '3V0-12.26',
    title: 'VMware Certified Advanced Professional – VMware Cloud Foundation Architect',
    level: 'Advanced',
    status: 'active',
    description:
      'Architect scalable, resilient VCF 9 private cloud infrastructures that align with business requirements — design, strategic planning, and multi-site topologies.',
    topics: ['VCF 9 Design', 'Requirements', 'Resilience', 'Multi-Site'],
    hours: 60,
    prepTime: '~6 months',
    featured: false,
    learnUrl: 'https://www.broadcom.com/support/education/vmware/certification/vcap-vcf-architect9',
  },
  {
    id: 'vcap-vcf-support',
    slug: 'vcap-vcf-support',
    code: 'VCAP-VCF-SUPPORT',
    examCode: '3V0-13.26',
    title: 'VMware Certified Advanced Professional – VMware Cloud Foundation Support',
    level: 'Advanced',
    status: 'active',
    description:
      'Troubleshoot and maintain VCF 9 platforms — hands-on diagnostics, performance optimization, and root cause analysis across the stack.',
    topics: ['Troubleshooting', 'Performance', 'Root Cause Analysis', 'VCF 9'],
    hours: 60,
    prepTime: '~6 months',
    featured: false,
    learnUrl: 'https://www.broadcom.com/support/education/vmware/certification/vcap-vcf-support9',
  },
];

export const learningPaths = [
  {
    id: 0,
    certCode: 'VCTA-DCV',
    title: 'Virtualization Foundations Path',
    level: 'Beginner',
    hours: 15,
    description:
      'Learn the fundamentals of server virtualization, vSphere administration basics, and hosting virtual machines.',
    modules: titledModules(
      'Intro to Virtualization',
      'vSphere Architecture Overview',
      'Basic VM Management',
      'Troubleshooting Common Issues'
    ),
    // The retired-exams document, not the certification index — the same URL
    // the VCTA-DCV row carries, and for the same reason. This path's target
    // certification is retired, and Broadcom's index does not list VCTA at
    // any track, so a "View details" landing there cannot confirm the thing
    // it was clicked to confirm. Sending a learner to a page that is silent
    // about their certification is worse than sending them to the page that
    // says it is gone (Copilot review of dc62998f).
    certUrl: 'https://docs.broadcom.com/doc/vmware-retired-exams-certifications-and-badges',
  },
  {
    id: 1,
    certCode: 'VCP-VCF',
    title: 'VCF Administrator Path',
    level: 'Intermediate',
    hours: 40,
    description:
      'Master enterprise software-defined data center orchestration using VMware Cloud Foundation (VCF) and SDDC Manager.',
    modules: titledModules(
      'SDDC & Cloud Architecture',
      'vSphere & vSAN Deployment',
      'NSX-T Networking Foundations',
      'SDDC Manager Lifecycle Operations'
    ),
    certUrl:
      'https://www.broadcom.com/support/education/vmware/certification/vcp-vcf-administrator',
  },
  {
    id: 2,
    certCode: 'VCAP-VCF-ADMIN',
    title: 'Advanced VCF Operations Path',
    level: 'Advanced',
    hours: 60,
    description:
      'Deep dive into VCF 9 day-2 operations — fleet lifecycle, VCF Automation and Operations, NSX VPCs with stateful services, and the vSphere Supervisor with VKS.',
    modules: titledModules(
      'Fleet Lifecycle & Workload Domains',
      'VCF Automation: Providers, Projects, Blueprints',
      'NSX VPCs & Stateful Gateway Services',
      'vSphere Supervisor & VKS at Scale'
    ),
    certUrl:
      'https://www.broadcom.com/support/education/vmware/certification/vcap-vcf-administrator9',
  },
];

export const resources = [
  resourceRow(
    'broadcom-support',
    'Broadcom Support Portal',
    ['Documentation', 'description'],
    'https://support.broadcom.com/',
    'Official portal for VMware license management, support tickets, product downloads, and knowledge base.'
  ),
  resourceRow(
    'vmware-customer-connect',
    'VMware Customer Connect',
    ['Learning Platform', 'school'],
    'https://customerconnect.vmware.com/',
    'Official VMware digital learning platform, product documentation, community forums, and training transcripts.'
  ),
  resourceRow(
    'vmware-hol',
    'VMware Hands-on Labs',
    ['Labs', 'science'],
    'https://hol.vmware.com/',
    'Free, web-based sandbox environments that allow testing and exploring VMware products without installation.'
  ),
  resourceRow(
    'vmware-press',
    'VMware Press Books',
    ['Guides', 'menu_book'],
    'https://www.vmwarepress.com/',
    'Official certification guides, best practice blueprints, and technical books from leading VMware architects.'
  ),
  resourceRow(
    'vcf-docs',
    'VCF Product Docs',
    ['Documentation', 'article'],
    'https://docs.vmware.com/en/VMware-Cloud-Foundation/index.html',
    'Technical product documentation for SDDC Manager, VMware Cloud Foundation, vSphere, and vSAN components.'
  ),
  resourceRow(
    'vmware-explore',
    'VMware Explore Videos',
    ['Video', 'play_circle'],
    'https://www.vmware.com/explore.html',
    'Sessions, deep dives, announcements, and customer case studies on-demand from the annual VMware Explore conference.'
  ),
];
