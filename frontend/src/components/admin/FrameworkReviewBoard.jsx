import React, { useState, lazy, Suspense } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Eye, Code, BookOpen, Layers, ExternalLink, Activity } from 'lucide-react';
import ReviewBoardShell, {
  MetadataSelect,
  TextareaCard,
  initialFormFrom,
} from '@/components/admin/ReviewBoardShell';
import ArticleTopicSelect from '@/components/admin/shared/ArticleTopicSelect';
import {
  hasPublishedAddress,
  PUBLISHED_ADDRESS_HINT,
} from '@/components/admin/blog-review/blogReviewModel';
const FrameworkRadar = lazy(() => import('@/components/widgets/FrameworkRadar'));

/**
 * The framework's form from its record: each field, the record keys it may
 * be stored under (legacy spellings included) and its default. Built per
 * call so no two forms share a fallback object.
 */
export function initialFrameworkForm(blog) {
  return initialFormFrom(blog, {
    title: [['title', 'Title'], ''],
    summary: [['summary', 'Summary'], ''],
    cloudProvider: [['cloudProvider', 'Cloud Provider'], 'AWS'],
    // The first word of the page address, `<topic>-<id>` (#1628); '' = pick automatically.
    topic: [['topic'], ''],
    category: [['category'], 'Architecture'],
    complexity: [['complexity'], 'Foundation'],
    tags: [['tags', 'Tags'], []],
    featured: [['featured'], false],
    docLink: [['docLink'], ''],
    overviewHtml: [['overviewHtml', 'overview'], ''],
    commandExample: [['commandExample'], ''],
    keyPillars: [['keyPillars'], []],
    frameworkConcepts: [['frameworkConcepts', 'frameworkConceptSeeds', 'keyPillars'], []],
    patterns: [['patterns'], []],
    architectureRecommendation: [['architectureRecommendation', 'recommendation'], ''],
    frameworkSourceUrls: [['frameworkSourceUrls', 'officialSources'], []],
    frameworkKnowledgePrompt: [['frameworkKnowledgePrompt'], ''],
    frameworkDiagramPrompt: [['frameworkDiagramPrompt'], ''],
    frameworkImagePrompt: [['frameworkImagePrompt'], ''],
    terraformCode: [['terraformCode'], '# IaC example'],
    // Maturity Scoring
    maturityScores: [
      ['maturityScores'],
      { Security: 3, Reliability: 3, Cost: 3, Operations: 3, Performance: 3, Sustainability: 3 },
    ],
  });
}

/** The Pillars tab: three lists typed one item per line. */
const PILLAR_LISTS = [
  {
    field: 'keyPillars',
    title: 'Key Pillars',
    ariaLabel: 'Key pillars, one per line',
    className: 'min-h-37.5 font-mono text-sm',
    placeholder:
      'Security\nReliability\nCost Optimization\nOperational Excellence\nPerformance Efficiency',
    help: 'One pillar per line',
  },
  {
    field: 'patterns',
    title: 'Architecture Patterns',
    ariaLabel: 'Architecture patterns, one per line',
    className: 'min-h-25 font-mono text-sm',
    placeholder: 'Event-Driven\nMicroservices\nMulti-Region',
    help: 'One pattern per line',
  },
  {
    field: 'frameworkConcepts',
    title: 'Framework Concepts (Interactive Nodes)',
    ariaLabel: 'Framework concepts, one per line',
    className: 'min-h-32.5 font-mono text-sm',
    placeholder: 'Security posture\nReliability guardrails\nCost governance',
    help: 'One concept node per line',
  },
];

/**
 * Framework Review Board
 * Specialized admin editor for "Framework" content type.
 * Includes "Next Level Interaction": Radar Chart scoring for pillars.
 *
 * The two-column chrome (title, summary, Delete / Save / Publish, tabs) is
 * ReviewBoardShell, shared with the Architecture board (ADR 0033 §2); this
 * file is the framework's own fields.
 */
export default function FrameworkReviewBoard({ blog, onSave, onPublish, onDelete, saving, error }) {
  const [formData, setFormData] = useState(() => initialFrameworkForm(blog));

  const handleChange = (field, value) => setFormData((prev) => ({ ...prev, [field]: value }));

  const handleScoreChange = (pillar, value) => {
    setFormData((prev) => ({
      ...prev,
      maturityScores: {
        ...prev.maturityScores,
        [pillar]: value,
      },
    }));
  };

  // Prepare data for Radar Chart preview
  const radarData = {
    labels: Object.keys(formData.maturityScores),
    datasets: [
      {
        label: 'Maturity Level',
        data: Object.values(formData.maturityScores),
        backgroundColor: 'rgba(59, 130, 246, 0.2)',
        borderColor: 'rgba(59, 130, 246, 1)',
        borderWidth: 2,
      },
    ],
  };

  const aside = (
    <>
      {/* Live Preview Card */}
      <Card className="bg-card/50">
        <CardHeader>
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Eye className="h-4 w-4" /> Framework Preview
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-62.5 mb-4">
            <Suspense
              fallback={
                <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                  Loading chart…
                </div>
              }
            >
              <FrameworkRadar data={radarData} title="Maturity Model Preview" />
            </Suspense>
          </div>
        </CardContent>
      </Card>

      {/* Maturity Scoring Editor */}
      <Card className="bg-card/50 border-l-4 border-l-purple-500">
        <CardHeader>
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4" /> Maturity Scoring
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {Object.entries(formData.maturityScores).map(([pillar, score]) => (
            <div key={pillar}>
              <div className="flex justify-between text-xs mb-1">
                <label htmlFor={`fw-score-${pillar}`}>{pillar}</label>
                <span className="font-mono">{score}/5</span>
              </div>
              <input
                id={`fw-score-${pillar}`}
                type="range"
                min="1"
                max="5"
                step="1"
                value={score}
                onChange={(e) => handleScoreChange(pillar, parseInt(e.target.value))}
                className="w-full accent-primary h-2 bg-muted rounded-lg appearance-none cursor-pointer"
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Metadata Card */}
      <Card className="bg-card/50">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-muted-foreground">Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <MetadataSelect
            id="fw-cloud-provider"
            label="Cloud Provider"
            value={formData.cloudProvider}
            onChange={(value) => handleChange('cloudProvider', value)}
            options={['AWS', 'Azure', 'GCP', 'FinOps']}
          />
          <MetadataSelect
            id="fw-complexity"
            label="Complexity"
            value={formData.complexity}
            onChange={(value) => handleChange('complexity', value)}
            options={['Foundation', 'Intermediate', 'Advanced']}
          />
          <div>
            <label htmlFor="fw-category" className="text-xs font-medium text-muted-foreground">
              Category
            </label>
            <Input
              id="fw-category"
              value={formData.category}
              onChange={(e) => handleChange('category', e.target.value)}
              className="mt-1 h-8"
              placeholder="Architecture, Security, FinOps..."
            />
          </div>
          <ArticleTopicSelect
            value={formData.topic}
            onChange={(value) => handleChange('topic', value)}
            disabled={hasPublishedAddress(blog)}
            hint={hasPublishedAddress(blog) ? PUBLISHED_ADDRESS_HINT : undefined}
          />
        </CardContent>
      </Card>
    </>
  );

  const lines = (field) => (formData[field] || []).join('\n');
  const setLines = (field) => (e) =>
    handleChange(
      field,
      e.target.value
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
    );

  const tabs = [
    {
      value: 'overview',
      label: 'Overview',
      icon: BookOpen,
      className: 'mt-0 h-full',
      content: (
        <Card className="h-full">
          <CardContent className="h-full p-0">
            <div className="p-4 space-y-4">
              <label htmlFor="fw-overview" className="sr-only">
                HTML overview
              </label>
              <Textarea
                id="fw-overview"
                value={formData.overviewHtml}
                onChange={(e) => handleChange('overviewHtml', e.target.value)}
                className="w-full min-h-65 border-none resize-none p-0 font-mono text-sm"
                placeholder="HTML overview content for the Overview tab..."
              />
              <div>
                <label
                  htmlFor="framework-architecture-recommendation"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Architecture Recommendation
                </label>
                <Textarea
                  id="framework-architecture-recommendation"
                  value={formData.architectureRecommendation}
                  onChange={(e) => handleChange('architectureRecommendation', e.target.value)}
                  className="min-h-22.5 mt-2 text-sm"
                  placeholder="Recommendation pane content shown under concept selections."
                />
              </div>
            </div>
          </CardContent>
        </Card>
      ),
    },
    {
      value: 'pillars',
      label: 'Pillars',
      icon: Layers,
      content: (
        <>
          {PILLAR_LISTS.map(({ field, ...card }) => (
            <TextareaCard
              key={field}
              {...card}
              value={lines(field)}
              onChange={(value) => handleChange(field, value.split('\n').filter(Boolean))}
            />
          ))}
        </>
      ),
    },
    {
      value: 'implementation',
      label: 'IaC',
      icon: Code,
      content: (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">CLI Command Example</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={formData.commandExample}
                onChange={(e) => handleChange('commandExample', e.target.value)}
                aria-label="CLI command example"
                className="min-h-20 font-mono text-sm"
                placeholder="aws wellarchitected list-workloads --region us-east-1"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-2">
              <CardTitle className="text-sm">Terraform / IaC</CardTitle>
              <Badge variant="outline">HCL</Badge>
            </CardHeader>
            <CardContent className="p-0">
              <Textarea
                value={formData.terraformCode}
                onChange={(e) => handleChange('terraformCode', e.target.value)}
                aria-label="Terraform code"
                className="w-full min-h-75 border-none resize-none p-4 font-mono text-sm bg-slate-950 text-slate-50"
                placeholder="# Resource definitions..."
                spellCheck={false}
              />
            </CardContent>
          </Card>
        </>
      ),
    },
    {
      value: 'resources',
      label: 'Resources',
      icon: ExternalLink,
      content: (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Official Documentation URL</CardTitle>
            </CardHeader>
            <CardContent>
              <Input
                value={formData.docLink}
                onChange={(e) => handleChange('docLink', e.target.value)}
                aria-label="Official documentation URL"
                className="font-mono text-xs"
                placeholder="https://docs.provider.com/framework/welcome.html"
              />
              <p className="text-xs text-muted-foreground mt-2">
                This appears on the Resources tab and the header button.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Official Source URLs</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={lines('frameworkSourceUrls')}
                onChange={setLines('frameworkSourceUrls')}
                aria-label="Official source URLs, one per line"
                className="min-h-30 font-mono text-xs"
                placeholder="https://learn.microsoft.com/...
https://docs.aws.amazon.com/..."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">AI/Scraping Prompt Metadata</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                ['frameworkKnowledgePrompt', 'framework-knowledge-prompt', 'Knowledge Prompt'],
                ['frameworkDiagramPrompt', 'framework-diagram-prompt', 'Diagram Prompt'],
                ['frameworkImagePrompt', 'framework-image-prompt', 'Image Prompt'],
              ].map(([field, id, label]) => (
                <div key={field}>
                  <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
                    {label}
                  </label>
                  <Textarea
                    id={id}
                    value={formData[field]}
                    onChange={(e) => handleChange(field, e.target.value)}
                    className="min-h-17.5 mt-1 text-xs"
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      ),
    },
  ];

  return (
    <ReviewBoardShell
      title={formData.title}
      summary={formData.summary}
      onTitleChange={(value) => handleChange('title', value)}
      onSummaryChange={(value) => handleChange('summary', value)}
      titlePlaceholder="Framework Title"
      summaryPlaceholder="Short description / executive summary..."
      saving={saving}
      error={error}
      onSave={() => onSave(formData)}
      onPublish={() => onPublish(formData)}
      onDelete={onDelete ? () => onDelete() : undefined}
      aside={aside}
      tabs={tabs}
    />
  );
}
