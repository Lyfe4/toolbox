import { createLazyFileRoute } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';

import {
  Button,
  CopyIcon,
  Field,
  IconButton,
  Panel,
  Select,
  SignalIcon,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextArea,
  TextInput,
  Toggle,
  Tooltip,
  useToast,
} from '@/components';
import { ThemeSwitcher, useTheme } from '@/features/theme';
import { contrastRatioHex } from '@/lib/color';
import { cx } from '@/lib/cx';

import styles from './styleguide.module.css';

/* ------------------------------------------------------------------------ *
 * Token inventories
 *
 * Listed by hand rather than parsed, because this page is documentation: what
 * appears here is a deliberate statement of the system's public surface.
 * ------------------------------------------------------------------------ */

interface TokenGroup {
  readonly title: string;
  readonly tokens: readonly string[];
}

const SEMANTIC_GROUPS: readonly TokenGroup[] = [
  {
    title: 'Surface',
    tokens: [
      '--pb-surface-sunken',
      '--pb-surface-base',
      '--pb-surface-raised',
      '--pb-surface-overlay',
      '--pb-surface-inset',
    ],
  },
  {
    title: 'Ink',
    tokens: [
      '--pb-ink-primary',
      '--pb-ink-secondary',
      '--pb-ink-muted',
      '--pb-ink-disabled',
      '--pb-ink-accent',
      '--pb-ink-on-accent',
      '--pb-ink-inverse',
    ],
  },
  {
    title: 'Border',
    tokens: [
      '--pb-border-subtle',
      '--pb-border-hairline',
      '--pb-border-strong',
      '--pb-border-accent',
    ],
  },
  {
    title: 'Accent',
    tokens: ['--pb-accent', '--pb-accent-hover', '--pb-accent-active', '--pb-accent-subtle'],
  },
  {
    title: 'Control',
    tokens: [
      '--pb-control-surface',
      '--pb-control-surface-hover',
      '--pb-control-surface-active',
      '--pb-control-surface-disabled',
      '--pb-control-border',
      '--pb-control-border-hover',
    ],
  },
  {
    title: 'Signal',
    tokens: [
      '--pb-signal-ok',
      '--pb-signal-ok-surface',
      '--pb-signal-warn',
      '--pb-signal-warn-surface',
      '--pb-signal-error',
      '--pb-signal-error-surface',
      '--pb-signal-on-surface',
    ],
  },
  {
    title: 'Focus and selection',
    tokens: ['--pb-focus-ring', '--pb-selection-surface', '--pb-selection-ink'],
  },
];

interface Ramp {
  readonly name: string;
  readonly steps: readonly string[];
}

const RAMPS: readonly Ramp[] = [
  {
    name: 'Grey',
    steps: [
      '--raw-grey-1000',
      '--raw-grey-950',
      '--raw-grey-900',
      '--raw-grey-850',
      '--raw-grey-800',
      '--raw-grey-750',
      '--raw-grey-700',
      '--raw-grey-600',
      '--raw-grey-500',
      '--raw-grey-450',
      '--raw-grey-400',
      '--raw-grey-300',
      '--raw-grey-200',
      '--raw-grey-100',
      '--raw-grey-50',
    ],
  },
  {
    name: 'Paper',
    steps: [
      '--raw-paper-900',
      '--raw-paper-800',
      '--raw-paper-700',
      '--raw-paper-600',
      '--raw-paper-500',
      '--raw-paper-450',
      '--raw-paper-400',
      '--raw-paper-300',
      '--raw-paper-200',
      '--raw-paper-150',
      '--raw-paper-100',
      '--raw-paper-50',
    ],
  },
  {
    name: 'Navy',
    steps: [
      '--raw-navy-950',
      '--raw-navy-900',
      '--raw-navy-850',
      '--raw-navy-800',
      '--raw-navy-700',
      '--raw-navy-600',
      '--raw-navy-500',
      '--raw-navy-450',
      '--raw-navy-400',
      '--raw-navy-300',
      '--raw-navy-200',
      '--raw-navy-100',
    ],
  },
  {
    name: 'Phosphor',
    steps: [
      '--raw-phos-950',
      '--raw-phos-900',
      '--raw-phos-850',
      '--raw-phos-800',
      '--raw-phos-700',
      '--raw-phos-600',
      '--raw-phos-500',
      '--raw-phos-450',
      '--raw-phos-400',
      '--raw-phos-300',
      '--raw-phos-200',
      '--raw-phos-100',
    ],
  },
  {
    name: 'Amber',
    steps: [
      '--raw-amber-800',
      '--raw-amber-700',
      '--raw-amber-600',
      '--raw-amber-500',
      '--raw-amber-400',
      '--raw-amber-300',
      '--raw-amber-200',
    ],
  },
  {
    name: 'Vermilion',
    steps: [
      '--raw-vermilion-800',
      '--raw-vermilion-700',
      '--raw-vermilion-600',
      '--raw-vermilion-500',
      '--raw-vermilion-400',
      '--raw-vermilion-300',
    ],
  },
  {
    name: 'Cyan',
    steps: [
      '--raw-cyan-700',
      '--raw-cyan-600',
      '--raw-cyan-500',
      '--raw-cyan-400',
      '--raw-cyan-300',
      '--raw-cyan-200',
    ],
  },
  {
    name: 'Green',
    steps: [
      '--raw-green-700',
      '--raw-green-600',
      '--raw-green-500',
      '--raw-green-400',
      '--raw-green-300',
      '--raw-green-200',
    ],
  },
  {
    name: 'Yellow',
    steps: [
      '--raw-yellow-700',
      '--raw-yellow-600',
      '--raw-yellow-500',
      '--raw-yellow-400',
      '--raw-yellow-300',
      '--raw-yellow-200',
    ],
  },
  {
    name: 'Red',
    steps: [
      '--raw-red-700',
      '--raw-red-600',
      '--raw-red-500',
      '--raw-red-400',
      '--raw-red-300',
      '--raw-red-200',
    ],
  },
];

const SPACE_SCALE = [
  '--pb-space-hairline',
  '--pb-space-2xs',
  '--pb-space-xs',
  '--pb-space-sm',
  '--pb-space-md',
  '--pb-space-lg',
  '--pb-space-xl',
  '--pb-space-2xl',
  '--pb-space-3xl',
  '--pb-space-4xl',
];

const TYPE_SCALE = [
  '--pb-label-size',
  '--pb-value-size',
  '--pb-body-size',
  '--pb-heading-size',
  '--pb-display-size',
];

const RADIUS_SCALE = ['--pb-radius-control', '--pb-radius-panel'];
const MOTION_SCALE = ['--pb-motion-fast', '--pb-motion-base', '--pb-motion-slow'];

/** Pairs shown in the live contrast readout, with their WCAG AA threshold. */
const CONTRAST_CHECKS: readonly (readonly [string, string, string, number])[] = [
  ['Body text', '--pb-ink-primary', '--pb-surface-base', 4.5],
  ['Muted text', '--pb-ink-muted', '--pb-surface-base', 4.5],
  ['On accent', '--pb-ink-on-accent', '--pb-accent', 4.5],
  ['Hairline', '--pb-border-hairline', '--pb-surface-base', 3],
  ['Control edge', '--pb-control-border', '--pb-control-surface', 3],
  ['Focus ring', '--pb-focus-ring', '--pb-surface-base', 3],
];

const ALL_TOKENS: readonly string[] = [
  ...SEMANTIC_GROUPS.flatMap((group) => group.tokens),
  ...RAMPS.flatMap((ramp) => ramp.steps),
  ...SPACE_SCALE,
  ...TYPE_SCALE,
  ...RADIUS_SCALE,
  ...MOTION_SCALE,
];

/* ------------------------------------------------------------------------ */

/** Reads the live computed value of every token off <html>. */
function readTokens(): Readonly<Record<string, string>> {
  const computed = getComputedStyle(document.documentElement);
  const next: Record<string, string> = {};
  for (const token of ALL_TOKENS) next[token] = computed.getPropertyValue(token).trim();
  return next;
}

/**
 * Keeps the readout in step with whatever the stylesheet is currently
 * producing, so this page can never claim a colour the CSS does not.
 *
 * The first read happens in useState's lazy initialiser. Updates come from a
 * MutationObserver watching <html> rather than from the theme store, because
 * the observer fires after the attribute has actually changed - it does not
 * depend on which subscriber the store happens to call first.
 */
function useComputedTokens(): Readonly<Record<string, string>> {
  const [values, setValues] = useState(readTokens);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setValues(readTokens());
    });
    // `style` as well as `data-theme`: a custom theme applies its overrides as
    // inline custom properties on the same element.
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    return () => {
      observer.disconnect();
    };
  }, []);

  return values;
}

/** Contrast ratio, or null when a value has not been read yet. */
function safeContrast(
  foreground: string | undefined,
  background: string | undefined,
): number | null {
  if (foreground === undefined || background === undefined) return null;
  try {
    return contrastRatioHex(foreground, background);
  } catch {
    return null;
  }
}

function Section({
  title,
  children,
  note,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly note?: string;
}) {
  return (
    <section className={styles.section} aria-labelledby={`section-${title}`}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle} id={`section-${title}`}>
          {title}
        </h2>
        <span className={styles.sectionRule} aria-hidden="true" />
      </div>
      {note !== undefined ? <p className={styles.note}>{note}</p> : null}
      {children}
    </section>
  );
}

function Specimen({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className={styles.specimen}>
      <span className={styles.specimenLabel}>{label}</span>
      <div className={styles.specimenBody}>{children}</div>
    </div>
  );
}

function Swatch({ token, value }: { readonly token: string; readonly value: string }) {
  return (
    <div className={styles.swatch}>
      {/*
        Inline style, not a class: the colour is data read from the document at
        runtime, so there is no class name that could express it. React writes
        this through the CSSOM, which CSP does not police.
      */}
      <span className={styles.swatchChip} style={{ backgroundColor: value }} aria-hidden="true" />
      <span className={styles.swatchText}>
        <span className={styles.swatchName}>{token.replace('--pb-', '')}</span>
        <span className={styles.swatchValue}>{value || '-'}</span>
      </span>
    </div>
  );
}

function ToastDemo() {
  const { notify } = useToast();

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          notify({
            title: 'Encoded',
            description: '1.2 kB written to the output port.',
            tone: 'ok',
          });
        }}
      >
        Success
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          notify({ title: 'Truncated', description: 'Input exceeded 1 MB.', tone: 'warn' });
        }}
      >
        Warning
      </Button>
      <Button
        size="sm"
        variant="danger"
        onClick={() => {
          notify({ title: 'Decode failed', description: 'Not valid base64.', tone: 'error' });
        }}
      >
        Error
      </Button>
    </>
  );
}

const ENCODINGS = [
  { value: 'hex', label: 'Hexadecimal' },
  { value: 'base64', label: 'Base64' },
  { value: 'base64url', label: 'Base64 (URL safe)' },
  { value: 'binary', label: 'Binary' },
];

export function StyleguidePage() {
  const { activePreset } = useTheme();
  const tokens = useComputedTokens();

  const [text, setText] = useState('SGVsbG8sIHBhdGNoYmF5');
  const [encoding, setEncoding] = useState('base64');
  const [monitor, setMonitor] = useState(true);

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <header className={styles.head}>
          <p className={styles.eyebrow}>Reference</p>
          <h1 className={styles.pageTitle}>Styleguide</h1>
          <p className={styles.pageLede}>
            Every token and every primitive Patchbay is built from. The palette values below are
            read out of the live document, so they are whatever the stylesheet actually produces for
            the theme you have selected &mdash; including the measured contrast ratios.
          </p>
        </header>

        <Section
          title="Themes"
          note="Four presets. Switching one swaps only the semantic colour layer; every component keeps describing intent and picks up the change for free."
        >
          <div className={styles.specimens}>
            <Specimen label="Active">
              <div className={styles.specimenStack}>
                <strong className={styles.swatchName}>{activePreset.label}</strong>
                <span className={styles.hint}>{activePreset.description}</span>
              </div>
            </Specimen>
            <Specimen label="Contrast">
              <div className={styles.specimenStack}>
                {CONTRAST_CHECKS.map(([label, fg, bg, threshold]) => {
                  const ratio = safeContrast(tokens[fg], tokens[bg]);
                  const passes = ratio !== null && ratio >= threshold;
                  return (
                    <span className={styles.readoutRow} key={label}>
                      <span>{label}</span>
                      <span className={cx(styles.readoutValue, passes ? styles.pass : styles.fail)}>
                        {ratio === null ? '-' : `${ratio.toFixed(2)}:1`}
                        {' / '}
                        {threshold.toFixed(1)}
                      </span>
                    </span>
                  );
                })}
              </div>
            </Specimen>
          </div>
        </Section>

        <Section
          title="Semantic colour"
          note="Layer 2. These are the only colour tokens a component may name."
        >
          {SEMANTIC_GROUPS.map((group) => (
            <div className={styles.ramp} key={group.title}>
              <span className={styles.rampName}>{group.title}</span>
              <div className={styles.swatchGrid}>
                {group.tokens.map((token) => (
                  <Swatch key={token} token={token} value={tokens[token] ?? ''} />
                ))}
              </div>
            </div>
          ))}
        </Section>

        <Section
          title="Primitive ramps"
          note="Layer 1. Theme-invariant raw scales. Components never reference these; the semantic layer does."
        >
          {RAMPS.map((ramp) => (
            <div className={styles.ramp} key={ramp.name}>
              <span className={styles.rampName}>{ramp.name}</span>
              <div className={styles.rampSteps}>
                {ramp.steps.map((step) => (
                  <span
                    key={step}
                    className={styles.rampStep}
                    style={{ backgroundColor: tokens[step] ?? 'transparent' }}
                    title={`${step.replace('--raw-', '')} ${tokens[step] ?? ''}`}
                  />
                ))}
              </div>
            </div>
          ))}
        </Section>

        <Section
          title="Type"
          note="IBM Plex Mono carries the interface. Archivo is for prose only."
        >
          <div className={styles.ramp}>
            {TYPE_SCALE.map((token) => (
              <div className={styles.scaleRow} key={token}>
                <span className={styles.scaleName}>{token.replace('--pb-', '')}</span>
                <span className={styles.scaleValue}>{tokens[token] ?? '-'}</span>
                <span className={styles.typeSample} style={{ fontSize: tokens[token] }}>
                  Patchbay 0123456789
                </span>
              </div>
            ))}
          </div>
          <p className={styles.proseSample}>
            Archivo handles running prose like this paragraph, where a monospace face would slow
            reading down. Everything else &mdash; labels, readouts, values, code &mdash; stays
            monospace, because alignment is what makes a dense panel legible.
          </p>
        </Section>

        <Section title="Space" note="An 8px baseline grid, exposed by role rather than by number.">
          <div className={styles.ramp}>
            {SPACE_SCALE.map((token) => (
              <div className={styles.scaleRow} key={token}>
                <span className={styles.scaleName}>{token.replace('--pb-space-', '')}</span>
                <span className={styles.scaleValue}>{tokens[token] ?? '-'}</span>
                <span className={styles.scaleBar} style={{ inlineSize: tokens[token] }} />
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Radius and motion"
          note="2px is the ceiling. Transitions are 120-180ms on a sharp curve."
        >
          <div className={styles.ramp}>
            {RADIUS_SCALE.map((token) => (
              <div className={styles.scaleRow} key={token}>
                <span className={styles.scaleName}>{token.replace('--pb-radius-', '')}</span>
                <span className={styles.scaleValue}>{tokens[token] ?? '-'}</span>
                <span className={styles.radiusSample} style={{ borderRadius: tokens[token] }} />
              </div>
            ))}
            {MOTION_SCALE.map((token) => (
              <div className={styles.scaleRow} key={token}>
                <span className={styles.scaleName}>{token.replace('--pb-motion-', '')}</span>
                <span className={styles.scaleValue}>{tokens[token] ?? '-'}</span>
                <span className={styles.hint}>Collapses to 1ms under prefers-reduced-motion</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Button"
          note="Three variants, two sizes. Hover, focus and active are shown forced as well as live, so the whole state machine is visible at once."
        >
          <div className={styles.specimens}>
            <Specimen label="Primary">
              <Button>Default</Button>
              <Button data-force="hover">Hover</Button>
              <Button data-force="focus">Focus</Button>
              <Button data-force="active">Active</Button>
              <Button disabled>Disabled</Button>
            </Specimen>
            <Specimen label="Ghost">
              <Button variant="ghost">Default</Button>
              <Button variant="ghost" data-force="hover">
                Hover
              </Button>
              <Button variant="ghost" data-force="focus">
                Focus
              </Button>
              <Button variant="ghost" data-force="active">
                Active
              </Button>
              <Button variant="ghost" disabled>
                Disabled
              </Button>
            </Specimen>
            <Specimen label="Danger">
              <Button variant="danger">Default</Button>
              <Button variant="danger" data-force="hover">
                Hover
              </Button>
              <Button variant="danger" data-force="focus">
                Focus
              </Button>
              <Button variant="danger" disabled>
                Disabled
              </Button>
            </Specimen>
            <Specimen label="Small">
              <Button size="sm">Primary</Button>
              <Button size="sm" variant="ghost">
                Ghost
              </Button>
              <Button size="sm" variant="danger">
                Danger
              </Button>
            </Specimen>
          </div>
        </Section>

        <Section
          title="Icon button"
          note="The accessible label is a required prop, so a nameless icon button will not compile."
        >
          <div className={styles.specimens}>
            <Specimen label="States">
              <IconButton label="Copy output" icon={<CopyIcon />} />
              <IconButton label="Copy output, hovered" icon={<CopyIcon />} data-force="hover" />
              <IconButton label="Copy output, focused" icon={<CopyIcon />} data-force="focus" />
              <IconButton label="Copy output, disabled" icon={<CopyIcon />} disabled />
              <IconButton label="Copy output, small" icon={<CopyIcon size={12} />} size="sm" />
            </Specimen>
          </div>
        </Section>

        <Section
          title="Panel"
          note="The module chassis: hairline border, optional title bar, optional footer."
        >
          <div className={styles.stateGrid}>
            <Panel title="Encoder" style={{ inlineSize: '260px' }}>
              <p className={styles.hint}>Body content sits on the 8px grid.</p>
            </Panel>
            <Panel
              title="Signal"
              style={{ inlineSize: '260px' }}
              actions={
                <IconButton label="Panel options" size="sm" icon={<SignalIcon size={12} />} />
              }
              footer="Ready / 0 errors"
            >
              <p className={styles.hint}>With actions and a footer.</p>
            </Panel>
            <Panel style={{ inlineSize: '200px' }}>
              <p className={styles.hint}>No title bar.</p>
            </Panel>
          </div>
        </Section>

        <Section
          title="Field and inputs"
          note="Field owns the ids: label, description and error are wired to the control with htmlFor, aria-describedby and aria-invalid."
        >
          <div className={styles.specimens}>
            <Specimen label="Default">
              <div className={styles.specimenStack}>
                <Field label="Input" description="Anything you paste stays in this tab.">
                  {(control) => (
                    <TextInput
                      {...control}
                      value={text}
                      onChange={(event) => {
                        setText(event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>
            </Specimen>
            <Specimen label="Error">
              <div className={styles.specimenStack}>
                <Field label="Payload" error="Not valid base64" required>
                  {(control) => <TextInput {...control} defaultValue="not base64!" />}
                </Field>
              </div>
            </Specimen>
            <Specimen label="Disabled">
              <div className={styles.specimenStack}>
                <Field label="Locked" description="Read only in this mode.">
                  {(control) => <TextInput {...control} value="0x00" disabled readOnly />}
                </Field>
              </div>
            </Specimen>
            <Specimen label="Textarea">
              <div className={styles.specimenStack}>
                <Field label="Multi-line">
                  {(control) => <TextArea {...control} defaultValue={'one\ntwo\nthree'} />}
                </Field>
              </div>
            </Specimen>
            <Specimen label="Select">
              <div className={styles.specimenStack}>
                <Field label="Encoding" description="Radix Select, styled with our tokens.">
                  {(control) => (
                    <Select
                      {...control}
                      value={encoding}
                      onValueChange={setEncoding}
                      options={ENCODINGS}
                    />
                  )}
                </Field>
              </div>
            </Specimen>
          </div>
        </Section>

        <Section
          title="Toggle"
          note="A real button with role=switch, so Space and Enter work without any key handling of our own."
        >
          <div className={styles.specimens}>
            <Specimen label="States">
              <Toggle checked={monitor} label="Monitor" onCheckedChange={setMonitor} />
              <Toggle checked label="On" onCheckedChange={() => undefined} />
              <Toggle checked={false} label="Off" onCheckedChange={() => undefined} />
              <Toggle checked={false} label="Disabled" disabled onCheckedChange={() => undefined} />
            </Specimen>
          </div>
        </Section>

        <Section
          title="Tabs"
          note="Arrow keys move between tabs, Home and End jump to the ends, per the WAI-ARIA pattern."
        >
          <Tabs defaultValue="input">
            <TabList aria-label="Styleguide tab example">
              <Tab value="input">Input</Tab>
              <Tab value="output">Output</Tab>
              <Tab value="about" disabled>
                Disabled
              </Tab>
            </TabList>
            <TabPanel value="input">
              <p className={styles.hint}>The active tab is marked by a 2px accent rule.</p>
            </TabPanel>
            <TabPanel value="output">
              <p className={styles.hint}>Second panel.</p>
            </TabPanel>
          </Tabs>
        </Section>

        <Section
          title="Tooltip"
          note="Opens on keyboard focus as well as hover, and closes on Escape. Never the only label on a control."
        >
          <div className={styles.specimens}>
            <Specimen label="Trigger">
              <Tooltip content="Copies the output to the clipboard">
                <Button variant="ghost">Focus or hover me</Button>
              </Tooltip>
              <Tooltip content="Tooltips work on icon buttons too" side="right">
                <IconButton label="Copy output" icon={<CopyIcon />} />
              </Tooltip>
            </Specimen>
          </div>
        </Section>

        <Section
          title="Toast"
          note="A live region that exists before any message does, so screen readers actually announce what arrives in it."
        >
          <div className={styles.specimens}>
            <Specimen label="Tones">
              <ToastDemo />
            </Specimen>
          </div>
        </Section>
      </div>

      <aside className={styles.sidebar} aria-label="Theme controls">
        <Panel title="Theme">
          <ThemeSwitcher legend="Preset" />
        </Panel>
      </aside>
    </div>
  );
}

export const Route = createLazyFileRoute('/styleguide')({ component: StyleguidePage });
