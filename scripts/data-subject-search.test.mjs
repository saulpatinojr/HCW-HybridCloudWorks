import { describe, it, expect } from 'vitest';
import {
  searchRecordFields,
  extractDocAttachments,
  scanDocuments,
  parseCommandLineArgs,
  DEFAULT_COSMOS_ACCOUNT,
  DEFAULT_DATABASE,
  DEFAULT_ATTACHMENT_CONTAINER,
} from './data-subject-search.mjs';

describe('searchRecordFields', () => {
  it('returns empty array when input or query is empty or non-string', () => {
    expect(searchRecordFields(null, 'test')).toEqual([]);
    expect(searchRecordFields({}, '')).toEqual([]);
    expect(searchRecordFields({ a: 123 }, 'test')).toEqual([]);
  });

  it('locates substring in simple and nested properties case-insensitively', () => {
    const doc = {
      id: 'app-1',
      title: 'Azure MVP Application for John Doe',
      notes: 'Reviewed candidate John Doe email jdoe@example.com',
      responses: [
        { questionId: 'q1', text: 'Spoke at Cloud Summit with John Doe' },
        { questionId: 'q2', text: 'Another response with no mention' },
      ],
      customValues: {
        nominatedBy: 'JDOE@EXAMPLE.COM',
        status: 'pending',
      },
    };

    const hits = searchRecordFields(doc, 'jdoe@example.com');
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.path)).toEqual(['notes', 'customValues.nominatedBy']);
    expect(hits[0].snippet).toContain('jdoe@example.com');
  });

  it('finds hits in arrays of strings and objects', () => {
    const doc = {
      tags: ['azure', 'contact:alice@example.com', 'speaker'],
      reviewerFeedback: 'Positive feedback from Alice',
    };

    const hits = searchRecordFields(doc, 'alice');
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.path)).toEqual(['tags[1]', 'reviewerFeedback']);
  });
});

describe('extractDocAttachments', () => {
  it('handles null, undefined or empty objects gracefully', () => {
    expect(extractDocAttachments(null)).toEqual([]);
    expect(extractDocAttachments({})).toEqual([]);
  });

  it('extracts files and images with blob paths and URLs', () => {
    const doc = {
      id: 'evidence-123',
      type: 'evidence',
      files: [
        { name: 'certificate.pdf', path: 'evidence/cert-123.pdf' },
        { name: 'external-link.pdf', url: 'https://externalsite.com/cert.pdf' },
        { name: 'custom-container.pdf', path: 'doc.pdf', container: 'custommedia' },
        { invalid: true },
      ],
      images: [
        { name: 'badge.png', path: 'badges/mvp.png' },
      ],
    };

    const attachments = extractDocAttachments(doc);
    expect(attachments).toHaveLength(4);

    expect(attachments[0]).toEqual({
      docId: 'evidence-123',
      docType: 'evidence',
      kind: 'file',
      name: 'certificate.pdf',
      container: DEFAULT_ATTACHMENT_CONTAINER,
      path: 'evidence/cert-123.pdf',
      url: null,
    });

    expect(attachments[1]).toEqual({
      docId: 'evidence-123',
      docType: 'evidence',
      kind: 'file',
      name: 'external-link.pdf',
      container: null,
      path: null,
      url: 'https://externalsite.com/cert.pdf',
    });

    expect(attachments[2]).toEqual({
      docId: 'evidence-123',
      docType: 'evidence',
      kind: 'file',
      name: 'custom-container.pdf',
      container: 'custommedia',
      path: 'doc.pdf',
      url: null,
    });

    expect(attachments[3]).toEqual({
      docId: 'evidence-123',
      docType: 'evidence',
      kind: 'image',
      name: 'badge.png',
      container: DEFAULT_ATTACHMENT_CONTAINER,
      path: 'badges/mvp.png',
      url: null,
    });
  });
});

describe('scanDocuments', () => {
  it('scans documents, matching text and aggregating attachments', () => {
    const docs = [
      {
        id: 'prog-1',
        type: 'program',
        name: 'MCT Program',
        description: 'Trainer program managed by coordinator test@example.com',
        files: [{ name: 'guide.pdf', path: 'mct/guide.pdf' }],
      },
      {
        id: 'prog-2',
        type: 'program',
        name: 'MVP Program',
        description: 'Community program',
        images: [{ name: 'mvp.jpg', path: 'mvp.jpg' }],
      },
    ];

    const result = scanDocuments(docs, 'test@example.com');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].docId).toBe('prog-1');
    expect(result.matches[0].hits[0].path).toBe('description');

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments.map((a) => a.name)).toEqual(['guide.pdf', 'mvp.jpg']);
  });
});

describe('parseCommandLineArgs', () => {
  it('applies defaults for account and database', () => {
    const args = parseCommandLineArgs(['--email', 'user@example.com']);
    expect(args.email).toBe('user@example.com');
    expect(args.account).toBe(DEFAULT_COSMOS_ACCOUNT);
    expect(args.database).toBe(DEFAULT_DATABASE);
    expect(args.help).toBe(false);
  });

  it('accepts short flags and overrides', () => {
    const args = parseCommandLineArgs([
      '-s', 'searchTerm',
      '--account', 'my-custom-cosmos',
      '--database', 'testdb',
    ]);
    expect(args.search).toBe('searchTerm');
    expect(args.account).toBe('my-custom-cosmos');
    expect(args.database).toBe('testdb');
  });
});
