import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Logger } from '../logger';
import type { ChamberToolProvider } from '../chamberTools';

const log = Logger.create('canvas');
import type { Tool } from '../mind/types';
import type { ExternalOpener } from '../ports';
import {
  MAX_AGGREGATE_TRANSITION_DURATION_MS,
  MAX_TRANSITION_DURATION_MS,
} from '../sullivan/motionLimits';
import { CanvasServer } from './CanvasServer';
import { isPathInside } from './canvasPaths';
import { buildCanvasTools } from './tools';
import type {
  CanvasAction,
  CanvasCloseInput,
  CanvasEntry,
  CanvasPresentation,
  CanvasServerLike,
  CanvasShowInput,
  CanvasUpdateInput,
} from './types';

const CANVAS_DIR = path.join('.chamber', 'canvas');
const VALID_CANVAS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALID_BCP47_LANG = /^[a-zA-Z]{1,3}(-[a-zA-Z0-9]{1,8})*$/;

/**
 * Minimum auto-advance interval, in milliseconds, accepted by
 * `validatePresentation`. Issue #5 acceptance criterion: auto-advance is off
 * by default and, when opted in, must not be shorter than 2000ms so reduced-
 * motion users still get a chance to pause/cancel.
 *
 * Sullivan's `motionLimits` module is read-only and does not export this
 * value (auto-advance is an authoring choice on top of the per-step motion
 * budget). The constant lives inline as a service-side editorial choice;
 * if Sullivan ever publishes an equivalent, switch to that import.
 */
// per Issue #5 acceptance criteria
const MIN_AUTO_ADVANCE_INTERVAL_MS = 2000;

export interface CanvasServiceOptions {
  onAction?: (action: CanvasAction) => void;
  openExternal?: ExternalOpener;
  server?: CanvasServerLike;
}

function validateCanvasName(name: string): void {
  if (name === 'all') {
    throw new Error('"all" is reserved for canvas_close and cannot be used as a canvas name');
  }

  if (!VALID_CANVAS_NAME.test(name)) {
    throw new Error(`Invalid canvas name "${name}". Use letters, numbers, dots, underscores, or hyphens.`);
  }
}

function validateCanvasLang(lang: string): void {
  if (!VALID_BCP47_LANG.test(lang)) {
    throw new Error(
      `Invalid canvas lang "${lang}". Use a BCP-47 language tag like "en", "en-US", or "pt-BR".`,
    );
  }
}

/**
 * Validates a presentation payload against the issue #5 acceptance criteria
 * and Sullivan's read-only motion limits.
 *
 * Surface-level invariants enforced here (independent of the engine):
 *   - At least one step; every step has a non-empty id; ids are unique.
 *   - Per-step transition `durationMs` ≤ `MAX_TRANSITION_DURATION_MS` (WCAG
 *     2.2.2, anchored in `sullivan/motionLimits.ts`).
 *   - Sum of `durationMs` across steps ≤ `MAX_AGGREGATE_TRANSITION_DURATION_MS`.
 *   - `autoAdvance.intervalMs` ≥ `MIN_AUTO_ADVANCE_INTERVAL_MS` so reduced-
 *     motion users always have a chance to pause/cancel.
 *
 * Engine-side concerns (unknown step ids, reduced-motion substitution) are
 * handled at render time; this validator runs at parse/write time so a bad
 * payload never reaches a sidecar on disk.
 */
function validatePresentation(presentation: CanvasPresentation): void {
  if (!Array.isArray(presentation.steps) || presentation.steps.length === 0) {
    throw new Error('Presentation must declare at least one step.');
  }

  const seenIds = new Set<string>();
  let aggregateMs = 0;
  for (const step of presentation.steps) {
    if (typeof step.id !== 'string' || step.id.trim().length === 0) {
      throw new Error('Step id must be a non-empty string.');
    }
    if (seenIds.has(step.id)) {
      throw new Error(`Duplicate step id "${step.id}". Step ids must be unique.`);
    }
    seenIds.add(step.id);

    const durationMs = step.transition?.durationMs;
    if (typeof durationMs === 'number') {
      if (durationMs < 0) {
        throw new Error(`Step "${step.id}" has a negative transition durationMs.`);
      }
      if (durationMs > MAX_TRANSITION_DURATION_MS) {
        throw new Error(
          `Step "${step.id}" transition durationMs (${durationMs}) exceeds the Sullivan per-step budget of ${MAX_TRANSITION_DURATION_MS}ms (WCAG 2.2.2 Pause, Stop, Hide).`,
        );
      }
      aggregateMs += durationMs;
    }
  }

  if (aggregateMs > MAX_AGGREGATE_TRANSITION_DURATION_MS) {
    throw new Error(
      `Presentation aggregate transition duration (${aggregateMs}ms) exceeds the Sullivan budget of ${MAX_AGGREGATE_TRANSITION_DURATION_MS}ms (WCAG 2.2.2 / 2.3.3).`,
    );
  }

  const autoAdvance = presentation.options?.autoAdvance;
  if (autoAdvance) {
    if (typeof autoAdvance.intervalMs !== 'number' || autoAdvance.intervalMs < MIN_AUTO_ADVANCE_INTERVAL_MS) {
      throw new Error(
        `autoAdvance.intervalMs (${String(autoAdvance.intervalMs)}) must be at least ${MIN_AUTO_ADVANCE_INTERVAL_MS}ms per Issue #5 acceptance.`,
      );
    }
  }
}

function presentationSidecarFilename(name: string): string {
  return `${name}.presentation.json`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface WrapHtmlOptions {
  title?: string;
  lang?: string;
}

function wrapHtml(name: string, html: string, opts: WrapHtmlOptions = {}): string {
  if (opts.lang !== undefined) {
    validateCanvasLang(opts.lang);
  }
  const lang = opts.lang ?? 'en';
  const lowerCaseHtml = html.toLowerCase();
  if (!lowerCaseHtml.includes('<!doctype') && !lowerCaseHtml.includes('<html')) {
    const pageTitle = opts.title ?? name;
    return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
</head>
<body>
<main id="ch-main" tabindex="-1">
${html}
</main>
</body>
</html>`;
  }

  if (opts.title && !lowerCaseHtml.includes('<title>')) {
    return html.replace(/<\/head>/i, `  <title>${escapeHtml(opts.title)}</title>\n</head>`);
  }

  return html;
}

export class CanvasService implements ChamberToolProvider {
  private readonly mindPaths = new Map<string, string>();
  private readonly canvases = new Map<string, Map<string, CanvasEntry>>();
  private readonly lensViewIdsByCanvas = new Map<string, Map<string, string>>();
  private readonly server: CanvasServerLike;
  private readonly openExternal: ExternalOpener;
  private readonly onAction: (action: CanvasAction) => void;

  constructor(options: CanvasServiceOptions = {}) {
    this.onAction = options.onAction ?? ((action: CanvasAction) => {
      log.info('Action received:', action);
    });

    this.server = options.server ?? new CanvasServer({
      resolveContentDir: (mindId) => this.getContentDirForMind(mindId),
      onAction: (action) => this.onAction(this.decorateCanvasAction(action)),
      authorizeRequest: (mindId, filename, token) => this.isAuthorizedCanvasRequest(mindId, filename, token),
      resolvePresentation: (mindId, filename) => this.resolvePresentationForRequest(mindId, filename),
    });
    this.openExternal = options.openExternal ?? {
      open: () => {
        throw new Error('CanvasService requires an ExternalOpener adapter');
      },
    };
  }

  getToolsForMind(mindId: string, mindPath: string): Tool[] {
    return buildCanvasTools(mindId, mindPath, this) as Tool[];
  }

  async activateMind(mindId: string, mindPath: string): Promise<void> {
    this.ensureMind(mindId, mindPath);
  }

  async releaseMind(mindId: string): Promise<void> {
    this.server.closeClients(mindId);
    this.canvases.delete(mindId);
    this.lensViewIdsByCanvas.delete(mindId);
    this.mindPaths.delete(mindId);
    await this.stopServerIfIdle();
  }

  async showCanvas(mindId: string, mindPath: string, input: CanvasShowInput): Promise<string> {
    validateCanvasName(input.name);
    if (!input.html && !input.file) {
      throw new Error('canvas_show requires either "html" or "file"');
    }
    if (input.presentation) {
      validatePresentation(input.presentation);
    }

    const contentDir = this.ensureMind(mindId, mindPath);
    const filename = `${input.name}.html`;
    const targetPath = path.join(contentDir, filename);

    if (input.file) {
      if (!path.isAbsolute(input.file)) {
        throw new Error('canvas_show file must be an absolute path');
      }
      if (!fs.existsSync(input.file)) {
        throw new Error(`Canvas source file not found: ${input.file}`);
      }
      fs.copyFileSync(input.file, targetPath);
    } else {
      fs.writeFileSync(targetPath, wrapHtml(input.name, input.html ?? '', { title: input.title, lang: input.lang }), 'utf8');
    }

    if (input.presentation) {
      this.writePresentationSidecar(contentDir, input.name, input.presentation);
    } else {
      this.removePresentationSidecar(contentDir, input.name);
    }

    const port = await this.server.start();
    const token = this.getExistingToken(mindId, input.name) ?? createCanvasToken();
    const url = this.buildCanvasUrl(mindId, filename, port, token);
    this.upsertCanvas(mindId, {
      filename,
      name: input.name,
      url,
      token,
    });

    if (input.open_browser !== false) {
      await this.openExternal.open(url);
      return `Canvas **${input.name}** is live at ${url} (opened in browser)`;
    }

    return `Canvas **${input.name}** is live at ${url}`;
  }

  async showLensCanvas(mindId: string, mindPath: string, viewId: string, sourcePath: string): Promise<string> {
    if (!path.isAbsolute(sourcePath)) {
      throw new Error('Canvas Lens source path must be absolute');
    }
    const lensDir = path.join(mindPath, '.github', 'lens');
    if (!isPathInside(lensDir, sourcePath)) {
      throw new Error('Canvas Lens source path must be inside the mind .github/lens directory');
    }
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Canvas Lens source file not found: ${sourcePath}`);
    }

    const contentDir = this.ensureMind(mindId, mindPath);
    const name = this.getLensCanvasName(viewId);
    const filename = `${name}.html`;
    fs.copyFileSync(sourcePath, path.join(contentDir, filename));

    const port = await this.server.start();
    const token = this.getExistingToken(mindId, name) ?? createCanvasToken();
    const url = this.buildCanvasUrl(mindId, filename, port, token);
    this.upsertCanvas(mindId, {
      filename,
      name,
      url,
      token,
    });

    const lensViews = this.lensViewIdsByCanvas.get(mindId) ?? new Map<string, string>();
    lensViews.set(filename, viewId);
    this.lensViewIdsByCanvas.set(mindId, lensViews);
    this.server.reload(mindId, filename);

    return url;
  }

  /**
   * Updates an existing canvas in place.
   *
   * Presentation sidecar semantics differ intentionally from {@link showCanvas}:
   * - `showCanvas` treats `presentation` as **replace-or-clear**: omitting the
   *   field removes any existing sidecar so a canvas can be downgraded from a
   *   presentation back to a plain document.
   * - `updateCanvas` treats `presentation` as **additive / patch**: omitting the
   *   field leaves the existing sidecar untouched so the HTML body can be
   *   refreshed independently of the presentation config.
   *
   * If a caller needs to clear a presentation from an existing canvas, they
   * should use `showCanvas` with the new HTML and no `presentation` field.
   */
  updateCanvas(mindId: string, mindPath: string, input: CanvasUpdateInput): string {
    validateCanvasName(input.name);
    if (input.presentation) {
      validatePresentation(input.presentation);
    }
    const contentDir = this.ensureMind(mindId, mindPath);
    const existing = this.requireCanvas(mindId, input.name);
    fs.writeFileSync(
      path.join(contentDir, existing.filename),
      wrapHtml(input.name, input.html, { title: input.title, lang: input.lang }),
      'utf8',
    );
    if (input.presentation) {
      this.writePresentationSidecar(contentDir, input.name, input.presentation);
    }
    this.server.reload(mindId, existing.filename);
    return `Canvas **${input.name}** updated. Browser will auto-reload.`;
  }

  async closeCanvas(mindId: string, mindPath: string, input: CanvasCloseInput): Promise<string> {
    this.ensureMind(mindId, mindPath);
    if (input.name === 'all') {
      return this.closeAllCanvases(mindId);
    }

    validateCanvasName(input.name);
    const existing = this.requireCanvas(mindId, input.name);
    this.server.closeClients(mindId, existing.filename);

    const canvases = this.canvases.get(mindId);
    canvases?.delete(input.name);
    this.removeLensCanvasMapping(mindId, existing.filename);
    if (canvases && canvases.size === 0) {
      this.canvases.delete(mindId);
    }

    this.deleteCanvasFile(mindId, existing.filename);
    this.deletePresentationSidecar(mindId, input.name);
    const remaining = this.totalCanvasCount();
    if (remaining === 0) {
      await this.server.stop();
      return `Canvas **${input.name}** closed. Server stopped (no remaining canvases).`;
    }

    return `Canvas **${input.name}** closed. ${remaining} canvas(es) still active.`;
  }

  listCanvases(mindId: string, mindPath: string): string {
    this.ensureMind(mindId, mindPath);
    const canvases = this.canvases.get(mindId);
    if (!canvases || canvases.size === 0) {
      return 'No canvases are open.';
    }

    const lines = [...canvases.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => `- **${entry.name}** - ${entry.url}`);

    const status = this.server.isRunning()
      ? `Server running on port ${this.server.getPort()}`
      : 'Server not running';

    return `${lines.join('\n')}\n\n${status}`;
  }

  private async closeAllCanvases(mindId: string): Promise<string> {
    const canvases = this.canvases.get(mindId);
    if (!canvases || canvases.size === 0) {
      return 'No canvases are open.';
    }

    this.server.closeClients(mindId);
    const count = canvases.size;
    for (const entry of canvases.values()) {
      this.deleteCanvasFile(mindId, entry.filename);
      this.deletePresentationSidecar(mindId, entry.name);
      this.removeLensCanvasMapping(mindId, entry.filename);
    }
    this.canvases.delete(mindId);

    const remaining = this.totalCanvasCount();
    if (remaining === 0) {
      await this.server.stop();
      return `Closed ${count} canvas(es) and stopped the server.`;
    }

    return `Closed ${count} canvas(es). ${remaining} canvas(es) still active.`;
  }

  private ensureMind(mindId: string, mindPath: string): string {
    this.mindPaths.set(mindId, mindPath);
    const contentDir = path.join(mindPath, CANVAS_DIR);
    fs.mkdirSync(contentDir, { recursive: true });
    return contentDir;
  }

  private requireCanvas(mindId: string, name: string): CanvasEntry {
    const existing = this.canvases.get(mindId)?.get(name);
    if (!existing) {
      throw new Error(`Canvas "${name}" not found. Use canvas_show to create it first.`);
    }
    return existing;
  }

  private getContentDirForMind(mindId: string): string | null {
    const mindPath = this.mindPaths.get(mindId);
    return mindPath ? path.join(mindPath, CANVAS_DIR) : null;
  }

  private upsertCanvas(mindId: string, entry: CanvasEntry): void {
    const canvases = this.canvases.get(mindId) ?? new Map<string, CanvasEntry>();
    canvases.set(entry.name, entry);
    this.canvases.set(mindId, canvases);
  }

  private buildCanvasUrl(mindId: string, filename: string, port: number, token: string): string {
    return `http://127.0.0.1:${port}/${encodeURIComponent(mindId)}/${encodeURIComponent(filename)}?token=${encodeURIComponent(token)}`;
  }

  private getLensCanvasName(viewId: string): string {
    const digest = createHash('sha256').update(viewId).digest('hex').slice(0, 16);
    return `lens-${digest}`;
  }

  private decorateCanvasAction(action: CanvasAction): CanvasAction {
    const lensViewId = this.lensViewIdsByCanvas.get(action.mindId)?.get(action.canvas);
    return lensViewId ? { ...action, lensViewId } : action;
  }

  private getExistingToken(mindId: string, name: string): string | null {
    return this.canvases.get(mindId)?.get(name)?.token ?? null;
  }

  private isAuthorizedCanvasRequest(mindId: string, filename: string, token: string | null): boolean {
    if (!token) return false;
    const canvases = this.canvases.get(mindId);
    if (!canvases) return false;
    const normalizedFilename = filename.replace(/\\/g, '/');
    for (const canvas of canvases.values()) {
      if (canvas.filename === normalizedFilename && canvas.token === token) {
        return true;
      }
    }
    return false;
  }

  private removeLensCanvasMapping(mindId: string, filename: string): void {
    const lensViews = this.lensViewIdsByCanvas.get(mindId);
    lensViews?.delete(filename);
    if (lensViews?.size === 0) {
      this.lensViewIdsByCanvas.delete(mindId);
    }
  }

  private deleteCanvasFile(mindId: string, filename: string): void {
    const contentDir = this.getContentDirForMind(mindId);
    if (!contentDir) {
      return;
    }

    fs.rmSync(path.join(contentDir, filename), { force: true });
  }

  private writePresentationSidecar(contentDir: string, name: string, presentation: CanvasPresentation): void {
    const sidecarPath = path.resolve(contentDir, presentationSidecarFilename(name));
    if (!isPathInside(contentDir, sidecarPath)) {
      throw new Error(`Refusing to write presentation sidecar outside canvas content directory: ${sidecarPath}`);
    }
    fs.writeFileSync(sidecarPath, `${JSON.stringify(presentation, null, 2)}\n`, 'utf8');
  }

  private removePresentationSidecar(contentDir: string, name: string): void {
    const sidecarPath = path.resolve(contentDir, presentationSidecarFilename(name));
    if (!isPathInside(contentDir, sidecarPath)) {
      return;
    }
    fs.rmSync(sidecarPath, { force: true });
  }

  private deletePresentationSidecar(mindId: string, name: string): void {
    const contentDir = this.getContentDirForMind(mindId);
    if (!contentDir) {
      return;
    }
    this.removePresentationSidecar(contentDir, name);
  }

  private resolvePresentationForRequest(mindId: string, filename: string): string | null {
    const contentDir = this.getContentDirForMind(mindId);
    if (!contentDir) {
      return null;
    }
    const name = filename.replace(/\.html$/i, '');
    const sidecarName = presentationSidecarFilename(name);
    const sidecarPath = path.resolve(contentDir, sidecarName);
    if (!isPathInside(contentDir, sidecarPath)) {
      return null;
    }
    if (!fs.existsSync(sidecarPath) || !fs.statSync(sidecarPath).isFile()) {
      return null;
    }
    try {
      return fs.readFileSync(sidecarPath, 'utf8');
    } catch {
      return null;
    }
  }

  private totalCanvasCount(): number {
    let count = 0;
    for (const canvases of this.canvases.values()) {
      count += canvases.size;
    }
    return count;
  }

  private async stopServerIfIdle(): Promise<void> {
    if (this.totalCanvasCount() === 0 && this.server.isRunning()) {
      await this.server.stop();
    }
  }
}

function createCanvasToken(): string {
  return randomBytes(32).toString('base64url');
}
