/**
 * The Prompts tab (ADR 0033): the set's named variations on the left, and
 * the form for the chosen one — or a new one — on the right, with a
 * template per slot. The form is fully reset by the editor's reducer when
 * the choice changes, so one prompt's slot text never leaks into another.
 */
import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SLOT_TEMPLATE_FIELDS, hasSlotTemplates } from './promptSetEditorModel';

function PromptList({ prompts, promptName, onChoose, onNew }) {
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" className="w-full" onClick={onNew}>
        New prompt
      </Button>
      {prompts.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No prompts yet. A prompt is a named variation of the set; the hero slot template is what
          the AI cover uses.
        </p>
      )}
      <ul className="space-y-1" aria-label="Prompts in this set">
        {prompts.map((prompt) => (
          <li key={prompt.id}>
            <button
              type="button"
              onClick={() => onChoose(prompt.name)}
              aria-pressed={promptName === prompt.name}
              className={`w-full rounded-md border px-2 py-1.5 text-left text-sm ${promptName === prompt.name ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40'}`}
            >
              {prompt.name}
              {hasSlotTemplates(prompt) && (
                <span className="ml-1 text-xs text-muted-foreground">· slot templates</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SlotTemplateFields({ slotTemplates, onChange }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {SLOT_TEMPLATE_FIELDS.map((field) => (
        <div key={field.key}>
          <label htmlFor={`slot-${field.key}`} className="text-xs font-medium">
            {field.label} template
          </label>
          <Textarea
            id={`slot-${field.key}`}
            value={slotTemplates[field.key]}
            onChange={(e) => onChange(field.key, e.target.value)}
            rows={3}
            placeholder={field.placeholder}
          />
        </div>
      ))}
    </div>
  );
}

function PromptForm({ promptFields, selectedPrompt, busy, actions }) {
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="prompt-name" className="text-xs font-medium">
          Prompt name <span className="text-destructive">*</span>
        </label>
        <Input
          id="prompt-name"
          value={promptFields.name}
          onChange={(e) => actions.setPromptField('name', e.target.value)}
          placeholder="e.g. Hero, Deep Dive, Lego Team"
          maxLength={120}
          disabled={Boolean(selectedPrompt)}
        />
        {selectedPrompt && (
          <p className="mt-1 text-xs text-muted-foreground">
            Names are the prompt&apos;s id; to rename, create a new prompt and delete this one.
          </p>
        )}
      </div>
      <div>
        <label htmlFor="prompt-params" className="text-xs font-medium">
          Additional parameters
        </label>
        <Textarea
          id="prompt-params"
          value={promptFields.additionalParameters}
          onChange={(e) => actions.setPromptField('additionalParameters', e.target.value)}
          rows={3}
          placeholder="What makes this variation different: composition, props, lighting, camera angle, palette."
        />
      </div>
      <SlotTemplateFields
        slotTemplates={promptFields.slotTemplates}
        onChange={actions.setSlotTemplate}
      />
      <p className="text-xs text-muted-foreground">
        The hero template is used by the AI cover (review queue and change feed) and by set samples;
        the secondary templates by the Submit URLs preview slots.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={actions.savePrompt}
          disabled={busy || !promptFields.name.trim()}
        >
          {selectedPrompt ? 'Save prompt' : 'Add prompt'}
        </Button>
        {selectedPrompt && (
          <Button
            type="button"
            variant="destructive"
            onClick={() => actions.openDialog('deletePrompt')}
            disabled={busy}
          >
            Delete prompt
          </Button>
        )}
      </div>
    </div>
  );
}

export default function PromptsTab({ prompts, selectedPrompt, busy, state, actions }) {
  return (
    <>
      <PromptList
        prompts={prompts}
        promptName={state.promptName}
        onChoose={actions.choosePrompt}
        onNew={actions.startNewPrompt}
      />
      <PromptForm
        promptFields={state.promptFields}
        selectedPrompt={selectedPrompt}
        busy={busy}
        actions={actions}
      />
    </>
  );
}
