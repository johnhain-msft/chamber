import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../sullivan/contrast';
import {
  CANVAS_AA_PAIRS,
  CANVAS_PALETTE_DARK,
  CANVAS_PALETTE_LIGHT,
  minRatioFor,
} from './canvasPalette';
import type { CanvasPalette } from './canvasPalette';

/**
 * Sullivan-as-spec: every visible foreground/background adjacency in the
 * canvas palette must satisfy WCAG 2.1 contrast for its kind. This test is
 * the regression detector — phase 0.5 ships with placeholder palettes that
 * FAIL by design; phase 2 fills in real hex and the assertions flip GREEN.
 *
 * The contrast math lives in `packages/services/src/sullivan/contrast.ts`
 * and is the same math Sullivan's `presentation_contrast_check` tool uses.
 */
function describePalette(palette: CanvasPalette, paletteName: string): void {
  describe(`${paletteName} palette WCAG 2.1 contrast`, () => {
    for (const pair of CANVAS_AA_PAIRS) {
      it(`${pair.name} (${pair.fg} on ${pair.bg}, ${pair.kind}) meets WCAG`, () => {
        const fg = palette[pair.fg];
        const bg = palette[pair.bg];
        const ratio = contrastRatio(fg, bg);
        const minimum = minRatioFor(pair.kind);
        expect(ratio).toBeGreaterThanOrEqual(minimum);
      });
    }
  });
}

describePalette(CANVAS_PALETTE_DARK, 'dark');
describePalette(CANVAS_PALETTE_LIGHT, 'light');

describe('canvasPalette module shape', () => {
  it('exports at least one pair per visible surface', () => {
    const surfaces = new Set(CANVAS_AA_PAIRS.map((p) => p.bg));
    expect(surfaces.has('background')).toBe(true);
    expect(surfaces.has('card')).toBe(true);
    expect(surfaces.has('muted')).toBe(true);
  });

  it('every pair references valid palette keys', () => {
    const validKeys = new Set(Object.keys(CANVAS_PALETTE_DARK));
    for (const pair of CANVAS_AA_PAIRS) {
      expect(validKeys.has(pair.fg)).toBe(true);
      expect(validKeys.has(pair.bg)).toBe(true);
    }
  });

  it('classifies every pair into a known contrast kind', () => {
    for (const pair of CANVAS_AA_PAIRS) {
      expect(['text', 'large-text', 'non-text']).toContain(pair.kind);
    }
  });
});
