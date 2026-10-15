/**
 * The image-host gate behind the narrowed img-src (#935).
 *
 * `img-src` used to admit every HTTPS host; it now names the ones the site
 * loads from, and check-image-hosts.mjs fails a build whose pages reach for
 * another. The extractors and the verdict are pinned here on fixtures, because
 * a gate that misses an attribute lets an image break on the deployed site,
 * and one that misreads a wildcard blocks every build for a host the policy
 * already allows.
 */
import { describe, it, expect } from 'vitest';

import {
  RETIRED_IMAGE_HOSTS,
  allowedBy,
  evaluate,
  imageOrigin,
  imageSourcesInCss,
  imageSourcesInHtml,
  imageSourcesInManifest,
  imgSrcOf,
} from './check-image-hosts.mjs';

const SOURCES = [
  "'self'",
  'data:',
  'https://api-azure.hybridcloudworks.com',
  'https://images.credly.com',
  'https://*.podbean.com',
];

describe('reading a page', () => {
  it('finds src and srcset on img and source, the poster of a video, image inputs, icons and image preloads', () => {
    const html = [
      '<link rel="icon" type="image/png" href="/icons/hcw-logo.png">',
      '<link rel="preload" as="image" href="https://images.credly.com/a.png" imagesrcset="/a-640.webp 640w, /a-1280.webp 1280w">',
      '<link rel="preload" as="script" href="/assets/index.js">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2">',
      '<img src="/icons/a.png" alt="" srcset="/icons/a-2x.png 2x, https://cdn.example/a.png 3x">',
      '<picture><source srcset="https://pbcdn1.podbean.com/b.webp" type="image/webp"><img src="/b.png"></picture>',
      '<video poster="/poster.jpg" src="/clip.mp4"></video>',
      '<input type="image" src="/go.png"><input type="text" src="/not-an-image">',
    ].join('\n');
    expect(imageSourcesInHtml(html)).toEqual([
      { url: '/icons/hcw-logo.png', where: 'link.href' },
      { url: 'https://images.credly.com/a.png', where: 'link.href' },
      { url: '/a-640.webp', where: 'link.imagesrcset' },
      { url: '/a-1280.webp', where: 'link.imagesrcset' },
      { url: '/icons/a.png', where: 'img.src' },
      { url: '/icons/a-2x.png', where: 'img.srcset' },
      { url: 'https://cdn.example/a.png', where: 'img.srcset' },
      { url: 'https://pbcdn1.podbean.com/b.webp', where: 'source.srcset' },
      { url: '/b.png', where: 'img.src' },
      { url: '/poster.jpg', where: 'video.poster' },
      { url: '/go.png', where: 'input.src' },
    ]);
  });

  it('decodes the entities React writes into a URL, so the origin is read from the real one', () => {
    const [found] = imageSourcesInHtml('<img src="https://cdn.example/a.png?x=1&amp;y=2">');
    expect(found.url).toBe('https://cdn.example/a.png?x=1&y=2');
  });

  // A hand-written srcset has no space after its commas, and a data URI
  // carries commas of its own; a split on ", " would lose the second
  // candidate of the first and keep the first whole only by luck.
  it('reads every srcset candidate whether or not a space follows the comma, and keeps a data URI whole', () => {
    const html =
      '<img src="/a.png" srcset="/a.png 1x,https://cdn.example/b.png 2x,/c.png">' +
      '<img src="/d.png" srcset="data:image/png;base64,AAAA 1x, /e.png 2x">';
    expect(imageSourcesInHtml(html).map((entry) => entry.url)).toEqual([
      '/a.png',
      '/a.png',
      'https://cdn.example/b.png',
      '/c.png',
      '/d.png',
      'data:image/png;base64,AAAA',
      '/e.png',
    ]);
  });

  it('reads the url() of a <style> block and of a style attribute, decoded, as image requests', () => {
    const html =
      '<style>.hero{background:url(https://cdn.example/bg.png)}@font-face{src:url(/f.woff2)}</style>' +
      '<div style="background-image:url(&quot;/images/x.png&quot;)"></div>';
    expect(imageSourcesInHtml(html)).toEqual([
      { url: 'https://cdn.example/bg.png', where: 'style element url()' },
      { url: '/images/x.png', where: 'style attribute url()' },
    ]);
  });
});

describe('reading a stylesheet', () => {
  it('keeps every url() that is not a font', () => {
    const css =
      '.a{background:url("/images/a.png")}.b{background-image:url(https://cdn.example/b.webp)}' +
      "@font-face{src:url('/fonts/x.woff2') format('woff2'),url(/fonts/x.ttf)}.c{mask:url(data:image/svg+xml;base64,AAAA)}";
    expect(imageSourcesInCss(css).map((entry) => entry.url)).toEqual([
      '/images/a.png',
      'https://cdn.example/b.webp',
      'data:image/svg+xml;base64,AAAA',
    ]);
  });
});

describe('reading the content manifest', () => {
  it('finds HTML and Markdown images in every body field of every article', () => {
    const manifest = {
      data: {
        'article:one': {
          Content: '<p><img src="https://techcommunity.microsoft.com/i.png" alt=""></p>',
          content: '![](https://techcommunity.microsoft.com/j.png)\n\ntext',
        },
        'article:two': { blogDraft: "<img src='/api/public/media/covers/x.png'>" },
        'article:three': { content: 'no images here' },
      },
    };
    expect(imageSourcesInManifest(manifest)).toEqual([
      { url: 'https://techcommunity.microsoft.com/i.png', where: 'article:one <img>' },
      { url: 'https://techcommunity.microsoft.com/j.png', where: 'article:one markdown' },
      { url: '/api/public/media/covers/x.png', where: 'article:two <img>' },
    ]);
  });

  it('reads nothing from a manifest with no data', () => {
    expect(imageSourcesInManifest({})).toEqual([]);
    expect(imageSourcesInManifest(undefined)).toEqual([]);
  });
});

describe('what a URL needs from img-src', () => {
  it.each([
    ['/icons/a.png', "'self'"],
    ['icons/a.png', "'self'"],
    ['data:image/png;base64,AAAA', 'data:'],
    ['blob:https://hybridcloudworks.com/uuid', 'blob:'],
    ['https://images.credly.com/size/340x340/images/x/image.png', 'https://images.credly.com'],
    ['HTTPS://Images.Credly.com/x.png', 'https://images.credly.com'],
    ['//cdn.example/a.png', 'https://cdn.example'],
    ['//CDN.Example/a.png', 'https://cdn.example'],
    ['http://insecure.example/a.png', 'http://insecure.example'],
    // Every other scheme is its own token, never a page of the site: a gate
    // that read these as relative would wave them through on 'self'.
    ['ftp://files.example/a.png', 'ftp:'],
    ['file:///C:/a.png', 'file:'],
    ['javascript:alert(1)', 'javascript:'],
    ['mailto:someone@example', 'mailto:'],
    ['FTP://files.example/a.png', 'ftp:'],
  ])('%s needs %s', (url, origin) => {
    expect(imageOrigin(url)).toBe(origin);
  });
});

describe('whether a source list admits an origin', () => {
  it("admits a relative URL through 'self' and a scheme through its own token", () => {
    expect(allowedBy("'self'", SOURCES)).toBe(true);
    expect(allowedBy('data:', SOURCES)).toBe(true);
    expect(allowedBy('blob:', SOURCES)).toBe(false);
  });

  it("does not let 'self' admit an absolute URL to the site, which fails on the other hostname", () => {
    expect(allowedBy('https://hybridcloudworks.com', SOURCES)).toBe(false);
  });

  it('matches an exact host and a wildcard on subdomains only', () => {
    expect(allowedBy('https://images.credly.com', SOURCES)).toBe(true);
    expect(allowedBy('https://pbcdn1.podbean.com', SOURCES)).toBe(true);
    expect(allowedBy('https://podbean.com', SOURCES)).toBe(false);
    expect(allowedBy('https://evil-podbean.com', SOURCES)).toBe(false);
    expect(allowedBy('https://cdn.example', SOURCES)).toBe(false);
  });

  it('never admits plain http, which the browser blocks as mixed content before CSP is consulted', () => {
    expect(allowedBy('http://images.credly.com', [...SOURCES, 'http://images.credly.com'])).toBe(
      false
    );
  });
});

describe('the directive', () => {
  it('reads img-src out of a policy and nothing else', () => {
    expect(
      imgSrcOf("default-src 'self'; img-src 'self' data: https://a.example; media-src 'self';")
    ).toEqual(["'self'", 'data:', 'https://a.example']);
    expect(imgSrcOf("default-src 'self';")).toEqual([]);
  });
});

describe('the verdict', () => {
  // Two retired hosts here, whatever the real list holds today: the real
  // list shrinks as content is re-hosted, and the rules are what is pinned.
  const retired = {
    'https://firebasestorage.googleapis.com': 'the bucket is gone',
    'https://storage.googleapis.com': 'the same bucket, other spelling',
  };
  const references = [
    { url: '/icons/a.png', file: 'dist/index.html', where: 'img.src' },
    { url: '/icons/b.png', file: 'dist/about/index.html', where: 'img.src' },
    { url: 'https://images.credly.com/x.png', file: 'dist/about/index.html', where: 'img.src' },
    {
      url: 'https://firebasestorage.googleapis.com/v0/b/x/o/y.png',
      file: 'dist/aws/blog/p/index.html',
      where: 'img.src',
    },
    { url: 'https://storage.googleapis.com/x/y.png', file: 'article:z', where: '<img>' },
  ];

  it('tolerates the Firebase-era bucket, with its reason, until the last page stops naming it', () => {
    expect(Object.keys(RETIRED_IMAGE_HOSTS)).toEqual(['https://firebasestorage.googleapis.com']);
    expect(RETIRED_IMAGE_HOSTS['https://firebasestorage.googleapis.com']).toContain('#518');
  });

  it('passes a build whose every host is allowed or retired, and reports each origin with its count', () => {
    const { rows, failures } = evaluate({ sources: SOURCES, references, retired });
    expect(failures).toEqual([]);
    expect(rows.map(({ origin, count, status }) => [origin, count, status])).toEqual([
      ["'self'", 2, 'allowed'],
      ['https://firebasestorage.googleapis.com', 1, 'retired'],
      ['https://images.credly.com', 1, 'allowed'],
      ['https://storage.googleapis.com', 1, 'retired'],
    ]);
    expect(rows[1].reason).toBe('the bucket is gone');
  });

  it('fails on a host the policy does not name, saying where it was used and what to do', () => {
    const { failures } = evaluate({
      sources: SOURCES,
      references: [
        ...references,
        {
          url: 'https://cdn.example/new.png',
          file: 'dist/azure/blog/q/index.html',
          where: 'link.href',
        },
      ],
      retired,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('https://cdn.example');
    expect(failures[0]).toContain('dist/azure/blog/q/index.html');
    expect(failures[0]).toContain('link.href');
    expect(failures[0]).toContain('staticwebapp.config.json');
  });

  it('fails on a scheme the policy does not carry, so blob: cannot creep back in unmeasured', () => {
    const { failures } = evaluate({
      sources: SOURCES,
      references: [
        {
          url: 'blob:https://hybridcloudworks.com/uuid',
          file: 'dist/index.html',
          where: 'img.src',
        },
      ],
      retired: {},
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('blob:');
  });

  it("fails on a scheme the policy never names, instead of reading it as 'self'", () => {
    const { failures } = evaluate({
      sources: SOURCES,
      references: [
        { url: 'ftp://files.example/a.png', file: 'dist/index.html', where: 'img.src' },
        { url: 'javascript:alert(1)', file: 'dist/index.html', where: 'img.src' },
      ],
      retired: {},
    });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('img-src does not allow ftp:');
    expect(failures[1]).toContain('img-src does not allow javascript:');
  });

  it('fails when a retired host has no reference left, so the entry cannot outlive its reason', () => {
    const { failures } = evaluate({
      sources: SOURCES,
      references: references.filter((entry) => !entry.url.includes('storage.googleapis.com')),
      retired,
    });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('https://firebasestorage.googleapis.com');
    expect(failures[0]).toContain('RETIRED_IMAGE_HOSTS');
    expect(failures[1]).toContain('https://storage.googleapis.com');
  });

  it('fails when a retired host is also allowed, because a dead host earns no entry', () => {
    const { failures } = evaluate({
      sources: [...SOURCES, 'https://firebasestorage.googleapis.com'],
      references,
      retired,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('both retired');
  });
});
