import {
  Lightbulb,
  CheckCircle2,
  Link2,
  Image as ImageIcon,
  Video,
  AlignLeft,
  FileCode2,
  Minus,
  Quote,
  BarChart3,
  Table2,
  ListOrdered,
  Megaphone,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MAX_MODULES } from '@/lib/moduleParser';
import { FULL_WIDTH_MODULE_TYPES } from '@/lib/modulePairing';
import { useEditor } from '../context/EditorContext';
import { ModuleTypeInputs } from './ModuleTypeInputs';

const MODULE_TYPES = [
  { key: 'fact', label: 'Fact', icon: Lightbulb },
  { key: 'recommendation', label: 'Tip', icon: CheckCircle2 },
  { key: 'code', label: 'Code', icon: FileCode2 },
  { key: 'text', label: 'Frame', icon: AlignLeft },
  { key: 'links', label: 'Links', icon: Link2 },
  { key: 'picture', label: 'Image', icon: ImageIcon },
  { key: 'video', label: 'Video', icon: Video },
  { key: 'spacer', label: 'Spacer', icon: Minus },
  { key: 'pull_quote', label: 'Quote', icon: Quote },
  { key: 'stat_board', label: 'Stats', icon: BarChart3 },
  { key: 'comparison', label: 'Table', icon: Table2 },
  { key: 'timeline', label: 'Timeline', icon: ListOrdered },
  { key: 'callout', label: 'Callout', icon: Megaphone },
];

const ALIGN_OPTIONS = ['left', 'right', 'all'];

function getPrimaryLabel({ isEditing, atMax }) {
  if (isEditing) return 'Apply Changes';
  if (atMax) return `Max ${MAX_MODULES} modules`;
  return 'Add to Article';
}

export function ModuleForm() {
  const {
    moduleItems,
    editingModuleIndex,
    moduleForm,
    setModuleFormField,
    applyModuleTypeSelection,
    applyModuleEdits,
    addModuleToDraft,
    resetModuleForm,
    imageCandidates,
  } = useEditor();

  const { type, align } = moduleForm;
  const isEditing = editingModuleIndex >= 0;
  const atMax = moduleItems.length >= MAX_MODULES;

  function handleTypeSelect(nextType) {
    applyModuleTypeSelection(nextType, imageCandidates);
  }

  function handlePrimaryAction() {
    if (isEditing) {
      applyModuleEdits();
    } else {
      addModuleToDraft();
    }
  }

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {isEditing ? `Editing module ${editingModuleIndex + 1}` : 'New module'}
        </p>
        <Badge variant="outline" className="text-xs">
          {moduleItems.length}/{MAX_MODULES}
        </Badge>
      </div>

      {/* Type selector — 4 across */}
      <div className="grid grid-cols-4 gap-1">
        {MODULE_TYPES.map(({ key, label, icon: Icon }) => (
          <Button
            key={key}
            type="button"
            variant={type === key ? 'default' : 'outline'}
            size="sm"
            className="h-8 flex-col gap-0.5 text-xs px-1"
            onClick={() => handleTypeSelect(key)}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Button>
        ))}
      </div>

      {/* Align row (full-width types pin their own align) */}
      {!FULL_WIDTH_MODULE_TYPES.includes(type) && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground w-10 shrink-0">Align</span>
          {ALIGN_OPTIONS.map((a) => (
            <Button
              key={a}
              type="button"
              variant={align === a ? 'default' : 'outline'}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => setModuleFormField('align', a)}
            >
              {a.charAt(0).toUpperCase() + a.slice(1)}
            </Button>
          ))}
        </div>
      )}

      {/* Type-specific inputs */}
      <ModuleTypeInputs
        form={moduleForm}
        setModuleFormField={setModuleFormField}
        imageCandidates={imageCandidates}
      />

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          className="flex-1"
          onClick={handlePrimaryAction}
          disabled={!isEditing && atMax}
        >
          {getPrimaryLabel({ isEditing, atMax })}
        </Button>
        {isEditing && (
          <Button type="button" variant="outline" size="sm" onClick={() => resetModuleForm(type)}>
            Done
          </Button>
        )}
        {!isEditing && (
          <Button type="button" variant="ghost" size="sm" onClick={() => resetModuleForm()}>
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}
