import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { CanvasServer } from '@chamber/services';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Spins up a real CanvasServer pointed at a temp content directory, then asserts
// that the served HTML (post bridge + a11y injection) clears WCAG 2.1 AA via
// axe-core under both prefers-color-scheme variants. Complements the Sullivan
// unit contrast tests by exercising the layered output as a browser sees it.

const MIND_ID = 'a11y-mind';
const FILENAME = 'a11y-smoke.html';
const TOKEN = 'a11y-token';

let server: CanvasServer;
let port: number;
let baseDir: string;

function canvasUrl(): string {
  return `http://127.0.0.1:${port}/${MIND_ID}/${FILENAME}?token=${TOKEN}`;
}

test.beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'chamber-canvas-a11y-'));
  const mindDir = join(baseDir, MIND_ID);
  mkdirSync(mindDir, { recursive: true });

  const wrappedFragment = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Canvas A11y Smoke</title>
</head>
<body>
<main id="ch-main" tabindex="-1">
<h1>Canvas A11y Smoke</h1>
<p>This page exercises the canvas server bridge and a11y baseline output.</p>
<p>Visit the <a href="https://example.com">example link</a> for more information.</p>
<button type="button">Sample action</button>
</main>
</body>
</html>`;
  writeFileSync(join(mindDir, FILENAME), wrappedFragment, 'utf8');

  server = new CanvasServer({
    resolveContentDir: (mindId) => (mindId === MIND_ID ? mindDir : null),
    onAction: () => undefined,
    authorizeRequest: (mindId, filename, token) =>
      mindId === MIND_ID && filename === FILENAME && token === TOKEN,
  });
  port = await server.start();
});

test.afterAll(async () => {
  if (server) {
    await server.stop();
  }
  if (baseDir) {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test.describe('canvas a11y baseline (#4)', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`renders without axe violations under prefers-color-scheme: ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto(canvasUrl());

      await expect(page.locator('main#ch-main')).toBeVisible();
      await expect(page.locator('a.ch-skip-link')).toHaveCount(1);
      await expect(page.locator('button.ch-view-toggle')).toHaveCount(1);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      expect(
        results.violations,
        results.violations
          .map((v) => `${v.id}: ${v.description}\n${v.nodes.map((n) => n.html).join('\n')}`)
          .join('\n\n'),
      ).toEqual([]);
    });
  }

  test('view-toggle flips :root data-ch-view and aria-pressed on click', async ({ page }) => {
    await page.goto(canvasUrl());
    const toggle = page.locator('button.ch-view-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const root = page.locator('html');
    await expect(root).not.toHaveAttribute('data-ch-view', /.+/);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(root).toHaveAttribute('data-ch-view', 'linear');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(root).not.toHaveAttribute('data-ch-view', /.+/);
  });

  test('skip-link points at the main landmark', async ({ page }) => {
    await page.goto(canvasUrl());
    const skipLink = page.locator('a.ch-skip-link');
    await expect(skipLink).toHaveAttribute('href', '#ch-main');
    await expect(page.locator('main#ch-main')).toBeAttached();
  });

  test('Tab focuses the skip-link, Enter moves focus to <main id="ch-main">', async ({ page }) => {
    await page.goto(canvasUrl());
    await expect(page.locator('main#ch-main')).toHaveAttribute('tabindex', '-1');

    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await page.keyboard.press('Tab');

    const firstFocus = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      cls: (document.activeElement as HTMLElement | null)?.className ?? null,
    }));
    expect(firstFocus.tag).toBe('A');
    expect(firstFocus.cls).toContain('ch-skip-link');

    await page.keyboard.press('Enter');

    await expect.poll(async () =>
      page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? null,
        id: (document.activeElement as HTMLElement | null)?.id ?? null,
      })),
    ).toEqual({ tag: 'MAIN', id: 'ch-main' });
  });
});
