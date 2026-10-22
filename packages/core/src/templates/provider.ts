import { seededRandom, shuffled } from './engine.js';
import type { PromptTemplate, TemplateConfig } from './model.js';

/**
 * Concept provider boundary (T1). A provider fills each prompt's slots (hook,
 * message line, ending, caption line…) for already-planned variations. The
 * deterministic TemplateProvider needs no AI and no network; an LLM adapter
 * can replace it behind the same interface later. Requests are built by one
 * whitelist function and, for remote providers, checked against the
 * installation's sensitive values before anything leaves the machine.
 */

export interface ConceptProviderDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'deterministic' | 'mock' | 'llm';
  /** True if requests leave this computer. */
  readonly remote: boolean;
}

export interface ConceptRequest {
  readonly template: {
    readonly name: string;
    readonly niche: string;
    readonly sections: ReadonlyArray<{ readonly title: string; readonly text: string }>;
    readonly slots: ReadonlyArray<{ readonly key: string; readonly label: string; readonly options: readonly string[] }>;
  };
  /** text, choice and consistency values (owner-written creative settings only). */
  readonly values: Readonly<Record<string, string>>;
  readonly items: ReadonlyArray<{ readonly position: number; readonly axes: Readonly<Record<string, string>> }>;
  readonly seed: string;
}

export interface ConceptResponse {
  readonly items: ReadonlyArray<{ readonly position: number; readonly slots: Readonly<Record<string, string>> }>;
}

export type ConceptProviderError = 'refused' | 'unavailable' | 'invalid_output' | 'unsafe_payload';

export interface ConceptProvider {
  readonly descriptor: ConceptProviderDescriptor;
  fill(request: ConceptRequest): Promise<ConceptResponse | { error: ConceptProviderError }>;
}

/** The only way a provider request is built: template text, the owner's creative values, planned axes. Nothing about the account. */
export function buildConceptRequest(
  t: PromptTemplate,
  config: TemplateConfig,
  items: ReadonlyArray<{ position: number; axes: Readonly<Record<string, string>> }>,
  seed: string,
): ConceptRequest {
  return {
    template: {
      name: t.name,
      niche: t.niche,
      sections: t.sections.map((s) => ({ title: s.title, text: s.text })),
      slots: t.slots.map((s) => ({ key: s.key, label: s.label, options: [...s.options] })),
    },
    values: { ...config.values },
    items: items.map((i) => ({ position: i.position, axes: { ...i.axes } })),
    seed,
  };
}

/** True if the serialized request contains none of the sensitive values (case-insensitive, values of 4+ characters). */
export function payloadIsSafe(request: ConceptRequest, sensitive: readonly string[]): boolean {
  const body = JSON.stringify(request).toLowerCase();
  return !sensitive.some((s) => s.trim().length >= 4 && body.includes(s.trim().toLowerCase()));
}

const URL_LIKE = /(https?:\/\/|www\.)/i;
const HANDLE = /(^|\s)@[a-z0-9._]{2,}/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Provider output is untrusted: every requested position once, every slot filled with plain text. */
export function validateConceptResponse(request: ConceptRequest, response: unknown): response is ConceptResponse {
  if (typeof response !== 'object' || response === null || !Array.isArray((response as ConceptResponse).items)) return false;
  const items = (response as ConceptResponse).items;
  const wanted = request.items.map((i) => i.position).sort((a, b) => a - b);
  const got = items.map((i) => i?.position).sort((a, b) => (a as number) - (b as number));
  if (wanted.length !== got.length || wanted.some((p, i) => p !== got[i])) return false;
  const keys = request.template.slots.map((s) => s.key);
  return items.every(
    (i) =>
      typeof i.slots === 'object' &&
      i.slots !== null &&
      Object.keys(i.slots).length === keys.length &&
      keys.every((k) => {
        const v = i.slots[k];
        return typeof v === 'string' && v.trim().length > 0 && v.length <= 600 && !URL_LIKE.test(v) && !HANDLE.test(v) && !CONTROL.test(v) && !v.includes('{{');
      }),
  );
}

/** Deterministic, offline provider: rotates each slot's options in a seeded order so neighbouring prompts differ. */
export class TemplateProvider implements ConceptProvider {
  readonly descriptor: ConceptProviderDescriptor = { id: 'template', displayName: 'Template engine (no AI, offline)', kind: 'deterministic', remote: false };

  async fill(request: ConceptRequest): Promise<ConceptResponse> {
    const orders = request.template.slots.map((s) => shuffled(s.options, seededRandom(`${request.seed}:${s.key}`)));
    return {
      items: request.items.map((item, i) => ({
        position: item.position,
        slots: Object.fromEntries(request.template.slots.map((s, k) => [s.key, orders[k]![(i + k) % orders[k]!.length]!])),
      })),
    };
  }
}
