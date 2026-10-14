import React from 'react';
import { ContentListingTemplate } from '@/components/templates/ContentListingTemplate';

export default function FinOpsFocusPage() {
  const focusAreas = [
    {
      title: 'Informing',
      description:
        'Build cost awareness through dashboards, reports, and cost allocation to enable informed decisions across the organization.',
      category: 'Foundation',
      complexity: 'Beginner',
      tags: ['Awareness', 'Dashboards', 'Reporting'],
    },
    {
      title: 'Optimizing',
      description:
        'Identify and eliminate waste through rightsizing, reserved capacity, and commitment discount optimization.',
      category: 'Operational',
      complexity: 'Intermediate',
      tags: ['Optimization', 'Savings', 'Automation'],
    },
    {
      title: 'Evolving',
      description:
        'Advance FinOps maturity through automation, governance policies, and integration with business processes.',
      category: 'Strategic',
      complexity: 'Advanced',
      tags: ['Evolution', 'Maturity', 'Integration'],
    },
    {
      title: 'Allocating',
      description:
        'Implement chargeback models and cost allocation to drive accountability and informed cloud usage.',
      category: 'Organizational',
      complexity: 'Intermediate',
      tags: ['Allocation', 'Chargeback', 'Accountability'],
    },
    {
      title: 'Planning',
      description:
        'Forecast cloud spending and align infrastructure investment with business goals and budgets.',
      category: 'Financial',
      complexity: 'Intermediate',
      tags: ['Planning', 'Forecasting', 'Budget'],
    },
    {
      title: 'Managing',
      description:
        'Establish governance controls and policies to prevent cost overruns and enforce spending limits.',
      category: 'Governance',
      complexity: 'Intermediate',
      tags: ['Governance', 'Controls', 'Policies'],
    },
  ];

  const categories = [
    'Foundation',
    'Operational',
    'Strategic',
    'Organizational',
    'Financial',
    'Governance',
  ];

  return (
    <ContentListingTemplate
      title="FinOps FOCUS 1.4 Framework"
      description="The six core focus areas of the FinOps Foundation framework and FOCUS 1.4 specification for cloud cost management maturity."
      items={focusAreas}
      itemType="guide"
      categories={categories}
      icon="center_focus_strong"
    />
  );
}
