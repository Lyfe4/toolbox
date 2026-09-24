import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { Field } from '@/components/Field';
import { Panel } from '@/components/Panel';
import { Select } from '@/components/Select';
import { TextInput } from '@/components/TextInput';
import { VisuallyHidden } from '@/components/VisuallyHidden';
import { searchTools } from '@/features/registry';
import { TOOL_CATEGORIES, type ToolCategory } from '@/features/registry/types';
import { counted } from '@/lib/plural';

import styles from './tools.module.css';

const CATEGORY_CHOICES = [
  { value: 'all', label: 'All categories' },
  ...TOOL_CATEGORIES.map((category) => ({
    value: category,
    label: category.charAt(0).toUpperCase() + category.slice(1),
  })),
];

/**
 * Every data type a direction can carry, once each, in declaration order.
 *
 * Deduplicated because the card names a DIRECTION rather than a port: base64
 * declares `text` on one output and `text` again through another, and a reader
 * scanning for "what can I wire this to" wants the set, not the multiset. The
 * separator is the one the node faces and the ports footnote already use.
 */
function portTypes(ports: readonly { readonly types: readonly string[] }[]): string {
  return [...new Set(ports.flatMap((port) => port.types))].join(' · ');
}

export function ToolsIndexPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ToolCategory | 'all'>('all');

  const results = useMemo(() => searchTools(query, category), [query, category]);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <p className={styles.eyebrow}>Tools</p>
        <h1 className={styles.title}>Every tool</h1>
        {/*
          THE PRIVACY CLAUSE CAME OFF THIS LINE when the Privacy panel landed at
          the foot of the page. It said "everything here runs in this tab -
          nothing you paste is uploaded anywhere", which is the panel's sentence
          in weaker words, on the same screen. Once is better than twice, and
          the panel is the one that can say WHY it is true.
        */}
        <p className={styles.lede}>
          The plain, keyboard-first way to run any tool on its own. This view stays available
          alongside the canvas rather than replacing it.
        </p>
      </header>

      <div className={styles.filters}>
        <Field label="Search" description="Matches names, summaries, categories and keywords.">
          {(control) => (
            <TextInput
              {...control}
              type="search"
              placeholder="base64, yaml, encode…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Category">
          {(control) => (
            <Select
              {...control}
              value={category}
              options={CATEGORY_CHOICES}
              onValueChange={(next) => {
                setCategory(next as ToolCategory | 'all');
              }}
            />
          )}
        </Field>

        {/*
          A live region, so filtering announces its result count to a screen
          reader rather than silently rewriting the list underneath them.
        */}
        <p className={styles.count} role="status" aria-live="polite" data-testid="tool-count">
          {counted(results.length, 'tool')}
        </p>
      </div>

      {results.length === 0 ? (
        <p className={styles.empty}>No tool matches &ldquo;{query}&rdquo;.</p>
      ) : (
        <ul className={styles.list}>
          {results.map((entry) => (
            <li key={entry.id}>
              {/* The whole card is one link, so it is a single tab stop. */}
              <Link to="/tools/$toolId" params={{ toolId: entry.id }} className={styles.card}>
                <span className={styles.cardHead}>
                  <span className={styles.cardName}>{entry.name}</span>
                  <span className={styles.badge}>{entry.category}</span>
                </span>
                <span className={styles.cardSummary}>{entry.summary}</span>
                {/*
                  ONE LINE PER DIRECTION, not one chip per port. A chip per port
                  is five of them on text-convert, in a wrapping row whose break
                  point is a function of the column width - so `out: json` fell
                  onto a line of its own on some cards and not others, and no
                  two cards in a row broke in the same place. The card is an
                  index entry; which particular port carries which type is the
                  tool page's Ports footnote, where there is room to say it.

                  The word is spoken rather than drawn, because `In` on its own
                  is a direction to the eye and an ambiguity to an ear.
                */}
                <span className={styles.cardPorts}>
                  <span className={styles.cardPortLine}>
                    <span className={styles.cardPortDirection} aria-hidden="true">
                      In
                    </span>
                    <VisuallyHidden>Accepts</VisuallyHidden>
                    <span className={styles.cardPortTypes}>{portTypes(entry.inputs)}</span>
                  </span>
                  <span className={styles.cardPortLine}>
                    <span className={styles.cardPortDirection} aria-hidden="true">
                      Out
                    </span>
                    <VisuallyHidden>Produces</VisuallyHidden>
                    <span className={styles.cardPortTypes}>{portTypes(entry.outputs)}</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/*
        THE PRIVACY CLAIM, ONCE, ON THE PAGE THAT LISTS EVERY TOOL.

        It used to be a panel on each of the ten tool pages - the same four
        lines of prose, ten times over - and it went from there when the tool
        page's content column needed to stop being the tallest thing on it.
        This is the page it belongs on: the claim is about the application
        rather than about any one tool, and said here it is said once.

        Each tool page keeps the claim as a clause on its Ports footer, at the
        point where somebody is about to paste a token into a text box. The
        SENTENCE is here; the reminder is there.
      */}
      <Panel title="Privacy" footer="No network access is possible from any page here">
        <p className={styles.lede}>
          Every tool on this list runs entirely in your browser. The page&rsquo;s
          Content-Security-Policy sets <code>connect-src &apos;none&apos;</code>, so the browser
          itself refuses any attempt to send your input anywhere &mdash; it is enforced, not merely
          promised.
        </p>
        {/*
          WHAT ELSE THE POLICY ADMITS, said where the claim is made. The
          policy grew two stylesheet hashes in 2026-09 (see public/_headers),
          and a privacy panel that described a policy narrower than the one
          served would be a claim that had stopped being true.
        */}
        <p className={styles.lede}>
          The same policy decides what may run and what may style the page: this site&rsquo;s own
          files, plus a handful of inline pieces allowed by their exact fingerprint &mdash; two
          start-up scripts, the text preview&rsquo;s stylesheet, the rule that hides a list&rsquo;s
          scrollbar, and an empty stylesheet. Anything else written into the page is refused.
        </p>
      </Panel>
    </div>
  );
}

export const Route = createLazyFileRoute('/tools/')({ component: ToolsIndexPage });
