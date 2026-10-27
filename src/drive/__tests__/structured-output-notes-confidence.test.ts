// Pins the GUB#157-notes-confidence contract: the distillation response
// schema must require a `confidence` field on every note item, exactly as
// it already does on field_change items — otherwise Gemini's structured
// output has no reason to produce one, and GUB's confidence-gated
// auto-approve sweep (gcp-universal-backend#157) has nothing to read.
import { describe, expect, it, vi } from 'vitest';

// config.ts validates the environment on import; structured-output.ts pulls
// in the ai module, which pulls in config.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
});

import { SchemaType } from '../../ai';
import { distillationResponseSchema } from '../structured-output';

describe('distillationResponseSchema', () => {
  it('requires confidence on every note item, not only on field_change items', () => {
    const schema = distillationResponseSchema('account');
    const noteItemSchema = schema.properties!['notes']!.items!;
    const fieldChangeItemSchema = schema.properties!['field_changes']!.items!;

    expect(noteItemSchema.required).toContain('confidence');
    expect(noteItemSchema.properties!['confidence']).toMatchObject({ type: SchemaType.NUMBER });
    // Same scale/shape as field_changes' confidence, so a reviewer or an
    // auto-approve gate never has to special-case one kind against the other.
    expect(noteItemSchema.properties!['confidence']!.type).toEqual(
      fieldChangeItemSchema.properties!['confidence']!.type,
    );
  });

  it('also requires it on the campaign-entity variant', () => {
    const schema = distillationResponseSchema('campaign');
    expect(schema.properties!['notes']!.items!.required).toContain('confidence');
  });
});
