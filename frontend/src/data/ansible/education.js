/**
 * ansible education data.
 *
 * Extracted from src/pages/ansible/EducationPage.jsx when that page moved onto the
 * shared EducationTemplate.
 */
import { resourceRow, titledModules } from '../educationRows.js';

/**
 * Catalogue last checked against Red Hat on 2026-09-09 (#461 audit): RHCSA
 * EX200, RHCE EX294, EX374 and EX467 are all current on
 * redhat.com/en/services/certifications. Rendered by the page as the one
 * freshness claim it can make, and used by `useToday` as the day the
 * pre-render and the hydrating render agree on.
 *
 * Re-verified 2026-09-10 (#469 item 1). All four exams are still current —
 * none is marked retired, unlike EX447, which redhat.com now titles
 * "Retired - ...". What moved is the naming and two links:
 *
 *   https://www.redhat.com/en/services/certifications — lists EX200, EX294,
 *     EX374 and EX467, and splits the engineer credential in two: "Red Hat
 *     Certified Engineer in Enterprise Linux" (EX200 + EX342) and "Red Hat
 *     Certified Engineer in Ansible" (EX200 + EX294).
 *   https://www.redhat.com/en/services/certification/rhce — the RHCE URL now
 *     resolves to "Red Hat Certified Engineer in Ansible", a Level 3 credential
 *     earned by holding both EX200 and EX294. The title below follows Red Hat;
 *     the `code` stays `RHCE (EX294)` because it is this file's card label and
 *     the key `learningPaths` joins on.
 *   https://www.redhat.com/en/services/training/ex294-red-hat-certified-engineer-rhce-exam-red-hat-enterprise-linux
 *     — EX294 itself is now titled "Red Hat Certified Advanced System
 *     Administrator in Ansible Exam", and the page says passing it counts
 *     toward Red Hat Certified Engineer in Ansible.
 *   https://www.redhat.com/en/services/certification/rhcsa — unchanged, still
 *     "Red Hat Certified System Administrator (RHCSA)", exam EX200.
 *   https://www.redhat.com/en/services/training/red-hat-certified-specialist-developing-automation-ansible-automation-platform-exam
 *     — EX374, current, on Ansible Automation Platform 2.5. The `ex374-`
 *     prefixed URL this file carried now returns 404, which is why both the
 *     certification row and the learning path move to this one.
 *   https://www.redhat.com/en/services/training/ex467-red-hat-certified-specialist-managing-automation-ansible-automation-platform-exam
 *     — EX467, current, over automation controller, automation hub AND
 *     automation mesh. The row used to link at the certification index because
 *     nobody had found this page; it does exist.
 *
 * No price is carried for any row: Red Hat quotes exam pricing per region
 * behind a locale selector rather than publishing one number, so there is no
 * single figure to state and none is invented.
 *
 * DATA_AS_OF is 2026-09-10 and not 2026-09-11 on purpose: the checks above ran
 * at 2026-09-11T04:10Z, which is still 2026-09-10 on the local calendar that
 * `todayIso()` — and therefore the "is DATA_AS_OF in the future" assertion —
 * reads. The earlier of the two days is the one that is true for every viewer.
 */
export const DATA_AS_OF = '2026-09-10';

export const DATA_SOURCE = {
  label: 'Red Hat certifications',
  url: 'https://www.redhat.com/en/services/certifications',
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
  Specialist: {
    badge: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
    accent: 'border-l-violet-500',
    dot: 'bg-violet-500',
    label: 'Specialist',
  },
};

export const filterLevels = ['All', 'Foundational', 'Professional', 'Specialist'];

export const certifications = [
  {
    id: 'rhcsa',
    slug: 'rhcsa',
    code: 'RHCSA (EX200)',
    title: 'Red Hat Certified System Administrator',
    level: 'Foundational',
    status: 'active',
    description:
      'Establish foundational system administration skills on Red Hat Enterprise Linux — essential prerequisite knowledge for automation.',
    topics: ['System Config', 'Local Storage', 'File Systems', 'Security & Firewalls'],
    hours: 30,
    prepTime: '2-3 months',
    featured: false,
    learnUrl: 'https://www.redhat.com/en/services/certification/rhcsa',
  },
  {
    id: 'rhce',
    slug: 'rhce',
    code: 'RHCE (EX294)',
    title: 'Red Hat Certified Engineer in Ansible',
    level: 'Professional',
    status: 'active',
    description:
      'Demonstrate expertise in automating system administration tasks with Ansible Automation Platform — playbooks, roles, and variables. Red Hat now awards this Level 3 credential for holding both RHCSA (EX200) and EX294, which it titles the Red Hat Certified Advanced System Administrator in Ansible exam.',
    topics: ['Ansible Playbooks', 'Custom Roles', 'Vault Security', 'System Automation'],
    hours: 45,
    prepTime: '~4 months',
    featured: true,
    learnUrl: 'https://www.redhat.com/en/services/certification/rhce',
  },
  {
    id: 'ex374',
    slug: 'ex374',
    code: 'EX374',
    title: 'Red Hat Certified Specialist in Developing Automation with AAP',
    level: 'Specialist',
    status: 'active',
    description:
      'Validate advanced knowledge of creating Ansible Content Collections, managing execution environments, and CI/CD pipelines.',
    topics: [
      'Ansible Collections',
      'Execution Environments',
      'Platform REST APIs',
      'Git Workflows',
    ],
    hours: 40,
    prepTime: '~3 months',
    featured: false,
    learnUrl:
      'https://www.redhat.com/en/services/training/red-hat-certified-specialist-developing-automation-ansible-automation-platform-exam',
  },
  {
    id: 'ex467',
    slug: 'ex467',
    code: 'EX467',
    title: 'Red Hat Certified Specialist in Managing Automation with AAP',
    level: 'Specialist',
    status: 'active',
    description:
      'Demonstrate skill in managing large-scale automation architectures using Ansible Automation Platform — automation controller, automation hub and automation mesh.',
    topics: ['AAP Controller', 'Automation Hub', 'Automation Mesh', 'Workflow Templates'],
    hours: 40,
    prepTime: '~3 months',
    featured: false,
    learnUrl:
      'https://www.redhat.com/en/services/training/ex467-red-hat-certified-specialist-managing-automation-ansible-automation-platform-exam',
  },
];

export const learningPaths = [
  {
    id: 0,
    certCode: 'RHCSA (EX200)',
    title: 'RHEL Linux Foundations Path',
    level: 'Beginner',
    hours: 30,
    description:
      'Gain intermediate competencies in Red Hat Enterprise Linux system management before diving into scripting and automation.',
    modules: titledModules(
      'Command Line Essentials',
      'Managing Users & Groups',
      'Configuring Storage & File Systems',
      'SSH & Basic Network Security'
    ),
    certUrl: 'https://www.redhat.com/en/services/certification/rhcsa',
  },
  {
    id: 1,
    certCode: 'RHCE (EX294)',
    title: 'Ansible Automation Engineering Path',
    level: 'Intermediate',
    hours: 45,
    description:
      'Learn the complete workflow of writing playbooks, creating reusable roles, securing credentials with Vault, and automating infrastructure.',
    modules: titledModules(
      'Ansible Engine Fundamentals',
      'Writing Playbooks & Tasks',
      'Designing Reusable Roles',
      'Ansible Vault Credential Encryption'
    ),
    certUrl: 'https://www.redhat.com/en/services/certification/rhce',
  },
  {
    id: 2,
    certCode: 'EX374',
    title: 'Ansible Platform & GitOps Path',
    level: 'Advanced',
    hours: 40,
    description:
      'Advance to enterprise orchestration using Ansible Automation Platform (AAP), Controller administration, and custom execution environments.',
    modules: titledModules(
      'VCS Integration & Webhooks',
      'Building Execution Environments',
      'AAP Controller Configuration',
      'Designing Automation Workflows'
    ),
    certUrl:
      'https://www.redhat.com/en/services/training/red-hat-certified-specialist-developing-automation-ansible-automation-platform-exam',
  },
];

export const resources = [
  resourceRow(
    'redhat-training',
    'Red Hat Training Portal',
    ['Learning Platform', 'school'],
    'https://www.redhat.com/en/services/training-and-certification',
    'Official Red Hat training portal offering courses, certification tracks, exams, and digital badges.'
  ),
  resourceRow(
    'ansible-docs',
    'Ansible Documentation',
    ['Documentation', 'description'],
    'https://docs.ansible.com/',
    'Comprehensive references, playbook guides, community modules documentation, and REST API guides.'
  ),
  resourceRow(
    'ansible-galaxy',
    'Ansible Galaxy Registry',
    ['Registry', 'inventory'],
    'https://galaxy.ansible.com/',
    'Browse, download, and share Ansible roles and collections contributed by the automation community.'
  ),
  resourceRow(
    'redhat-dev',
    'Red Hat Developer',
    ['Builder Resources', 'code'],
    'https://developers.redhat.com/',
    'Access free developer subscriptions, technical articles, and Ansible Automation Platform sandbox guides.'
  ),
  resourceRow(
    'ansible-blog',
    'Official Ansible Blog',
    ['Blog', 'article'],
    'https://www.ansible.com/blog',
    'Read the latest product announcements, case studies, automation patterns, and updates from the Ansible core team.'
  ),
  resourceRow(
    'redhat-labs',
    'Red Hat Interactive Labs',
    ['Labs', 'science'],
    'https://www.redhat.com/en/interactive-labs',
    'Free, sandbox-based interactive courses on Red Hat Enterprise Linux and Ansible Automation Platform.'
  ),
];
