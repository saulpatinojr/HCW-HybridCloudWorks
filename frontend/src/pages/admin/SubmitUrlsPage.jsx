import React from 'react';
import { getPublishTargetLabel } from '@/components/admin/submit-urls/pageMeta';
import PageHeader from '@/components/admin/shared/PageHeader';
import { FilePlus2 } from 'lucide-react';
import StageOneCard from '@/components/admin/submit-urls/StageOneCard';
import StageTwoCard from '@/components/admin/submit-urls/StageTwoCard';
import StageThreeCard from '@/components/admin/submit-urls/StageThreeCard';
import StageFourCard from '@/components/admin/submit-urls/StageFourCard';
import FeedbackCard, {
  SelectionSummaryCard,
  WorkflowHeader,
} from '@/components/admin/submit-urls/pageChrome';
import { useSubmitUrlsState } from '@/components/admin/submit-urls/useSubmitUrlsState';

const SUBMIT_HELP = [
  'What this page is: the start of the pipeline. Paste a source URL (or several) and the builder drafts, illustrates and saves a new content item.',
  'Stage 1 sets what the item will be: provider, content type, and its kind and idea origin (the classification downstream tools read).',
  'Stage 2 drafts from the source, Stage 3 picks or generates images, Stage 4 checks readiness and saves. Nothing is published from here.',
  'Where it goes next: the saved item lands in the Review Queue as Inspected, where it is approved or rejected; Create and Open Editor jumps straight to it.',
];

/**
 * The New Content page: the stages from a source to a created item, with the
 * result banner beneath them.
 */
export default function SubmitUrlsPage() {
  const {
    provider,
    setProvider,
    inferredProvider,
    hasProviderMismatch,
    contentType,
    setContentType,
    blogLandingProvider,
    setBlogLandingProvider,
    resolvedBlogLandingProvider,
    title,
    setTitle,
    publishedDate,
    setPublishedDate,
    taxonomy,
    setTaxonomy,
    currentStep,
    readinessComplete,
    readinessScore,
    readinessChecks,
    draftInstructionPrompt,
    setDraftInstructionPrompt,
    supportingDocuments,
    handleSupportingDocumentUpload,
    removeSupportingDocument,
    kbDocumentUrl,
    setKbDocumentUrl,
    kbDocumentUrls,
    addKbDocumentUrl,
    removeKbDocumentUrl,
    sourceUrl,
    setSourceUrl,
    kbArticleUrls,
    addKbArticleUrl,
    removeKbArticleUrl,
    handleSubmitDraft,
    submittingDraft,
    draftReady,
    frameworkSourceUrls,
    setFrameworkSourceUrls,
    frameworkKnowledgePrompt,
    setFrameworkKnowledgePrompt,
    frameworkDiagramPrompt,
    setFrameworkDiagramPrompt,
    frameworkImagePrompt,
    setFrameworkImagePrompt,
    frameworkConceptSeeds,
    setFrameworkConceptSeeds,
    slotFiles,
    setSlotFiles,
    uploadSlotImage,
    uploadingSlot,
    slotUrls,
    selectedUploaded,
    setSelectedUploaded,
    aiTargets,
    setAiTargets,
    promptSets,
    promptNames,
    selectedPromptSet,
    selectedPromptName,
    handleSelectPromptSet,
    handleSelectPromptName,
    promptLibraryLoading,
    promptLibraryStatus,
    promptLibraryError,
    summaryPrompt,
    setSummaryPrompt,
    detailsPrompt,
    setDetailsPrompt,
    handleGenerateImages,
    canGenerateImages,
    generatingImages,
    generationStatus,
    generationError,
    selectedAiTargets,
    generatedSlots,
    selectedGenerated,
    setSelectedGenerated,
    generatedImages,
    removeGeneratedImage,
    generationPromptLogs,
    galleryItems,
    galleryLoading,
    galleryRefreshing,
    loadPreviewGalleryItems,
    deleteGalleryItem,
    draftTitle,
    setDraftTitle,
    draftSummary,
    setDraftSummary,
    sectionBlocks,
    draftContent,
    setDraftContent,
    insertSectionBlock,
    draftTopics,
    resolveSlotImage,
    previewPath,
    savedContentId,
    canPreview,
    previewSaving,
    createAndOpenSaving,
    handleCreateAndOpenEditor,
    handlePreviewSave,
    result,
    error,
  } = useSubmitUrlsState();

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader icon={FilePlus2} help={SUBMIT_HELP}>
        <WorkflowHeader
          currentStep={currentStep}
          readinessComplete={readinessComplete}
          readinessScore={readinessScore}
          readinessTotal={readinessChecks.length}
        />
      </PageHeader>

      <SelectionSummaryCard
        provider={provider}
        inferredProvider={inferredProvider}
        contentType={contentType}
        resolvedBlogLandingProvider={resolvedBlogLandingProvider}
        publishedDate={publishedDate}
      />

      <form onSubmit={handlePreviewSave} className="space-y-6">
        <StageOneCard
          provider={provider}
          setProvider={setProvider}
          inferredProvider={inferredProvider}
          hasProviderMismatch={hasProviderMismatch}
          contentType={contentType}
          setContentType={setContentType}
          blogLandingProvider={blogLandingProvider}
          setBlogLandingProvider={setBlogLandingProvider}
          resolvedBlogLandingProvider={resolvedBlogLandingProvider}
          title={title}
          setTitle={setTitle}
          publishedDate={publishedDate}
          setPublishedDate={setPublishedDate}
          kind={taxonomy.kind}
          ideaOrigin={taxonomy.ideaOrigin}
          setTaxonomy={setTaxonomy}
        />

        <StageTwoCard
          contentType={contentType}
          draftInstructionPrompt={draftInstructionPrompt}
          setDraftInstructionPrompt={setDraftInstructionPrompt}
          supportingDocuments={supportingDocuments}
          handleSupportingDocumentUpload={handleSupportingDocumentUpload}
          removeSupportingDocument={removeSupportingDocument}
          kbDocumentUrl={kbDocumentUrl}
          setKbDocumentUrl={setKbDocumentUrl}
          kbDocumentUrls={kbDocumentUrls}
          addKbDocumentUrl={addKbDocumentUrl}
          removeKbDocumentUrl={removeKbDocumentUrl}
          sourceUrl={sourceUrl}
          setSourceUrl={setSourceUrl}
          kbArticleUrls={kbArticleUrls}
          addKbArticleUrl={addKbArticleUrl}
          removeKbArticleUrl={removeKbArticleUrl}
          handleSubmitDraft={handleSubmitDraft}
          submittingDraft={submittingDraft}
          draftReady={draftReady}
          frameworkSourceUrls={frameworkSourceUrls}
          setFrameworkSourceUrls={setFrameworkSourceUrls}
          frameworkKnowledgePrompt={frameworkKnowledgePrompt}
          setFrameworkKnowledgePrompt={setFrameworkKnowledgePrompt}
          frameworkDiagramPrompt={frameworkDiagramPrompt}
          setFrameworkDiagramPrompt={setFrameworkDiagramPrompt}
          frameworkImagePrompt={frameworkImagePrompt}
          setFrameworkImagePrompt={setFrameworkImagePrompt}
          frameworkConceptSeeds={frameworkConceptSeeds}
          setFrameworkConceptSeeds={setFrameworkConceptSeeds}
        />

        <StageThreeCard
          slotFiles={slotFiles}
          setSlotFiles={setSlotFiles}
          uploadSlotImage={uploadSlotImage}
          uploadingSlot={uploadingSlot}
          slotUrls={slotUrls}
          selectedUploaded={selectedUploaded}
          setSelectedUploaded={setSelectedUploaded}
          aiTargets={aiTargets}
          setAiTargets={setAiTargets}
          promptSets={promptSets}
          promptNames={promptNames}
          selectedPromptSet={selectedPromptSet}
          selectedPromptName={selectedPromptName}
          handleSelectPromptSet={handleSelectPromptSet}
          handleSelectPromptName={handleSelectPromptName}
          promptLibraryLoading={promptLibraryLoading}
          promptLibraryStatus={promptLibraryStatus}
          promptLibraryError={promptLibraryError}
          summaryPrompt={summaryPrompt}
          setSummaryPrompt={setSummaryPrompt}
          detailsPrompt={detailsPrompt}
          setDetailsPrompt={setDetailsPrompt}
          draftReady={draftReady}
          handleGenerateImages={handleGenerateImages}
          canGenerateImages={canGenerateImages}
          generatingImages={generatingImages}
          generationStatus={generationStatus}
          generationError={generationError}
          selectedAiTargets={selectedAiTargets}
          generatedSlots={generatedSlots}
          selectedGenerated={selectedGenerated}
          setSelectedGenerated={setSelectedGenerated}
          generatedImages={generatedImages}
          removeGeneratedImage={removeGeneratedImage}
          generationPromptLogs={generationPromptLogs}
          galleryItems={galleryItems}
          galleryLoading={galleryLoading}
          galleryRefreshing={galleryRefreshing}
          refreshGalleryItems={() => loadPreviewGalleryItems({ silent: true })}
          deleteGalleryItem={deleteGalleryItem}
        />

        <StageFourCard
          draftTitle={draftTitle}
          setDraftTitle={setDraftTitle}
          title={title}
          draftSummary={draftSummary}
          setDraftSummary={setDraftSummary}
          sectionBlocks={sectionBlocks}
          draftContent={draftContent}
          setDraftContent={setDraftContent}
          draftReady={draftReady}
          insertSectionBlock={insertSectionBlock}
          draftTopics={draftTopics}
          resolveSlotImage={resolveSlotImage}
          previewPath={previewPath}
          readinessChecks={readinessChecks}
          savedContentId={savedContentId}
          canPreview={canPreview}
          readinessComplete={readinessComplete}
          previewSaving={previewSaving}
          createAndOpenSaving={createAndOpenSaving}
          handleCreateAndOpenEditor={handleCreateAndOpenEditor}
          saveLabel={`${getPublishTargetLabel(contentType)} Draft`}
        />
      </form>

      {result && (
        <FeedbackCard
          variant="success"
          message={result.message || 'Operation complete.'}
          contentId={result.contentId}
        />
      )}

      {error && <FeedbackCard variant="error" message={error} />}
    </div>
  );
}
