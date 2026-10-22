import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, looksLikeMp4, needsUser, validateCreativeInput } from '../src/index.js';

describe('creative settings', () => {
  it('accepts a prompt with valid settings and trims it', () => {
    expect(validateCreativeInput({ prompt: '  A calm kitchen scene  ', settings: { aspectRatio: '9:16', durationSeconds: 8, quality: 'fast' } })).toEqual({
      ok: true,
      value: { prompt: 'A calm kitchen scene', settings: { aspectRatio: '9:16', durationSeconds: 8, quality: 'fast' } },
    });
    expect(validateCreativeInput({ prompt: 'line one\nline two', settings: { aspectRatio: '1:1', durationSeconds: 30, quality: 'quality' } }).ok).toBe(true);
  });

  it('reports every invalid field', () => {
    expect(validateCreativeInput({ prompt: '', settings: { aspectRatio: '4:3', durationSeconds: 1.5, quality: 'max' } })).toEqual({
      ok: false,
      issues: ['invalid_prompt', 'invalid_aspect_ratio', 'invalid_duration', 'invalid_quality'],
    });
    expect(validateCreativeInput({ prompt: 'x'.repeat(4001), settings: null })).toMatchObject({ ok: false });
  });
});

describe('job lifecycle', () => {
  it('only moves forward; finished jobs never change', () => {
    expect(canTransition('pending', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'waiting_for_user')).toBe(true);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('failed', 'pending')).toBe(false);
    expect(canTransition('waiting_for_user', 'running')).toBe(false);
    expect(['completed', 'waiting_for_user', 'failed'].every((s) => isTerminal(s as 'failed'))).toBe(true);
  });

  it('challenges, sign-in, quota, rate limits and interface changes need the owner', () => {
    for (const c of ['challenge_required', 'auth_required', 'quota_exhausted', 'rate_limited', 'interface_changed'] as const) expect(needsUser(c)).toBe(true);
    for (const c of ['transient', 'output_invalid', 'policy_rejected', 'cancelled'] as const) expect(needsUser(c)).toBe(false);
  });

  it('recognizes an MP4 by its ftyp box', () => {
    const mp4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...new Array(20).fill(0)]);
    expect(looksLikeMp4(mp4)).toBe(true);
    expect(looksLikeMp4(new TextEncoder().encode('<html>not a video</html>'))).toBe(false);
    expect(looksLikeMp4(new Uint8Array(4))).toBe(false);
  });
});
