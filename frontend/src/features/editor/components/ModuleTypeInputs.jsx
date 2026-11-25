import React from 'react';
import { ClipboardPaste } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { SPACER_STYLE_OPTIONS } from '@/components/modules/InlineModules';
import { resolveMediaUrl } from '../../../lib/functionsBase';

// The type-specific inputs of ModuleForm: one small component per module
// type, picked from INPUTS_BY_TYPE. Line-oriented encodings match useModules'
// parse helpers (hooks/moduleFormEncoding.js).

// A textarea bound to one form field.
function FieldTextarea({ field, form, setModuleFormField, className, placeholder }) {
  return (
    <Textarea
      value={form[field]}
      onChange={(e) => setModuleFormField(field, e.target.value)}
      className={className}
      placeholder={placeholder}
    />
  );
}

// A one-line input bound to one form field.
function FieldInput({ field, form, setModuleFormField, placeholder }) {
  return (
    <Input
      value={form[field]}
      onChange={(e) => setModuleFormField(field, e.target.value)}
      placeholder={placeholder}
      className="text-sm"
    />
  );
}

// A short hint above a monospace content textarea.
function HintedContent({ hint, className, placeholder, form, setModuleFormField }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{hint}</p>
      <FieldTextarea
        field="content"
        form={form}
        setModuleFormField={setModuleFormField}
        className={className}
        placeholder={placeholder}
      />
    </div>
  );
}

function PlainContentInputs(props) {
  return (
    <FieldTextarea
      field="content"
      {...props}
      className="min-h-[100px] text-sm"
      placeholder="Write the module content..."
    />
  );
}

function CodeInputs(props) {
  return (
    <FieldTextarea
      field="content"
      {...props}
      className="min-h-[100px] text-sm font-mono"
      placeholder="Paste a code snippet here..."
    />
  );
}

function LinksInputs(props) {
  return (
    <HintedContent
      {...props}
      hint={
        <>
          One link per line. Markdown format: <code className="text-xs">- [Title](url)</code>
        </>
      }
      className="min-h-[80px] text-sm font-mono"
      placeholder="- [AWS Docs](https://docs.aws.amazon.com)"
    />
  );
}

function PictureInputs({ form, setModuleFormField, imageCandidates }) {
  const imageUrlInputRef = React.useRef(null);
  const { imageUrl } = form;

  function applyImageUrlValue(value) {
    setModuleFormField('imageUrl', String(value || '').trim());
  }

  function handleImageUrlPaste(event) {
    const pastedValue = event.clipboardData?.getData('text');
    if (!pastedValue) return;
    applyImageUrlValue(pastedValue);
  }

  function handleImageUrlDrop(event) {
    const droppedValue = event.dataTransfer?.getData('text/plain');
    if (!droppedValue) return;
    event.preventDefault();
    event.stopPropagation();
    applyImageUrlValue(droppedValue);
  }

  async function handlePasteButtonClick() {
    try {
      const clipboardValue = await navigator.clipboard?.readText?.();
      if (clipboardValue) {
        applyImageUrlValue(clipboardValue);
        imageUrlInputRef.current?.focus();
        return;
      }
    } catch {
      // Fall back to manual entry if clipboard access is blocked by the browser.
    }

    const manualValue = window.prompt('Paste the external image URL');
    if (manualValue) {
      applyImageUrlValue(manualValue);
      imageUrlInputRef.current?.focus();
    }
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div className="flex gap-2">
          <Input
            ref={imageUrlInputRef}
            value={imageUrl}
            onChange={(e) => applyImageUrlValue(e.target.value)}
            onPaste={handleImageUrlPaste}
            onDrop={handleImageUrlDrop}
            onDragOver={(event) => event.preventDefault()}
            placeholder="https://example.com/image.png"
            className="text-sm"
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={handlePasteButtonClick}
          >
            <ClipboardPaste className="h-3.5 w-3.5 mr-1" />
            Paste URL
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          External image URLs stay external. They are not copied into the Image Gallery unless you
          manually upload them there.
        </p>
      </div>
      <FieldInput
        field="caption"
        form={form}
        setModuleFormField={setModuleFormField}
        placeholder="Caption (optional)"
      />
      {/* Quick-pick from image candidates */}
      {imageCandidates.length > 0 && (
        <div className="grid grid-cols-4 gap-1 max-h-32 overflow-y-auto">
          {imageCandidates.slice(0, 12).map((img) => (
            <button
              key={img.id}
              type="button"
              className={`rounded border overflow-hidden transition-all ${
                imageUrl === img.imageUrl
                  ? 'ring-2 ring-primary'
                  : 'border-border hover:border-primary/50'
              }`}
              onClick={() => setModuleFormField('imageUrl', img.imageUrl)}
              title={img.label}
            >
              <img
                src={resolveMediaUrl(img.imageUrl)}
                alt={img.label}
                className="w-full h-10 object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VideoInputs({ form, setModuleFormField }) {
  return (
    <div className="space-y-2">
      <Input
        value={form.videoUrl}
        onChange={(e) => setModuleFormField('videoUrl', String(e.target.value || '').trim())}
        placeholder="https://www.youtube.com/watch?v=..."
        className="text-sm"
        autoComplete="off"
        spellCheck={false}
      />
      <p className="text-xs text-muted-foreground">
        YouTube only. Click plays; double-click toggles 50% screen size in the published article.
      </p>
      <FieldInput
        field="caption"
        form={form}
        setModuleFormField={setModuleFormField}
        placeholder="Caption (optional)"
      />
    </div>
  );
}

function SpacerInputs({ form, setModuleFormField }) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {(SPACER_STYLE_OPTIONS || []).map(({ key, label }) => (
        <Button
          key={key}
          type="button"
          variant={form.content === key ? 'default' : 'outline'}
          size="sm"
          className="h-7 text-xs"
          onClick={() => setModuleFormField('content', key)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function PullQuoteInputs(props) {
  return (
    <div className="space-y-2">
      <FieldTextarea
        field="content"
        {...props}
        className="min-h-[80px] text-sm"
        placeholder="The one sentence worth restating large..."
      />
      <FieldInput field="attribution" {...props} placeholder="Attribution (optional)" />
    </div>
  );
}

function StatBoardInputs(props) {
  return (
    <HintedContent
      {...props}
      hint={
        <>
          One stat per line (2-4): <code className="text-xs">value | label | sublabel</code>{' '}
          (sublabel optional)
        </>
      }
      className="min-h-[80px] text-sm font-mono"
      placeholder={'40% | lower cost\n3x | faster deploys'}
    />
  );
}

function ComparisonInputs(props) {
  return (
    <HintedContent
      {...props}
      hint={
        <>
          First line: column headers separated by <code className="text-xs">|</code>. Each following
          line: one row.
        </>
      }
      className="min-h-[100px] text-sm font-mono"
      placeholder={'Dimension | Option A | Option B\nCost | $ | $$'}
    />
  );
}

function TimelineInputs(props) {
  return (
    <HintedContent
      {...props}
      hint={
        <>
          One step per line (at least 2): <code className="text-xs">Title :: detail</code> (detail
          optional)
        </>
      }
      className="min-h-[100px] text-sm font-mono"
      placeholder={'Assess :: Inventory what you run today\nMigrate :: Move workloads in waves'}
    />
  );
}

function CalloutInputs(props) {
  return (
    <div className="space-y-2">
      <FieldInput
        field="eyebrow"
        {...props}
        placeholder="Eyebrow label (optional, e.g. Heads up)"
      />
      <FieldInput field="title" {...props} placeholder="Title" />
      <FieldTextarea
        field="content"
        {...props}
        className="min-h-[80px] text-sm"
        placeholder="One or two sentences of detail..."
      />
    </div>
  );
}

// design is reachable when editing a forged draft.
function DesignInputs(props) {
  return (
    <HintedContent
      {...props}
      hint="Mermaid diagram source."
      className="min-h-[100px] text-sm font-mono"
      placeholder={'graph TD;\n  A[Start] --> B[Finish]'}
    />
  );
}

const INPUTS_BY_TYPE = {
  fact: PlainContentInputs,
  recommendation: PlainContentInputs,
  text: PlainContentInputs,
  code: CodeInputs,
  links: LinksInputs,
  picture: PictureInputs,
  video: VideoInputs,
  spacer: SpacerInputs,
  pull_quote: PullQuoteInputs,
  stat_board: StatBoardInputs,
  comparison: ComparisonInputs,
  timeline: TimelineInputs,
  callout: CalloutInputs,
  design: DesignInputs,
};

/** The inputs for the form's module type; nothing for an unknown type. */
export function ModuleTypeInputs({ form, setModuleFormField, imageCandidates }) {
  if (!Object.hasOwn(INPUTS_BY_TYPE, form.type)) return null;
  const Inputs = INPUTS_BY_TYPE[form.type];
  return (
    <Inputs form={form} setModuleFormField={setModuleFormField} imageCandidates={imageCandidates} />
  );
}
