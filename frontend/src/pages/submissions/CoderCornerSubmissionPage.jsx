import React, { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Send } from 'lucide-react';
import { submitPublicContent } from '@/lib/publicApi';
import {
  SubmitRow,
  SubmittedCard,
  TextAreaField,
  TextField,
  TitleProviderRow,
} from './SubmissionFields';

const PROVIDER_OPTIONS = ['Github', 'Terraform', 'Docker'];

const EMPTY_FORM = {
  title: '',
  summary: '',
  provider: 'Github',
  language: '',
  repoUrl: '',
  codeSnippet: '',
  explanation: '',
};

export default function CoderCornerSubmissionPage() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));
  /** What every shared field needs: the form and how to change it. */
  const field = { form, onChange: handleChange };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!form.title.trim()) {
      setError('Title is required.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      const title = form.title.trim();
      const summary = form.summary.trim();
      const articleContent = [
        form.explanation.trim(),
        form.codeSnippet.trim()
          ? `\`\`\`${form.language.trim() || ''}\n${form.codeSnippet.trim()}\n\`\`\``
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      await submitPublicContent({
        type: 'coder_corner',
        title,
        summary,
        content: articleContent,
        cloudProvider: form.provider,
        language: form.language.trim(),
        repoUrl: form.repoUrl.trim(),
        codeSnippet: form.codeSnippet.trim(),
        explanation: form.explanation.trim(),
      });

      setSubmitted(true);
      setForm(EMPTY_FORM);
    } catch (submitError) {
      setError(submitError.message || 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <Helmet>
        <title>Coder Corner Templates | HCW</title>
        <meta
          name="description"
          content="Submit Coder Corner technical entries for GitHub, Terraform and Docker workflows."
        />
      </Helmet>

      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold mb-2">Coder Corner Template Submission</h1>
        <p className="text-muted-foreground mb-3">
          Submit practical implementation notes, snippets, and patterns for engineering workflows.
        </p>
        <div className="flex items-center gap-2">
          <Badge variant="outline">GitHub</Badge>
          <Badge variant="outline">Terraform</Badge>
        </div>
      </div>

      {submitted ? (
        <SubmittedCard title="Coder Corner entry submitted" onAnother={() => setSubmitted(false)}>
          The entry is now in review and can be edited before publication.
        </SubmittedCard>
      ) : (
        <Card className="bg-card/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-primary" />
              New Coder Corner Entry
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <TitleProviderRow
                form={form}
                onChange={handleChange}
                titlePlaceholder="Terraform module validation pipeline"
                providerLabel="Provider"
                providers={PROVIDER_OPTIONS}
              />

              <TextAreaField
                {...field}
                name="summary"
                label="Summary"
                placeholder="What problem this snippet solves"
                rows={3}
              />

              <div className="grid md:grid-cols-2 gap-4">
                <TextField
                  {...field}
                  name="language"
                  label="Language / Stack"
                  placeholder="HCL, YAML, Bash"
                />
                <TextField
                  {...field}
                  name="repoUrl"
                  label="Repository URL (optional)"
                  placeholder="https://github.com/org/repo"
                />
              </div>

              <TextAreaField
                {...field}
                name="explanation"
                label="Implementation Notes"
                placeholder="Explain approach, pitfalls, and expected outcomes"
                rows={5}
              />

              <TextAreaField
                {...field}
                name="codeSnippet"
                label="Code Snippet"
                placeholder="Paste sample code"
                rows={10}
              />

              <SubmitRow error={error} submitting={submitting} label="Submit Coder Corner entry" />
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
