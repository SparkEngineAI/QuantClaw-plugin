import { describe, expect, it } from 'vitest';
import { mergeConfig } from '../src/live-config.js';
import { resolveRouteTarget } from '../src/provider.js';

describe('resolveRouteTarget', () => {
  it('falls back upward when the preferred target is missing', () => {
    const quant = mergeConfig({
      targets: {
        '4bit': { provider: '', model: '' } as any,
        '8bit': { provider: 'openai', model: 'gpt-4o' },
        '16bit': { provider: 'openai', model: 'gpt-5.4' },
      },
    });

    const resolved = resolveRouteTarget({ models: { providers: { openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', models: [{ id: 'gpt-4o' }, { id: 'gpt-5.4' }] } } } }, quant, '4bit');

    expect(resolved).not.toBeNull();
    expect(resolved?.precision).toBe('8bit');
    expect(resolved?.fallbackPath).toEqual(['4bit', '8bit']);
    expect(resolved?.target.model).toBe('gpt-4o');
  });
});
