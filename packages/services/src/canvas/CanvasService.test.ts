import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasService } from './CanvasService';
import { isPathInside } from './canvasPaths';
import type { CanvasServerLike } from './types';

const tempDirs: string[] = [];

function makeMindPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chamber-canvas-service-'));
  tempDirs.push(dir);
  return dir;
}

class MockCanvasServer implements CanvasServerLike {
  private port: number | null = null;

  readonly start = vi.fn(async () => {
    if (this.port === null) {
      this.port = 4312;
    }
    return this.port;
  });

  readonly stop = vi.fn(async () => {
    this.port = null;
  });

  readonly reload = vi.fn();
  readonly closeClients = vi.fn();

  readonly getPort = vi.fn(() => this.port);
  readonly isRunning = vi.fn(() => this.port !== null);
}

describe('CanvasService', () => {
  let server: MockCanvasServer;
  let openedUrls: string[];
  let service: CanvasService;

  beforeEach(() => {
    server = new MockCanvasServer();
    openedUrls = [];
    service = new CanvasService({
      openExternal: { open: (url) => { openedUrls.push(url); } },
      server,
    });
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('activateMind creates the .chamber\\canvas directory', async () => {
    const mindPath = makeMindPath();

    await service.activateMind('mind-1', mindPath);

    expect(fs.existsSync(path.join(mindPath, '.chamber', 'canvas'))).toBe(true);
  });

  it('shows a wrapped canvas, starts the server, and opens the browser by default', async () => {
    const mindPath = makeMindPath();

    const result = await service.showCanvas('mind-1', mindPath, {
      html: '<h1>Plan</h1>',
      name: 'daily-plan',
    });

    const contentPath = path.join(mindPath, '.chamber', 'canvas', 'daily-plan.html');
    const content = fs.readFileSync(contentPath, 'utf8');

    expect(server.start).toHaveBeenCalledOnce();
    expect(openedUrls[0]).toMatch(/^http:\/\/127\.0\.0\.1:4312\/mind-1\/daily-plan\.html\?token=[A-Za-z0-9_-]+$/);
    expect(content).toContain('<!DOCTYPE html>');
    expect(content).toContain('<h1>Plan</h1>');
    expect(result).toContain('opened in browser');
    expect(service.listCanvases('mind-1', mindPath)).toContain('daily-plan');
  });

  it('can copy an existing html file without opening the browser', async () => {
    const mindPath = makeMindPath();
    const sourceFile = path.join(mindPath, 'source.html');
    fs.writeFileSync(sourceFile, '<html><body>From file</body></html>', 'utf8');

    const result = await service.showCanvas('mind-1', mindPath, {
      file: sourceFile,
      name: 'copied',
      open_browser: false,
    });

    const copied = fs.readFileSync(path.join(mindPath, '.chamber', 'canvas', 'copied.html'), 'utf8');
    expect(copied).toBe('<html><body>From file</body></html>');
    expect(openedUrls).toHaveLength(0);
    expect(result).toMatch(/http:\/\/127\.0\.0\.1:4312\/mind-1\/copied\.html\?token=[A-Za-z0-9_-]+/);
  });

  it('serves a Lens html source as an embedded canvas without opening the browser', async () => {
    const mindPath = makeMindPath();
    const sourceFile = path.join(mindPath, '.github', 'lens', 'command-center', 'index.html');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, '<html><body>Command</body></html>', 'utf8');

    const url = await service.showLensCanvas('mind-1', mindPath, 'command-center', sourceFile);

    expect(server.start).toHaveBeenCalledOnce();
    expect(openedUrls).toHaveLength(0);
    const servedFilename = new URL(url).pathname.split('/').pop();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:4312\/mind-1\/lens-[a-f0-9]{16}\.html\?token=[A-Za-z0-9_-]+$/);
    expect(fs.readFileSync(path.join(mindPath, '.chamber', 'canvas', servedFilename ?? ''), 'utf8')).toContain('Command');
    expect(server.reload).toHaveBeenCalledWith('mind-1', servedFilename);
  });

  it('rejects embedded Lens canvas sources outside the mind lens directory', async () => {
    const mindPath = makeMindPath();
    const sourceFile = path.join(mindPath, 'outside.html');
    fs.writeFileSync(sourceFile, '<html><body>Outside</body></html>', 'utf8');

    await expect(service.showLensCanvas('mind-1', mindPath, 'outside', sourceFile))
      .rejects.toThrow('inside the mind .github/lens directory');
  });

  it('updates an existing canvas and triggers targeted reload', async () => {
    const mindPath = makeMindPath();
    await service.showCanvas('mind-1', mindPath, {
      html: '<h1>Before</h1>',
      name: 'report',
      open_browser: false,
    });

    const result = service.updateCanvas('mind-1', mindPath, {
      html: '<h1>After</h1>',
      name: 'report',
    });

    const content = fs.readFileSync(path.join(mindPath, '.chamber', 'canvas', 'report.html'), 'utf8');
    expect(content).toContain('<h1>After</h1>');
    expect(server.reload).toHaveBeenCalledWith('mind-1', 'report.html');
    expect(result).toContain('updated');
  });

  it('closes a single canvas, removes its file, and stops the server when it was the last one', async () => {
    const mindPath = makeMindPath();
    await service.showCanvas('mind-1', mindPath, {
      html: '<h1>Report</h1>',
      name: 'report',
      open_browser: false,
    });

    const result = await service.closeCanvas('mind-1', mindPath, {
      name: 'report',
    });

    expect(server.closeClients).toHaveBeenCalledWith('mind-1', 'report.html');
    expect(server.stop).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(mindPath, '.chamber', 'canvas', 'report.html'))).toBe(false);
    expect(result).toContain('Server stopped');
  });

  it('close all only affects the current mind and keeps the server running if others remain', async () => {
    const mindPathA = makeMindPath();
    const mindPathB = makeMindPath();

    await service.showCanvas('mind-a', mindPathA, {
      html: '<h1>A</h1>',
      name: 'alpha',
      open_browser: false,
    });
    await service.showCanvas('mind-b', mindPathB, {
      html: '<h1>B</h1>',
      name: 'beta',
      open_browser: false,
    });

    const result = await service.closeCanvas('mind-a', mindPathA, {
      name: 'all',
    });

    expect(server.closeClients).toHaveBeenCalledWith('mind-a');
    expect(server.stop).not.toHaveBeenCalled();
    expect(result).toContain('1 canvas(es) still active');
    expect(service.listCanvases('mind-b', mindPathB)).toContain('beta');
  });

  it('releaseMind closes that mind clients and stops the server when no canvases remain', async () => {
    const mindPath = makeMindPath();
    await service.showCanvas('mind-1', mindPath, {
      html: '<h1>Report</h1>',
      name: 'report',
      open_browser: false,
    });

    await service.releaseMind('mind-1');

    expect(server.closeClients).toHaveBeenCalledWith('mind-1');
    expect(server.stop).toHaveBeenCalledOnce();
  });

  it('rejects invalid names and missing content', async () => {
    const mindPath = makeMindPath();

    await expect(service.showCanvas('mind-1', mindPath, {
      html: '<h1>Bad</h1>',
      name: '../bad',
    })).rejects.toThrow('Invalid canvas name');

    await expect(service.showCanvas('mind-1', mindPath, {
      name: 'empty',
    })).rejects.toThrow('canvas_show requires either "html" or "file"');
  });

  describe('a11y baseline wrapping (#4)', () => {
    function readCanvasFile(mindPath: string, name: string): string {
      return fs.readFileSync(
        path.join(mindPath, '.chamber', 'canvas', `${name}.html`),
        'utf8',
      );
    }

    it('wraps fragment HTML in <main id="ch-main" tabindex="-1"> so the skip link has a target', async () => {
      const mindPath = makeMindPath();

      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>Lesson</h1>',
        name: 'lesson',
        open_browser: false,
      });

      const content = readCanvasFile(mindPath, 'lesson');
      expect(content).toMatch(
        /<main\s+id="ch-main"\s+tabindex="-1"[^>]*>[\s\S]*?<h1>Lesson<\/h1>[\s\S]*?<\/main>/,
      );
    });

    it('HTML-escapes title when wrapping a fragment to prevent <title> breakout', async () => {
      const mindPath = makeMindPath();

      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>x</h1>',
        name: 'safe',
        open_browser: false,
        title: '</title><script>alert(1)</script>',
      });

      const content = readCanvasFile(mindPath, 'safe');
      expect(content).not.toContain('</title><script>alert(1)</script>');
      expect(content).toContain(
        '&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
      );
    });

    it('HTML-escapes title when updating a canvas to prevent <title> breakout', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>x</h1>',
        name: 'safe',
        open_browser: false,
      });

      service.updateCanvas('mind-1', mindPath, {
        html: '<h1>y</h1>',
        name: 'safe',
        title: '<img src=x onerror=alert(1)>',
      });

      const content = readCanvasFile(mindPath, 'safe');
      expect(content).not.toContain('<img src=x onerror=alert(1)>');
      expect(content).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
  });

  describe('lang propagation (#4)', () => {
    function readCanvasFile(mindPath: string, name: string): string {
      return fs.readFileSync(
        path.join(mindPath, '.chamber', 'canvas', `${name}.html`),
        'utf8',
      );
    }

    it('defaults to <html lang="en"> when no lang is provided', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>x</h1>',
        name: 'default-lang',
        open_browser: false,
      });

      const content = readCanvasFile(mindPath, 'default-lang');
      expect(content).toMatch(/<html\s+lang="en"\s*>/);
    });

    it.each([
      ['fr', '<html lang="fr">'],
      ['en-US', '<html lang="en-US">'],
      ['pt-BR', '<html lang="pt-BR">'],
      ['zh-Hans', '<html lang="zh-Hans">'],
    ])('propagates valid lang %s to the generated <html> tag', async (lang, expectedFragment) => {
      const mindPath = makeMindPath();
      const safeName = `lang-${lang.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>x</h1>',
        name: safeName,
        open_browser: false,
        lang,
      });

      const content = readCanvasFile(mindPath, safeName);
      expect(content).toContain(expectedFragment);
    });

    it.each([
      ['EN_US', 'underscore separator is not valid BCP-47'],
      ['english', 'primary subtag exceeds 3 characters'],
      ['en"><script>', 'angle brackets / quotes break out'],
      ['en; alert(1)', 'punctuation and spaces are not valid subtag chars'],
      ['', 'empty lang must be rejected'],
      ['x'.repeat(50), 'overly long primary subtag must be rejected'],
    ])('rejects invalid lang %j (%s)', async (lang) => {
      const mindPath = makeMindPath();
      const safeName = `invalid-${Math.random().toString(36).slice(2, 10)}`;
      await expect(
        service.showCanvas('mind-1', mindPath, {
          html: '<h1>x</h1>',
          name: safeName,
          open_browser: false,
          lang,
        }),
      ).rejects.toThrow(/lang/i);
    });

    it('propagates valid lang on updateCanvas', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>before</h1>',
        name: 'updatable',
        open_browser: false,
      });

      service.updateCanvas('mind-1', mindPath, {
        html: '<h1>after</h1>',
        name: 'updatable',
        lang: 'pt-BR',
      });

      const content = readCanvasFile(mindPath, 'updatable');
      expect(content).toMatch(/<html\s+lang="pt-BR"\s*>/);
    });

    it('rejects invalid lang on updateCanvas', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>x</h1>',
        name: 'invalid-update',
        open_browser: false,
      });

      expect(() =>
        service.updateCanvas('mind-1', mindPath, {
          html: '<h1>y</h1>',
          name: 'invalid-update',
          lang: 'en"><script>',
        }),
      ).toThrow(/lang/i);
    });

    it('does not inject lang into user-provided full HTML documents', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<!DOCTYPE html><html lang="ja"><body><h1>x</h1></body></html>',
        name: 'user-html',
        open_browser: false,
        lang: 'pt-BR',
      });

      const content = readCanvasFile(mindPath, 'user-html');
      expect(content).toContain('<html lang="ja">');
      expect(content).not.toContain('<html lang="pt-BR">');
    });
  });

  describe('presentation sidecar (#5)', () => {
    function sidecarPath(mindPath: string, name: string): string {
      return path.join(mindPath, '.chamber', 'canvas', `${name}.presentation.json`);
    }

    function readSidecar(mindPath: string, name: string): unknown {
      return JSON.parse(fs.readFileSync(sidecarPath(mindPath, name), 'utf8'));
    }

    const minimalPresentation = {
      steps: [
        { id: 'intro', title: 'Intro' },
        { id: 'detail', title: 'Detail' },
      ],
    };

    it('writes the sidecar JSON next to the HTML when showCanvas carries presentation', async () => {
      const mindPath = makeMindPath();

      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>Hi</h1>',
        name: 'flow',
        open_browser: false,
        presentation: minimalPresentation,
      });

      expect(fs.existsSync(sidecarPath(mindPath, 'flow'))).toBe(true);
      expect(readSidecar(mindPath, 'flow')).toEqual(minimalPresentation);
    });

    it('does not write a sidecar when showCanvas omits presentation', async () => {
      const mindPath = makeMindPath();

      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>Hi</h1>',
        name: 'plain',
        open_browser: false,
      });

      expect(fs.existsSync(sidecarPath(mindPath, 'plain'))).toBe(false);
    });

    it('removes a stale sidecar when re-showing the same name without presentation', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>Hi</h1>',
        name: 'mixed',
        open_browser: false,
        presentation: minimalPresentation,
      });
      expect(fs.existsSync(sidecarPath(mindPath, 'mixed'))).toBe(true);

      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>Hi again</h1>',
        name: 'mixed',
        open_browser: false,
      });

      expect(fs.existsSync(sidecarPath(mindPath, 'mixed'))).toBe(false);
    });

    it('updateCanvas with presentation overwrites the existing sidecar', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>Hi</h1>',
        name: 'flow',
        open_browser: false,
        presentation: minimalPresentation,
      });

      const next = {
        steps: [{ id: 'only', title: 'Only step' }],
        startStepId: 'only',
      };
      service.updateCanvas('mind-1', mindPath, {
        html: '<h1>After</h1>',
        name: 'flow',
        presentation: next,
      });

      expect(readSidecar(mindPath, 'flow')).toEqual(next);
    });

    it('updateCanvas without presentation leaves the existing sidecar untouched (additive semantics)', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>Hi</h1>',
        name: 'flow',
        open_browser: false,
        presentation: minimalPresentation,
      });

      service.updateCanvas('mind-1', mindPath, {
        html: '<h1>Refreshed HTML</h1>',
        name: 'flow',
      });

      expect(fs.existsSync(sidecarPath(mindPath, 'flow'))).toBe(true);
      expect(readSidecar(mindPath, 'flow')).toEqual(minimalPresentation);
    });

    it('closeCanvas deletes both the HTML and the sidecar', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>Hi</h1>',
        name: 'flow',
        open_browser: false,
        presentation: minimalPresentation,
      });
      expect(fs.existsSync(sidecarPath(mindPath, 'flow'))).toBe(true);

      await service.closeCanvas('mind-1', mindPath, { name: 'flow' });

      expect(fs.existsSync(path.join(mindPath, '.chamber', 'canvas', 'flow.html'))).toBe(false);
      expect(fs.existsSync(sidecarPath(mindPath, 'flow'))).toBe(false);
    });

    it('closeCanvas "all" deletes every sidecar', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>A</h1>',
        name: 'alpha',
        open_browser: false,
        presentation: minimalPresentation,
      });
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>B</h1>',
        name: 'beta',
        open_browser: false,
        presentation: minimalPresentation,
      });

      await service.closeCanvas('mind-1', mindPath, { name: 'all' });

      expect(fs.existsSync(sidecarPath(mindPath, 'alpha'))).toBe(false);
      expect(fs.existsSync(sidecarPath(mindPath, 'beta'))).toBe(false);
    });

    it('rejects a step transition longer than the Sullivan per-step budget (WCAG 2.2.2)', async () => {
      const mindPath = makeMindPath();

      await expect(
        service.showCanvas('mind-1', mindPath, {
          html: '<h1>x</h1>',
          name: 'too-long',
          open_browser: false,
          presentation: {
            steps: [{ id: 'a', title: 'A', transition: { kind: 'fade', durationMs: 801 } }],
          },
        }),
      ).rejects.toThrow(/WCAG 2\.2\.2|MAX_TRANSITION_DURATION_MS|800/);
    });

    it('rejects when the aggregate transition budget is exceeded', async () => {
      const mindPath = makeMindPath();

      await expect(
        service.showCanvas('mind-1', mindPath, {
          html: '<h1>x</h1>',
          name: 'aggregate',
          open_browser: false,
          presentation: {
            steps: [
              { id: 'a', title: 'A', transition: { kind: 'fade', durationMs: 800 } },
              { id: 'b', title: 'B', transition: { kind: 'fade', durationMs: 800 } },
              { id: 'c', title: 'C', transition: { kind: 'fade', durationMs: 800 } },
              { id: 'd', title: 'D', transition: { kind: 'fade', durationMs: 800 } },
              { id: 'e', title: 'E', transition: { kind: 'fade', durationMs: 800 } },
              { id: 'f', title: 'F', transition: { kind: 'fade', durationMs: 800 } },
            ],
          },
        }),
      ).rejects.toThrow(/aggregate|MAX_AGGREGATE_TRANSITION_DURATION_MS|4000/);
    });

    it('rejects auto-advance shorter than 2000ms (per Issue #5 acceptance)', async () => {
      const mindPath = makeMindPath();

      await expect(
        service.showCanvas('mind-1', mindPath, {
          html: '<h1>x</h1>',
          name: 'fast-auto',
          open_browser: false,
          presentation: {
            steps: [{ id: 'a', title: 'A' }],
            options: { autoAdvance: { intervalMs: 1999 } },
          },
        }),
      ).rejects.toThrow(/autoAdvance|2000/);
    });

    it('rejects an empty steps array', async () => {
      const mindPath = makeMindPath();

      await expect(
        service.showCanvas('mind-1', mindPath, {
          html: '<h1>x</h1>',
          name: 'empty',
          open_browser: false,
          presentation: { steps: [] },
        }),
      ).rejects.toThrow(/at least one step|steps/);
    });

    it('rejects an empty step id', async () => {
      const mindPath = makeMindPath();

      await expect(
        service.showCanvas('mind-1', mindPath, {
          html: '<h1>x</h1>',
          name: 'empty-id',
          open_browser: false,
          presentation: { steps: [{ id: '', title: 'Empty' }] },
        }),
      ).rejects.toThrow(/step id/i);
    });

    it('rejects duplicate step ids', async () => {
      const mindPath = makeMindPath();

      await expect(
        service.showCanvas('mind-1', mindPath, {
          html: '<h1>x</h1>',
          name: 'dup',
          open_browser: false,
          presentation: {
            steps: [
              { id: 'same', title: 'First' },
              { id: 'same', title: 'Second' },
            ],
          },
        }),
      ).rejects.toThrow(/duplicate|unique/i);
    });

    it('resolved sidecar path stays inside the canvas content directory', async () => {
      const mindPath = makeMindPath();
      await service.showCanvas('mind-1', mindPath, {
        html: '<h1>x</h1>',
        name: 'safe-path',
        open_browser: false,
        presentation: minimalPresentation,
      });

      const contentDir = path.join(mindPath, '.chamber', 'canvas');
      const sidecar = sidecarPath(mindPath, 'safe-path');
      expect(isPathInside(contentDir, sidecar)).toBe(true);
    });
  });

  describe('integration: real CanvasServer end-to-end (#5)', () => {
    let realService: CanvasService;

    beforeEach(() => {
      realService = new CanvasService({
        openExternal: { open: () => {} },
      });
    });

    afterEach(async () => {
      await realService.releaseMind('mind-1').catch(() => {});
    });

    it('serves a canvas with engine injected when showCanvas wrote a presentation sidecar', async () => {
      const mindPath = makeMindPath();
      const result = await realService.showCanvas('mind-1', mindPath, {
        html: '<section id="a"></section><section id="b"></section>',
        name: 'flow',
        open_browser: false,
        presentation: {
          steps: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
          ],
        },
      });
      const url = result.match(/https?:\/\/\S+/)?.[0] ?? '';

      const response = await fetch(url);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('__chamberCanvas:presentation');
      expect(html).toContain('createPresentationEngine');
    });

    it('serves a canvas WITHOUT engine injected when no presentation was supplied', async () => {
      const mindPath = makeMindPath();
      const result = await realService.showCanvas('mind-1', mindPath, {
        html: '<h1>plain</h1>',
        name: 'plain',
        open_browser: false,
      });
      const url = result.match(/https?:\/\/\S+/)?.[0] ?? '';

      const response = await fetch(url);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).not.toContain('createPresentationEngine');
      expect(html).not.toContain('__chamberCanvas:presentation');
    });
  });
});
