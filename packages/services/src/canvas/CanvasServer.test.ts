import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasServer } from './CanvasServer';

const tempDirs: string[] = [];

function makeMindDir(name = 'mind-1'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chamber-canvas-server-'));
  const mindDir = path.join(root, name);
  fs.mkdirSync(mindDir, { recursive: true });
  tempDirs.push(root);
  return mindDir;
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ done: boolean; text: string }> {
  const { done, value } = await reader.read();
  return {
    done,
    text: value ? new TextDecoder().decode(value) : '',
  };
}

describe('CanvasServer', () => {
  let server: CanvasServer;
  const mindDirs = new Map<string, string>();
  const tokens = new Map<string, string>();
  const onAction = vi.fn();

  beforeEach(() => {
    mindDirs.clear();
    tokens.clear();
    onAction.mockReset();
    server = new CanvasServer({
      resolveContentDir: (mindId) => mindDirs.get(mindId) ?? null,
      onAction,
      authorizeRequest: (mindId, filename, token) => tokens.get(`${mindId}:${filename}`) === token,
    });
  });

  afterEach(async () => {
    await server.stop();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('serves html with the bridge script injected', async () => {
    const mindDir = makeMindDir();
    mindDirs.set('mind-1', mindDir);
    fs.writeFileSync(
      path.join(mindDir, 'report.html'),
      '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>',
      'utf8',
    );
    tokens.set('mind-1:report.html', 'secret-token');

    const port = await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/mind-1/report.html?token=secret-token`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('--ch-background');
    expect(html).toContain('.ch-card');
    expect(html).toContain("new URLSearchParams(location.search).get('token')");
    expect(html).toContain("new EventSource('_sse?canvas=' + encodeURIComponent(canvasFile) + '&token='");
    expect(html).toContain("fetch('_action?canvas=' + encodeURIComponent(canvasFile) + '&token='");
  });

  it('supports targeted reload and close events over SSE', async () => {
    const mindDir = makeMindDir();
    mindDirs.set('mind-1', mindDir);
    tokens.set('mind-1:report.html', 'secret-token');
    fs.writeFileSync(path.join(mindDir, 'report.html'), '<html><body>Hi</body></html>', 'utf8');

    const port = await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/mind-1/_sse?canvas=report.html&token=secret-token`);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Expected SSE response body');
    }

    const first = await readChunk(reader);
    expect(first.text).toContain('connected');

    server.reload('mind-1', 'report.html');
    const second = await readChunk(reader);
    expect(second.text).toContain('reload');

    server.closeClients('mind-1', 'report.html');
    const third = await readChunk(reader);
    expect(third.text).toContain('close');

    const fourth = await readChunk(reader);
    expect(fourth.done).toBe(true);
  });

  it('routes browser actions back to the callback', async () => {
    const mindDir = makeMindDir();
    mindDirs.set('mind-1', mindDir);
    tokens.set('mind-1:report.html', 'secret-token');

    const port = await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/mind-1/_action?canvas=report.html&token=secret-token`, {
      body: JSON.stringify({
        action: 'button-clicked',
        data: { id: 'approve' },
        timestamp: 123,
      }),
      headers: {
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(onAction).toHaveBeenCalledWith({
      action: 'button-clicked',
      canvas: 'report.html',
      data: { id: 'approve' },
      mindId: 'mind-1',
      timestamp: 123,
    });
  });

  it('rejects Canvas actions without the canvas token', async () => {
    const mindDir = makeMindDir();
    mindDirs.set('mind-1', mindDir);
    tokens.set('mind-1:report.html', 'secret-token');

    const port = await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/mind-1/_action?canvas=report.html`, {
      body: JSON.stringify({ action: 'button-clicked' }),
      headers: {
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    expect(response.status).toBe(403);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('rejects path traversal outside the mind content directory', async () => {
    const mindDir = makeMindDir();
    mindDirs.set('mind-1', mindDir);

    const port = await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/mind-1/..%2Fsecret.txt`);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Forbidden');
  });

  describe('CHAMBER_CANVAS_STYLE a11y baseline (#4)', () => {
    async function fetchServedHtml(): Promise<string> {
      const mindDir = makeMindDir('a11y-mind');
      mindDirs.set('a11y-mind', mindDir);
      tokens.set('a11y-mind:report.html', 'a11y-token');
      fs.writeFileSync(
        path.join(mindDir, 'report.html'),
        '<!DOCTYPE html><html><head></head><body><h1>Hi</h1></body></html>',
        'utf8',
      );
      const port = await server.start();
      const response = await fetch(
        `http://127.0.0.1:${port}/a11y-mind/report.html?token=a11y-token`,
      );
      return response.text();
    }

    it('declares color-scheme: light dark so the canvas honors the OS theme', async () => {
      const html = await fetchServedHtml();
      expect(html).toMatch(/color-scheme:\s*light dark/);
    });

    it('emits :focus-visible rules so keyboard focus is always perceivable', async () => {
      const html = await fetchServedHtml();
      expect(html).toContain(':focus-visible');
    });

    it('collapses transitions and animations under prefers-reduced-motion', async () => {
      const html = await fetchServedHtml();
      expect(html).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
      expect(html).toMatch(
        /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?transition:\s*none\s*!important[\s\S]*?animation:\s*none\s*!important/,
      );
    });

    it('uses CSS system colors inside a forced-colors media block', async () => {
      const html = await fetchServedHtml();
      expect(html).toMatch(/@media\s*\(forced-colors:\s*active\)/);
      expect(html).toMatch(/background:\s*Canvas\b/);
      expect(html).toMatch(/color:\s*CanvasText\b/);
      expect(html).toMatch(/background:\s*ButtonFace\b/);
      expect(html).toMatch(/color:\s*ButtonText\b/);
      expect(html).toMatch(/outline-color:\s*Highlight\b/);
    });

    it('defines a .ch-skip-link rule so the bridge can style the skip target', async () => {
      const html = await fetchServedHtml();
      expect(html).toMatch(/\.ch-skip-link\s*\{/);
    });

    it('declares the :root[data-ch-view="linear"] scroll-behavior hook for the presentation engine in #5', async () => {
      const html = await fetchServedHtml();
      expect(html).toMatch(
        /:root\[data-ch-view="linear"\]\s*\{[\s\S]*?scroll-behavior:\s*auto/,
      );
    });

    it('injects style + skip-link + bridge script even when </HEAD>/</BODY> are uppercase', async () => {
      const mindDir = makeMindDir('a11y-mixedcase');
      mindDirs.set('a11y-mixedcase', mindDir);
      tokens.set('a11y-mixedcase:upper.html', 'a11y-token');
      fs.writeFileSync(
        path.join(mindDir, 'upper.html'),
        '<!DOCTYPE HTML><HTML><HEAD></HEAD><BODY><H1>Hi</H1></BODY></HTML>',
        'utf8',
      );
      const port = await server.start();
      const response = await fetch(
        `http://127.0.0.1:${port}/a11y-mixedcase/upper.html?token=a11y-token`,
      );
      const html = await response.text();

      expect(html).toContain('--ch-background');
      expect(html).toMatch(/<a[^>]*\bclass=["'][^"']*\bch-skip-link\b/i);
      expect(html).toMatch(/<main\b[^>]*\bid=["']ch-main["']/i);
      expect(html).toContain("EventSource('_sse?canvas=");
      const scriptIdx = html.indexOf("EventSource('_sse?canvas=");
      const closeBodyIdx = html.search(/<\/body\s*>/i);
      expect(scriptIdx).toBeGreaterThan(-1);
      expect(closeBodyIdx).toBeGreaterThan(-1);
      expect(scriptIdx).toBeLessThan(closeBodyIdx);
    });
  });

  describe('injectBridge a11y affordances (#4)', () => {
    async function fetchInjectedHtml(
      bodyHtml: string,
      opts?: { headHtml?: string },
    ): Promise<string> {
      const mindId = 'bridge-mind';
      const mindDir = makeMindDir(mindId);
      mindDirs.set(mindId, mindDir);
      const filename = 'report.html';
      tokens.set(`${mindId}:${filename}`, 'bridge-token');
      fs.writeFileSync(
        path.join(mindDir, filename),
        `<!DOCTYPE html><html><head>${opts?.headHtml ?? ''}</head><body>${bodyHtml}</body></html>`,
        'utf8',
      );
      const port = await server.start();
      const response = await fetch(
        `http://127.0.0.1:${port}/${mindId}/${filename}?token=bridge-token`,
      );
      return response.text();
    }

    function countMatches(html: string, pattern: RegExp): number {
      const matches = html.match(pattern);
      return matches ? matches.length : 0;
    }

    it('wraps body content in <main id="ch-main" tabindex="-1"> when no <main> element exists', async () => {
      const html = await fetchInjectedHtml('<h1>Title</h1><p>Body</p>');
      expect(html).toMatch(
        /<main\s+id=["']ch-main["']\s+tabindex=["']-1["']\s*>[\s\S]*<h1>Title<\/h1>[\s\S]*<p>Body<\/p>[\s\S]*<\/main>/,
      );
      expect(countMatches(html, /<main\b/g)).toBe(1);
    });

    it('reuses an existing <main id="ch-main"> instead of double-wrapping', async () => {
      const html = await fetchInjectedHtml('<main id="ch-main"><h1>Existing</h1></main>');
      expect(countMatches(html, /<main\b/g)).toBe(1);
      expect(countMatches(html, /<main\b[^>]*\bid=["']ch-main["']/g)).toBe(1);
    });

    it('adds id="ch-main" and tabindex="-1" to an existing <main> element that has no id', async () => {
      const html = await fetchInjectedHtml('<main><h1>Unlabeled</h1></main>');
      expect(countMatches(html, /<main\b/g)).toBe(1);
      expect(html).toMatch(
        /<main\b[^>]*\bid=["']ch-main["'][^>]*\btabindex=["']-1["'][^>]*>[\s\S]*<h1>Unlabeled<\/h1>[\s\S]*<\/main>/,
      );
    });

    it('points the skip-link at the existing <main> id when it differs from ch-main', async () => {
      const html = await fetchInjectedHtml('<main id="primary"><h1>Custom</h1></main>');
      expect(countMatches(html, /<main\b/g)).toBe(1);
      expect(html).toMatch(
        /<a[^>]*\bclass=["'][^"']*\bch-skip-link\b[^"']*["'][^>]*\bhref=["']#primary["']/,
      );
    });

    it('prepends the .ch-skip-link as the first child of <body> pointing to #ch-main', async () => {
      const html = await fetchInjectedHtml('<h1>Body</h1>');
      expect(html).toMatch(
        /<body[^>]*>\s*<a[^>]*\bclass=["'][^"']*\bch-skip-link\b[^"']*["'][^>]*\bhref=["']#ch-main["']/,
      );
    });

    it('renders a view-toggle button with aria-pressed="false" and data-action="ch-view-toggle"', async () => {
      const html = await fetchInjectedHtml('<h1>Body</h1>');
      const buttonMatch = html.match(
        /<button\b[^>]*\bclass=["'][^"']*\bch-view-toggle\b[^"']*["'][^>]*>/,
      );
      expect(buttonMatch).not.toBeNull();
      const button = buttonMatch?.[0] ?? '';
      expect(button).toMatch(/\baria-pressed=["']false["']/);
      expect(button).toMatch(/\bdata-action=["']ch-view-toggle["']/);
      expect(button).not.toMatch(/\bon[a-z]+=/i);
    });

    it('uses addEventListener to wire the view-toggle to documentElement.dataset.chView without inline handlers', async () => {
      const html = await fetchInjectedHtml('<h1>Body</h1>');
      const scripts = html.match(/<script\b[\s\S]*?<\/script>/g) ?? [];
      const bridge = scripts.find((s) => s.includes("EventSource('_sse")) ?? '';
      expect(bridge).not.toBe('');
      expect(bridge).toMatch(/addEventListener\(\s*['"]click['"]/);
      expect(bridge).toContain('document.documentElement.dataset.chView');
      expect(bridge).not.toContain('document.body.dataset.chView');
      expect(bridge).toMatch(/['"]linear['"]/);
    });

    it('does not duplicate chamber markup when the user HTML already contains skip-link, view-toggle, and <main id="ch-main">', async () => {
      const html = await fetchInjectedHtml(
        [
          '<a class="ch-skip-link" href="#ch-main">Skip to main content</a>',
          '<button class="ch-view-toggle" aria-pressed="false" data-action="ch-view-toggle">Linear</button>',
          '<main id="ch-main"><h1>X</h1></main>',
        ].join(''),
      );
      expect(countMatches(html, /<a[^>]*\bclass=["'][^"']*\bch-skip-link\b/g)).toBe(1);
      expect(countMatches(html, /<button[^>]*\bclass=["'][^"']*\bch-view-toggle\b/g)).toBe(1);
      expect(countMatches(html, /<main\b/g)).toBe(1);
    });
  });
});
