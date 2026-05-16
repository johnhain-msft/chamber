import { describe, it, expectTypeOf } from 'vitest';
import type {
  CanvasPresentation,
  CanvasPresentationStep,
  CanvasPresentationTransition,
  CanvasPresentationTransitionKind,
  CanvasShowInput,
  CanvasUpdateInput,
} from './types';

/**
 * Type-level contract for the presentation surface introduced for #5.
 *
 * The interface must match the schema published in the issue body so that
 * minds (and the engine) can rely on field shapes without runtime probes.
 * These tests fail at `tsc --noEmit` if a field is dropped or its optionality
 * changes — the same gate `npm run typecheck` runs in CI.
 */

describe('CanvasPresentation type contract', () => {
  it('CanvasPresentationTransitionKind is the closed union from the issue body', () => {
    expectTypeOf<CanvasPresentationTransitionKind>().toEqualTypeOf<
      'zoom' | 'pan' | 'fade' | 'reveal' | 'none'
    >();
  });

  it('CanvasPresentationTransition has the kind/durationMs shape', () => {
    expectTypeOf<CanvasPresentationTransition['kind']>().toEqualTypeOf<CanvasPresentationTransitionKind>();
    expectTypeOf<CanvasPresentationTransition['durationMs']>().toEqualTypeOf<number | undefined>();
  });

  it('CanvasPresentationStep matches the issue body schema', () => {
    expectTypeOf<CanvasPresentationStep['id']>().toEqualTypeOf<string>();
    expectTypeOf<CanvasPresentationStep['title']>().toEqualTypeOf<string>();
    expectTypeOf<CanvasPresentationStep['narration']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CanvasPresentationStep['transition']>().toEqualTypeOf<
      CanvasPresentationTransition | undefined
    >();
  });

  it('CanvasPresentation carries steps, optional startStepId, and optional options', () => {
    expectTypeOf<CanvasPresentation['steps']>().toEqualTypeOf<CanvasPresentationStep[]>();
    expectTypeOf<CanvasPresentation['startStepId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CanvasPresentation['options']>().toEqualTypeOf<
      | {
          autoAdvance?: { intervalMs: number };
          linearByDefault?: boolean;
        }
      | undefined
    >();
  });

  it('CanvasShowInput.presentation is optional and omitting it remains assignable', () => {
    expectTypeOf<CanvasShowInput['presentation']>().toEqualTypeOf<CanvasPresentation | undefined>();

    const withoutPresentation: CanvasShowInput = { name: 'plain', html: '<h1>hi</h1>' };
    expectTypeOf(withoutPresentation).toEqualTypeOf<CanvasShowInput>();

    const withPresentation: CanvasShowInput = {
      name: 'flow',
      html: '<h1>hi</h1>',
      presentation: {
        steps: [{ id: 'a', title: 'A' }],
      },
    };
    expectTypeOf(withPresentation).toEqualTypeOf<CanvasShowInput>();
  });

  it('CanvasUpdateInput.presentation is optional and omitting it remains assignable', () => {
    expectTypeOf<CanvasUpdateInput['presentation']>().toEqualTypeOf<CanvasPresentation | undefined>();

    const withoutPresentation: CanvasUpdateInput = { name: 'plain', html: '<h1>hi</h1>' };
    expectTypeOf(withoutPresentation).toEqualTypeOf<CanvasUpdateInput>();

    const withPresentation: CanvasUpdateInput = {
      name: 'flow',
      html: '<h1>hi</h1>',
      presentation: {
        steps: [{ id: 'a', title: 'A' }],
        startStepId: 'a',
        options: { linearByDefault: true, autoAdvance: { intervalMs: 4000 } },
      },
    };
    expectTypeOf(withPresentation).toEqualTypeOf<CanvasUpdateInput>();
  });
});
