import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

export const jwtOptionsSchema = z.object({
  /**
   * The shared secret (HS*) or public key in PEM form (RS*, PS*, ES*).
   *
   * Listed in the tool's `secretOptionKeys`, so it is stripped out of a share
   * link. Options normally travel in a link; a signing key must not.
   */
  key: z.string().max(8_192).default(''),
  keyEncoding: z.enum(['utf8', 'base64url', 'pem']).default('utf8'),
  /** Seconds of slack allowed on exp/nbf, for clock skew between machines. */
  clockToleranceSec: z.number().int().min(0).max(3_600).default(0),
});

export type JwtOptions = z.output<typeof jwtOptionsSchema>;

export const jwtDefaultOptions: JwtOptions = jwtOptionsSchema.parse({});

export const jwtOptionFields: readonly OptionField<JwtOptions>[] = [
  {
    key: 'key',
    label: 'Key',
    description:
      'The HMAC secret, or a PEM public key. Leave empty to decode without verifying. Never included in a share link.',
    control: 'text',
    multiline: true,
    placeholder: 'shared secret, or -----BEGIN PUBLIC KEY-----',
  },
  {
    key: 'keyEncoding',
    label: 'Secret encoding',
    description: 'How to read an HMAC secret. PEM keys are detected automatically.',
    control: 'select',
    choices: [
      { value: 'utf8', label: 'Plain text' },
      { value: 'base64url', label: 'Base64' },
      { value: 'pem', label: 'PEM' },
    ],
  },
  {
    key: 'clockToleranceSec',
    label: 'Clock tolerance (seconds)',
    description: 'Slack allowed on exp and nbf, for clock drift between machines.',
    control: 'number',
    min: 0,
    max: 3_600,
    step: 30,
  },
];
