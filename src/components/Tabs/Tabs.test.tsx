import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Tab, TabList, TabPanel, Tabs } from './Tabs';

function Example() {
  return (
    <Tabs defaultValue="input">
      <TabList aria-label="Tool sections">
        <Tab value="input">Input</Tab>
        <Tab value="output">Output</Tab>
        <Tab value="about">About</Tab>
      </TabList>
      <TabPanel value="input">Input panel</TabPanel>
      <TabPanel value="output">Output panel</TabPanel>
      <TabPanel value="about">About panel</TabPanel>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('shows only the selected panel', () => {
    render(<Example />);
    expect(screen.getByRole('tab', { name: 'Input' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Input panel')).toBeInTheDocument();
    expect(screen.queryByText('Output panel')).not.toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys, per the WAI-ARIA pattern', async () => {
    const user = userEvent.setup();
    render(<Example />);

    await user.tab();
    expect(screen.getByRole('tab', { name: 'Input' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Output' })).toHaveFocus();
    expect(screen.getByText('Output panel')).toBeInTheDocument();

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'About' })).toHaveFocus();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Example />);
    await expectNoAxeViolations(container);
  });
});
