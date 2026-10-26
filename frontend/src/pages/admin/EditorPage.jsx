import { useParams, useNavigate } from 'react-router';
import BrainContextPanel from '@/components/admin/BrainContextPanel';
import { PenTool } from 'lucide-react';
import { EditorProvider, useEditor } from '@/features/editor/context/EditorContext';
import { EditorLayout } from '@/features/editor/components/EditorLayout';
import PipelineStepper from '@/components/admin/PipelineStepper';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';

const EDITOR_HELP = [
  'What this is: the article open for editing — its text (Content), its reusable blocks (Modules), its title, summary, tags, images and dates (Metadata), and a Board view of the whole.',
  'Save Draft keeps your work and writes a version; History on the Metadata tab lists every version and can restore one.',
  'Send to Publish moves an approved article to the Publish page; a live article is republished in place when you Save Live.',
  'If someone else saved while you were editing, the save is blocked until you Reload or Force Save; nothing is overwritten silently.',
];

/** The header reads the loaded article; nothing to say until it is here. */
function EditorHeader() {
  const { blog, loading } = useEditor();
  return (
    <PageHeader
      icon={PenTool}
      title={blog?.Title || blog?.title || (loading ? 'Loading…' : 'Editor')}
      eyebrow="Pipeline · Editor"
      description="Polish this draft: text, metadata, images, and the publish date."
      help={EDITOR_HELP}
      status={
        blog ? (
          <>
            <StatusBadge content={blog} />
            <TaxonomyChips item={blog} />
          </>
        ) : null
      }
    >
      {blog && <PipelineStepper item={blog} />}
    </PageHeader>
  );
}

export default function EditorPage() {
  const { blogId } = useParams();
  const navigate = useNavigate();

  return (
    <EditorProvider blogId={blogId} navigate={navigate}>
      <div className="mb-4">
        <EditorHeader />
      </div>
      <BrainContextPanel contentId={blogId} />
      <EditorLayout navigate={navigate} />
    </EditorProvider>
  );
}
