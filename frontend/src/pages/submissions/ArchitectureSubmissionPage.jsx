import React, { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import {
  CheckCircle2,
  Send,
  Layers,
  Code,
  ExternalLink,
  ArrowRight,
  Loader2,
  Shield,
  TrendingUp,
  Network,
  Eye,
} from 'lucide-react';
import { submitPublicContent } from '@/lib/publicApi';
import { BasicInfoCard, FieldLabel } from './SubmissionFields';
import SubmissionReceived from './SubmissionReceived';

const REFERENCE_BLUEPRINTS = [
  {
    name: 'AWS Multi-Region Web App',
    components: ['CloudFront', 'ALB', 'ECS', 'RDS Aurora Global'],
    complexity: 'Advanced',
    icon: '🏗️',
    provider: 'aws',
    category: 'Compute',
  },
  {
    name: 'Azure Landing Zone',
    components: ['Management Groups', 'Policy', 'Networking', 'Identity'],
    complexity: 'Foundation',
    icon: '🔵',
    provider: 'azure',
    category: 'Governance',
  },
  {
    name: 'GCP Data Analytics Platform',
    components: ['BigQuery', 'Dataflow', 'Pub/Sub', 'Looker'],
    complexity: 'Intermediate',
    icon: '🔴',
    provider: 'gcp',
    category: 'Data & Analytics',
  },
  {
    name: 'FinOps Cost Governance',
    components: ['Tagging Policy', 'Budget Alerts', 'Rightsizing', 'Reports'],
    complexity: 'Foundation',
    icon: '💰',
    provider: 'finops',
    category: 'FinOps',
  },
  {
    name: 'Serverless Event Platform',
    components: ['API Gateway', 'Lambda/Functions', 'Event Bus', 'DynamoDB'],
    complexity: 'Intermediate',
    icon: '⚡',
    provider: 'aws',
    category: 'Serverless',
  },
  {
    name: 'Zero Trust Network',
    components: ['Identity Provider', 'Micro-segmentation', 'WAF', 'SIEM'],
    complexity: 'Advanced',
    icon: '🔒',
    provider: 'azure',
    category: 'Security',
  },
];

const PROVIDER_OPTIONS = ['AWS', 'Azure', 'GCP', 'FinOps'];
const COMPLEXITY_OPTIONS = ['Foundation', 'Intermediate', 'Advanced'];
const CATEGORY_OPTIONS = [
  'Compute',
  'Networking',
  'Security',
  'FinOps',
  'Serverless',
  'Containers',
  'Data & Analytics',
  'Governance',
  'Migration',
  'AI/ML',
];

const EMPTY_FORM = {
  title: '',
  summary: '',
  cloudProvider: 'AWS',
  category: 'Compute',
  complexity: 'Foundation',
  tags: '',
  diagramUrl: '',
  overviewHtml: '',
  technicalComponents: '',
  estimatedMonthlyCost: '',
  terraformCode: '',
};

export default function ArchitectureSubmissionPage() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [activeTab, setActiveTab] = useState('overview');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) {
      setError('Title is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // The server validates, composes the review-pipeline document, and
      // enforces the anonymous hourly quota (public/submissions).
      await submitPublicContent({
        type: 'architecture',
        title: form.title.trim(),
        summary: form.summary.trim(),
        cloudProvider: form.cloudProvider,
        category: form.category,
        complexity: form.complexity,
        tags: form.tags,
        diagramUrl: form.diagramUrl.trim(),
        overviewHtml: form.overviewHtml.trim(),
      });
      setSubmitted(true);
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(err.message || 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <Helmet>
        <title>Architecture Templates | HCW</title>
        <meta
          name="description"
          content="Reusable architecture patterns and templates for cloud design. Browse blueprints and submit your own."
        />
      </Helmet>

      {/* PAGE HEADER */}
      <div className="mb-12">
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-foreground mb-4">
          Architecture Template Patterns
        </h1>
        <p className="text-muted-foreground text-base sm:text-lg max-w-3xl">
          Reference architectures and design patterns for common cloud scenarios. Browse blueprints
          below, then submit your own via the form.
        </p>
      </div>

      {/* REFERENCE GALLERY */}
      <section className="mb-16">
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
          <span className="w-1 h-5 rounded-full bg-primary inline-block" />
          Reference Architecture Blueprints
        </h2>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {REFERENCE_BLUEPRINTS.map((bp, i) => (
            <Card key={i} className="bg-card/40 hover:bg-card/60 transition-colors group">
              <CardHeader>
                <div className="flex items-start justify-between mb-2">
                  <span className="text-3xl">{bp.icon}</span>
                  <Badge variant="outline" className="ml-auto">
                    {bp.complexity}
                  </Badge>
                </div>
                <CardTitle className="text-lg">{bp.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 mb-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Components:
                  </p>
                  <ul className="text-sm space-y-1">
                    {bp.components.map((comp, j) => (
                      <li key={j} className="flex items-center gap-2">
                        <Layers className="h-3 w-3 text-primary" />
                        <span>{comp}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex items-center justify-between mt-4">
                  <div className="flex items-center gap-2 text-sm text-primary">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>{bp.category}</span>
                  </div>
                  {bp.provider !== 'finops' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      asChild
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Link to={`/${bp.provider}/architecture-designs`}>
                        View All <ArrowRight className="h-3 w-3 ml-1" />
                      </Link>
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card className="bg-card/30">
            <CardHeader>
              <Code className="h-8 w-8 text-primary mb-2" />
              <CardTitle className="text-lg">Infrastructure as Code</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                CloudFormation, Terraform, and ARM templates for rapid architecture deployment.
              </p>
            </CardContent>
          </Card>
          <Card className="bg-card/30">
            <CardHeader>
              <Shield className="h-8 w-8 text-primary mb-2" />
              <CardTitle className="text-lg">Security Patterns</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                Network isolation, encryption, and zero-trust architecture patterns.
              </p>
            </CardContent>
          </Card>
          <Card className="bg-card/30">
            <CardHeader>
              <TrendingUp className="h-8 w-8 text-primary mb-2" />
              <CardTitle className="text-lg">Scalability Design</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                Auto-scaling, load balancing, and distributed architecture patterns.
              </p>
            </CardContent>
          </Card>
          <Card className="bg-card/30">
            <CardHeader>
              <Network className="h-8 w-8 text-primary mb-2" />
              <CardTitle className="text-lg">Resilience & DR</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                Disaster recovery and business continuity patterns for high availability.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      <Separator className="mb-16" />

      {/* SUBMISSION FORM */}
      <section>
        <div className="mb-8">
          <h2 className="text-2xl font-bold mb-2 flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" />
            Submit an Architecture Blueprint
          </h2>
          <p className="text-muted-foreground text-sm max-w-2xl">
            Create your own cloud architecture blueprint. Once submitted it is reviewed before being
            published to the provider&apos;s Architecture Designs page.
          </p>
        </div>

        {submitted ? (
          <SubmissionReceived
            title="Blueprint Submitted!"
            message="Your architecture blueprint has been submitted for review. It will be published once it has been reviewed."
            onAnother={() => setSubmitted(false)}
          />
        ) : (
          <form onSubmit={handleSubmit} className="max-w-4xl space-y-6">
            {/* Basic Info */}
            <BasicInfoCard
              idPrefix="arch"
              form={form}
              onChange={handleChange}
              text={{
                titleLabel: 'Blueprint Title *',
                titlePlaceholder: 'AWS Multi-Region Web Application',
                summaryPlaceholder:
                  'A highly available, multi-region web application architecture using...',
                tagsPlaceholder: 'HA, Multi-Region, Auto-Scaling',
              }}
              options={{
                providers: PROVIDER_OPTIONS,
                categories: CATEGORY_OPTIONS,
                complexities: COMPLEXITY_OPTIONS,
              }}
            >
              <div>
                <FieldLabel htmlFor="arch-diagram">Architecture Diagram URL</FieldLabel>
                <Input
                  id="arch-diagram"
                  value={form.diagramUrl}
                  onChange={(e) => handleChange('diagramUrl', e.target.value)}
                  placeholder="https://..."
                  type="url"
                />
              </div>
            </BasicInfoCard>

            {/* Content Tabs */}
            <Card className="bg-card/40">
              <CardHeader>
                <CardTitle className="text-base">Blueprint Content</CardTitle>
              </CardHeader>
              <CardContent>
                <Tabs value={activeTab} onValueChange={setActiveTab}>
                  <TabsList className="grid w-full grid-cols-4 mb-4">
                    <TabsTrigger value="overview">
                      <Eye className="h-3 w-3 mr-1" /> Overview
                    </TabsTrigger>
                    <TabsTrigger value="technical">
                      <Layers className="h-3 w-3 mr-1" /> Technical
                    </TabsTrigger>
                    <TabsTrigger value="iac">
                      <Code className="h-3 w-3 mr-1" /> IaC
                    </TabsTrigger>
                    <TabsTrigger value="finops">
                      <ExternalLink className="h-3 w-3 mr-1" /> FinOps
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview">
                    <Textarea
                      value={form.overviewHtml}
                      onChange={(e) => handleChange('overviewHtml', e.target.value)}
                      className="min-h-[200px] font-mono text-sm"
                      placeholder="<p>HTML overview content describing the architecture...</p>"
                    />
                    <p className="text-xs text-muted-foreground mt-2">
                      Supports HTML. Renders in the Overview tab on the detail page.
                    </p>
                  </TabsContent>
                  <TabsContent value="technical" className="space-y-4">
                    <div>
                      <label
                        htmlFor="arch-components"
                        className="text-xs font-medium text-muted-foreground mb-1 block"
                      >
                        Technical Components (one per line)
                      </label>
                      <Textarea
                        id="arch-components"
                        value={form.technicalComponents}
                        onChange={(e) => handleChange('technicalComponents', e.target.value)}
                        className="min-h-[140px] font-mono text-sm"
                        placeholder="Amazon CloudFront&#10;Application Load Balancer&#10;ECS Fargate&#10;RDS Aurora Global&#10;ElastiCache Redis"
                      />
                    </div>
                  </TabsContent>
                  <TabsContent value="iac" className="space-y-4">
                    <div>
                      <label
                        htmlFor="arch-iac"
                        className="text-xs font-medium text-muted-foreground mb-1 block"
                      >
                        Terraform / CloudFormation / Bicep Example
                      </label>
                      <Textarea
                        id="arch-iac"
                        value={form.terraformCode}
                        onChange={(e) => handleChange('terraformCode', e.target.value)}
                        className="min-h-[200px] font-mono text-sm bg-slate-950 text-slate-50"
                        placeholder="# terraform block..."
                        spellCheck={false}
                      />
                    </div>
                  </TabsContent>
                  <TabsContent value="finops" className="space-y-4">
                    <div>
                      <label
                        htmlFor="arch-cost"
                        className="text-xs font-medium text-muted-foreground mb-1 block"
                      >
                        Estimated Monthly Cost
                      </label>
                      <Input
                        id="arch-cost"
                        value={form.estimatedMonthlyCost}
                        onChange={(e) => handleChange('estimatedMonthlyCost', e.target.value)}
                        placeholder="$2,400 / month"
                        className="max-w-xs"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Rough cost estimate for this architecture. A detailed cost breakdown can be
                      added after review.
                    </p>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>

            {error && (
              <p className="text-destructive text-sm bg-destructive/10 border border-destructive/20 rounded-md px-4 py-3">
                {error}
              </p>
            )}

            <div className="flex items-center gap-4">
              <Button type="submit" disabled={submitting} size="lg">
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Submit for Review
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                Your blueprint is reviewed before it is published.
              </p>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
