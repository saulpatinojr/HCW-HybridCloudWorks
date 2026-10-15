/**
 * The policy the deploy ships is computed from the pages, not copied (#935).
 *
 * `staticwebapp.config.json` commits a Content-Security-Policy with no
 * 'unsafe-inline'; what the pre-rendered pages carry inline is allowed by
 * hashes that stage-swa-config.mjs computes from dist on every build. Nothing
 * else looks at that computation: a wrong hash shows up as an unstyled legal
 * page or a navigation grid with every item in column one, on the deployed
 * site, in a browser console, and nowhere earlier. So the pieces are pinned
 * here — the hash itself against a value computed outside this code, the
 * entity decoding React's escaping makes necessary, and the shape of the
 * policy that comes out.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectInlineStyles,
  decodeAttribute,
  filesUnder,
  htmlPages,
  sha256Source,
  stageConfig,
  styleAttributeValues,
  withInlineStyleHashes,
} from './stage-swa-config.mjs';

/** The same digest, computed here rather than by the code under test. */
const digest = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const POLICY =
  "default-src 'self'; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; frame-ancestors 'none';";

describe('the hash source', () => {
  it("is 'sha256-<base64>' of the UTF-8 bytes, matching an external digest", () => {
    // Computed with openssl on 2026-10-15: printf '%s' 'grid-column:1' |
    // openssl dgst -sha256 -binary | openssl base64 -A
    expect(sha256Source('grid-column:1')).toBe(
      "'sha256-5+pCFarhql4pP3EwQhGswvlhMnOT8OlLou55GpEJiVg='"
    );
    expect(sha256Source('é')).toBe(digest('é'));
  });
});

describe('decoding an attribute value', () => {
  it('undoes the five escapes React emits, so a quoted font-family hashes as the browser sees it', () => {
    expect(decodeAttribute('font-family:&quot;Fira Code&quot;, &#x27;Fira Mono&#x27;')).toBe(
      'font-family:"Fira Code", \'Fira Mono\''
    );
    expect(decodeAttribute('a &lt; b &amp;&amp; c &gt; d')).toBe('a < b && c > d');
  });

  it('reads decimal and hexadecimal references and leaves an unknown entity as written', () => {
    expect(decodeAttribute('&#65;&#x42;&nbsp;&bogus;')).toBe('AB &bogus;');
  });
});

describe('collecting inline styles from pages', () => {
  const legal = '<html><head><style>\n  body { margin: 0; }\n</style></head><body></body></html>';
  const home =
    '<div style="grid-column:1"><a style="grid-column:1">x</a>' +
    '<pre style="font-family:&quot;Fira Code&quot;">y</pre></div>';
  const about = '<nav style="grid-column:1"></nav>';

  it('keys each distinct <style> body and each distinct attribute value by hash, with where it was seen', () => {
    const styles = collectInlineStyles([
      ['privacy-policy.html', legal],
      ['terms-of-service.html', legal],
      ['index.html', home],
      ['about/index.html', about],
    ]);

    expect(styles.elementCount).toBe(2);
    expect(styles.elements.size).toBe(1);
    const [elementHash, element] = [...styles.elements.entries()][0];
    expect(elementHash).toBe(digest('\n  body { margin: 0; }\n'));
    expect(element.files).toEqual(['privacy-policy.html', 'terms-of-service.html']);

    expect(styles.attributeCount).toBe(4);
    expect(styles.attributes.size).toBe(2);
    const grid = styles.attributes.get(digest('grid-column:1'));
    expect(grid).toMatchObject({ value: 'grid-column:1', count: 3 });
    expect(grid.files).toEqual(['index.html', 'about/index.html']);
  });

  it('hashes the DECODED attribute value, which is the one the browser checks', () => {
    const styles = collectInlineStyles([['index.html', home]]);
    expect(styles.attributes.has(digest('font-family:"Fira Code"'))).toBe(true);
    expect(styles.attributes.has(digest('font-family:&quot;Fira Code&quot;'))).toBe(false);
  });

  it('sees a style attribute whatever the spacing around its equals sign', () => {
    const styles = collectInlineStyles([
      ['x.html', '<p style = "color:red">a</p><p style="color:red">b</p>'],
    ]);
    expect(styles.attributes.get(digest('color:red')).count).toBe(2);
  });

  // React writes style="…", but the HTML parser accepts '…' and an unquoted
  // value too, and a page copied from public/ or an article body can carry
  // either. A value the scan misses has no hash, so the browser blocks it on
  // the deployed site while every check here stays green.
  it('hashes a single-quoted and an unquoted style attribute, each as its own value', () => {
    const styles = collectInlineStyles([
      [
        'x.html',
        "<p style='color:blue'>a</p><p style=color:green>b</p>" +
          '<p style=\'font-family:"Fira Code"\'>c</p><p style = color:teal class=x>d</p>',
      ],
    ]);
    expect(styles.attributeCount).toBe(4);
    for (const value of ['color:blue', 'color:green', 'font-family:"Fira Code"', 'color:teal']) {
      expect(styles.attributes.get(digest(value))).toMatchObject({ value, count: 1 });
    }
  });

  it('reads a style attribute in all three forms, decoded, and only the attribute named style', () => {
    expect(
      styleAttributeValues(
        '<a style="a:1" data-style="b:2"><b style=\'c:&quot;3&quot;\'><i style=d:4&#59;></i></b></a>'
      )
    ).toEqual(['a:1', 'c:"3"', 'd:4;']);
  });

  // Measured on the first build with the unquoted form: the pre-render's seed
  // attribute carries whole article bodies, escaped, and a search of the whole
  // page for `style=` found eleven in there and hashed values like `\"width:`.
  it('reads style only in attribute position, never inside another value or in text', () => {
    const html =
      '<div id="root" data-prerendered-seed="{&quot;body&quot;:&quot;&lt;col style=\\&quot;width: 1px\\&quot; /&gt;&quot;}">' +
      "<p title='set style=x here' style=color:red>write style=bold in prose</p></div>" +
      '<col style="width: 2px" style="width: 3px" />';
    expect(styleAttributeValues(html)).toEqual(['color:red', 'width: 2px']);
  });
});

describe('walking the build output', () => {
  // A stat followed by a read is two looks at a path that can change in
  // between (CodeQL js/file-system-race); the walk branches on the type
  // readdir hands back with each name instead. These pin what it returns, so
  // the order and the filtering cannot change with the mechanism.
  const tree = () => {
    const root = mkdtempSync(join(tmpdir(), 'hcw-stage-swa-walk-'));
    mkdirSync(join(root, 'about'));
    mkdirSync(join(root, 'assets'));
    mkdirSync(join(root, 'legacy.html'));
    writeFileSync(join(root, 'index.html'), '<p style="a:1">home</p>');
    writeFileSync(join(root, 'Zeta.html'), 'zeta');
    writeFileSync(join(root, 'notes.txt'), 'not a page');
    writeFileSync(join(root, 'about', 'index.html'), 'about\r\nus');
    writeFileSync(join(root, 'assets', 'app.css'), '.a{}');
    writeFileSync(join(root, 'legacy.html', 'page.html'), 'legacy');
    return root;
  };

  it('returns every matching file under the root, each level in code-unit order, whatever the filesystem lists first', () => {
    expect(filesUnder(tree(), ['.html', '.css']).map(([path]) => path)).toEqual([
      'Zeta.html',
      join('about', 'index.html'),
      join('assets', 'app.css'),
      'index.html',
      join('legacy.html', 'page.html'),
    ]);
  });

  it('walks into a directory whose name ends in .html instead of reading it as a page', () => {
    const pages = htmlPages(tree());
    expect(pages).toContainEqual([join('legacy.html', 'page.html'), 'legacy']);
    expect(pages.map(([path]) => path)).not.toContain('legacy.html');
  });

  it('reads each page with its line endings normalised to LF', () => {
    expect(htmlPages(tree())).toContainEqual([join('about', 'index.html'), 'about\nus']);
  });
});

describe('the finished policy', () => {
  const elementHashes = [digest('body{}')];
  const attributeHashes = [digest('grid-column:2'), digest('grid-column:1')];

  it('appends the element hashes to style-src and puts the attribute hashes behind unsafe-hashes in style-src-attr', () => {
    const policy = withInlineStyleHashes(POLICY, { elementHashes, attributeHashes });
    expect(policy).toBe(
      `default-src 'self'; style-src 'self' https://fonts.googleapis.com ${digest('body{}')}; img-src 'self' data:; frame-ancestors 'none'; ` +
        `style-src-attr 'unsafe-hashes' ${[...attributeHashes].sort().join(' ')};`
    );
  });

  it('leaves every other directive exactly as committed', () => {
    const policy = withInlineStyleHashes(POLICY, { elementHashes, attributeHashes });
    for (const directive of [
      "default-src 'self'",
      "img-src 'self' data:",
      "frame-ancestors 'none'",
    ]) {
      expect(policy).toContain(`${directive};`);
    }
  });

  it('writes no style-src-attr when the pages carry no style attribute', () => {
    const policy = withInlineStyleHashes(POLICY, { elementHashes, attributeHashes: [] });
    expect(policy).not.toContain('style-src-attr');
    expect(policy).not.toContain('unsafe-hashes');
  });

  it("refuses a committed policy that has drifted back to 'unsafe-inline'", () => {
    expect(() =>
      withInlineStyleHashes(
        POLICY.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
        {}
      )
    ).toThrow(/unsafe-inline/);
  });

  it('refuses a committed style-src-attr, which is its own to write', () => {
    expect(() => withInlineStyleHashes(`${POLICY} style-src-attr 'none';`, {})).toThrow(
      /style-src-attr/
    );
  });

  it('refuses a policy with no style-src to extend', () => {
    expect(() => withInlineStyleHashes("default-src 'self';", {})).toThrow(/style-src/);
  });
});

describe('staging into dist', () => {
  it('writes the computed policy beside the pages and leaves the committed file and the other keys alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'hcw-stage-swa-'));
    const source = join(root, 'staticwebapp.config.json');
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'about'), { recursive: true });
    const committed = {
      navigationFallback: { rewrite: '/app-shell.html' },
      globalHeaders: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': POLICY },
      routes: [{ route: '/admin/*', headers: { 'X-Robots-Tag': 'noindex, nofollow' } }],
    };
    writeFileSync(source, JSON.stringify(committed, null, 2));
    writeFileSync(join(dist, 'privacy-policy.html'), '<style>p{}</style>');
    writeFileSync(join(dist, 'about', 'index.html'), '<nav style="grid-column:1"></nav>');

    const result = stageConfig({ source, dist });

    const staged = JSON.parse(readFileSync(result.destination, 'utf8'));
    expect(result.destination).toBe(join(dist, 'staticwebapp.config.json'));
    expect(staged.globalHeaders['Content-Security-Policy']).toBe(
      `default-src 'self'; style-src 'self' https://fonts.googleapis.com ${digest('p{}')}; img-src 'self' data:; frame-ancestors 'none'; ` +
        `style-src-attr 'unsafe-hashes' ${digest('grid-column:1')};`
    );
    expect(staged.navigationFallback).toEqual(committed.navigationFallback);
    expect(staged.globalHeaders['X-Frame-Options']).toBe('DENY');
    expect(staged.routes).toEqual(committed.routes);
    expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(committed);
    expect(result.styles.elements.size).toBe(1);
    expect(result.styles.attributes.size).toBe(1);
  });

  // The browser's HTML parser turns CR LF and a lone CR into LF before a
  // <style> body or an attribute value exists, so the hash it checks is of
  // the LF text. A page written with CRLF must hash the same way, or the
  // policy carries a hash no browser ever computes.
  it('hashes a page written with CRLF as the browser reads it, with LF', () => {
    const root = mkdtempSync(join(tmpdir(), 'hcw-stage-swa-crlf-'));
    const source = join(root, 'staticwebapp.config.json');
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      source,
      JSON.stringify({ globalHeaders: { 'Content-Security-Policy': POLICY } }, null, 2)
    );
    writeFileSync(
      join(dist, 'terms-of-service.html'),
      '<style>\r\nbody { margin: 0; }\r\n</style>\r\n<p style="color:red;\rbackground:none">x</p>'
    );

    const { policy } = stageConfig({ source, dist });

    expect(policy).toContain(digest('\nbody { margin: 0; }\n'));
    expect(policy).toContain(digest('color:red;\nbackground:none'));
    expect(policy).not.toContain(digest('\r\nbody { margin: 0; }\r\n'));
  });
});

describe('decodeAttribute, invalid numeric references (CodeRabbit on #1185)', () => {
  it('maps a numeric reference the HTML spec calls invalid to U+FFFD instead of throwing', () => {
    expect(decodeAttribute('a&#x110000;b')).toBe('a\uFFFDb');
    expect(decodeAttribute('a&#0;b')).toBe('a\uFFFDb');
    expect(decodeAttribute('a&#xD800;b')).toBe('a\uFFFDb');
    expect(decodeAttribute('a&#99999999999;b')).toBe('a\uFFFDb');
    expect(decodeAttribute('a&#x41;b&#66;c')).toBe('aAbBc');
  });
});
