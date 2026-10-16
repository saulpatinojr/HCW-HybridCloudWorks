/**
 * Attach a `.drawio` source to an architecture and pin hotspots to its shapes.
 *
 * What this replaces: typing x/y percentages into two number inputs, eyeballing
 * the result, and redoing all of them the next time the diagram is edited.
 * A hotspot created here stores a draw.io **shape id**; its position is derived
 * from the XML on every render (useResolvedHotspots), so re-uploading an edited
 * diagram moves every pin with its shape.
 *
 * Nothing renders the .drawio file. Vendor stencils are most of what makes a
 * cloud diagram readable, and reimplementing them means shipping icon
 * libraries and still looking subtly wrong — the exported PNG/SVG stays the
 * image visitors see. This panel reads the file only for identity and geometry.
 *
 * Parsing is entirely client-side, so an unparseable file costs a message and
 * nothing else: no upload, no request, no stored state.
 */
import React, { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { AlertTriangle, FileCode2, Loader2, Plus, Upload } from 'lucide-react';
import { parseDrawioFile } from '@/lib/drawio/parseDrawio';

/** Shapes with no label are containers and backdrops, not things to pin. */
const isPinnable = (shape) => Boolean(shape.label);

export default function DiagramSourcePanel({
  diagramXml,
  hotspots = [],
  onDiagramXmlChange,
  onAddHotspot,
}) {
  const fileInput = useRef(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [filter, setFilter] = useState('');

  const pinnedShapeIds = new Set(hotspots.map((h) => h.shapeId).filter(Boolean));

  const ingest = async (text) => {
    setParsing(true);
    setError(null);
    try {
      const result = await parseDrawioFile(text);
      setParsed(result);
      onDiagramXmlChange(text);
    } catch (err) {
      // The file is not stored on a parse failure: a diagramXml that cannot be
      // parsed resolves no hotspots, so saving it would silently blank every
      // shape-anchored pin on the page.
      setError(err.message);
      setParsed(null);
    } finally {
      setParsing(false);
    }
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await ingest(await file.text());
    // Clearing lets the same file be re-selected after an edit, which is the
    // normal way this panel is used.
    event.target.value = '';
  };

  const reparse = async () => {
    if (diagramXml) await ingest(diagramXml);
  };

  const shapes = (parsed?.shapes || []).filter(isPinnable);
  const visible = filter
    ? shapes.filter((s) => s.label.toLowerCase().includes(filter.toLowerCase()))
    : shapes;

  return (
    <Card className="bg-card/50 border-l-4 border-l-emerald-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <FileCode2 className="h-4 w-4" /> Diagram source (.drawio)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".drawio,.xml"
            onChange={handleFile}
            className="hidden"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={parsing}
            onClick={() => fileInput.current?.click()}
          >
            {parsing ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5 mr-1.5" />
            )}
            {diagramXml ? 'Replace file' : 'Upload .drawio'}
          </Button>
          {diagramXml && !parsed && (
            <Button size="sm" variant="ghost" disabled={parsing} onClick={reparse}>
              Load shapes
            </Button>
          )}
        </div>

        {error && (
          <p className="text-xs text-destructive flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            {error}
          </p>
        )}

        {!diagramXml && !error && (
          <p className="text-xs text-muted-foreground">
            Upload the diagram&apos;s source file to pin hotspots to shapes instead of typing
            coordinates. Existing hotspots keep working either way.
          </p>
        )}

        {parsed && (
          <>
            <p className="text-xs text-muted-foreground">
              {parsed.page.name || 'Page 1'}
              {parsed.pageCount > 1 ? ` (1 of ${parsed.pageCount})` : ''} · {shapes.length} labelled
              shapes
            </p>

            {shapes.length > 8 && (
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter shapes…"
                className="h-7 text-xs"
              />
            )}

            <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
              {visible.map((shape) => {
                const pinned = pinnedShapeIds.has(shape.id);
                return (
                  <div
                    key={shape.id}
                    className="flex items-center gap-2 rounded border border-border px-2 py-1.5"
                  >
                    <span className="text-xs flex-1 truncate" title={shape.label}>
                      {shape.label}
                    </span>
                    <Button
                      size="xs"
                      variant={pinned ? 'ghost' : 'outline'}
                      className="h-6 shrink-0"
                      disabled={pinned}
                      onClick={() => onAddHotspot({ shapeId: shape.id, label: shape.label })}
                    >
                      {pinned ? (
                        'Pinned'
                      ) : (
                        <>
                          <Plus className="h-3 w-3 mr-1" /> Pin
                        </>
                      )}
                    </Button>
                  </div>
                );
              })}
              {visible.length === 0 && (
                <p className="text-xs text-muted-foreground italic">No shapes match.</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
