/**
 * Canvas palette — data-only module.
 *
 * Why this lives here, not inline in `CHAMBER_CANVAS_STYLE`: Sullivan's
 * WCAG contrast math (`packages/services/src/sullivan/contrast.ts`) operates
 * on typed hex strings, not opaque CSS. Treating palette tokens as opaque
 * strings means a typo or theme tweak silently regresses a11y. Keeping the
 * tokens here as typed constants — and iterating `CANVAS_AA_PAIRS` in
 * `canvasPalette.test.ts` through Sullivan's `passesAA` — means every
 * adjacency the rendered canvas can produce is validated against the same
 * threshold Sullivan's `presentation_contrast_check` tool enforces.
 *
 * Threshold knowledge lives in Sullivan, not here. This module owns the
 * palette and the surface inventory; Sullivan owns "passes AA?".
 */

export interface CanvasPalette {
  readonly background: string;
  readonly foreground: string;
  readonly card: string;
  readonly border: string;
  readonly muted: string;
  readonly mutedForeground: string;
  readonly accent: string;
  readonly genesis: string;
  readonly link: string;
  readonly linkVisited: string;
  readonly skipLinkBg: string;
  readonly skipLinkFg: string;
  readonly focusRing: string;
}

/**
 * Dark palette — WCAG 2.1 AA compliant for every pair in `CANVAS_AA_PAIRS`.
 *
 * Design constraints (the focus-ring constraint is the tight one):
 *   - `focusRing` must clear 3:1 on `background`, `card`, `muted`, AND on
 *     `foreground` (the button-primary surface). The first three push it
 *     lighter; the last pushes it darker. That forces a mid-luminance
 *     accent (~L≈0.16) like amber-700.
 *   - `border` must clear 3:1 on `background`, `card`, AND `muted`. `muted`
 *     is the brightest of the three, so border is sized against it.
 *   - `mutedForeground` must clear 4.5:1 on `background`, `card`, AND
 *     `muted`. `muted` again is the constraint.
 *
 * Pairs and ratios verified offline against the same WCAG formula Sullivan's
 * `contrastRatio` uses; tightest margins are at ~3.1 (input-border on muted)
 * — comfortably above 3.0 but close enough that any palette tweak must be
 * re-run through `canvasPalette.test.ts` before landing.
 */
export const CANVAS_PALETTE_DARK: CanvasPalette = {
  background: '#0b0b10',
  foreground: '#f5f5f7',
  card: '#16161d',
  border: '#6b6b78',
  muted: '#1f1f28',
  mutedForeground: '#b9b9c5',
  accent: '#b45309',
  genesis: '#6ee7b7',
  link: '#7dd3fc',
  linkVisited: '#c4b5fd',
  skipLinkBg: '#1a1a22',
  skipLinkFg: '#f5f5f7',
  focusRing: '#b45309',
};

/**
 * Light palette — mirrors the dark constraints with inverted lightness.
 *
 * `skipLinkBg` / `skipLinkFg` deliberately stay dark even in light mode so
 * the skip link reads like a high-contrast tooltip when it slides into view
 * (matches the OS convention for keyboard focus indicators).
 */
export const CANVAS_PALETTE_LIGHT: CanvasPalette = {
  background: '#ffffff',
  foreground: '#18181b',
  card: '#f7f7f9',
  border: '#87878f',
  muted: '#f0f0f3',
  mutedForeground: '#57575e',
  accent: '#b45309',
  genesis: '#15803d',
  link: '#1e40af',
  linkVisited: '#6b21a8',
  skipLinkBg: '#1a1a22',
  skipLinkFg: '#f5f5f7',
  focusRing: '#b45309',
};

export type ContrastKind = 'text' | 'large-text' | 'non-text';

export interface CanvasAaPair {
  readonly name: string;
  readonly fg: keyof CanvasPalette;
  readonly bg: keyof CanvasPalette;
  readonly kind: ContrastKind;
}

/**
 * Every visible foreground/background combination that the rendered canvas
 * DOM produces. New surfaces (e.g., the linear-view toggle, badges on cards,
 * focus rings on muted) MUST be added here when they ship — otherwise the
 * Sullivan contrast assertion misses them.
 *
 * AA thresholds (WCAG 2.1):
 *   - text          → 4.5:1
 *   - large-text    → 3.0:1
 *   - non-text UI   → 3.0:1 (success criterion 1.4.11)
 */
export const CANVAS_AA_PAIRS: readonly CanvasAaPair[] = [
  // Body / page text
  { name: 'body-text', fg: 'foreground', bg: 'background', kind: 'text' },

  // Cards
  { name: 'card-text', fg: 'foreground', bg: 'card', kind: 'text' },
  { name: 'card-muted-text', fg: 'mutedForeground', bg: 'card', kind: 'text' },
  { name: 'card-border', fg: 'border', bg: 'background', kind: 'non-text' },
  { name: 'card-border-on-card', fg: 'border', bg: 'card', kind: 'non-text' },

  // Muted text in body
  { name: 'muted-text-on-bg', fg: 'mutedForeground', bg: 'background', kind: 'text' },

  // Buttons
  { name: 'button-primary-text', fg: 'background', bg: 'foreground', kind: 'text' },
  { name: 'button-secondary-text', fg: 'foreground', bg: 'muted', kind: 'text' },

  // Inputs
  { name: 'input-text', fg: 'foreground', bg: 'muted', kind: 'text' },
  { name: 'input-border', fg: 'border', bg: 'muted', kind: 'non-text' },
  { name: 'input-placeholder', fg: 'mutedForeground', bg: 'muted', kind: 'text' },

  // Badges
  { name: 'badge-text-on-bg', fg: 'mutedForeground', bg: 'background', kind: 'text' },
  { name: 'badge-text-on-card', fg: 'mutedForeground', bg: 'card', kind: 'text' },
  { name: 'badge-border-on-bg', fg: 'border', bg: 'background', kind: 'non-text' },
  { name: 'badge-border-on-card', fg: 'border', bg: 'card', kind: 'non-text' },

  // Tables
  { name: 'table-cell-text', fg: 'foreground', bg: 'background', kind: 'text' },
  { name: 'table-row-border', fg: 'border', bg: 'background', kind: 'non-text' },

  // Links
  { name: 'link-text-on-bg', fg: 'link', bg: 'background', kind: 'text' },
  { name: 'link-text-on-card', fg: 'link', bg: 'card', kind: 'text' },
  { name: 'link-visited-on-bg', fg: 'linkVisited', bg: 'background', kind: 'text' },

  // Skip link (visible on focus)
  { name: 'skip-link-text', fg: 'skipLinkFg', bg: 'skipLinkBg', kind: 'text' },
  { name: 'skip-link-border', fg: 'focusRing', bg: 'skipLinkBg', kind: 'non-text' },

  // Linear-view toggle (styled as secondary button; same contrast surface)
  { name: 'linear-toggle-text', fg: 'foreground', bg: 'muted', kind: 'text' },

  // Focus ring — WCAG 2.4.7 + 1.4.11 against every surface a focusable element can appear on
  { name: 'focus-ring-on-bg', fg: 'focusRing', bg: 'background', kind: 'non-text' },
  { name: 'focus-ring-on-card', fg: 'focusRing', bg: 'card', kind: 'non-text' },
  { name: 'focus-ring-on-muted', fg: 'focusRing', bg: 'muted', kind: 'non-text' },
  { name: 'focus-ring-on-button-primary', fg: 'focusRing', bg: 'foreground', kind: 'non-text' },
] as const;
