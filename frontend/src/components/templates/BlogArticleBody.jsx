import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownCodeComponents } from '@/components/shared/CodeBlock';
import { sanitizeHtml } from '@/lib/sanitizeHtml';
import { ModuleContainer } from '@/components/modules/InlineModules';
import { parseModulesFromMarkdown } from '@/lib/moduleParser';
import { canPairModules, isHeadingOnlyTextSegment } from '@/lib/modulePairing';
import { ARTICLE_PROSE_CLASS, HEADING_PROSE_CLASS } from '@/lib/articleStyles';

// The article body of BlogDetailTemplate: text and inline modules in order,
// with two side-by-side modules shown as a pair.

function MarkdownBlock({ className, children }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

// One piece of text: as sanitized HTML when the body is HTML, else markdown.
function TextBlock({ text, isHtml }) {
  if (isHtml) {
    return (
      <div
        className={ARTICLE_PROSE_CLASS}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(text) }}
      />
    );
  }
  return <MarkdownBlock className={ARTICLE_PROSE_CLASS}>{text}</MarkdownBlock>;
}

function PairedModule({ moduleData }) {
  return (
    <div className="min-w-0">
      <ModuleContainer type={moduleData.type} data={moduleData} align={moduleData.align} paired />
    </div>
  );
}

function ModulePair({ left, right }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 md:items-start">
      <PairedModule moduleData={left} />
      <PairedModule moduleData={right} />
    </div>
  );
}

// Splits the body at the module placeholders into an ordered list of text
// and module items, dropping empty text and unknown modules.
function toOrderedItems(bodyWithPlaceholders, modules) {
  return bodyWithPlaceholders
    .split(/(<!-- MODULE_\d+ -->)/g)
    .map((segment, index) => {
      const placeholderMatch = segment.match(/^<!-- MODULE_(\d+) -->$/);
      if (placeholderMatch) {
        const moduleIndex = Number.parseInt(placeholderMatch[1], 10);
        const moduleData = modules[moduleIndex];
        if (!moduleData) return null;
        return {
          kind: 'module',
          key: `module-${moduleIndex}-${index}`,
          moduleData,
        };
      }

      if (!segment.trim()) return null;
      return {
        kind: 'text',
        key: `text-${index}`,
        text: segment,
      };
    })
    .filter(Boolean);
}

function canPairAcrossHeading(item, textBetweenItem, moduleAfterTextItem) {
  return (
    textBetweenItem?.kind === 'text' &&
    isHeadingOnlyTextSegment(textBetweenItem.text) &&
    moduleAfterTextItem?.kind === 'module' &&
    canPairModules(item.moduleData, moduleAfterTextItem.moduleData)
  );
}

// The rows for the module at `index`, and how many items they used up.
function moduleRows(orderedItems, index) {
  const item = orderedItems[index];
  const nextItem = orderedItems[index + 1];
  const moduleAfterTextItem = orderedItems[index + 2];

  if (nextItem?.kind === 'module' && canPairModules(item.moduleData, nextItem.moduleData)) {
    return {
      used: 2,
      rows: [
        <ModulePair
          key={`${item.key}-${nextItem.key}-pair`}
          left={item.moduleData}
          right={nextItem.moduleData}
        />,
      ],
    };
  }

  if (canPairAcrossHeading(item, nextItem, moduleAfterTextItem)) {
    return {
      used: 3,
      rows: [
        <MarkdownBlock
          key={`${item.key}-${nextItem.key}-${moduleAfterTextItem.key}-heading`}
          className={HEADING_PROSE_CLASS}
        >
          {nextItem.text}
        </MarkdownBlock>,
        <ModulePair
          key={`${item.key}-${moduleAfterTextItem.key}-pair`}
          left={item.moduleData}
          right={moduleAfterTextItem.moduleData}
        />,
      ],
    };
  }

  return {
    used: 1,
    rows: [
      <div key={item.key} className="clear-both w-full">
        <ModuleContainer
          type={item.moduleData.type}
          data={item.moduleData}
          align={item.moduleData.align}
        />
      </div>,
    ],
  };
}

function buildRows(orderedItems, bodyIsHtml) {
  const rows = [];
  let index = 0;
  while (index < orderedItems.length) {
    const item = orderedItems[index];
    if (item.kind === 'text') {
      rows.push(<TextBlock key={item.key} text={item.text} isHtml={bodyIsHtml} />);
      index += 1;
    } else {
      const { rows: added, used } = moduleRows(orderedItems, index);
      rows.push(...added);
      index += used;
    }
  }
  return rows;
}

export default function BlogArticleBody({ body }) {
  const { text: bodyWithPlaceholders, modules } = parseModulesFromMarkdown(body);
  const contentToRender = bodyWithPlaceholders.replace(/<!-- MODULE_\d+ -->/g, '\n\n').trim();
  // Only treat as raw HTML if the stripped content has actual block-level HTML tags.
  // This prevents <module> tags in blogDraft from wrongly triggering the HTML path
  // and rendering markdown as plain text.
  const bodyIsHtml =
    /<\s*(p|div|span|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|section|article|blockquote)\b[^>]*>/i.test(
      contentToRender
    );
  const orderedItems = toOrderedItems(bodyWithPlaceholders, modules);

  return (
    <div className="relative">
      {orderedItems.length ? (
        buildRows(orderedItems, bodyIsHtml)
      ) : (
        <TextBlock text={contentToRender} isHtml={bodyIsHtml} />
      )}
    </div>
  );
}
