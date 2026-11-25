/**
 * Form pieces the submission pages share. The architecture and framework
 * pages share the "Basic Information" card, its link field, the content tab
 * buttons and the overview tab; the blog and Coder Corner pages share the
 * title-and-provider row, the plain text fields, the "submitted" card and the
 * submit button. Each page used to write these out in full.
 */
import React from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

const LABEL = 'text-xs font-medium text-muted-foreground mb-1 block';
const SELECT = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

/** A small label above a field. */
export function FieldLabel({ htmlFor, children }) {
  return (
    <label htmlFor={htmlFor} className={LABEL}>
      {children}
    </label>
  );
}

function LabeledSelect({ id, label, value, onChange, options }) {
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The "Basic Information" card: title, provider, summary, category,
 * complexity and tags. `idPrefix` names the fields' ids ("arch" gives
 * "arch-title"); `text` holds the page's own labels and placeholders;
 * `children` is the page's link field, under the rest.
 */
export function BasicInfoCard({ idPrefix, form, onChange, text, options, children }) {
  const id = (name) => `${idPrefix}-${name}`;
  return (
    <Card className="bg-card/40">
      <CardHeader>
        <CardTitle className="text-base">Basic Information</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <FieldLabel htmlFor={id('title')}>{text.titleLabel}</FieldLabel>
            <Input
              id={id('title')}
              value={form.title}
              onChange={(e) => onChange('title', e.target.value)}
              placeholder={text.titlePlaceholder}
              required
            />
          </div>
          <LabeledSelect
            id={id('provider')}
            label="Cloud Provider *"
            value={form.cloudProvider}
            onChange={(value) => onChange('cloudProvider', value)}
            options={options.providers}
          />
        </div>
        <div>
          <FieldLabel htmlFor={id('summary')}>Short Description / Summary *</FieldLabel>
          <Textarea
            id={id('summary')}
            value={form.summary}
            onChange={(e) => onChange('summary', e.target.value)}
            placeholder={text.summaryPlaceholder}
            className="min-h-[80px]"
            required
          />
        </div>
        <div className="grid md:grid-cols-3 gap-4">
          <LabeledSelect
            id={id('category')}
            label="Category"
            value={form.category}
            onChange={(value) => onChange('category', value)}
            options={options.categories}
          />
          <LabeledSelect
            id={id('complexity')}
            label="Complexity"
            value={form.complexity}
            onChange={(value) => onChange('complexity', value)}
            options={options.complexities}
          />
          <div>
            <FieldLabel htmlFor={id('tags')}>Tags (comma-separated)</FieldLabel>
            <Input
              id={id('tags')}
              value={form.tags}
              onChange={(e) => onChange('tags', e.target.value)}
              placeholder={text.tagsPlaceholder}
            />
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * The page's own link field, under the "Basic Information" card
 * (architecture and framework). Like the fields below, it reads
 * `form[name]` and reports a change as `onChange(name, value)`.
 */
export function UrlField({ form, onChange, name, id, label, placeholder }) {
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={form[name]}
        onChange={(e) => onChange(name, e.target.value)}
        placeholder={placeholder}
        type="url"
      />
    </div>
  );
}

/** The four tab buttons above the content editor. Each tab is `{ value, Icon, label }`. */
export function ContentTabList({ tabs }) {
  return (
    <TabsList className="grid w-full grid-cols-4 mb-4">
      {tabs.map(({ value, Icon, label }) => (
        <TabsTrigger key={value} value={value}>
          <Icon className="h-3 w-3 mr-1" />
          {` ${label}`}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

/** The "Overview" tab: one HTML text area and a line on where it shows. */
export function OverviewTab({ value, onChange, placeholder }) {
  return (
    <TabsContent value="overview">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[200px] font-mono text-sm"
        placeholder={placeholder}
      />
      <p className="text-xs text-muted-foreground mt-2">
        Supports HTML. Renders in the Overview tab on the detail page.
      </p>
    </TabsContent>
  );
}

/** The title field and the provider list, side by side (blog and Coder Corner). */
export function TitleProviderRow({ form, onChange, titlePlaceholder, providerLabel, providers }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div>
        <p className="text-sm font-medium">Title</p>
        <Input
          value={form.title}
          onChange={(event) => onChange('title', event.target.value)}
          placeholder={titlePlaceholder}
          required
        />
      </div>
      <div>
        <p className="text-sm font-medium">{providerLabel}</p>
        <select
          className="w-full mt-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={form.provider}
          onChange={(event) => onChange('provider', event.target.value)}
        >
          {providers.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** A labelled one-line text field for `form[name]` (blog and Coder Corner). */
export function TextField({ form, onChange, name, label, placeholder }) {
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      <Input
        value={form[name]}
        onChange={(event) => onChange(name, event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

/** A labelled text area for `form[name]` (blog and Coder Corner). */
export function TextAreaField({ form, onChange, name, label, placeholder, rows }) {
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      <Textarea
        value={form[name]}
        onChange={(event) => onChange(name, event.target.value)}
        placeholder={placeholder}
        rows={rows}
      />
    </div>
  );
}

/** The card shown once the form went through, with "Submit another". */
export function SubmittedCard({ title, children, onAnother }) {
  return (
    <Card className="border-green-500/30 bg-card/40">
      <CardContent className="pt-8 pb-8 text-center space-y-3">
        <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-muted-foreground text-sm">{children}</p>
        <Button onClick={onAnother}>Submit another</Button>
      </CardContent>
    </Card>
  );
}

/** The form's error line and its submit button, which spins while sending. */
export function SubmitRow({ error, submitting, label }) {
  return (
    <>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={submitting} className="w-full md:w-auto">
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Submitting...
          </>
        ) : (
          label
        )}
      </Button>
    </>
  );
}
