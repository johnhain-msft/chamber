import { REDUCED_MOTION_EQUIVALENT } from '../sullivan/motionLimits';
import type {
  CanvasPresentation,
  CanvasPresentationStep,
  CanvasPresentationTransitionKind,
} from './types';

/**
 * Construction context for the presentation engine.
 *
 * The engine is factored so it can be unit-tested in jsdom against a
 * synthetic `Window`/`Document` pair and, in Phase 5, bundled into a
 * `<script>` that injects itself against the real browser globals.
 */
export interface PresentationEngineContext {
  window: Window;
  document: Document;
  config: CanvasPresentation;
}

export interface PresentationEngineHandle {
  destroy(): void;
  play(): void;
  pause(): void;
  getView(): PresentationView;
  setView(next: PresentationView): void;
  getCurrentStepId(): string | null;
}

export type PresentationView = 'flow' | 'linear';

const MIN_AUTO_ADVANCE_INTERVAL_MS = 2000;

function isReducedMotion(win: Window): boolean {
  try {
    return win.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

function effectiveTransitionKind(
  kind: CanvasPresentationTransitionKind,
  prefersReducedMotion: boolean,
): string {
  if (!prefersReducedMotion) {
    return kind;
  }
  return REDUCED_MOTION_EQUIVALENT[kind] ?? kind;
}

function applyViewToRoot(doc: Document, view: PresentationView): void {
  if (view === 'linear') {
    doc.documentElement.dataset.chView = 'linear';
  } else {
    delete doc.documentElement.dataset.chView;
  }
}

function buildLiveRegion(doc: Document): HTMLElement {
  const el = doc.createElement('div');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.className = 'ch-pres-live';
  el.style.position = 'absolute';
  el.style.width = '1px';
  el.style.height = '1px';
  el.style.overflow = 'hidden';
  el.style.clip = 'rect(0 0 0 0)';
  el.style.whiteSpace = 'nowrap';
  return el;
}

function buildHelpDialog(doc: Document): HTMLElement {
  const dialog = doc.createElement('dialog');
  dialog.className = 'ch-pres-help';
  dialog.innerHTML = [
    '<p><strong>Presentation controls</strong></p>',
    '<ul>',
    '<li><kbd>&rarr;</kbd> / <kbd>Space</kbd> / <kbd>PageDown</kbd> &mdash; next step</li>',
    '<li><kbd>&larr;</kbd> / <kbd>PageUp</kbd> &mdash; previous step</li>',
    '<li><kbd>Home</kbd> / <kbd>End</kbd> &mdash; first / last step</li>',
    '<li><kbd>Esc</kbd> &mdash; exit to linear view</li>',
    '<li><kbd>?</kbd> &mdash; toggle this help</li>',
    '</ul>',
    '<form method="dialog"><button type="submit">Close</button></form>',
  ].join('');
  return dialog;
}

function buildWarningRegion(doc: Document, unknownIds: string[]): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'ch-pres-warning';
  el.setAttribute('role', 'status');
  const items = unknownIds.map((id) => `<li><code>${id}</code></li>`).join('');
  el.innerHTML = `<p>Unknown presentation steps (no matching element):</p><ul>${items}</ul>`;
  return el;
}

export function createPresentationEngine(
  ctx: PresentationEngineContext,
): PresentationEngineHandle {
  const { window: win, document: doc, config } = ctx;
  const prefersReducedMotion = isReducedMotion(win);

  const knownStepEls = new Map<string, HTMLElement>();
  const unknownStepIds: string[] = [];
  for (const step of config.steps) {
    const el = doc.getElementById(step.id);
    if (el) {
      knownStepEls.set(step.id, el as HTMLElement);
      if (!el.hasAttribute('tabindex')) {
        el.setAttribute('tabindex', '-1');
      }
    } else {
      unknownStepIds.push(step.id);
    }
  }

  const liveRegion = buildLiveRegion(doc);
  doc.body.appendChild(liveRegion);

  let warningRegion: HTMLElement | null = null;
  let helpDialog: HTMLElement | null = null;

  const linearByDefault = config.options?.linearByDefault === true;
  let view: PresentationView =
    prefersReducedMotion || linearByDefault ? 'linear' : 'flow';
  applyViewToRoot(doc, view);

  let currentIndex = 0;
  if (config.startStepId) {
    const idx = config.steps.findIndex((s) => s.id === config.startStepId);
    if (idx >= 0 && knownStepEls.has(config.startStepId)) {
      currentIndex = idx;
    }
  }
  if (view === 'flow') {
    while (
      currentIndex < config.steps.length &&
      !knownStepEls.has(config.steps[currentIndex].id)
    ) {
      currentIndex += 1;
    }
    if (currentIndex >= config.steps.length) {
      currentIndex = 0;
    }
  }

  function announce(step: CanvasPresentationStep | undefined): void {
    if (!step) {
      return;
    }
    liveRegion.textContent = step.narration ?? step.title;
  }

  function applyTransitionAttr(step: CanvasPresentationStep | undefined): void {
    if (!step?.transition) {
      delete doc.body.dataset.chTransition;
      return;
    }
    doc.body.dataset.chTransition = effectiveTransitionKind(
      step.transition.kind,
      prefersReducedMotion,
    );
  }

  let suppressFocusPause = false;

  function focusCurrent(): void {
    const step = config.steps[currentIndex];
    for (const [id, otherEl] of knownStepEls) {
      if (step && id === step.id) {
        otherEl.setAttribute('aria-current', 'step');
      } else {
        otherEl.removeAttribute('aria-current');
      }
    }
    if (step) {
      const el = knownStepEls.get(step.id);
      if (el) {
        suppressFocusPause = true;
        try {
          el.focus({ preventScroll: true });
        } finally {
          suppressFocusPause = false;
        }
        if (view === 'flow' && prefersReducedMotion) {
          el.scrollIntoView({ behavior: 'auto' });
        }
      }
      applyTransitionAttr(step);
      announce(step);
    }
  }

  function renderUnknownWarnings(): void {
    if (warningRegion) {
      warningRegion.remove();
      warningRegion = null;
    }
    if (view === 'linear' && unknownStepIds.length > 0) {
      warningRegion = buildWarningRegion(doc, unknownStepIds);
      doc.body.appendChild(warningRegion);
    }
  }

  renderUnknownWarnings();
  focusCurrent();

  function goTo(idx: number): void {
    if (idx < 0 || idx >= config.steps.length) {
      return;
    }
    currentIndex = idx;
    focusCurrent();
  }

  function advance(): void {
    let next = currentIndex + 1;
    if (view === 'flow') {
      while (
        next < config.steps.length &&
        !knownStepEls.has(config.steps[next].id)
      ) {
        next += 1;
      }
    }
    if (next < config.steps.length) {
      goTo(next);
    }
  }

  function retreat(): void {
    let prev = currentIndex - 1;
    if (view === 'flow') {
      while (prev >= 0 && !knownStepEls.has(config.steps[prev].id)) {
        prev -= 1;
      }
    }
    if (prev >= 0) {
      goTo(prev);
    }
  }

  function setView(next: PresentationView): void {
    view = next;
    applyViewToRoot(doc, view);
    renderUnknownWarnings();
    focusCurrent();
  }

  function showHelp(): void {
    if (!helpDialog) {
      helpDialog = buildHelpDialog(doc);
      doc.body.appendChild(helpDialog);
    }
    const dlg = helpDialog as HTMLElement & {
      showModal?: () => void;
      open?: boolean;
    };
    if (typeof dlg.showModal === 'function') {
      try {
        dlg.showModal();
      } catch {
        dlg.setAttribute('open', '');
      }
    } else {
      dlg.setAttribute('open', '');
    }
  }

  let autoAdvanceTimer: ReturnType<typeof setInterval> | null = null;
  const autoIntervalMs = config.options?.autoAdvance?.intervalMs;
  const autoAdvanceOptedIn =
    typeof autoIntervalMs === 'number' &&
    autoIntervalMs >= MIN_AUTO_ADVANCE_INTERVAL_MS &&
    !prefersReducedMotion;

  function pauseAutoAdvance(): void {
    if (autoAdvanceTimer !== null) {
      clearInterval(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
  }

  function playAutoAdvance(): void {
    if (!autoAdvanceOptedIn || autoAdvanceTimer !== null) {
      return;
    }
    autoAdvanceTimer = setInterval(() => {
      if (currentIndex < config.steps.length - 1) {
        advance();
      } else {
        pauseAutoAdvance();
      }
    }, autoIntervalMs as number);
  }

  function onKey(ev: KeyboardEvent): void {
    let handled = false;
    switch (ev.key) {
      case 'ArrowRight':
      case ' ':
      case 'Spacebar':
      case 'PageDown':
        advance();
        handled = true;
        break;
      case 'ArrowLeft':
      case 'PageUp':
        retreat();
        handled = true;
        break;
      case 'Home':
        goTo(0);
        handled = true;
        break;
      case 'End':
        goTo(config.steps.length - 1);
        handled = true;
        break;
      case 'Escape':
        setView('linear');
        handled = true;
        break;
      case '?':
        showHelp();
        handled = true;
        break;
    }
    if (handled) {
      ev.preventDefault();
      pauseAutoAdvance();
    }
  }

  function onFocusIn(): void {
    if (suppressFocusPause) {
      return;
    }
    pauseAutoAdvance();
  }
  function onMouseEnter(): void {
    pauseAutoAdvance();
  }

  doc.addEventListener('keydown', onKey);
  doc.addEventListener('focusin', onFocusIn);
  doc.body.addEventListener('mouseenter', onMouseEnter, true);

  function onViewToggleClick(): void {
    const desktopView: PresentationView =
      doc.documentElement.dataset.chView === 'linear' ? 'linear' : 'flow';
    if (desktopView !== view) {
      setView(desktopView);
    }
  }
  const toggleBtn = doc.querySelector('button.ch-view-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', onViewToggleClick);
  }

  function destroy(): void {
    pauseAutoAdvance();
    doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('focusin', onFocusIn);
    doc.body.removeEventListener('mouseenter', onMouseEnter, true);
    if (toggleBtn) {
      toggleBtn.removeEventListener('click', onViewToggleClick);
    }
    liveRegion.remove();
    if (warningRegion) {
      warningRegion.remove();
      warningRegion = null;
    }
    if (helpDialog) {
      helpDialog.remove();
      helpDialog = null;
    }
    for (const el of knownStepEls.values()) {
      el.removeAttribute('aria-current');
    }
    delete doc.documentElement.dataset.chView;
    delete doc.body.dataset.chTransition;
  }

  return {
    destroy,
    play: playAutoAdvance,
    pause: pauseAutoAdvance,
    getView: () => view,
    setView,
    getCurrentStepId: () => config.steps[currentIndex]?.id ?? null,
  };
}
