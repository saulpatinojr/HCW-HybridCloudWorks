/**
 * The actions `POST /api/manageImagePromptConfig` performs, one function
 * each over `ctx` (`{ store }`) and the normalised request
 * (`{ body, action, setName, promptName, newSetName, nowIso, updatedBy }`).
 * Each answers the JSON response to send (PR #841 split of image-prompts.js).
 */
import { authoredMessage, isAuthoredError } from '../../http/error-response.js';
import { normalizeSlotTemplates } from '../content-quality.js';
import { assertStringLength } from '../content-update-validation.js';
import {
  json,
  mergeSet,
  deleteIgnoringMissing,
  pathToPromptPageDocId,
  stripSystem,
} from './shared.js';
import { assertAllowedPromptPage } from './pages.js';
import { buildSetSaveFields } from './sets.js';
import {
  clearAssignmentsForSet,
  copyPrompts,
  deleteLegacyPromptIfNeeded,
  deleteSetAndPrompts,
  deleteSetArtifacts,
  repointSet,
} from './store.js';

const SET_REQUIRED = json(400, { error: 'setName is required' });
const SET_AND_PROMPT_REQUIRED = json(400, { error: 'setName and promptName are required' });

const readSet = (store, name) => store.readDoc('image_prompt_sets', name, name);

/**
 * The save fields, or the 400 for a body that fails validation. Only a
 * validator's own sentence is the 400; a failed read is thrown on to the
 * route's 500 (#945).
 *
 * @param {{ readDoc: Function }} store - the document store
 * @param {{ body: object, setName: string, nowIso: string, updatedBy: string }} req - the request
 * @returns {Promise<{ fields: object } | { error: object }>}
 */
async function saveSetFields(store, { body, setName, nowIso, updatedBy }) {
  try {
    assertStringLength(body.primaryPrompt, 'primaryPrompt', 12000, { allowEmpty: false });
    const existing = await readSet(store, setName);
    return { fields: buildSetSaveFields(existing, body, { nowIso, updatedBy }) };
  } catch (error) {
    if (!isAuthoredError(error)) throw error;
    return { error: json(400, { error: authoredMessage(error, 'The prompt set was refused.') }) };
  }
}

async function saveSet({ store }, req) {
  if (!req.setName) return SET_REQUIRED;
  const { fields, error } = await saveSetFields(store, req);
  if (error) return error;
  const saved = await mergeSet(store, 'image_prompt_sets', req.setName, {
    name: req.setName,
    ...fields,
  });
  return json(200, {
    success: true,
    action: 'saveSet',
    setName: req.setName,
    version: saved?.version ?? fields.version ?? null,
  });
}

async function deleteSet({ store }, { setName, nowIso }) {
  if (!setName) return SET_REQUIRED;
  await deleteSetArtifacts(store, setName, nowIso);
  return json(200, { success: true, action: 'deleteSet', setName });
}

/** `archiveSet` and `restoreSet`: the stamp, and the assignments cleared on archive. */
async function archiveOrRestoreSet({ store }, { action, setName, nowIso, updatedBy }) {
  if (!setName) return SET_REQUIRED;
  const existing = await readSet(store, setName);
  if (!existing) return json(404, { error: `set ${setName} not found` });
  const archiving = action === 'archiveSet';
  await store.patchDoc('image_prompt_sets', setName, {
    archivedAt: archiving ? nowIso : null,
    updatedAt: nowIso,
    updatedBy,
  });
  if (archiving) await clearAssignmentsForSet(store, setName, nowIso);
  return json(200, {
    success: true,
    action,
    setName,
    archivedAt: archiving ? nowIso : null,
  });
}

/** The new set document a duplicate or rename writes from the source. */
function copiedSetDoc(source, { renaming, setName, newSetName, nowIso, updatedBy }) {
  const base = stripSystem(source);
  return {
    ...base,
    id: newSetName,
    name: newSetName,
    ...(renaming
      ? { aliases: [...new Set([...(base.aliases || []), setName])] }
      : { version: 1, history: [], aliases: [], duplicatedFrom: setName }),
    archivedAt: renaming ? base.archivedAt || null : null,
    createdAt: renaming ? base.createdAt || nowIso : nowIso,
    createdBy: renaming ? base.createdBy || updatedBy : updatedBy,
    updatedAt: nowIso,
    updatedBy,
  };
}

/** The set to copy from, or the response refusing the duplicate or rename. */
async function copySource(store, { setName, newSetName }) {
  if (!setName || !newSetName) {
    return { error: json(400, { error: 'setName and newSetName are required' }) };
  }
  if (setName === newSetName) {
    return { error: json(400, { error: 'newSetName must differ from setName' }) };
  }
  const source = await readSet(store, setName);
  if (!source) return { error: json(404, { error: `set ${setName} not found` }) };
  const clash = await readSet(store, newSetName);
  if (clash) return { error: json(409, { error: `set ${newSetName} already exists` }) };
  return { source };
}

/** `duplicateSet` and `renameSet`: copy the set and its prompts; a rename also re-points and removes the old. */
async function duplicateOrRenameSet({ store }, req) {
  const { source, error } = await copySource(store, req);
  if (error) return error;
  const { action, setName, newSetName, nowIso, updatedBy } = req;
  const renaming = action === 'renameSet';
  await store.upsertDoc('image_prompt_sets', copiedSetDoc(source, { renaming, ...req }));
  const prompts = await copyPrompts(store, setName, newSetName, nowIso, updatedBy);
  let repointed = { pages: 0, images: 0 };
  if (renaming) {
    repointed = await repointSet(store, setName, newSetName, nowIso, updatedBy);
    await deleteSetAndPrompts(store, setName);
  }
  return json(200, {
    success: true,
    action,
    setName,
    newSetName,
    prompts,
    ...repointed,
  });
}

/**
 * The prompt's bounded fields, or the 400 for a body that fails validation.
 *
 * @param {object} body - the request body
 * @returns {{ slotTemplates: object } | { error: object }}
 */
function promptFieldsOf(body) {
  try {
    assertStringLength(body.additionalParameters, 'additionalParameters', 12000, {
      allowEmpty: true,
    });
    const slotTemplates = normalizeSlotTemplates(body.slotTemplates);
    Object.values(slotTemplates).forEach((value) => {
      assertStringLength(value, 'slotTemplate', 2000, { allowEmpty: true });
    });
    return { slotTemplates };
  } catch (error) {
    if (!isAuthoredError(error)) throw error;
    return { error: json(400, { error: authoredMessage(error, 'The prompt was refused.') }) };
  }
}

async function savePrompt({ store }, { body, setName, promptName, nowIso, updatedBy }) {
  if (!setName || !promptName) return SET_AND_PROMPT_REQUIRED;
  const { slotTemplates, error } = promptFieldsOf(body);
  if (error) return error;
  await mergeSet(store, 'image_prompt_sets', setName, {
    name: setName,
    updatedAt: nowIso,
    updatedBy,
  });
  // Prompt names are unique only within a set — /setName partition.
  await mergeSet(
    store,
    'image_prompt_sets_prompts',
    promptName,
    {
      setName,
      name: promptName,
      additionalParameters: String(body.additionalParameters || '').trim(),
      slotTemplates,
      updatedAt: nowIso,
      updatedBy,
    },
    setName
  );
  return json(200, {
    success: true,
    action: 'savePrompt',
    setName,
    promptName,
  });
}

async function deletePrompt({ store }, { setName, promptName }) {
  if (!setName || !promptName) return SET_AND_PROMPT_REQUIRED;
  await deleteIgnoringMissing(store, 'image_prompt_sets_prompts', promptName, setName);
  await deleteLegacyPromptIfNeeded(store, setName, promptName);
  return json(200, {
    success: true,
    action: 'deletePrompt',
    setName,
    promptName,
  });
}

/**
 * Assign a prompt set to one allowlisted page.
 *
 * @param {{ store: object }} ctx - the document store
 * @param {object} req - the normalised request
 * @returns {Promise<object>} the JSON response
 */
async function savePageAssignment({ store }, { body, setName, promptName, nowIso, updatedBy }) {
  let pagePath;
  try {
    pagePath = assertAllowedPromptPage(body.pagePath);
  } catch (error) {
    if (!isAuthoredError(error)) throw error;
    return json(400, { error: authoredMessage(error, 'That page cannot take a prompt set.') });
  }
  await mergeSet(store, 'image_prompt_pages', pathToPromptPageDocId(pagePath), {
    pagePath,
    setName: setName || '',
    promptName: promptName || '',
    updatedAt: nowIso,
    updatedBy,
  });
  return json(200, {
    success: true,
    action: 'savePageAssignment',
    pagePath,
    setName: setName || '',
    promptName: promptName || '',
  });
}

/** Action name → the function that performs it. */
export const CONFIG_ACTIONS = Object.freeze({
  saveSet,
  deleteSet,
  archiveSet: archiveOrRestoreSet,
  restoreSet: archiveOrRestoreSet,
  duplicateSet: duplicateOrRenameSet,
  renameSet: duplicateOrRenameSet,
  savePrompt,
  deletePrompt,
  savePageAssignment,
});
