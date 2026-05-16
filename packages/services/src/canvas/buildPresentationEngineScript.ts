import { REDUCED_MOTION_EQUIVALENT } from '../sullivan/motionLimits';

/**
 * Returns the browser-side IIFE that runs the presentation engine.
 *
 * The TypeScript source of truth for the engine lives in
 * `./presentationEngine.ts` and is unit-tested with jsdom. This file is the
 * server-side bundle: a minimal vanilla-JS port of that engine wired to the
 * `__chamberCanvas:presentation` event dispatched by the bridge in
 * `CanvasServer.buildBridgeScript()`.
 *
 * Both copies must stay in lock-step. When changing the engine factory,
 * mirror the change here and re-run the canvas test suite + Playwright web
 * smoke. Gzipped output is asserted to stay under 8 KiB so it never bloats
 * the canvas HTML payload past the budget.
 */
export function buildPresentationEngineScript(): string {
  const reducedMotionEquivalent = JSON.stringify(REDUCED_MOTION_EQUIVALENT);
  return `
<script>
(function() {
  var REDUCED_MOTION_EQUIVALENT = ${reducedMotionEquivalent};
  var MIN_AUTO_INTERVAL = 2000;

  function isReducedMotion(win) {
    try { return win.matchMedia('(prefers-reduced-motion: reduce)').matches === true; }
    catch (_) { return false; }
  }

  function effectiveKind(kind, prm) {
    if (!prm) { return kind; }
    return Object.prototype.hasOwnProperty.call(REDUCED_MOTION_EQUIVALENT, kind)
      ? REDUCED_MOTION_EQUIVALENT[kind]
      : kind;
  }

  function applyView(doc, view) {
    if (view === 'linear') { doc.documentElement.dataset.chView = 'linear'; }
    else { delete doc.documentElement.dataset.chView; }
  }

  function buildLive(doc) {
    var el = doc.createElement('div');
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

  function buildHelp(doc) {
    var d = doc.createElement('dialog');
    d.className = 'ch-pres-help';
    d.innerHTML = '<p><strong>Presentation controls</strong></p>'
      + '<ul>'
      + '<li><kbd>&rarr;</kbd> / <kbd>Space</kbd> / <kbd>PageDown</kbd> &mdash; next step</li>'
      + '<li><kbd>&larr;</kbd> / <kbd>PageUp</kbd> &mdash; previous step</li>'
      + '<li><kbd>Home</kbd> / <kbd>End</kbd> &mdash; first / last step</li>'
      + '<li><kbd>Esc</kbd> &mdash; exit to linear view</li>'
      + '<li><kbd>?</kbd> &mdash; toggle this help</li>'
      + '</ul>'
      + '<form method="dialog"><button type="submit">Close</button></form>';
    return d;
  }

  function escapeForHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildWarning(doc, ids) {
    var w = doc.createElement('div');
    w.className = 'ch-pres-warning';
    w.setAttribute('role', 'status');
    var items = '';
    for (var i = 0; i < ids.length; i++) { items += '<li><code>' + escapeForHtml(ids[i]) + '</code></li>'; }
    w.innerHTML = '<p>Unknown presentation steps (no matching element):</p><ul>' + items + '</ul>';
    return w;
  }

  function createPresentationEngine(ctx) {
    var win = ctx.window, doc = ctx.document, config = ctx.config;
    var prm = isReducedMotion(win);

    var knownEls = {};
    var unknownIds = [];
    for (var i = 0; i < config.steps.length; i++) {
      var step = config.steps[i];
      var el = doc.getElementById(step.id);
      if (el) {
        knownEls[step.id] = el;
        if (!el.hasAttribute('tabindex')) { el.setAttribute('tabindex', '-1'); }
      } else { unknownIds.push(step.id); }
    }

    var liveRegion = buildLive(doc);
    doc.body.appendChild(liveRegion);
    var warningRegion = null, helpDialog = null;

    var linearByDefault = !!(config.options && config.options.linearByDefault);
    var view = (prm || linearByDefault) ? 'linear' : 'flow';
    applyView(doc, view);

    var idx = 0;
    if (config.startStepId) {
      for (var j = 0; j < config.steps.length; j++) {
        if (config.steps[j].id === config.startStepId) {
          if (knownEls[config.startStepId]) { idx = j; }
          break;
        }
      }
    }
    if (view === 'flow') {
      while (idx < config.steps.length && !knownEls[config.steps[idx].id]) { idx++; }
      if (idx >= config.steps.length) { idx = 0; }
    }

    var suppressFocusPause = false;

    function announce(step) {
      if (!step) { return; }
      liveRegion.textContent = (step.narration != null) ? step.narration : step.title;
    }

    function applyTransitionAttr(step) {
      if (!step || !step.transition) { delete doc.body.dataset.chTransition; return; }
      doc.body.dataset.chTransition = effectiveKind(step.transition.kind, prm);
    }

    function focusCurrent() {
      var step = config.steps[idx];
      for (var id in knownEls) {
        if (Object.prototype.hasOwnProperty.call(knownEls, id)) {
          if (step && id === step.id) { knownEls[id].setAttribute('aria-current', 'step'); }
          else { knownEls[id].removeAttribute('aria-current'); }
        }
      }
      if (step) {
        var el = knownEls[step.id];
        if (el) {
          suppressFocusPause = true;
          try { el.focus({ preventScroll: true }); } finally { suppressFocusPause = false; }
          if (view === 'flow' && prm) { el.scrollIntoView({ behavior: 'auto' }); }
        }
        applyTransitionAttr(step);
        announce(step);
      }
    }

    function renderWarnings() {
      if (warningRegion) { warningRegion.remove(); warningRegion = null; }
      if (view === 'linear' && unknownIds.length > 0) {
        warningRegion = buildWarning(doc, unknownIds);
        doc.body.appendChild(warningRegion);
      }
    }

    renderWarnings();
    focusCurrent();

    function goTo(i) { if (i < 0 || i >= config.steps.length) { return; } idx = i; focusCurrent(); }
    function advance() {
      var next = idx + 1;
      if (view === 'flow') { while (next < config.steps.length && !knownEls[config.steps[next].id]) { next++; } }
      if (next < config.steps.length) { goTo(next); }
    }
    function retreat() {
      var prev = idx - 1;
      if (view === 'flow') { while (prev >= 0 && !knownEls[config.steps[prev].id]) { prev--; } }
      if (prev >= 0) { goTo(prev); }
    }
    function setView(next) { view = next; applyView(doc, view); renderWarnings(); focusCurrent(); }

    function showHelp() {
      if (!helpDialog) { helpDialog = buildHelp(doc); doc.body.appendChild(helpDialog); }
      if (typeof helpDialog.showModal === 'function') {
        try { helpDialog.showModal(); } catch (_) { helpDialog.setAttribute('open', ''); }
      } else { helpDialog.setAttribute('open', ''); }
    }

    var autoTimer = null;
    var autoIntervalMs = (config.options && config.options.autoAdvance && config.options.autoAdvance.intervalMs) || 0;
    var autoOptedIn = (autoIntervalMs >= MIN_AUTO_INTERVAL) && !prm;

    function pauseAuto() { if (autoTimer !== null) { clearInterval(autoTimer); autoTimer = null; } }
    function playAuto() {
      if (!autoOptedIn || autoTimer !== null) { return; }
      autoTimer = setInterval(function() {
        if (idx < config.steps.length - 1) { advance(); } else { pauseAuto(); }
      }, autoIntervalMs);
    }

    function onKey(ev) {
      var handled = false;
      switch (ev.key) {
        case 'ArrowRight': case ' ': case 'Spacebar': case 'PageDown': advance(); handled = true; break;
        case 'ArrowLeft': case 'PageUp': retreat(); handled = true; break;
        case 'Home': goTo(0); handled = true; break;
        case 'End': goTo(config.steps.length - 1); handled = true; break;
        case 'Escape': setView('linear'); handled = true; break;
        case '?': showHelp(); handled = true; break;
      }
      if (handled) { ev.preventDefault(); pauseAuto(); }
    }
    function onFocusIn() { if (suppressFocusPause) { return; } pauseAuto(); }
    function onMouseEnter() { pauseAuto(); }

    doc.addEventListener('keydown', onKey);
    doc.addEventListener('focusin', onFocusIn);
    doc.body.addEventListener('mouseenter', onMouseEnter, true);

    function onToggleClick() {
      var next = (doc.documentElement.dataset.chView === 'linear') ? 'linear' : 'flow';
      if (next !== view) { setView(next); }
    }
    var toggleBtn = doc.querySelector('button.ch-view-toggle');
    if (toggleBtn) { toggleBtn.addEventListener('click', onToggleClick); }

    return {
      destroy: function() {
        pauseAuto();
        doc.removeEventListener('keydown', onKey);
        doc.removeEventListener('focusin', onFocusIn);
        doc.body.removeEventListener('mouseenter', onMouseEnter, true);
        if (toggleBtn) { toggleBtn.removeEventListener('click', onToggleClick); }
        liveRegion.remove();
        if (warningRegion) { warningRegion.remove(); warningRegion = null; }
        if (helpDialog) { helpDialog.remove(); helpDialog = null; }
        for (var id in knownEls) {
          if (Object.prototype.hasOwnProperty.call(knownEls, id)) { knownEls[id].removeAttribute('aria-current'); }
        }
        delete doc.documentElement.dataset.chView;
        delete doc.body.dataset.chTransition;
      },
      play: playAuto,
      pause: pauseAuto,
      getView: function() { return view; },
      setView: setView,
      getCurrentStepId: function() { return config.steps[idx] ? config.steps[idx].id : null; }
    };
  }

  var handle = null;
  function init(presentation) {
    if (!presentation || handle) { return; }
    handle = createPresentationEngine({ window: window, document: document, config: presentation });
  }

  var cached = window.__chamberCanvas && window.__chamberCanvas.presentation;
  if (cached) {
    init(cached);
  } else {
    document.addEventListener('__chamberCanvas:presentation', function(ev) {
      init(ev && ev.detail ? ev.detail : null);
    });
  }
})();
</script>`;
}
