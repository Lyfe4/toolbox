import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TextInput } from '@/components/TextInput';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Field } from './Field';

describe('Field', () => {
  it('associates the label with the control', () => {
    render(<Field label="Input text">{(control) => <TextInput {...control} />}</Field>);
    expect(screen.getByLabelText('Input text')).toBeInTheDocument();
  });

  it('describes the control with the hint text', () => {
    render(
      <Field label="Input text" description="UTF-8 only">
        {(control) => <TextInput {...control} />}
      </Field>,
    );
    expect(screen.getByLabelText('Input text')).toHaveAccessibleDescription('UTF-8 only');
  });

  it('marks the control invalid and announces the error', () => {
    render(
      <Field label="Input text" error="Not valid base64">
        {(control) => <TextInput {...control} />}
      </Field>,
    );

    const input = screen.getByLabelText('Input text');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Not valid base64');
    expect(screen.getByRole('alert')).toHaveTextContent('Not valid base64');
  });

  it('sets no aria-describedby when there is nothing to describe', () => {
    render(<Field label="Input text">{(control) => <TextInput {...control} />}</Field>);
    expect(screen.getByLabelText('Input text')).not.toHaveAttribute('aria-describedby');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <Field label="Plain" description="A hint">
          {(control) => <TextInput {...control} />}
        </Field>
        <Field label="Broken" error="Bad value" required>
          {(control) => <TextInput {...control} />}
        </Field>
      </>,
    );
    await expectNoAxeViolations(container);
  });
});
