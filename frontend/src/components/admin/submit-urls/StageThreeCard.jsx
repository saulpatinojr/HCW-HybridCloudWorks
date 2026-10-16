/**
 * Stage 3: upload or generate the slot images, and the saved gallery.
 *
 * The machinery behind every handler here is in imageStage.js (#635); this is
 * only the markup.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Upload, Loader2, Sparkles, X } from 'lucide-react';
import { resolveMediaUrl } from '@/lib/functionsBase';
import { IMAGE_SLOTS, SLOT_IMAGE_ACCEPT } from './imageStage';

function renderGalleryContent({ galleryLoading, galleryItems, deleteGalleryItem }) {
  if (galleryLoading) {
    return <p className="text-xs text-muted-foreground">Loading saved gallery items...</p>;
  }

  if (galleryItems.length > 0) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {galleryItems.map((item) => (
          <div key={item.id} className="rounded-md border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Badge variant="secondary" className="text-xs">
                {item.slot || 'preview'}
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => deleteGalleryItem(item)}
                aria-label={`Delete saved ${item.slot || 'preview'} image`}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <a href={item.imageUrl} target="_blank" rel="noreferrer">
              <img
                src={resolveMediaUrl(item.imageUrl)}
                alt={item.slot || 'Saved gallery image'}
                className="h-32 w-full rounded object-cover"
              />
            </a>
            <p className="text-xs text-muted-foreground truncate">{item.imageUrl}</p>
          </div>
        ))}
      </div>
    );
  }

  return (
    <p className="text-xs text-muted-foreground">
      Generate images to save them here for inline review and deletion.
    </p>
  );
}

/** One upload row per slot: pick a file, send it, then tick it to include. */
function SlotUploads({
  slotFiles,
  setSlotFiles,
  uploadSlotImage,
  uploadingSlot,
  slotUrls,
  selectedUploaded,
  setSelectedUploaded,
}) {
  return (
    <>
      {IMAGE_SLOTS.map(({ key, label }) => (
        <div key={key} className="space-y-2">
          <Label className="text-xs">{label}</Label>
          <div className="flex gap-2">
            <Input
              type="file"
              accept={SLOT_IMAGE_ACCEPT}
              onChange={(e) => {
                const nextFile = e.target.files?.[0] || null;
                setSlotFiles((prev) => ({ ...prev, [key]: nextFile }));
                if (nextFile) {
                  uploadSlotImage(key, nextFile);
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => uploadSlotImage(key)}
              disabled={!slotFiles[key] || uploadingSlot === key}
            >
              {uploadingSlot === key ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
            </Button>
          </div>
          {slotUrls[key] && (
            <div className="rounded-md border border-border px-2 py-1">
              <label className="text-xs flex items-center gap-2 min-w-0">
                <input
                  type="checkbox"
                  checked={selectedUploaded[key]}
                  onChange={(e) =>
                    setSelectedUploaded((prev) => ({ ...prev, [key]: e.target.checked }))
                  }
                />
                <a
                  href={slotUrls[key]}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline truncate"
                >
                  {label} uploaded (select to include)
                </a>
              </label>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** The generated images, each selectable and removable. */
function GeneratedSlots({
  generatedSlots,
  generatedImages,
  selectedGenerated,
  setSelectedGenerated,
  removeGeneratedImage,
  generationPromptLogs,
}) {
  return (
    <>
      {generatedSlots.map(({ key, label }) => (
        <div
          key={key}
          className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
        >
          <label className="flex items-center gap-2 min-w-0 flex-1">
            <input
              type="checkbox"
              checked={selectedGenerated[key]}
              onChange={(e) =>
                setSelectedGenerated((prev) => ({ ...prev, [key]: e.target.checked }))
              }
            />
            <a
              href={generatedImages[key]}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-600 hover:underline truncate"
            >
              {label}: {generatedImages[key]}
            </a>
          </label>
          {generationPromptLogs[key]?.slotLabel && (
            <Badge variant="outline" className="text-xs">
              {generationPromptLogs[key].slotLabel}
            </Badge>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => removeGeneratedImage(key)}
            aria-label={`Delete ${label}`}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </>
  );
}

/** What each slot was actually asked for, once anything has been generated. */
function PromptLogs({ generationPromptLogs }) {
  return (
    <>
      {Object.keys(generationPromptLogs).length > 0 && (
        <div className="border-t border-border pt-4 space-y-3">
          <h4 className="text-sm font-semibold">Generation Prompt Payloads</h4>
          <p className="text-xs text-muted-foreground">
            Exact slot prompts used for the latest generated images in this session.
          </p>
          <div className="space-y-3">
            {Object.entries(generationPromptLogs).map(([slot, info]) => (
              <div key={slot} className="space-y-1">
                <Label className="text-xs">
                  {info.slotLabel || slot} · template {info.templateVersion || 'v1'}
                </Label>
                <Textarea value={info.prompt || ''} readOnly rows={5} className="text-xs" />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Which slots the generator is asked for. */
function AiImageTargets({ aiTargets, setAiTargets }) {
  return (
    <div>
      <Label className="text-xs">Image Targets</Label>
      <div className="grid grid-cols-2 gap-2 mt-2">
        {IMAGE_SLOTS.map(({ key, label }) => (
          <label key={key} className="text-xs flex items-center gap-2">
            <input
              type="checkbox"
              checked={aiTargets[key]}
              onChange={(e) => setAiTargets((prev) => ({ ...prev, [key]: e.target.checked }))}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * The saved Prompt Set and Prompt Name assigned to this page.
 *
 * Choosing either saves the assignment immediately — promptStage.js does the
 * writing; this only shows what is chosen and what the last attempt said.
 */
function PromptLibraryPicker({
  promptSets,
  promptNames,
  selectedPromptSet,
  selectedPromptName,
  handleSelectPromptSet,
  handleSelectPromptName,
  promptLibraryLoading,
  promptLibraryStatus,
  promptLibraryError,
}) {
  return (
    <div>
      <Label className="text-xs">Prompt Library</Label>
      <div className="grid grid-cols-1 gap-2 mt-1">
        <select
          value={selectedPromptSet}
          onChange={(e) => handleSelectPromptSet(e.target.value)}
          disabled={promptLibraryLoading}
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">Select Prompt Set...</option>
          {promptSets.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select
          value={selectedPromptName}
          onChange={(e) => handleSelectPromptName(e.target.value)}
          disabled={promptLibraryLoading || !selectedPromptSet}
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">Select Prompt Name...</option>
          {promptNames.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {promptLibraryLoading
          ? 'Loading prompt library...'
          : promptLibraryStatus || 'Select a saved Prompt Set and Prompt Name for this page.'}
      </p>
      {promptLibraryError && <p className="mt-1 text-xs text-destructive">{promptLibraryError}</p>}
    </div>
  );
}

/**
 * The Generate button and whatever the last run said.
 *
 * Disabled unless there is something to generate AND at least one target: a
 * run with no targets would spin and store nothing.
 */
function GenerateControls({
  handleGenerateImages,
  canGenerateImages,
  generatingImages,
  selectedAiTargets,
  generationStatus,
  generationError,
}) {
  return (
    <>
      <Button
        type="button"
        onClick={handleGenerateImages}
        disabled={!canGenerateImages || generatingImages || selectedAiTargets.length === 0}
        className="gap-1"
      >
        {generatingImages ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
        Generate
      </Button>
      {(generationStatus || generationError) && (
        <div className="rounded-md border border-border px-3 py-2 text-xs space-y-1">
          {generationStatus && <p>{generationStatus}</p>}
          {generationError && <p className="text-destructive">{generationError}</p>}
        </div>
      )}
    </>
  );
}

export default function StageThreeCard({
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
  draftReady,
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
  refreshGalleryItems,
  deleteGalleryItem,
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Stage 3: Image Generation</CardTitle>
        <CardDescription>
          Upload images and/or generate AI images. Preview generations are saved to the AI Image
          Gallery automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-3 rounded-lg border border-border p-3 bg-card/40">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Upload className="h-4 w-4" /> Upload Images
            </h3>
            <SlotUploads
              slotFiles={slotFiles}
              setSlotFiles={setSlotFiles}
              uploadSlotImage={uploadSlotImage}
              uploadingSlot={uploadingSlot}
              slotUrls={slotUrls}
              selectedUploaded={selectedUploaded}
              setSelectedUploaded={setSelectedUploaded}
            />
          </div>

          <div className="space-y-3 rounded-lg border border-border p-3 bg-card/40">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4" /> AI Image Creation
            </h3>

            <AiImageTargets aiTargets={aiTargets} setAiTargets={setAiTargets} />

            <PromptLibraryPicker
              promptSets={promptSets}
              promptNames={promptNames}
              selectedPromptSet={selectedPromptSet}
              selectedPromptName={selectedPromptName}
              handleSelectPromptSet={handleSelectPromptSet}
              handleSelectPromptName={handleSelectPromptName}
              promptLibraryLoading={promptLibraryLoading}
              promptLibraryStatus={promptLibraryStatus}
              promptLibraryError={promptLibraryError}
            />

            <div>
              <Label className="text-xs">Summary Prompt</Label>
              <Textarea
                value={summaryPrompt}
                onChange={(e) => setSummaryPrompt(e.target.value)}
                placeholder="Define environment, scenario, and overall theme..."
                rows={3}
                disabled={!draftReady}
              />
            </div>

            <div>
              <Label className="text-xs">Details Prompt</Label>
              <Textarea
                value={detailsPrompt}
                onChange={(e) => setDetailsPrompt(e.target.value)}
                placeholder="Detailed visual specifics for this article..."
                rows={3}
                disabled={!draftReady}
              />
            </div>

            <GenerateControls
              handleGenerateImages={handleGenerateImages}
              canGenerateImages={canGenerateImages}
              generatingImages={generatingImages}
              selectedAiTargets={selectedAiTargets}
              generationStatus={generationStatus}
              generationError={generationError}
            />
          </div>
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <h4 className="text-sm font-semibold">Newly Created Images</h4>

          {generatedSlots.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Generated image links appear here after clicking Generate.
            </p>
          ) : (
            <div className="space-y-2">
              <GeneratedSlots
                generatedSlots={generatedSlots}
                generatedImages={generatedImages}
                selectedGenerated={selectedGenerated}
                setSelectedGenerated={setSelectedGenerated}
                removeGeneratedImage={removeGeneratedImage}
                generationPromptLogs={generationPromptLogs}
              />
            </div>
          )}
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold">Saved to AI Image Gallery</h4>
              <p className="text-xs text-muted-foreground">
                These are the saved preview images for this draft session.
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={refreshGalleryItems}>
                {galleryRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
              </Button>
              <Button type="button" variant="outline" size="sm" asChild>
                <a href="/admin/image-gallery" target="_blank" rel="noreferrer">
                  Open AI Image Gallery
                </a>
              </Button>
            </div>
          </div>

          {renderGalleryContent({ galleryLoading, galleryItems, deleteGalleryItem })}
        </div>

        <PromptLogs generationPromptLogs={generationPromptLogs} />
      </CardContent>
    </Card>
  );
}
