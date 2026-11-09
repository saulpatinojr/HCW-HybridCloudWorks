import React from 'react';
import { useNavigate } from 'react-router';
import { ContentListingTemplate } from '@/components/templates/ContentListingTemplate';
import { staticRoutes } from '@/lib/routeFactory';

export default function TerraformToolsPage() {
  const navigate = useNavigate();

  const tools = [
    // The site's own tool first: it is the one card here that opens a page on
    // this site rather than describing a product (#668).
    {
      title: 'Landing Zone Builder',
      // "Based on": the wording HashiCorp's trademark policy allows (#1302).
      description:
        'Assemble an Azure landing zone component by component on this site, read what each part is for, and download the Terraform it becomes, based on HashiCorp’s validated pattern “Use Terraform to build an Azure landing zone” and the Azure Verified Modules it uses.',
      category: 'Learn',
      complexity: 'Beginner',
      tags: ['Azure', 'AVM', 'Interactive'],
      path: staticRoutes.landingZone,
    },
    {
      title: 'Terraform CLI',
      description: 'Official Terraform command-line tool with init, plan, apply, and destroy operations.',
      category: 'Core',
      complexity: 'Beginner',
      tags: ['CLI', 'Core', 'Official'],
    },
    {
      title: 'TFLint',
      description: 'Linter for Terraform code quality, security best practices, and AWS/Azure/GCP compliance checks.',
      category: 'Quality',
      complexity: 'Beginner',
      tags: ['Linting', 'Quality', 'Security'],
    },
    {
      title: 'Sentinel',
      description: 'Policy as Code framework for enforcing governance and compliance on Terraform runs.',
      category: 'Governance',
      complexity: 'Advanced',
      tags: ['Policy', 'Governance', 'Compliance'],
    },
  ];

  // Only the tools the site stands behind: Terraform itself, HashiCorp's own
  // Sentinel, and TFLint, which the site's own checks run (owner decision
  // 2026-11-09, ADR 0041). A category with no card left is gone too.
  const categories = ['Learn', 'Core', 'Quality', 'Governance'];

  return (
    <ContentListingTemplate
      title="Terraform Tools & Utilities"
      description="The tools this site recommends for writing, checking and governing Terraform."
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
