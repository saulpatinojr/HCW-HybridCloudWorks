import React from 'react';
import { ContentListingTemplate } from '@/components/templates/ContentListingTemplate';

export default function TerraformModulesPage() {
  const modules = [
    {
      title: 'AWS VPC Module',
      description:
        'Complete VPC setup with subnets, NAT gateways, route tables, and security groups in a reusable module.',
      category: 'Networking',
      complexity: 'Intermediate',
      tags: ['VPC', 'Module', 'AWS'],
    },
    {
      title: 'Kubernetes on EKS Module',
      description:
        'Production-grade EKS cluster module with auto-scaling, networking, and IAM roles configured.',
      category: 'Containers',
      complexity: 'Advanced',
      tags: ['EKS', 'Kubernetes', 'Module'],
    },
    {
      title: 'RDS Database Module',
      description:
        'Reusable RDS module with multi-AZ failover, automated backups, and monitoring enabled.',
      category: 'Databases',
      complexity: 'Intermediate',
      tags: ['RDS', 'Database', 'Module'],
    },
    {
      title: 'S3 Storage Module',
      description:
        'S3 bucket module with encryption, versioning, lifecycle policies, and public access controls.',
      category: 'Storage',
      complexity: 'Beginner',
      tags: ['S3', 'Storage', 'Module'],
    },
    {
      title: 'IAM & Security Module',
      description:
        'IAM roles, policies, and security group module following least privilege principle.',
      category: 'Security',
      complexity: 'Intermediate',
      tags: ['IAM', 'Security', 'Module'],
    },
    {
      title: 'Azure & GCP Equivalents',
      description:
        'Multi-cloud modules for deploying identical infrastructure across Azure and Google Cloud.',
      category: 'Multi-Cloud',
      complexity: 'Advanced',
      tags: ['Azure', 'GCP', 'Module'],
    },
  ];

  const categories = [
    'Networking',
    'Containers',
    'Databases',
    'Storage',
    'Security',
    'Multi-Cloud',
  ];

  return (
    <ContentListingTemplate
      title="Terraform Modules Library"
      description="Production-ready Terraform modules for reusable infrastructure components across clouds."
      items={modules}
      itemType="guide"
      categories={categories}
      icon="view_in_ar"
    />
  );
}
