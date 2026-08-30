import { describe, expect, it } from 'vitest';

import { stripHtmlComments } from './index-html';

/**
 * The comment stripper.
 *
 * The dangerous case is the inline theme bootstrap: its exact bytes are hashed
 * into the CSP, so touching anything inside <script> would produce a policy
 * that refuses the one script the page cannot start without - and it would
 * fail at runtime in the browser, not at build time.
 */

describe('stripHtmlComments', () => {
  it('removes a comment', () => {
    expect(stripHtmlComments('<p>a</p><!-- gone --><p>b</p>')).toBe('<p>a</p><p>b</p>');
  });

  it('removes a multi-line comment and the blank line it leaves', () => {
    const html = ['<head>', '  <!--', '    An explanation.', '  -->', '  <title>x</title>'].join(
      '\n',
    );

    expect(stripHtmlComments(html)).toBe(['<head>', '  <title>x</title>'].join('\n'));
  });

  it('leaves everything inside a script alone', () => {
    // `<!--` is legal inside script text and used to be the standard way to
    // hide scripts from ancient browsers. Stripping it here would corrupt the
    // hashed bootstrap.
    const html = '<script>\n  var a = 1; <!-- not a comment -->\n</script>';

    expect(stripHtmlComments(html)).toBe(html);
  });

  it('leaves a style block alone', () => {
    const html = '<style>\n  /* <!-- keep --> */\n</style>';

    expect(stripHtmlComments(html)).toBe(html);
  });

  it('strips around a script without touching it', () => {
    const html = '<!-- a --><script>var x = 1;</script><!-- b -->';

    expect(stripHtmlComments(html)).toBe('<script>var x = 1;</script>');
  });

  it('keeps conditional comments, which are markup rather than notes', () => {
    const html = '<!--[if IE]><p>old</p><![endif]-->';

    expect(stripHtmlComments(html)).toBe(html);
  });

  it('does not hang on an unterminated comment', () => {
    expect(stripHtmlComments('<p>a</p><!-- never closed')).toBe('<p>a</p><!-- never closed');
  });

  it('leaves comment-free html byte-identical', () => {
    const html = '<!doctype html>\n<html>\n  <body>hi</body>\n</html>\n';

    expect(stripHtmlComments(html)).toBe(html);
  });
});
