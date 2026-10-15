/**
 * Image Prompts — a creative system for coordinated image sets (ADR 0033).
 *
 * The image set is the first-class object: the grid shows every set with
 * its purpose, style, prompts, images and pages; opening one shows its
 * brief, its prompt variations, the pages that generate with it, and every
 * image it has produced — with a Generate action to try it. Assigning a set
 * to a page is an explicit button press; nothing saves on a dropdown change.
 * The keyword matrix below is applied by every generator (see its panel).
 *
 * `?set=NAME` opens a set, which is how the gallery and the review board
 * link here.
 */
import React, { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Image as ImageIcon, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import PageHeader from '@/components/admin/shared/PageHeader';
import EmptyState from '@/components/admin/shared/EmptyState';
import PromptSetCard from '@/components/admin/images/PromptSetCard';
import PromptSetEditor from '@/components/admin/images/PromptSetEditor';
import KeywordMatrixPanel from '@/components/admin/KeywordMatrixPanel';
import { useImagePrompts } from '@/hooks/useImagePrompts';
import { useToast } from '@/components/ui/use-toast';
import {
  buildSetHandlers,
  filterSets,
  indexPageAssignments,
  usePromptLibrary,
} from './imagePrompts/libraryState';

const HELP = [
  'An image set is a creative brief: a shared primary prompt, style rules, what to avoid, an aspect ratio and tags. Everything generated from it looks like it belongs together.',
  'Prompts are named variations inside a set — extra parameters plus a template per image slot. The hero template is what the AI cover uses from the review queue and the change feed; the secondary templates feed the Submit URLs previews.',
  'Assign a set to a site page (every provider section, including VMware and Ansible) and the covers for content on that page generate from it. Choose the prompt, then press Assign — the dropdown alone saves nothing.',
  'Every image generated from a set appears under it with its status and where it is used, and every image in the gallery links back to its set. Generate tries the set on a subject right here.',
  'Changing a primary prompt bumps the version and keeps the old text; images record the version they came from. Archive hides a set from generators without losing it; rename moves prompts, pages and images with it.',
];

/** The five states of the page body, first match wins (PR #841: one return). */
function LibraryError({ hookError, loadError, onRetry }) {
  return (
    <EmptyState
      variant="error"
      title="The prompt library could not be read"
      description={hookError || loadError}
      onRetry={onRetry}
    />
  );
}

function LibraryLoading() {
  return (
    <p className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
      Loading image sets…
    </p>
  );
}

function LibraryEditor({ editor }) {
  return editor;
}

function LibraryEmpty({ onCreate }) {
  return (
    <EmptyState
      icon={ImageIcon}
      title="No image sets yet"
      description="A set is the shared brief every image generated from it follows. Create one, give it a primary prompt and style rules, then assign it to the pages it should illustrate."
      action={
        <Button size="sm" onClick={onCreate} className="gap-1">
          <Plus className="h-4 w-4" aria-hidden="true" /> Create the first set
        </Button>
      }
    />
  );
}

function LibraryNoMatch({ archivedHidden, onShowEverything }) {
  return (
    <EmptyState
      variant="filtered"
      title="No sets match"
      description={
        archivedHidden
          ? `${archivedHidden} archived set${archivedHidden === 1 ? ' is' : 's are'} hidden.`
          : 'Try another word.'
      }
      action={
        <Button variant="outline" size="sm" onClick={onShowEverything}>
          Show everything
        </Button>
      }
    />
  );
}

function LibraryGrid({ visibleSets, openName, onOpen }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {visibleSets.map((set) => (
        <PromptSetCard
          key={set.id}
          set={set}
          selected={set.name === openName}
          onOpen={(s) => onOpen(s.name)}
        />
      ))}
    </div>
  );
}

const LIBRARY_VIEWS = [
  [(p) => Boolean(p.loadError), LibraryError],
  [(p) => !p.library, LibraryLoading],
  [(p) => Boolean(p.editor), LibraryEditor],
  [(p) => p.sets.length === 0, LibraryEmpty],
  [(p) => p.visibleSets.length === 0, LibraryNoMatch],
  [() => true, LibraryGrid],
];

/** The page body: error, loading, the open set, the empty library, or the grid. */
function LibraryBody(props) {
  const [, View] = LIBRARY_VIEWS.find(([when]) => when(props));
  return <View {...props} />;
}

/** The header's count line: active sets, archived sets, assigned pages. */
function LibraryStatus({ sets, archivedCount, assignedCount }) {
  const active = sets.length - archivedCount;
  return (
    <span className="text-muted-foreground">
      {active} active set{active === 1 ? '' : 's'}
      {archivedCount ? ` · ${archivedCount} archived` : ''} · {assignedCount} page
      {assignedCount === 1 ? '' : 's'} assigned
    </span>
  );
}

/** The search box and the archived toggle above the grid. */
function LibraryFilters({ query, onQuery, showArchived, onShowArchived, archivedCount }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-[16rem] flex-1">
        <Search
          className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search sets by name, purpose, theme, prompt or tag"
          aria-label="Search image sets"
          className="pl-8"
        />
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => onShowArchived(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        Show archived ({archivedCount})
      </label>
    </div>
  );
}

export default function ImagePromptsPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const api = useImagePrompts();
  const { fetchPromptLibrary, loading, error: hookError } = api;

  const { library, loadError, refresh } = usePromptLibrary(fetchPromptLibrary);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [openName, setOpenName] = useState(
    () => new URLSearchParams(location.search).get('set') || ''
  );
  const [creating, setCreating] = useState(false);

  const sets = useMemo(() => library?.sets || [], [library]);
  const openSet = useMemo(
    () => sets.find((set) => set.name === openName) || null,
    [sets, openName]
  );
  const pageAssignments = useMemo(() => indexPageAssignments(sets), [sets]);
  const visibleSets = useMemo(
    () => filterSets(sets, query, showArchived),
    [sets, query, showArchived]
  );
  const archivedCount = sets.filter((set) => set.archivedAt).length;

  const open = (name) => {
    setCreating(false);
    setOpenName(name);
    const search = name ? `?set=${encodeURIComponent(name)}` : '';
    navigate(`${location.pathname}${search}`, { replace: true });
  };

  const handlers = buildSetHandlers({ api, open, openName, navigate, toast, hookError, refresh });

  const editing = creating || Boolean(openSet);
  const body = (
    <LibraryBody
      loadError={loadError}
      hookError={hookError}
      library={library}
      editor={
        editing ? (
          <PromptSetEditor
            set={openSet}
            isNew={creating}
            allowedPages={library?.allowedPages || []}
            pageAssignments={pageAssignments}
            busy={loading}
            onBack={() => open('')}
            {...handlers}
          />
        ) : null
      }
      sets={sets}
      visibleSets={visibleSets}
      openName={openName}
      archivedHidden={showArchived ? 0 : archivedCount}
      onRetry={refresh}
      onCreate={() => setCreating(true)}
      onOpen={(name) => open(name)}
      onShowEverything={() => {
        setQuery('');
        setShowArchived(true);
      }}
    />
  );

  return (
    <div className="space-y-5">
      <PageHeader
        icon={ImageIcon}
        help={HELP}
        status={
          library ? (
            <LibraryStatus
              sets={sets}
              archivedCount={archivedCount}
              assignedCount={Object.keys(pageAssignments).length}
            />
          ) : null
        }
        actions={
          !editing ? (
            <Button type="button" size="sm" className="gap-1" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" /> New set
            </Button>
          ) : null
        }
      />

      {!editing && library && sets.length > 0 && (
        <LibraryFilters
          query={query}
          onQuery={setQuery}
          showArchived={showArchived}
          onShowArchived={setShowArchived}
          archivedCount={archivedCount}
        />
      )}

      {body}

      <KeywordMatrixPanel />
    </div>
  );
}
