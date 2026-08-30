import rehypeParse from 'rehype-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';

import { htmlToMarkdown, htmlToText, markdownToHtml } from './pipelines';

import type { Nodes } from 'hast';

/**
 * XSS VECTORS.
 *
 * These tools are the first here that produce markup intended to be RENDERED -
 * in the preview pane, and wherever somebody pastes it. So both directions are
 * hostile: the HTML coming in is untrusted, and the HTML going out may be
 * rendered by something that trusts us.
 *
 * Every vector below is checked through BOTH pipelines, because sanitising one
 * side only is the classic mistake. `md → html` matters because Markdown can
 * carry raw HTML blocks; `html → md` matters because anything that survives
 * into the tree comes back out in the Markdown.
 *
 * The assertions are deliberately about ABSENCE of the dangerous construct
 * rather than presence of some expected replacement: the sanitiser is free to
 * drop, unwrap or rewrite, and any of those is a pass. What is never
 * acceptable is a surviving handler, scheme or executable element.
 */

const TO_HTML = { headingIds: true, linkify: true };
const TO_MD = {
  bullet: '-',
  emphasis: '_',
  strong: '*',
  fence: '`',
  setext: false,
  unsupported: 'keep',
} as const;
const TO_TEXT = { keepLinkUrls: true, listMarker: '-', tables: 'rows' } as const;

/**
 * The scheme the check below rejects.
 *
 * A named constant so the one lint exemption this file needs sits on a line
 * Prettier will not reflow. The rule is right in general - a `javascript:`
 * string usually IS an attempt to execute something - and wrong here, where it
 * is the value being refused.
 */
// eslint-disable-next-line no-script-url -- the comparison that rejects it
const SCRIPT_SCHEME = 'javascript:';

/**
 * Asserts that PARSED output contains nothing that can execute.
 *
 * Parsed, not pattern-matched, and the difference is the whole point.
 *
 * A first version of this searched the output string for `onerror=`,
 * `<script` and so on, and reported five vulnerabilities that were not
 * vulnerabilities. `<p>&#x3C;img src=x onerror=alert(1)></p>` contains the
 * characters `onerror=` and executes nothing: the `<` is escaped, so it is
 * text. `<p title="</noscript><img src=x onerror=alert(1)>">` likewise - that
 * is an attribute VALUE, and a `<` inside a quoted value never opens a tag.
 *
 * A string search cannot tell those from a live handler, which means it can
 * only be made to pass by loosening it until it stops testing anything. So
 * this parses the output the way a browser would and asks the tree the
 * question that actually matters: is there an element that runs, a property
 * that fires, or a URL that navigates to script?
 */
function assertInertHtml(html: string): void {
  const tree = unified().use(rehypeParse, { fragment: true }).parse(html);

  const EXECUTABLE = new Set([
    'script',
    'iframe',
    'object',
    'embed',
    'svg',
    'math',
    'form',
    'style',
    'link',
    'meta',
    'base',
    'noscript',
    'template',
    'audio',
    'video',
  ]);

  const found: string[] = [];

  const walk = (node: Nodes): void => {
    if (node.type === 'element') {
      if (EXECUTABLE.has(node.tagName)) found.push(`<${node.tagName}>`);

      for (const [name, value] of Object.entries(node.properties)) {
        // Every event handler, by shape rather than by name.
        if (/^on[a-z]/i.test(name)) found.push(`${node.tagName}[${name}]`);

        if ((name === 'href' || name === 'src') && typeof value === 'string') {
          /*
           * Control characters and whitespace are stripped first, by CODE
           * POINT rather than by regex. A browser ignores them when resolving
           * a scheme, so `java\nscript:` and `java\tscript:` both run - and a
           * regex holding literal control characters is banned by lint,
           * rightly, which makes the explicit filter the clearer form anyway.
           */
          let stripped = '';
          for (const character of value) {
            if (character.charCodeAt(0) > 0x20) stripped += character;
          }
          const scheme = stripped.toLowerCase();
          if (scheme.startsWith(SCRIPT_SCHEME) || scheme.startsWith('data:')) {
            found.push(`${node.tagName}[${name}=${scheme.slice(0, 24)}]`);
          }
        }
      }
    }

    if (node.type === 'root' || node.type === 'element') {
      for (const child of node.children) walk(child);
    }
  };

  walk(tree);

  expect(found).toEqual([]);
}

/**
 * The Markdown pipeline's output is checked by RENDERING it.
 *
 * That is the threat model: nobody executes Markdown, they publish it, and
 * what matters is whether anything hostile survives into the HTML somebody
 * eventually gets. Escaped text in the Markdown (`\<img ...>`) is correct
 * behaviour, and rendering is what proves it stayed escaped.
 */
function assertInertMarkdown(markdown: string): void {
  assertInertHtml(markdownToHtml(markdown, TO_HTML));
}

const VECTORS: readonly (readonly [string, string])[] = [
  ['a script element', '<script>alert(1)</script>'],
  ['a script with attributes', '<script type="text/javascript" src="x.js">alert(1)</script>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['img onerror, quoted and spaced', '<img src="x" onerror = "alert(1)" >'],
  ['svg onload', '<svg onload=alert(1)></svg>'],
  ['svg with a nested script', '<svg><script>alert(1)</script></svg>'],
  ['a javascript: href', '<a href="javascript:alert(1)">click</a>'],
  ['a javascript: href with padding', '<a href=" \tjava\nscript:alert(1)">click</a>'],
  ['a JaVaScRiPt: href', '<a href="JaVaScRiPt:alert(1)">click</a>'],
  ['a data:text/html href', '<a href="data:text/html;base64,PHNjcmlwdD4=">click</a>'],
  ['a data: image src', '<img src="data:image/svg+xml,<svg onload=alert(1)>">'],
  ['an iframe', '<iframe src="https://evil.example"></iframe>'],
  ['an iframe with srcdoc', '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>'],
  ['an object', '<object data="x.swf"></object>'],
  ['an embed', '<embed src="x.swf">'],
  [
    'a form with a formaction',
    '<form action="x"><button formaction="javascript:alert(1)">go</button></form>',
  ],
  ['a style element', '<style>body{background:url(javascript:alert(1))}</style>'],
  ['a style attribute', '<p style="background:url(javascript:alert(1))">text</p>'],
  ['body onload', '<body onload=alert(1)>text</body>'],
  ['a meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
  ['a base tag', '<base href="https://evil.example/">'],
  ['an unclosed script', '<script>alert(1)'],
  ['a malformed nested tag', '<<script>script>alert(1)<</script>/script>'],
  ['an attribute that is not closed', '<img src="x onerror=alert(1)>'],
  ['a null byte in a tag name', '<scr\0ipt>alert(1)</scr\0ipt>'],
  ['a comment hiding a tag', '<!--><script>alert(1)</script>-->'],
  ['a CDATA-looking wrapper', '<![CDATA[<script>alert(1)</script>]]>'],
  ['an entity-encoded handler', '<img src=x on&#101;rror=alert(1)>'],
  [
    'a namespace-confusion tag',
    '<svg><foreignObject><script>alert(1)</script></foreignObject></svg>',
  ],
  ['noscript wrapping markup', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ['a template element', '<template><script>alert(1)</script></template>'],
  ['an isindex-style legacy tag', '<isindex action="javascript:alert(1)">'],
  ['nested anchors with a handler', '<a href="#a"><a href="#b" onclick="alert(1)">x</a></a>'],
  ['a math element', '<math><mtext><script>alert(1)</script></mtext></math>'],
  ['an audio source with a handler', '<audio src=x onerror=alert(1)></audio>'],
  ['a details toggle handler', '<details ontoggle=alert(1) open>text</details>'],
];

describe('HTML → HTML, through Markdown parsing', () => {
  it.each(VECTORS)('neutralises %s', (_name, payload) => {
    // Raw HTML inside a Markdown document is parsed as markup by rehype-raw,
    // which is exactly why the sanitiser has to run on this side too.
    assertInertHtml(markdownToHtml(`Before\n\n${payload}\n\nAfter\n`, TO_HTML));
  });

  it.each(VECTORS)('neutralises %s inside a Markdown construct', (_name, payload) => {
    // Nested inside a blockquote and a list, where a converter that only looks
    // at top-level blocks would miss it.
    assertInertHtml(markdownToHtml(`> - item\n>\n>   ${payload}\n`, TO_HTML));
  });
});

describe('HTML → Markdown', () => {
  it.each(VECTORS)('does not carry %s into the Markdown', (_name, payload) => {
    assertInertMarkdown(htmlToMarkdown(payload, TO_MD));
  });

  it.each(VECTORS)('does not carry %s through with unsupported: keep', (_name, payload) => {
    // `keep` re-emits allowed-but-unconvertible elements as raw HTML, so it is
    // the setting most likely to smuggle something back out.
    assertInertMarkdown(htmlToMarkdown(payload, { ...TO_MD, unsupported: 'keep' }));
  });
});

describe('HTML → text', () => {
  /*
   * Plain text cannot execute, so there is no "inert" to assert here - the
   * question is different. What matters is that a <script> BODY goes with its
   * tag rather than being unwrapped into visible content, which is what the
   * schema's `strip` list is for. Cases where the payload was never parsed as
   * a script element in the first place (a null byte in the tag name, a CDATA
   * wrapper) legitimately leave their contents behind as ordinary words.
   */
  it.each([
    '<script>alert(1)</script>',
    '<script type="text/javascript" src="x.js">alert(1)</script>',
    '<style>body{background:url(javascript:alert(1))}</style>',
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    '<template><script>alert(1)</script></template>',
    '<noscript><script>alert(1)</script></noscript>',
  ])('strips the body of %s rather than unwrapping it', (payload) => {
    expect(htmlToText(payload, TO_TEXT)).not.toContain('alert(1)');
  });

  it.each(VECTORS)('produces text with no live markup for %s', (_name, payload) => {
    // Round-tripped through the renderer: whatever words survive, they must
    // not become markup if the text is later treated as HTML.
    assertInertMarkdown(htmlToText(payload, TO_TEXT));
  });
});

describe('mutation XSS', () => {
  /*
   * The family that defeats string-rewriting sanitisers: markup that parses
   * one way when sanitised and a different way when the browser re-parses the
   * sanitised output.
   *
   * This pipeline is structurally immune rather than defended: the sanitiser
   * operates on an ALREADY-PARSED tree and its output is serialised from that
   * tree. There is no second parse to disagree with the first. These cases
   * assert the property rather than trusting the argument.
   */
  const MUTATION: readonly (readonly [string, string])[] = [
    ['noscript re-parse', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
    ['style re-parse', '<style><style /><img src=x onerror=alert(1)>'],
    ['listing element', '<listing><img src=x onerror=alert(1)></listing>'],
    ['xmp element', '<xmp><img src=x onerror=alert(1)></xmp>'],
    [
      'nested form breaking out',
      '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    ],
    [
      'svg foreignObject re-parse',
      '<svg></p><style><a id="</style><img src=x onerror=alert(1)>"></style>',
    ],
    [
      'table foster parenting',
      '<table><noscript></tbody><img src=x onerror=alert(1)></noscript></table>',
    ],
    ['select breaking out', '<select><noembed></select><img src=x onerror=alert(1)>'],
  ];

  it.each(MUTATION)('survives re-parsing after %s', (_name, payload) => {
    const once = markdownToHtml(payload, TO_HTML);
    assertInertHtml(once);

    // Feed the sanitised output back in. If sanitising had produced markup that
    // re-parses differently, this is where the payload would reappear.
    const twice = markdownToHtml(once, TO_HTML);
    assertInertHtml(twice);

    // And through the other pipeline, which parses with a different entry point.
    assertInertMarkdown(htmlToMarkdown(once, TO_MD));
  });
});

describe('what survives', () => {
  /*
   * A sanitiser that removes everything is trivially safe and useless. These
   * assert the allow-list still lets real documents through.
   */
  it('keeps ordinary prose, links and structure', () => {
    const out = markdownToHtml(
      '# Title\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two\n',
      TO_HTML,
    );

    expect(out).toContain('<h1');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('<li>one</li>');
  });

  it('keeps mailto and tel links, which cannot execute anything', () => {
    const out = markdownToHtml(
      '[mail](mailto:a@example.com) and [call](tel:+441234567890)\n',
      TO_HTML,
    );

    expect(out).toContain('mailto:a@example.com');
    expect(out).toContain('tel:+441234567890');
  });

  it('keeps an image with an http source', () => {
    expect(markdownToHtml('![alt](https://example.com/a.png)\n', TO_HTML)).toContain(
      'src="https://example.com/a.png"',
    );
  });

  it('rewrites a stray input into an inert checkbox rather than dropping it', () => {
    // The `required` rule in the schema forces type=checkbox and disabled onto
    // any input that gets through, so a hostile one becomes harmless furniture.
    const out = markdownToHtml(
      '<input type="image" src="x" formaction="javascript:alert(1)">\n',
      TO_HTML,
    );

    assertInertHtml(out);
    expect(out).not.toContain('type="image"');
  });
});
