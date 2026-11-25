/**
 * Read shape identity and geometry out of a `.drawio` file.
 *
 * This deliberately does **not** render anything. Vendor stencils
 * (`shape=mxgraph.aws4.*`, `mxgraph.azure.*`) are most of what makes a cloud
 * diagram readable — a sampled AWS diagram was 42 plain boxes to 10 stencils —
 * and reimplementing them means shipping icon libraries and still looking
 * subtly wrong. The exported SVG/PNG from draw.io is what visitors see; this
 * file exists only so a hotspot can be pinned to a *shape id* rather than to
 * coordinates that rot the moment the diagram is edited.
 *
 * Split in two on purpose: decoding may be async (the platform decompression
 * API is), but the geometry maths — the part that has to be right — stays
 * synchronous and trivially testable.
 */

/**
 * The inner `<mxGraphModel>` XML for each page of an mxfile.
 *
 * draw.io writes `<diagram>` two ways. Desktop usually stores the model as a
 * child element; the web app stores it base64'd, raw-deflated **and
 * URI-encoded**. The `decodeURIComponent` is the step that gets forgotten:
 * without it the inflate succeeds and yields mojibake that still parses as
 * valid-but-wrong XML, so the failure is silent rather than loud.
 *
 * @returns {Promise<Array<{id: string, name: string, xml: string}>>}
 */
export async function decodeMxfile(fileText) {
  const doc = new DOMParser().parseFromString(String(fileText || ''), 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Not valid XML — is this a .drawio file?');
  }

  const diagrams = Array.from(doc.getElementsByTagName('diagram'));
  if (diagrams.length === 0) {
    throw new Error('No <diagram> element found — is this a .drawio file?');
  }

  const pages = [];
  for (const diagram of diagrams) {
    const [inline] = diagram.getElementsByTagName('mxGraphModel');
    const xml = inline
      ? new XMLSerializer().serializeToString(inline)
      : await inflateDiagramPayload((diagram.textContent || '').trim());

    pages.push({
      id: diagram.getAttribute('id') || '',
      name: diagram.getAttribute('name') || '',
      xml,
    });
  }
  return pages;
}

async function inflateDiagramPayload(payload) {
  if (!payload) throw new Error('<diagram> is empty and holds no model');

  const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
  // Response.body, not Blob.stream(): identical in browsers, and it is the
  // form jsdom can execute, which keeps this path testable.
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
  const inflated = await new Response(stream).text();

  // draw.io URI-encodes before deflating. Skipping this yields plausible
  // garbage rather than an error, so it is asserted in the tests.
  return decodeURIComponent(inflated);
}

/**
 * Absolute geometry for every vertex in one page.
 *
 * mxGeometry is expressed **relative to the parent cell**, and in a real
 * diagram most cells are nested — 41 of 63 in the AWS fixture sit inside a
 * group or container. Resolving the parent chain is therefore the main job
 * here, not an edge case: skip it and every hotspot inside a container lands in
 * the wrong place.
 *
 * @returns {{shapes: Array, bounds: {minX,minY,maxX,maxY,width,height}|null}}
 */
export function parseMxGraphModel(modelXml) {
  const doc = new DOMParser().parseFromString(String(modelXml || ''), 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('Model XML did not parse');

  const cells = Array.from(doc.getElementsByTagName('mxCell'));
  const byId = new Map();
  for (const cell of cells) {
    const id = cell.getAttribute('id');
    if (id) byId.set(id, cell);
  }

  const shapes = cells.map((cell) => vertexShape(cell, byId)).filter(Boolean);

  return { shapes, bounds: boundsOf(shapes) };
}

/** One vertex cell as a shape with absolute geometry, or null when it has none to anchor to. */
function vertexShape(cell, byId) {
  if (cell.getAttribute('vertex') !== '1') return null;

  const [geometry] = cell.getElementsByTagName('mxGeometry');
  if (!geometry) return null;
  // Edge labels are positioned along their edge, not on the canvas, so they
  // are not anchorable.
  if (geometry.getAttribute('relative') === '1') return null;

  const width = num(geometry.getAttribute('width'));
  const height = num(geometry.getAttribute('height'));
  if (!width || !height) return null;

  const offset = resolveParentOffset(cell, byId);
  const absX = num(geometry.getAttribute('x')) + offset.x;
  const absY = num(geometry.getAttribute('y')) + offset.y;

  return {
    id: cell.getAttribute('id'),
    parentId: cell.getAttribute('parent') || null,
    label: plainLabel(cell.getAttribute('value')),
    style: cell.getAttribute('style') || '',
    absX,
    absY,
    width,
    height,
    centerX: absX + width / 2,
    centerY: absY + height / 2,
  };
}

/**
 * Accumulated offset of a cell's ancestors.
 *
 * Walks up `parent` until it reaches a layer cell (parent `"0"`, conventionally
 * id `"1"`), which is the canvas origin. Guarded against cycles: a hand-edited
 * or generated file can contain one, and an unguarded walk would hang the
 * admin tab rather than reject the file.
 */
function resolveParentOffset(cell, byId) {
  let x = 0;
  let y = 0;
  const seen = new Set([cell.getAttribute('id')]);
  let parent = byId.get(cell.getAttribute('parent'));

  while (parent && parent.getAttribute('vertex') === '1') {
    const id = parent.getAttribute('id');
    if (seen.has(id)) break;
    seen.add(id);

    const [geometry] = parent.getElementsByTagName('mxGeometry');
    if (geometry) {
      x += num(geometry.getAttribute('x'));
      y += num(geometry.getAttribute('y'));
    }
    parent = byId.get(parent.getAttribute('parent'));
  }
  return { x, y };
}

/** Union of every shape rect — the frame draw.io's own export crops to. */
function boundsOf(shapes) {
  if (shapes.length === 0) return null;
  const minX = Math.min(...shapes.map((s) => s.absX));
  const minY = Math.min(...shapes.map((s) => s.absY));
  const maxX = Math.max(...shapes.map((s) => s.absX + s.width));
  const maxY = Math.max(...shapes.map((s) => s.absY + s.height));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** draw.io labels may be HTML; hotspot pickers want readable text. */
function plainLabel(value) {
  if (!value) return '';
  return (
    String(value)
      .replace(/<br\s*\/?>/gi, ' ')
      // A space, not '': '<div>' carries a line break visually, and dropping it
      // glues words together — 'Amazon API GatewayREST endpoint'.
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function num(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Convenience: decode a file and parse one page (the first unless named). */
export async function parseDrawioFile(fileText, { pageId = null } = {}) {
  const pages = await decodeMxfile(fileText);
  const page = pageId ? pages.find((p) => p.id === pageId) || pages[0] : pages[0];
  return {
    page: { id: page.id, name: page.name },
    pageCount: pages.length,
    ...parseMxGraphModel(page.xml),
  };
}
