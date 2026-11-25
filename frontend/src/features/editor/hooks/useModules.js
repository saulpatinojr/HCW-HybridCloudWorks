import { useState, useMemo, useCallback } from 'react';
import {
  parseModulesFromMarkdown,
  rebuildMarkdownWithModules,
  MAX_MODULES,
} from '@/lib/moduleParser';
import {
  INITIAL_FORM,
  buildPayloadFromForm,
  defaultFormForType,
  editingIndexAfterMove,
  isIndexIn,
  movedModules,
  withModuleAlign,
  withModuleAt,
  moduleForTypeSwitch,
  moduleToFormState,
  newModulePayload,
} from './moduleFormModel';

// The pure helpers (defaults, form <-> payload) live in moduleFormModel.js.

/**
 * Manages module state.
 * The auto-sync useEffect from the old editor is intentionally removed.
 * Changes to the module form do NOT cascade to the draft until the user
 * explicitly calls applyModuleEdits() or addModuleToDraft().
 *
 * @param {string}   draft     - Current markdown draft (owned by useEditorState)
 * @param {Function} setDraft  - Stable setter from useEditorState
 */
export function useModules(draft, setDraft) {
  const [editingModuleIndex, setEditingModuleIndex] = useState(-1);
  const [moduleForm, setModuleForm] = useState(INITIAL_FORM);

  // Single parse per draft change — no double-parse
  const parsedDraft = useMemo(() => parseModulesFromMarkdown(draft), [draft]);
  const moduleItems = parsedDraft.modules;
  const parsedPreviewText = parsedDraft.text;

  // ── Form helpers ───────────────────────────────────────────────────────────

  const setModuleFormField = useCallback((field, value) => {
    setModuleForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const resetModuleForm = useCallback((nextType = 'fact') => {
    setEditingModuleIndex(-1);
    setModuleForm(defaultFormForType(nextType));
  }, []);

  // ── Module mutations ───────────────────────────────────────────────────────

  /**
   * Commit the current form state to the draft for the module being edited.
   * Called via an explicit "Apply Changes" button — replaces the auto-sync effect.
   */
  const applyModuleEdits = useCallback(() => {
    if (isIndexIn(moduleItems, editingModuleIndex)) {
      const next = withModuleAt(moduleItems, editingModuleIndex, buildPayloadFromForm(moduleForm));
      setDraft(rebuildMarkdownWithModules(parsedPreviewText, next));
    }
  }, [editingModuleIndex, moduleForm, moduleItems, parsedPreviewText, setDraft]);

  /**
   * Add a new module from the current form state. Adds to the end of the draft.
   * Auto-selects the new module for editing.
   */
  const addModuleToDraft = useCallback(() => {
    if (moduleItems.length >= MAX_MODULES) return;

    const payload = newModulePayload(moduleForm);

    const next = [...moduleItems, payload];
    setDraft(rebuildMarkdownWithModules(parsedPreviewText, next));

    const newIndex = next.length - 1;
    setEditingModuleIndex(newIndex);

    // Load the committed payload back into the form (normalises content representation)
    setModuleForm(moduleToFormState(payload));
  }, [moduleForm, moduleItems, parsedPreviewText, setDraft]);

  /**
   * Load an existing module into the form for editing.
   * Does NOT touch the draft — changes are only committed via applyModuleEdits().
   */
  const editModule = useCallback(
    (index) => {
      const item = moduleItems[index];
      if (item) {
        setEditingModuleIndex(index);
        setModuleForm(moduleToFormState(item));
      }
    },
    [moduleItems]
  );

  const deleteModule = useCallback(
    (index) => {
      const next = moduleItems.filter((_, i) => i !== index);
      setDraft(rebuildMarkdownWithModules(parsedPreviewText, next));
      if (editingModuleIndex === index) {
        resetModuleForm(moduleForm.type);
      }
    },
    [editingModuleIndex, moduleForm.type, moduleItems, parsedPreviewText, resetModuleForm, setDraft]
  );

  const setModuleAlignAtIndex = useCallback(
    (index, align) => {
      const next = withModuleAlign(moduleItems, index, align);
      if (!next) return;
      setDraft(rebuildMarkdownWithModules(parsedPreviewText, next));
      // If this module is currently being edited, sync the form align field
      if (index === editingModuleIndex) {
        setModuleFormField('align', align);
      }
    },
    [editingModuleIndex, moduleItems, parsedPreviewText, setDraft, setModuleFormField]
  );

  const reorderModules = useCallback(
    (fromIndex, toIndex) => {
      const next = movedModules(moduleItems, fromIndex, toIndex);
      if (next) {
        setDraft(rebuildMarkdownWithModules(parsedPreviewText, next));

        // Track editing index through the reorder
        setEditingModuleIndex((prev) => editingIndexAfterMove(prev, fromIndex, toIndex));
      }
    },
    [moduleItems, parsedPreviewText, setDraft]
  );

  const moveModuleItem = useCallback(
    (index, direction) => {
      const target = index + direction;
      if (isIndexIn(moduleItems, target)) reorderModules(index, target);
    },
    [moduleItems, reorderModules]
  );

  /**
   * Switch module type.
   * When editing: immediately commits the type change to the draft (preserves content
   * where type families are compatible), then syncs form state.
   * When adding: only updates form state.
   */
  const applyModuleTypeSelection = useCallback(
    (nextType, imageCandidates = []) => {
      if (editingModuleIndex >= 0) {
        const current = moduleItems[editingModuleIndex] || {};
        const nextModule = moduleForTypeSwitch(nextType, current, imageCandidates);

        const next = withModuleAt(moduleItems, editingModuleIndex, nextModule);
        setDraft(rebuildMarkdownWithModules(parsedPreviewText, next));

        setModuleForm(moduleToFormState(nextModule));
      } else {
        // Not editing — just update form
        setModuleForm(defaultFormForType(nextType));
      }
    },
    [editingModuleIndex, moduleItems, parsedPreviewText, setDraft]
  );

  return {
    moduleItems,
    parsedPreviewText,
    editingModuleIndex,
    moduleForm,
    setModuleFormField,
    resetModuleForm,
    applyModuleEdits,
    addModuleToDraft,
    editModule,
    deleteModule,
    setModuleAlignAtIndex,
    reorderModules,
    moveModuleItem,
    applyModuleTypeSelection,
  };
}
