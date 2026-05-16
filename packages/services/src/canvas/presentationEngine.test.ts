// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPresentationEngine } from './presentationEngine';
import type {
  PresentationEngineHandle,
  PresentationEngineContext,
} from './presentationEngine';
import type { CanvasPresentation } from './types';

interface BuildOptions {
  bodyHtml?: string;
  config?: CanvasPresentation;
  reducedMotion?: boolean;
}

let activeHandles: PresentationEngineHandle[] = [];

function build(opts: BuildOptions = {}): PresentationEngineHandle {
  const bodyHtml =
    opts.bodyHtml ??
    [
      '<section id="intro" data-step><h2>Intro</h2></section>',
      '<section id="detail" data-step><h2>Detail</h2></section>',
      '<section id="finale" data-step><h2>Finale</h2></section>',
    ].join('');
  document.body.innerHTML = bodyHtml;

  const config: CanvasPresentation =
    opts.config ??
    ({
      steps: [
        { id: 'intro', title: 'Intro' },
        { id: 'detail', title: 'Detail', narration: 'Detail narration.' },
        { id: 'finale', title: 'Finale' },
      ],
    } as CanvasPresentation);

  const reducedMotion = opts.reducedMotion === true;
  const matchMediaMock = vi.fn((query: string) => ({
    matches: reducedMotion && query.includes('reduce'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  // jsdom does not implement matchMedia by default.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMediaMock,
  });

  const ctx: PresentationEngineContext = {
    window,
    document,
    config,
  };
  const handle = createPresentationEngine(ctx);
  activeHandles.push(handle);
  return handle;
}

function pressKey(key: string): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-ch-view');
  document.body.innerHTML = '';
  document.body.removeAttribute('data-ch-transition');
});

afterEach(() => {
  for (const handle of activeHandles) {
    try {
      handle.destroy();
    } catch {
      // ignore destroy errors so other tests can clean up
    }
  }
  activeHandles = [];
});

describe('createPresentationEngine — initial render', () => {
  it('focuses the first step and marks it with aria-current="step"', () => {
    build();
    const first = document.getElementById('intro') as HTMLElement;
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute('aria-current')).toBe('step');
  });

  it('creates an aria-live region that announces the active step narration or title', () => {
    build();
    const live = document.querySelector('.ch-pres-live') as HTMLElement;
    expect(live).not.toBeNull();
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('Intro');
  });

  it('honors startStepId when the named step has a matching element', () => {
    build({
      config: {
        steps: [
          { id: 'intro', title: 'Intro' },
          { id: 'detail', title: 'Detail', narration: 'Detail narration.' },
          { id: 'finale', title: 'Finale' },
        ],
        startStepId: 'detail',
      },
    });
    const detail = document.getElementById('detail') as HTMLElement;
    expect(document.activeElement).toBe(detail);
    expect(detail.getAttribute('aria-current')).toBe('step');
  });
});

describe('createPresentationEngine — keyboard navigation', () => {
  it.each([
    ['ArrowRight'],
    [' '],
    ['PageDown'],
  ])('advances to the next step on %s', (key) => {
    build();
    pressKey(key);
    expect(document.activeElement?.id).toBe('detail');
  });

  it.each([
    ['ArrowLeft'],
    ['PageUp'],
  ])('retreats to the previous step on %s', (key) => {
    build();
    pressKey('ArrowRight');
    pressKey(key);
    expect(document.activeElement?.id).toBe('intro');
  });

  it('jumps to the first step on Home and the last step on End', () => {
    build();
    pressKey('End');
    expect(document.activeElement?.id).toBe('finale');
    pressKey('Home');
    expect(document.activeElement?.id).toBe('intro');
  });

  it('switches to linear view on Escape', () => {
    build();
    expect(document.documentElement.dataset.chView).toBeUndefined();
    pressKey('Escape');
    expect(document.documentElement.dataset.chView).toBe('linear');
  });

  it('opens a help dialog on "?"', () => {
    build();
    pressKey('?');
    const dialog = document.querySelector('dialog.ch-pres-help');
    expect(dialog).not.toBeNull();
    expect(dialog?.hasAttribute('open')).toBe(true);
  });
});

describe('createPresentationEngine — reduced motion', () => {
  it('starts in linear view even when linearByDefault is false', () => {
    build({
      reducedMotion: true,
      config: {
        steps: [{ id: 'intro', title: 'Intro' }],
        options: { linearByDefault: false },
      },
    });
    expect(document.documentElement.dataset.chView).toBe('linear');
  });

  it('substitutes zoom with fade on the body data-ch-transition attribute', () => {
    build({
      reducedMotion: true,
      config: {
        steps: [
          {
            id: 'intro',
            title: 'Intro',
            transition: { kind: 'zoom', durationMs: 400 },
          },
          { id: 'detail', title: 'Detail' },
        ],
      },
    });
    expect(document.body.dataset.chTransition).toBe('fade');
  });

  it('keeps the original transition kind when reduced motion is off', () => {
    build({
      reducedMotion: false,
      config: {
        steps: [
          {
            id: 'intro',
            title: 'Intro',
            transition: { kind: 'zoom', durationMs: 400 },
          },
          { id: 'detail', title: 'Detail' },
        ],
      },
    });
    expect(document.body.dataset.chTransition).toBe('zoom');
  });

  it('disables auto-advance entirely under reduced motion even when opted in', () => {
    vi.useFakeTimers();
    try {
      const handle = build({
        reducedMotion: true,
        config: {
          steps: [
            { id: 'intro', title: 'Intro' },
            { id: 'detail', title: 'Detail' },
            { id: 'finale', title: 'Finale' },
          ],
          options: { autoAdvance: { intervalMs: 2000 } },
        },
      });
      handle.play();
      vi.advanceTimersByTime(10_000);
      expect(handle.getCurrentStepId()).toBe('intro');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createPresentationEngine — unknown step ids', () => {
  it('skips unknown step ids in flow view advance', () => {
    build({
      config: {
        steps: [
          { id: 'intro', title: 'Intro' },
          { id: 'ghost', title: 'Ghost' },
          { id: 'finale', title: 'Finale' },
        ],
      },
    });
    pressKey('ArrowRight');
    expect(document.activeElement?.id).toBe('finale');
  });

  it('renders a visible warning listing unknown step ids in linear view', () => {
    build({
      config: {
        steps: [
          { id: 'intro', title: 'Intro' },
          { id: 'ghost', title: 'Ghost' },
          { id: 'phantom', title: 'Phantom' },
        ],
        options: { linearByDefault: true },
      },
    });
    const warning = document.querySelector('.ch-pres-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('ghost');
    expect(warning?.textContent).toContain('phantom');
  });

  it('HTML-escapes step ids in the unknown-step warning region to defuse injected markup', () => {
    build({
      config: {
        steps: [
          { id: 'intro', title: 'Intro' },
          { id: '<img src=x onerror=alert(1)>', title: 'Bad' },
        ],
        options: { linearByDefault: true },
      },
    });
    const warning = document.querySelector('.ch-pres-warning');
    expect(warning).not.toBeNull();
    expect(warning?.querySelector('img')).toBeNull();
    expect(warning?.innerHTML).toContain('&lt;img');
    expect(warning?.innerHTML).not.toContain('<img');
  });
});

describe('createPresentationEngine — tabindex handling', () => {
  it('injects tabindex="-1" on step elements that lack one', () => {
    build();
    expect(document.getElementById('intro')?.getAttribute('tabindex')).toBe(
      '-1',
    );
    expect(document.getElementById('detail')?.getAttribute('tabindex')).toBe(
      '-1',
    );
  });

  it('leaves a user-authored tabindex untouched', () => {
    build({
      bodyHtml: [
        '<section id="intro" tabindex="0"><h2>Intro</h2></section>',
        '<section id="detail"><h2>Detail</h2></section>',
      ].join(''),
      config: {
        steps: [
          { id: 'intro', title: 'Intro' },
          { id: 'detail', title: 'Detail' },
        ],
      },
    });
    expect(document.getElementById('intro')?.getAttribute('tabindex')).toBe(
      '0',
    );
    expect(document.getElementById('detail')?.getAttribute('tabindex')).toBe(
      '-1',
    );
  });
});

describe('createPresentationEngine — auto-advance', () => {
  it('does not auto-advance when options.autoAdvance is omitted', () => {
    vi.useFakeTimers();
    try {
      const handle = build();
      handle.play();
      vi.advanceTimersByTime(10_000);
      expect(handle.getCurrentStepId()).toBe('intro');
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances on play() when autoAdvance.intervalMs >= 2000', () => {
    vi.useFakeTimers();
    try {
      const handle = build({
        config: {
          steps: [
            { id: 'intro', title: 'Intro' },
            { id: 'detail', title: 'Detail' },
            { id: 'finale', title: 'Finale' },
          ],
          options: { autoAdvance: { intervalMs: 2000 } },
        },
      });
      expect(handle.getCurrentStepId()).toBe('intro');
      handle.play();
      vi.advanceTimersByTime(2000);
      expect(handle.getCurrentStepId()).toBe('detail');
      vi.advanceTimersByTime(2000);
      expect(handle.getCurrentStepId()).toBe('finale');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses auto-advance on a navigation keypress and stays paused without explicit play', () => {
    vi.useFakeTimers();
    try {
      const handle = build({
        config: {
          steps: [
            { id: 'intro', title: 'Intro' },
            { id: 'detail', title: 'Detail' },
            { id: 'finale', title: 'Finale' },
          ],
          options: { autoAdvance: { intervalMs: 2000 } },
        },
      });
      handle.play();
      pressKey('ArrowRight');
      expect(handle.getCurrentStepId()).toBe('detail');
      vi.advanceTimersByTime(10_000);
      expect(handle.getCurrentStepId()).toBe('detail');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createPresentationEngine — view toggle button', () => {
  it('flips the engine view when the existing ch-view-toggle button is clicked', () => {
    document.body.innerHTML = [
      '<button class="ch-view-toggle" aria-pressed="false" data-action="ch-view-toggle">Linear</button>',
      '<section id="intro"><h2>Intro</h2></section>',
      '<section id="detail"><h2>Detail</h2></section>',
    ].join('');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({
        matches: false,
        media: '',
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    const handle = createPresentationEngine({
      window,
      document,
      config: {
        steps: [
          { id: 'intro', title: 'Intro' },
          { id: 'detail', title: 'Detail' },
        ],
      },
    });
    activeHandles.push(handle);

    expect(handle.getView()).toBe('flow');

    // The bridge (Phase 4) flips documentElement.dataset.chView and aria-pressed.
    // Simulate the bridge behaviour by flipping the attribute first, then clicking.
    document.documentElement.dataset.chView = 'linear';
    (document.querySelector('button.ch-view-toggle') as HTMLElement).click();

    expect(handle.getView()).toBe('linear');
  });
});

describe('createPresentationEngine — destroy()', () => {
  it('removes the live region, aria-current, and stops responding to keys', () => {
    const handle = build();
    handle.destroy();

    expect(document.querySelector('.ch-pres-live')).toBeNull();
    expect(
      document.getElementById('intro')?.getAttribute('aria-current'),
    ).toBeNull();

    // After destroy, ArrowRight should not advance.
    const before = document.activeElement;
    pressKey('ArrowRight');
    expect(document.activeElement).toBe(before);
  });

  it('reverts the documentElement view attribute on destroy', () => {
    const handle = build({
      config: {
        steps: [{ id: 'intro', title: 'Intro' }],
        options: { linearByDefault: true },
      },
    });
    expect(document.documentElement.dataset.chView).toBe('linear');
    handle.destroy();
    expect(document.documentElement.dataset.chView).toBeUndefined();
  });
});
