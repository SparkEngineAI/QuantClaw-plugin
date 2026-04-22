import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeConfig } from '../src/live-config.js';
import { classificationCache, quantRouter } from '../src/routers/quant.js';

describe('quantRouter', () => {
  beforeEach(() => {
    classificationCache.clear();
    vi.unstubAllGlobals();
  });

  it('routes to the classified precision target', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        choices: [{ message: { content: '{"taskTypeId":"simple"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    })) as any);

    const quant = mergeConfig({
      detectors: ['loadModelDetector'],
      judge: {
        endpoint: 'http://localhost:11434',
        model: 'judge-model',
        providerType: 'openai-compatible',
        cacheTtlMs: 300000,
      },
      taskTypes: [
        { id: 'simple', precision: '4bit', description: 'tiny tasks' },
        { id: 'reasoning', precision: '16bit', description: 'hard tasks' },
      ],
      defaultTaskType: 'reasoning',
      targets: {
        '4bit': { provider: 'openai', model: 'cheap-model' },
        '8bit': { provider: 'openai', model: 'mid-model' },
        '16bit': { provider: 'openai', model: 'best-model' },
      },
    });

    const decision = await quantRouter.detect(
      { checkpoint: 'onUserMessage', message: 'say hello', sessionKey: 's1' },
      {
        quant,
        hostConfig: {
          models: {
            providers: {
              openai: {
                baseUrl: 'https://api.openai.com/v1',
                api: 'openai-completions',
                models: [{ id: 'cheap-model' }, { id: 'mid-model' }, { id: 'best-model' }],
              },
            },
          },
        },
      },
    );

    expect(decision.action).toBe('redirect');
    expect(decision.taskTypeId).toBe('simple');
    expect(decision.precision).toBe('4bit');
    expect(decision.target).toEqual({ provider: 'openai', model: 'cheap-model', displayName: undefined });
  });

  it('falls back to the default task type when judge output is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        choices: [{ message: { content: '{"taskTypeId":"unknown"}' } }],
      }),
    })) as any);

    const quant = mergeConfig({
      detectors: ['loadModelDetector'],
      judge: {
        endpoint: 'http://localhost:11434',
        model: 'judge-model',
        providerType: 'openai-compatible',
        cacheTtlMs: 300000,
      },
      taskTypes: [
        { id: 'simple', precision: '4bit', description: 'tiny tasks' },
        { id: 'standard', precision: '8bit', description: 'normal tasks' },
      ],
      defaultTaskType: 'standard',
      targets: {
        '4bit': { provider: 'openai', model: 'cheap-model' },
        '8bit': { provider: 'openai', model: 'mid-model' },
        '16bit': { provider: 'openai', model: 'best-model' },
      },
    });

    const decision = await quantRouter.detect(
      { checkpoint: 'onUserMessage', message: 'write a longer report', sessionKey: 's2' },
      {
        quant,
        hostConfig: {
          models: {
            providers: {
              openai: {
                baseUrl: 'https://api.openai.com/v1',
                api: 'openai-completions',
                models: [{ id: 'cheap-model' }, { id: 'mid-model' }, { id: 'best-model' }],
              },
            },
          },
        },
      },
    );

    expect(decision.taskTypeId).toBe('standard');
    expect(decision.precision).toBe('8bit');
    expect(decision.target?.model).toBe('mid-model');
  });

  it('uses ruleDetector keyword rules without calling the judge', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy as any);

    const quant = mergeConfig({
      detectors: ['ruleDetector'],
      taskTypes: [
        { id: 'simple', precision: '4bit', description: 'tiny tasks', keywords: ['release note', 'rewrite'] },
        { id: 'reasoning', precision: '16bit', description: 'hard tasks', keywords: ['deep debugging'] },
      ],
      defaultTaskType: 'reasoning',
      targets: {
        '4bit': { provider: 'openai', model: 'cheap-model' },
        '8bit': { provider: 'openai', model: 'mid-model' },
        '16bit': { provider: 'openai', model: 'best-model' },
      },
    });

    const decision = await quantRouter.detect(
      { checkpoint: 'onUserMessage', message: 'rewrite this release note', sessionKey: 's3' },
      { quant, hostConfig: { models: { providers: { openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', models: [{ id: 'cheap-model' }, { id: 'mid-model' }, { id: 'best-model' }] } } } } },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(decision.taskTypeId).toBe('simple');
    expect(decision.reason).toContain('keyword:release note');
  });

  it('uses ruleDetector regex patterns without calling the judge', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy as any);

    const quant = mergeConfig({
      detectors: ['ruleDetector'],
      taskTypes: [
        { id: 'simple', precision: '4bit', description: 'tiny tasks' },
        { id: 'reasoning', precision: '16bit', description: 'hard tasks', patterns: ['multi[- ]file', 'debug(ging)?'] },
      ],
      defaultTaskType: 'simple',
      targets: {
        '4bit': { provider: 'openai', model: 'cheap-model' },
        '8bit': { provider: 'openai', model: 'mid-model' },
        '16bit': { provider: 'openai', model: 'best-model' },
      },
    });

    const decision = await quantRouter.detect(
      { checkpoint: 'onUserMessage', message: 'need multi-file debugging help', sessionKey: 's4' },
      { quant, hostConfig: { models: { providers: { openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', models: [{ id: 'cheap-model' }, { id: 'mid-model' }, { id: 'best-model' }] } } } } },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(decision.taskTypeId).toBe('reasoning');
    expect(decision.reason).toContain('pattern:multi[- ]file');
  });

  it('falls through from ruleDetector to loadModelDetector when no rule matches', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        choices: [{ message: { content: '{"taskTypeId":"reasoning"}' } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchSpy as any);

    const quant = mergeConfig({
      detectors: ['ruleDetector', 'loadModelDetector'],
      judge: {
        endpoint: 'http://localhost:11434',
        model: 'judge-model',
        providerType: 'openai-compatible',
        cacheTtlMs: 300000,
      },
      taskTypes: [
        { id: 'simple', precision: '4bit', description: 'tiny tasks', keywords: ['release note'] },
        { id: 'reasoning', precision: '16bit', description: 'hard tasks', keywords: ['deep debugging'] },
      ],
      defaultTaskType: 'simple',
      targets: {
        '4bit': { provider: 'openai', model: 'cheap-model' },
        '8bit': { provider: 'openai', model: 'mid-model' },
        '16bit': { provider: 'openai', model: 'best-model' },
      },
    });

    const decision = await quantRouter.detect(
      { checkpoint: 'onUserMessage', message: 'analyse this compiler bug thoroughly', sessionKey: 's5' },
      { quant, hostConfig: { models: { providers: { openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', models: [{ id: 'cheap-model' }, { id: 'mid-model' }, { id: 'best-model' }] } } } } },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(decision.taskTypeId).toBe('reasoning');
    expect(decision.reason).toContain('detector=loadModelDetector');
  });
});
