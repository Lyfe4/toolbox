import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { Field } from '@/components/Field';
import { Select } from '@/components/Select';
import { TextInput } from '@/components/TextInput';
import { VisuallyHidden } from '@/components/VisuallyHidden';
import { searchTools } from '@/features/registry';
import { TOOL_CATEGORIES, type ToolCategory } from '@/features/registry/types';

import styles from './tools.module.css';

const CATEGORY_CHOICES = [
  { value: 'all', label: 'All categories' },
  ...TOOL_CATEGORIES.map((category) => ({
    value: category,
    label: category.charAt(0).toUpperCase() + category.slice(1),
  })),
];

export function ToolsIndexPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ToolCategory | 'all'>('all');

  const results = useMemo(() => searchTools(query, category), [query, category]);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <p className={styles.eyebrow}>Tools</p>
        <h1 className={styles.title}>Every tool</h1>
        <p className={styles.lede}>
          The plain, keyboard-first way to run any tool on its own. This view stays available
          alongside the canvas, and everything here runs in this tab &mdash; nothing you paste is
          uploaded anywhere.
        </p>
      </header>

      <div className={styles.filters}>
        <Field label="Search" description="Matches names, summaries and keywords.">
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
        <p className={styles.count} role="status" aria-live="polite">
          {results.length} {results.length === 1 ? 'tool' : 'tools'}
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
                <span className={styles.cardPorts}>
                  <VisuallyHidden>Accepts</VisuallyHidden>
                  {entry.inputs.map((input) => (
                    <span key={input.id} className={styles.badge}>
                      in: {input.types.join('/')}
                    </span>
                  ))}
                  <VisuallyHidden>Produces</VisuallyHidden>
                  {entry.outputs.map((output) => (
                    <span key={output.id} className={styles.badge}>
                      out: {output.types.join('/')}
                    </span>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const Route = createLazyFileRoute('/tools/')({ component: ToolsIndexPage });
