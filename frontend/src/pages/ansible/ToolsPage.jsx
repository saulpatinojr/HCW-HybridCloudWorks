import React from 'react';
import { useNavigate } from 'react-router';
import { ContentListingTemplate } from '@/components/templates/ContentListingTemplate';
import { routes } from '@/lib/routeFactory';

export default function AnsibleToolsPage() {
  const navigate = useNavigate();

  const tools = [
    {
      title: 'Ansible Playbook & Lint Lab',
      description:
        'Write, lint, and dry-run Ansible playbooks directly in your browser using ansible-playbook and ansible-lint with no local setup required.',
      category: 'Learn',
      complexity: 'Beginner',
      tags: ['Ansible', 'Lint', 'Interactive'],
      path: routes.labs('ansible'),
    },
    {
      title: 'ansible-core CLI',
      description:
        'Core execution engine providing ansible, ansible-playbook, ansible-inventory, ansible-galaxy, and ansible-vault command-line utilities.',
      category: 'Core',
      complexity: 'Beginner',
      tags: ['CLI', 'Core', 'Playbooks'],
    },
    {
      title: 'ansible-lint',
      description:
        'Static analysis tool for playbooks, roles, and collections that enforces production readiness, idempotency, and FQCN standards.',
      category: 'Quality',
      complexity: 'Beginner',
      tags: ['Linting', 'Quality', 'CI/CD'],
    },
    {
      title: 'Molecule',
      description:
        'Testing framework designed to aid in the development and automated verification of Ansible roles and collections across containers and VMs.',
      category: 'Testing',
      complexity: 'Intermediate',
      tags: ['Testing', 'Roles', 'Containers'],
    },
    {
      title: 'ansible-navigator',
      description:
        'Text-based user interface (TUI) and CLI for running and inspecting Ansible content inside Execution Environments.',
      category: 'Execution',
      complexity: 'Intermediate',
      tags: ['TUI', 'Execution Environments', 'Containers'],
    },
    {
      title: 'ansible-builder',
      description:
        'Tool that automates building reproducible container images (Execution Environments) containing collections, Python libraries, and system dependencies.',
      category: 'Packaging',
      complexity: 'Intermediate',
      tags: ['Containers', 'Execution Environments', 'Build'],
    },
    {
      title: 'AWX / Automation Controller',
      description:
        'Web-based user interface, REST interface, and task engine built on top of Ansible for RBAC, job scheduling, and centralized inventory.',
      category: 'Orchestration',
      complexity: 'Advanced',
      tags: ['Orchestration', 'RBAC', 'Scheduling'],
    },
  ];

  const categories = [
    'Learn',
    'Core',
    'Quality',
    'Testing',
    'Execution',
    'Packaging',
    'Orchestration',
  ];

  return (
    <ContentListingTemplate
      title="Ansible Tools & Utilities"
      description="Essential tools for authoring, linting, testing, and orchestrating Ansible automation."
      items={tools}
      itemType="guide"
      categories={categories}
      icon="build"
      onItemClick={(item) => {
        if (item.path) navigate(item.path);
      }}
    />
  );
}
