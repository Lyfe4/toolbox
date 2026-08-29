import * as RadixTabs from '@radix-ui/react-tabs';

import { cx } from '@/lib/cx';

import styles from './Tabs.module.css';

import type { ComponentPropsWithRef } from 'react';

/**
 * Tabs built on Radix Tabs.
 *
 * The WAI-ARIA tabs pattern is more than role attributes: arrow keys move
 * between tabs, Home/End jump to the ends, only the active tab is in the tab
 * order, and focus has to be managed manually as it moves. Radix implements
 * that; these wrappers add nothing but class names, so the behaviour stays the
 * audited one.
 */
export type TabsProps = ComponentPropsWithRef<typeof RadixTabs.Root>;
export type TabListProps = ComponentPropsWithRef<typeof RadixTabs.List>;
export type TabProps = ComponentPropsWithRef<typeof RadixTabs.Trigger>;
export type TabPanelProps = ComponentPropsWithRef<typeof RadixTabs.Content>;

export function Tabs({ className, ...rest }: TabsProps) {
  return <RadixTabs.Root className={className} {...rest} />;
}

export function TabList({ className, ...rest }: TabListProps) {
  return <RadixTabs.List className={cx(styles.list, className)} {...rest} />;
}

export function Tab({ className, ...rest }: TabProps) {
  return <RadixTabs.Trigger className={cx(styles.tab, className)} {...rest} />;
}

export function TabPanel({ className, ...rest }: TabPanelProps) {
  return <RadixTabs.Content className={cx(styles.panel, className)} {...rest} />;
}
