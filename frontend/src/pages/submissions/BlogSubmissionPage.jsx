import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Send } from 'lucide-react';
import { submitPublicContent } from '@/lib/publicApi';
import {
  SubmitRow,
  SubmittedCard,
  TextAreaField,
  TextField,
  TitleProviderRow,
} from './SubmissionFields';

const MAX_CONTENT_LENGTH = 50000;
const VALID_URL_RE = /^https?:\/\/.+\..+/;

const PROVIDER_OPTIONS = ['Azure', 'Aws', 'Gcp', 'Github', 'Terraform', 'Finops', 'Docker'];

const EMPTY_FORM = {
  title: '',
  summary: '',
  provider: 'Azure',
  tags: '',
  sourceUrl: '',
  content: '',
};

/** Why the draft cannot be sent yet, or '' when it can. */
function blogFormProblem(form) {
  if (!form.title.trim()) return 'Title is required.';
  if (form.sourceUrl.trim() && !VALID_URL_RE.test(form.sourceUrl.trim())) {
    return 'Source URL must be a valid http/https URL.';
  }
  if (form.content.length > MAX_CONTENT_LENGTH) {
    return `Content must be under ${MAX_CONTENT_LENGTH / 1000}KB.`;
  }
  return '';
}

export default function BlogSubmissionPage() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));
  /** What every shared field needs: the form and how to change it. */
  const field = { form, onChange: handleChange };

  useEffect(() => {
    if (!submitted) return;
    const timer = setTimeout(() => setSubmitted(false), 5000);
    return () => clearTimeout(timer);
  }, [submitted]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const problem = blogFormProblem(form);
    if (problem) {
      setError(problem);
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      const title = form.title.trim();
      const summary = form.summary.trim();
      const content = form.content.trim();

      // The server validates, composes the review-pipeline document, and
      // enforces the anonymous hourly quota (public/submissions).
      await submitPublicContent({
        type: 'blog',
        title,
        summary,
        content,
        cloudProvider: form.provider,
        tags: form.tags,
        sourceUrl: form.sourceUrl.trim(),
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
        <title>Blog Templates | HCW</title>
        <meta
          name="description"
          content="Submit draft blog content for review before it is published."
        />
      </Helmet>

      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold mb-2">Blog Template Submission</h1>
        <p className="text-muted-foreground">
          Create a blog draft and send it for review before publishing.
        </p>
      </div>

      {submitted ? (
        <SubmittedCard title="Blog draft submitted" onAnother={() => setSubmitted(false)}>
          The draft has been submitted for review.
        </SubmittedCard>
      ) : (
        <Card className="bg-card/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-primary" />
              New Blog Draft
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <TitleProviderRow
                form={form}
                onChange={handleChange}
                titlePlaceholder="Enter blog title"
                providerLabel="Cloud Provider"
                providers={PROVIDER_OPTIONS}
              />

              <TextAreaField
                {...field}
                name="summary"
                label="Summary"
                placeholder="Short summary for preview cards"
                rows={3}
              />

              <div className="grid md:grid-cols-2 gap-4">
                <TextField
                  {...field}
                  name="tags"
                  label="Tags (comma-separated)"
                  placeholder="kubernetes, finops, optimization"
                />
                <TextField
                  {...field}
                  name="sourceUrl"
                  label="Source URL (optional)"
                  placeholder="https://example.com"
                />
              </div>

              <TextAreaField
                {...field}
                name="content"
                label="Blog Content"
                placeholder="Write markdown or plain text content"
                rows={12}
              />

              <SubmitRow error={error} submitting={submitting} label="Submit blog draft" />
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
