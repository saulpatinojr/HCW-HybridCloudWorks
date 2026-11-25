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
  BookOpen,
  Zap,
  Grid3x3,
  Send,
  Layers,
  Code,
  ExternalLink,
  ArrowRight,
  Loader2,
} from 'lucide-react';
import { submitPublicContent } from '@/lib/publicApi';
import { BasicInfoCard, FieldLabel } from './SubmissionFields';
import SubmissionReceived from './SubmissionReceived';

const REFERENCE_FRAMEWORKS = [
  {
    name: 'AWS Well-Architected Framework',
    pillars: 6,
    focus: 'Design principles for secure, reliable, efficient infrastructure.',
    icon: '🏗️',
    provider: 'aws',
    complexity: 'Foundation',
  },
  {
    name: 'Azure Well-Architected Review',
    pillars: 5,
    focus: 'Architecture review framework aligned with Microsoft design patterns.',
    icon: '🔵',
    provider: 'azure',
    complexity: 'Foundation',
  },
  {
    name: 'Google Cloud Architecture Framework',
    pillars: 4,
    focus: 'Key architectural principles for successful cloud implementations.',
    icon: '🔴',
    provider: 'gcp',
    complexity: 'Foundation',
  },
];

const PROVIDER_OPTIONS = ['AWS', 'Azure', 'GCP'];
const COMPLEXITY_OPTIONS = ['Foundation', 'Intermediate', 'Advanced'];
const CATEGORY_OPTIONS = [
  'Architecture',
  'Security',
  'FinOps',
  'Migration',
  'Governance',
  'Operations',
  'Data & Analytics',
  'Containers',
];

const EMPTY_FORM = {
  title: '',
  summary: '',
  cloudProvider: 'AWS',
  category: 'Architecture',
  complexity: 'Foundation',
  tags: '',
  docLink: '',
  overviewHtml: '',
  commandExample: '',
  keyPillars: '',
  patterns: '',
  terraformCode: '',
};

export default function FrameworkSubmissionPage() {
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
        type: 'framework',
        title: form.title.trim(),
        summary: form.summary.trim(),
        cloudProvider: form.cloudProvider,
        category: form.category,
        complexity: form.complexity,
        tags: form.tags,
        docLink: form.docLink.trim(),
        overviewHtml: form.overviewHtml.trim(),
        commandExample: form.commandExample.trim(),
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
        <title>Framework Templates | HCW</title>
        <meta
          name="description"
          content="Browse framework patterns and submit your own cloud framework for review."
        />
      </Helmet>

      {/* PAGE HEADER */}
      <div className="mb-12">
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-foreground mb-4">
          Framework Template Patterns
        </h1>
        <p className="text-muted-foreground text-base sm:text-lg max-w-3xl">
          Reusable framework structures for assessing, designing, and optimizing cloud
          architectures. Browse examples below, then submit your own via the form.
        </p>
      </div>

      {/* REFERENCE GALLERY */}
      <section className="mb-16">
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
          <span className="w-1 h-5 rounded-full bg-primary inline-block" />
          Browse Framework Patterns
        </h2>

        <div className="grid md:grid-cols-2 gap-6 mb-8">
          {REFERENCE_FRAMEWORKS.map((fw, i) => (
            <Card key={i} className="bg-card/40 hover:bg-card/60 transition-colors group">
              <CardHeader>
                <div className="flex items-start justify-between mb-2">
                  <span className="text-3xl">{fw.icon}</span>
                  <Badge variant="outline" className="ml-auto">
                    {fw.pillars} Pillars
                  </Badge>
                </div>
                <CardTitle className="text-xl">{fw.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm mb-4">{fw.focus}</p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-primary">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>{fw.complexity}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    asChild
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Link to={`/${fw.provider}/frameworks`}>
                      View All <ArrowRight className="h-3 w-3 ml-1" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <Card className="bg-card/30">
            <CardHeader>
              <Grid3x3 className="h-8 w-8 text-primary mb-2" />
              <CardTitle className="text-lg">Framework Components</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                Each framework includes pillars, design principles, and assessment criteria for
                comprehensive architecture review.
              </p>
            </CardContent>
          </Card>
          <Card className="bg-card/30">
            <CardHeader>
              <BookOpen className="h-8 w-8 text-primary mb-2" />
              <CardTitle className="text-lg">Documentation</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                Access official framework documentation and detailed implementation guides for each
                cloud provider.
              </p>
            </CardContent>
          </Card>
          <Card className="bg-card/30">
            <CardHeader>
              <Zap className="h-8 w-8 text-primary mb-2" />
              <CardTitle className="text-lg">Quick Assessments</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                Run automated assessments using framework-aligned tools and generate improvement
                recommendations.
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
            Submit a Framework Blueprint
          </h2>
          <p className="text-muted-foreground text-sm max-w-2xl">
            Create your own cloud framework entry. Once submitted it is reviewed before being
            published to the provider&apos;s Frameworks page.
          </p>
        </div>

        {submitted ? (
          <SubmissionReceived
            title="Framework Submitted!"
            message="Your framework has been submitted for review. It will be published once it has been reviewed."
            onAnother={() => setSubmitted(false)}
          />
        ) : (
          <form onSubmit={handleSubmit} className="max-w-4xl space-y-6">
            {/* Basic Info */}
            <BasicInfoCard
              idPrefix="fw-sub"
              form={form}
              onChange={handleChange}
              text={{
                titleLabel: 'Framework Title *',
                titlePlaceholder: 'AWS Well-Architected Framework',
                summaryPlaceholder:
                  'Comprehensive framework for building secure, reliable infrastructure...',
                tagsPlaceholder: 'WAF, Security, Best Practices',
              }}
              options={{
                providers: PROVIDER_OPTIONS,
                categories: CATEGORY_OPTIONS,
                complexities: COMPLEXITY_OPTIONS,
              }}
            >
              <div>
                <FieldLabel htmlFor="fw-sub-doc">Official Documentation Link</FieldLabel>
                <Input
                  id="fw-sub-doc"
                  value={form.docLink}
                  onChange={(e) => handleChange('docLink', e.target.value)}
                  placeholder="https://docs.aws.amazon.com/wellarchitected/..."
                  type="url"
                />
              </div>
            </BasicInfoCard>

            {/* Content Tabs */}
            <Card className="bg-card/40">
              <CardHeader>
                <CardTitle className="text-base">Framework Content</CardTitle>
              </CardHeader>
              <CardContent>
                <Tabs value={activeTab} onValueChange={setActiveTab}>
                  <TabsList className="grid w-full grid-cols-4 mb-4">
                    <TabsTrigger value="overview">
                      <BookOpen className="h-3 w-3 mr-1" /> Overview
                    </TabsTrigger>
                    <TabsTrigger value="pillars">
                      <Layers className="h-3 w-3 mr-1" /> Pillars
                    </TabsTrigger>
                    <TabsTrigger value="implementation">
                      <Code className="h-3 w-3 mr-1" /> IaC
                    </TabsTrigger>
                    <TabsTrigger value="resources">
                      <ExternalLink className="h-3 w-3 mr-1" /> Resources
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview">
                    <Textarea
                      value={form.overviewHtml}
                      onChange={(e) => handleChange('overviewHtml', e.target.value)}
                      className="min-h-[200px] font-mono text-sm"
                      placeholder="<p>HTML overview content...</p>"
                    />
                    <p className="text-xs text-muted-foreground mt-2">
                      Supports HTML. Renders in the Overview tab on the detail page.
                    </p>
                  </TabsContent>
                  <TabsContent value="pillars" className="space-y-4">
                    <div>
                      <label
                        htmlFor="fw-sub-pillars"
                        className="text-xs font-medium text-muted-foreground mb-1 block"
                      >
                        Key Pillars (one per line)
                      </label>
                      <Textarea
                        id="fw-sub-pillars"
                        value={form.keyPillars}
                        onChange={(e) => handleChange('keyPillars', e.target.value)}
                        className="min-h-[120px] font-mono text-sm"
                        placeholder="Security&#10;Reliability&#10;Cost Optimization&#10;Operational Excellence&#10;Performance Efficiency"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="fw-sub-patterns"
                        className="text-xs font-medium text-muted-foreground mb-1 block"
                      >
                        Architecture Patterns (one per line)
                      </label>
                      <Textarea
                        id="fw-sub-patterns"
                        value={form.patterns}
                        onChange={(e) => handleChange('patterns', e.target.value)}
                        className="min-h-[80px] font-mono text-sm"
                        placeholder="Event-Driven&#10;Microservices&#10;Multi-Region"
                      />
                    </div>
                  </TabsContent>
                  <TabsContent value="implementation" className="space-y-4">
                    <div>
                      <label
                        htmlFor="fw-sub-cli"
                        className="text-xs font-medium text-muted-foreground mb-1 block"
                      >
                        CLI Command Example
                      </label>
                      <Textarea
                        id="fw-sub-cli"
                        value={form.commandExample}
                        onChange={(e) => handleChange('commandExample', e.target.value)}
                        className="min-h-[60px] font-mono text-sm"
                        placeholder="aws wellarchitected list-workloads --region us-east-1"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="fw-sub-iac"
                        className="text-xs font-medium text-muted-foreground mb-1 block"
                      >
                        Terraform / IaC Example
                      </label>
                      <Textarea
                        id="fw-sub-iac"
                        value={form.terraformCode}
                        onChange={(e) => handleChange('terraformCode', e.target.value)}
                        className="min-h-[160px] font-mono text-sm bg-slate-950 text-slate-50"
                        placeholder="# terraform block..."
                        spellCheck={false}
                      />
                    </div>
                  </TabsContent>
                  <TabsContent value="resources">
                    <p className="text-xs text-muted-foreground mb-2">
                      Add the official documentation URL above. Additional links can be added after
                      review.
                    </p>
                    {form.docLink && (
                      <Card className="bg-card/30">
                        <CardContent className="flex items-center gap-3 pt-4 pb-4">
                          <ExternalLink className="h-4 w-4 text-primary shrink-0" />
                          <span className="text-sm font-mono truncate">{form.docLink}</span>
                        </CardContent>
                      </Card>
                    )}
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
                Your framework is reviewed before it is published.
              </p>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
