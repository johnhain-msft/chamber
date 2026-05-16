import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { URL } from 'node:url';
import { CANVAS_PALETTE_DARK, CANVAS_PALETTE_LIGHT } from './canvasPalette';
import { isPathInside } from './canvasPaths';
import type { CanvasAction, CanvasServerLike } from './types';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

interface CanvasServerOptions {
  resolveContentDir: (mindId: string) => string | null;
  onAction: (action: CanvasAction) => void;
  authorizeRequest: (mindId: string, filename: string, token: string | null) => boolean;
  /**
   * Returns the presentation sidecar JSON for `(mindId, filename)` or null when
   * no sidecar exists. Optional so existing callers (and tests) without
   * presentation support continue to compile and behave as before — when
   * absent, the server behaves as if every canvas lacks a presentation.
   */
  resolvePresentation?: (mindId: string, filename: string) => string | null;
}

type CanvasClient = ServerResponse<IncomingMessage>;

const CHAMBER_CANVAS_STYLE = `
<style>
:root {
  color-scheme: light dark;
  --ch-background: ${CANVAS_PALETTE_DARK.background};
  --ch-foreground: ${CANVAS_PALETTE_DARK.foreground};
  --ch-card: ${CANVAS_PALETTE_DARK.card};
  --ch-border: ${CANVAS_PALETTE_DARK.border};
  --ch-muted: ${CANVAS_PALETTE_DARK.muted};
  --ch-muted-foreground: ${CANVAS_PALETTE_DARK.mutedForeground};
  --ch-accent: ${CANVAS_PALETTE_DARK.accent};
  --ch-genesis: ${CANVAS_PALETTE_DARK.genesis};
  --ch-link: ${CANVAS_PALETTE_DARK.link};
  --ch-link-visited: ${CANVAS_PALETTE_DARK.linkVisited};
  --ch-skip-link-bg: ${CANVAS_PALETTE_DARK.skipLinkBg};
  --ch-skip-link-fg: ${CANVAS_PALETTE_DARK.skipLinkFg};
  --ch-focus-ring: ${CANVAS_PALETTE_DARK.focusRing};
  --ch-radius: 0.75rem;
  --ch-font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --ch-font-mono: "JetBrains Mono", ui-monospace, monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    --ch-background: ${CANVAS_PALETTE_LIGHT.background};
    --ch-foreground: ${CANVAS_PALETTE_LIGHT.foreground};
    --ch-card: ${CANVAS_PALETTE_LIGHT.card};
    --ch-border: ${CANVAS_PALETTE_LIGHT.border};
    --ch-muted: ${CANVAS_PALETTE_LIGHT.muted};
    --ch-muted-foreground: ${CANVAS_PALETTE_LIGHT.mutedForeground};
    --ch-accent: ${CANVAS_PALETTE_LIGHT.accent};
    --ch-genesis: ${CANVAS_PALETTE_LIGHT.genesis};
    --ch-link: ${CANVAS_PALETTE_LIGHT.link};
    --ch-link-visited: ${CANVAS_PALETTE_LIGHT.linkVisited};
    --ch-skip-link-bg: ${CANVAS_PALETTE_LIGHT.skipLinkBg};
    --ch-skip-link-fg: ${CANVAS_PALETTE_LIGHT.skipLinkFg};
    --ch-focus-ring: ${CANVAS_PALETTE_LIGHT.focusRing};
  }
}
* { box-sizing: border-box; }
html, body { min-height: 100%; }
body {
  margin: 0;
  background: var(--ch-background);
  color: var(--ch-foreground);
  font-family: var(--ch-font-sans);
}
:root[data-ch-view="linear"] { scroll-behavior: auto; }
.ch-page { min-height: 100vh; padding: 1.5rem; background: var(--ch-background); color: var(--ch-foreground); }
.ch-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; }
.ch-card { border: 1px solid var(--ch-border); border-radius: var(--ch-radius); background: var(--ch-card); padding: 1rem; }
.ch-muted { color: var(--ch-muted-foreground); }
.ch-button, .ch-button-secondary {
  border: 0;
  border-radius: 0.5rem;
  cursor: pointer;
  font: inherit;
  padding: 0.5rem 0.75rem;
}
.ch-button { background: var(--ch-foreground); color: var(--ch-background); }
.ch-button-secondary { background: var(--ch-muted); color: var(--ch-foreground); }
.ch-input {
  width: 100%;
  border: 1px solid var(--ch-border);
  border-radius: 0.5rem;
  background: var(--ch-muted);
  color: var(--ch-foreground);
  font: inherit;
  padding: 0.5rem 0.75rem;
}
.ch-input::placeholder { color: var(--ch-muted-foreground); }
.ch-table { width: 100%; border-collapse: collapse; }
.ch-table th, .ch-table td { border-bottom: 1px solid var(--ch-border); padding: 0.625rem; text-align: left; }
.ch-table th { color: var(--ch-muted-foreground); }
.ch-badge { border: 1px solid var(--ch-border); border-radius: 999px; display: inline-flex; padding: 0.125rem 0.5rem; color: var(--ch-muted-foreground); }
a { color: var(--ch-link); }
a:visited { color: var(--ch-link-visited); }
:focus-visible {
  outline: 2px solid var(--ch-focus-ring);
  outline-offset: 2px;
}
.ch-skip-link {
  position: absolute;
  left: 0.5rem;
  top: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--ch-skip-link-bg);
  color: var(--ch-skip-link-fg);
  border: 2px solid var(--ch-focus-ring);
  border-radius: 0.5rem;
  text-decoration: none;
  font: inherit;
  transform: translateY(-200%);
  transition: transform 150ms ease;
  z-index: 1000;
}
.ch-skip-link:focus,
.ch-skip-link:focus-visible {
  transform: translateY(0);
}
.ch-view-toggle {
  background: var(--ch-muted);
  color: var(--ch-foreground);
  border: 1px solid var(--ch-border);
  border-radius: 0.5rem;
  padding: 0.375rem 0.625rem;
  font: inherit;
  cursor: pointer;
}
.ch-view-toggle[aria-pressed="true"] {
  background: var(--ch-foreground);
  color: var(--ch-background);
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    scroll-behavior: auto !important;
  }
}
@media (forced-colors: active) {
  body { background: Canvas; color: CanvasText; }
  .ch-card { background: Canvas; border-color: CanvasText; }
  .ch-button { background: ButtonFace; color: ButtonText; border: 1px solid ButtonText; }
  .ch-button-secondary { background: ButtonFace; color: ButtonText; border: 1px solid ButtonText; }
  .ch-input { background: Field; color: FieldText; border: 1px solid FieldText; }
  .ch-skip-link { background: ButtonFace; color: ButtonText; border-color: Highlight; }
  .ch-view-toggle { background: ButtonFace; color: ButtonText; border: 1px solid ButtonText; }
  .ch-view-toggle[aria-pressed="true"] { background: Highlight; color: HighlightText; }
  .ch-badge { background: Canvas; color: CanvasText; border-color: CanvasText; }
  a { color: LinkText; }
  a:visited { color: VisitedText; }
  :focus-visible { outline-color: Highlight; }
}
</style>`;

function buildBridgeScript(filename: string, opts: { hasPresentation: boolean } = { hasPresentation: false }): string {
  const presentationFetch = opts.hasPresentation
    ? `
  window.__chamberCanvas = window.__chamberCanvas || { presentation: null };
  fetch('_presentation?canvas=' + encodeURIComponent(canvasFile) + '&token=' + encodeURIComponent(canvasToken))
    .then(function(r) { return r.status === 200 ? r.json() : null; })
    .then(function(json) {
      window.__chamberCanvas.presentation = json;
      document.dispatchEvent(new CustomEvent('__chamberCanvas:presentation', { detail: json }));
    })
    .catch(function() {
      window.__chamberCanvas.presentation = null;
      document.dispatchEvent(new CustomEvent('__chamberCanvas:presentation', { detail: null }));
    });
`
    : '';
  return `
<script>
(function() {
  var canvasFile = ${JSON.stringify(filename)};
  var canvasToken = new URLSearchParams(location.search).get('token') || '';
  var es = new EventSource('_sse?canvas=' + encodeURIComponent(canvasFile) + '&token=' + encodeURIComponent(canvasToken));
  es.onmessage = function(e) {
    if (e.data === 'reload') { location.reload(); }
    if (e.data === 'close') { window.close(); }
  };

  window.canvas = {
    sendAction: function(name, data) {
      return fetch('_action?canvas=' + encodeURIComponent(canvasFile) + '&token=' + encodeURIComponent(canvasToken), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: name, data: data || {}, timestamp: Date.now() })
      });
    }
  };
${presentationFetch}
  function wireViewToggle() {
    var btn = document.querySelector('button.ch-view-toggle');
    if (!btn || btn.dataset.chWired === '1') { return; }
    btn.dataset.chWired = '1';
    btn.addEventListener('click', function() {
      var nextLinear = document.documentElement.dataset.chView !== 'linear';
      if (nextLinear) {
        document.documentElement.dataset.chView = 'linear';
        btn.setAttribute('aria-pressed', 'true');
      } else {
        delete document.documentElement.dataset.chView;
        btn.setAttribute('aria-pressed', 'false');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireViewToggle);
  } else {
    wireViewToggle();
  }
})();
</script>`;
}

function escapeReplacement(value: string): string {
  return value.replace(/\$/g, '$$$$');
}

function findBodyOpen(html: string): { match: string; start: number; end: number } | null {
  const match = html.match(/<body\b[^>]*>/i);
  if (!match || match.index === undefined) {
    return null;
  }
  return { match: match[0], start: match.index, end: match.index + match[0].length };
}

function injectStyle(html: string): string {
  const headCloseMatch = html.match(/<\/head\s*>/i);
  if (headCloseMatch && headCloseMatch.index !== undefined) {
    const idx = headCloseMatch.index;
    return `${html.slice(0, idx)}${CHAMBER_CANVAS_STYLE}\n${html.slice(idx)}`;
  }
  const bodyOpen = findBodyOpen(html);
  if (bodyOpen) {
    return `${html.slice(0, bodyOpen.start)}<head>${CHAMBER_CANVAS_STYLE}</head>${html.slice(bodyOpen.start)}`;
  }
  return `${CHAMBER_CANVAS_STYLE}${html}`;
}

function resolveMainElement(html: string): { html: string; mainId: string } {
  const mainOpenMatch = html.match(/<main\b([^>]*)>/i);
  if (mainOpenMatch) {
    const attrs = mainOpenMatch[1] ?? '';
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/);
    if (idMatch && idMatch[1]) {
      return { html, mainId: idMatch[1] };
    }
    const tabindexSuffix = /\btabindex\s*=/i.test(attrs) ? '' : ' tabindex="-1"';
    const replacement = `<main${attrs} id="ch-main"${tabindexSuffix}>`;
    return {
      html: html.replace(mainOpenMatch[0], escapeReplacement(replacement)),
      mainId: 'ch-main',
    };
  }

  const bodyOpen = findBodyOpen(html);
  const bodyCloseMatch = html.match(/<\/body\s*>/i);
  if (bodyOpen && bodyCloseMatch && bodyCloseMatch.index !== undefined) {
    const before = html.slice(0, bodyOpen.end);
    const body = html.slice(bodyOpen.end, bodyCloseMatch.index);
    const after = html.slice(bodyCloseMatch.index);
    return {
      html: `${before}<main id="ch-main" tabindex="-1">${body}</main>${after}`,
      mainId: 'ch-main',
    };
  }

  return {
    html: `${html}<main id="ch-main" tabindex="-1"></main>`,
    mainId: 'ch-main',
  };
}

function injectSkipLink(html: string, mainId: string): string {
  if (/<a\b[^>]*\bclass\s*=\s*["'][^"']*\bch-skip-link\b/i.test(html)) {
    return html;
  }
  const safeMainId = mainId.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const skipLink = `<a class="ch-skip-link" href="#${safeMainId}">Skip to main content</a>`;
  const bodyOpen = findBodyOpen(html);
  if (bodyOpen) {
    return `${html.slice(0, bodyOpen.end)}${skipLink}${html.slice(bodyOpen.end)}`;
  }
  return `${skipLink}${html}`;
}

function injectViewToggle(html: string): string {
  if (/<button\b[^>]*\bclass\s*=\s*["'][^"']*\bch-view-toggle\b/i.test(html)) {
    return html;
  }
  const button = `<button type="button" class="ch-view-toggle" aria-pressed="false" data-action="ch-view-toggle">Linear view</button>`;
  const skipLinkMatch = html.match(/<a\b[^>]*\bclass\s*=\s*["'][^"']*\bch-skip-link\b[^"']*["'][^>]*>[\s\S]*?<\/a>/i);
  if (skipLinkMatch && skipLinkMatch.index !== undefined) {
    const insertAt = skipLinkMatch.index + skipLinkMatch[0].length;
    return `${html.slice(0, insertAt)}${button}${html.slice(insertAt)}`;
  }
  const bodyOpen = findBodyOpen(html);
  if (bodyOpen) {
    return `${html.slice(0, bodyOpen.end)}${button}${html.slice(bodyOpen.end)}`;
  }
  return `${button}${html}`;
}

function injectScript(html: string, bridgeScript: string): string {
  const bodyCloseMatch = html.match(/<\/body\s*>/i);
  if (bodyCloseMatch && bodyCloseMatch.index !== undefined) {
    const idx = bodyCloseMatch.index;
    return `${html.slice(0, idx)}${bridgeScript}\n${html.slice(idx)}`;
  }
  const htmlCloseMatch = html.match(/<\/html\s*>/i);
  if (htmlCloseMatch && htmlCloseMatch.index !== undefined) {
    const idx = htmlCloseMatch.index;
    return `${html.slice(0, idx)}${bridgeScript}\n${html.slice(idx)}`;
  }
  return `${html}${bridgeScript}`;
}

function injectBridge(html: string, filename: string, opts: { hasPresentation: boolean } = { hasPresentation: false }): string {
  const bridgeScript = buildBridgeScript(filename, opts);
  const styled = injectStyle(html);
  const { html: withMain, mainId } = resolveMainElement(styled);
  const withSkip = injectSkipLink(withMain, mainId);
  const withToggle = injectViewToggle(withSkip);
  return injectScript(withToggle, bridgeScript);
}

function readRequestBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export class CanvasServer implements CanvasServerLike {
  private server: Server | null = null;
  private port: number | null = null;
  private readonly sseClients = new Map<string, Set<CanvasClient>>();

  constructor(private readonly options: CanvasServerOptions) {}

  async start(): Promise<number> {
    if (this.server) {
      if (this.port === null) {
        throw new Error('Canvas server is running without a bound port');
      }
      return this.port;
    }

    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Canvas server failed to bind to a TCP port'));
          return;
        }

        this.server = server;
        this.port = address.port;
        resolve(address.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.closeClients();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.server = null;
    this.port = null;
    this.sseClients.clear();
  }

  reload(mindId?: string, filename?: string): void {
    this.broadcast('reload', mindId, filename);
  }

  closeClients(mindId?: string, filename?: string): void {
    const entries = this.matchingClientEntries(mindId, filename);
    for (const [key, clients] of entries) {
      for (const client of clients) {
        try {
          client.write('data: close\n\n');
          client.end();
        } catch {
          // Ignore client disconnect races during close.
        }
      }
      this.sseClients.delete(key);
    }
  }

  getPort(): number | null {
    return this.port;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const segments = requestUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (segments.length === 0) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const [mindId, ...rest] = segments;
    if (!mindId) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (rest.length === 1 && rest[0] === '_sse') {
      this.handleSse(req, res, mindId, requestUrl.searchParams.get('canvas'), requestUrl.searchParams.get('token'));
      return;
    }

    if (rest.length === 1 && rest[0] === '_action') {
      await this.handleAction(req, res, mindId, requestUrl.searchParams.get('canvas'), requestUrl.searchParams.get('token'));
      return;
    }

    if (rest.length === 1 && rest[0] === '_presentation') {
      this.handlePresentation(
        req,
        res,
        mindId,
        requestUrl.searchParams.get('canvas'),
        requestUrl.searchParams.get('token'),
      );
      return;
    }

    this.handleStaticFile(res, mindId, rest, requestUrl.searchParams.get('token'));
  }

  private handleSse(req: IncomingMessage, res: ServerResponse, mindId: string, filename: string | null, token: string | null): void {
    if (!filename) {
      res.writeHead(400);
      res.end('Missing canvas query parameter');
      return;
    }
    if (!this.options.authorizeRequest(mindId, filename, token)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    res.writeHead(200, {
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    });
    res.write('data: connected\n\n');

    this.addClient(mindId, filename, res);
    req.on('close', () => {
      this.removeClient(mindId, filename, res);
    });
  }

  private async handleAction(req: IncomingMessage, res: ServerResponse, mindId: string, filename: string | null, token: string | null): Promise<void> {
    if (!filename) {
      res.writeHead(400);
      res.end('{"error":"missing canvas"}');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('{"error":"method not allowed"}');
      return;
    }
    if (!this.options.authorizeRequest(mindId, filename, token)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
      res.writeHead(415);
      res.end('{"error":"unsupported media type"}');
      return;
    }

    try {
      const body = await readRequestBody(req);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      this.options.onAction({
        mindId,
        canvas: filename,
        action: typeof parsed.action === 'string' ? parsed.action : 'unknown',
        data: parsed.data,
        timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now(),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end('{"ok":true}');
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
    }
  }

  private handlePresentation(
    req: IncomingMessage,
    res: ServerResponse,
    mindId: string,
    filename: string | null,
    token: string | null,
  ): void {
    if (!filename) {
      res.writeHead(400);
      res.end('{"error":"missing canvas"}');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('{"error":"method not allowed"}');
      return;
    }
    if (!this.options.authorizeRequest(mindId, filename, token)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    const sidecar = this.options.resolvePresentation
      ? this.options.resolvePresentation(mindId, filename)
      : null;
    if (sidecar === null) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(sidecar);
  }

  private handleStaticFile(res: ServerResponse, mindId: string, segments: string[], token: string | null): void {
    const contentDir = this.options.resolveContentDir(mindId);
    if (!contentDir) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const relativePath = segments.length === 0 ? 'index.html' : path.join(...segments);
    const fullPath = path.resolve(contentDir, relativePath);
    if (!isPathInside(contentDir, fullPath)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');
    if (!this.options.authorizeRequest(mindId, normalizedRelativePath, token)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    try {
      let content: Buffer | string = fs.readFileSync(fullPath);
      const extension = path.extname(fullPath).toLowerCase();
      const mimeType = MIME_TYPES[extension] ?? 'application/octet-stream';

      if (extension === '.html') {
        const hasPresentation = this.options.resolvePresentation
          ? this.options.resolvePresentation(mindId, normalizedRelativePath) !== null
          : false;
        content = injectBridge(content.toString('utf8'), normalizedRelativePath, { hasPresentation });
      }

      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': mimeType,
      });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end('Server error');
    }
  }

  private broadcast(message: 'reload' | 'close', mindId?: string, filename?: string): void {
    const entries = this.matchingClientEntries(mindId, filename);
    for (const [, clients] of entries) {
      for (const client of clients) {
        try {
          client.write(`data: ${message}\n\n`);
        } catch {
          // Ignore client disconnect races during broadcast.
        }
      }
    }
  }

  private addClient(mindId: string, filename: string, client: CanvasClient): void {
    const key = this.clientKey(mindId, filename);
    const clients = this.sseClients.get(key) ?? new Set<CanvasClient>();
    clients.add(client);
    this.sseClients.set(key, clients);
  }

  private removeClient(mindId: string, filename: string, client: CanvasClient): void {
    const key = this.clientKey(mindId, filename);
    const clients = this.sseClients.get(key);
    if (!clients) {
      return;
    }

    clients.delete(client);
    if (clients.size === 0) {
      this.sseClients.delete(key);
    }
  }

  private matchingClientEntries(mindId?: string, filename?: string): Array<[string, Set<CanvasClient>]> {
    if (mindId && filename) {
      const clients = this.sseClients.get(this.clientKey(mindId, filename));
      return clients ? [[this.clientKey(mindId, filename), clients]] : [];
    }

    if (mindId) {
      const prefix = `${mindId}:`;
      return [...this.sseClients.entries()].filter(([key]) => key.startsWith(prefix));
    }

    return [...this.sseClients.entries()];
  }

  private clientKey(mindId: string, filename: string): string {
    return `${mindId}:${filename}`;
  }
}
