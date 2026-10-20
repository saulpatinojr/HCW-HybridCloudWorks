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
      title: 'Terragrunt',
      description: 'Wrapper for Terraform providing DRY configs, remote state management, and dependency handling.',
      category: 'Orchestration',
      complexity: 'Intermediate',
      tags: ['Orchestration', 'DRY', 'State'],
    },
    {
      title: 'Infracost',
      description: 'Cost estimation tool showing infrastructure costs before deployment and in pull requests.',
      category: 'Cost Management',
      complexity: 'Beginner',
      tags: ['Cost', 'Estimation', 'CI/CD'],
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
    {
      title: 'Atlantis',
      description: 'Terraform automation and collaboration platform for pull request-based infrastructure updates.',
      category: 'Automation',
      complexity: 'Advanced',
      tags: ['Automation', 'CI/CD', 'Collaboration'],
    },
  ];

  const categories = ['Learn', 'Core', 'Orchestration', 'Cost Management', 'Quality', 'Governance', 'Automation'];

  return (
    <ContentListingTemplate
      title="Terraform Tools & Utilities"
      description="Essential and advanced tools for Terraform development, testing, cost management, and automation."
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
