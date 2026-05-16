import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { CanvasServer } from '@chamber/services';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end smoke for the canvas presentation engine (#5). Mirrors the
// canvas-a11y harness pattern: spin up a real CanvasServer pointed at a
// temp directory, then drive a 5-step Sullivan-shaped presentation in a
// real browser. Asserts forward / backward navigation, axe-core cleanliness
// on every step, reduced-motion start-in-linear behavior, view-toggle
// round-trip, and Esc-to-linear.

const MIND_ID = 'pres-mind';
const FILENAME = 'pres-smoke.html';
const TOKEN = 'pres-token';

const STEP_IDS = ['s1', 's2', 's3', 's4', 's5'] as const;

const PRESENTATION = {
  steps: [
    { id: 's1', title: 'Step one', narration: 'Opening of the deck.' },
    { id: 's2', title: 'Step two', narration: 'Establish the problem.' },
    { id: 's3', title: 'Step three', narration: 'Show the data.' },
    { id: 's4', title: 'Step four', narration: 'Propose the move.' },
    { id: 's5', title: 'Step five', narration: 'Wrap up.' },
  ],
};

let server: CanvasServer;
let port: number;
let baseDir: string;
let mindDir: string;

function canvasUrl(): string {
  return `http://127.0.0.1:${port}/${MIND_ID}/${FILENAME}?token=${TOKEN}`;
}

test.beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'chamber-canvas-pres-'));
  mindDir = join(baseDir, MIND_ID);
  mkdirSync(mindDir, { recursive: true });

  const stepsHtml = STEP_IDS.map(
    (id, i) =>
      `<section id="${id}"><h2>Step ${i + 1}</h2><p>Body for ${id}.</p></section>`,
  ).join('\n');

  const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Canvas Presentation Smoke</title>
</head>
<body>
<main id="ch-main" tabindex="-1">
<h1>Canvas Presentation Smoke</h1>
${stepsHtml}
</main>
</body>
</html>`;
  writeFileSync(join(mindDir, FILENAME), page, 'utf8');
  writeFileSync(
    join(mindDir, `${FILENAME}.presentation.json`),
    JSON.stringify(PRESENTATION, null, 2),
    'utf8',
  );

  server = new CanvasServer({
    resolveContentDir: (mindId) => (mindId === MIND_ID ? mindDir : null),
    onAction: () => undefined,
    authorizeRequest: (mindId, filename, token) =>
      mindId === MIND_ID && filename === FILENAME && token === TOKEN,
    resolvePresentation: (mindId, filename) => {
      if (mindId !== MIND_ID || filename !== FILENAME) {
        return null;
      }
      return JSON.stringify(PRESENTATION);
    },
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

test.describe('canvas presentation engine (#5)', () => {
  test('walks forward through every step on ArrowRight and back on ArrowLeft', async ({ page }) => {
    await page.goto(canvasUrl());

    await expect.poll(async () =>
      page.evaluate(() => document.activeElement?.id ?? null),
    ).toBe('s1');

    for (let i = 1; i < STEP_IDS.length; i++) {
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () =>
        page.evaluate(() => document.activeElement?.id ?? null),
      ).toBe(STEP_IDS[i]);
    }

    for (let i = STEP_IDS.length - 2; i >= 0; i--) {
      await page.keyboard.press('ArrowLeft');
      await expect.poll(async () =>
        page.evaluate(() => document.activeElement?.id ?? null),
      ).toBe(STEP_IDS[i]);
    }
  });

  test('every step renders without axe violations', async ({ page }) => {
    await page.goto(canvasUrl());

    for (let i = 0; i < STEP_IDS.length; i++) {
      if (i > 0) {
        await page.keyboard.press('ArrowRight');
        await expect.poll(async () =>
          page.evaluate(() => document.activeElement?.id ?? null),
        ).toBe(STEP_IDS[i]);
      }

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      expect(
        results.violations,
        results.violations
          .map((v) => `[${STEP_IDS[i]}] ${v.id}: ${v.description}`)
          .join('\n'),
      ).toEqual([]);
    }
  });

  test('starts in linear view under prefers-reduced-motion: reduce', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      await page.goto(canvasUrl());
      await expect(page.locator('html')).toHaveAttribute('data-ch-view', 'linear');
    } finally {
      await context.close();
    }
  });

  test('view-toggle button round-trips between flow and linear with the engine attached', async ({ page }) => {
    await page.goto(canvasUrl());

    const root = page.locator('html');
    const toggle = page.locator('button.ch-view-toggle');

    await expect(root).not.toHaveAttribute('data-ch-view', /.+/);
    await toggle.click();
    await expect(root).toHaveAttribute('data-ch-view', 'linear');
    await toggle.click();
    await expect(root).not.toHaveAttribute('data-ch-view', /.+/);
  });

  test('Esc returns to linear view from any step', async ({ page }) => {
    await page.goto(canvasUrl());

    await expect.poll(async () =>
      page.evaluate(() => document.activeElement?.id ?? null),
    ).toBe('s1');

    await page.keyboard.press('ArrowRight');
    await expect.poll(async () =>
      page.evaluate(() => document.activeElement?.id ?? null),
    ).toBe('s2');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () =>
      page.evaluate(() => document.activeElement?.id ?? null),
    ).toBe('s3');

    await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveAttribute('data-ch-view', 'linear');
  });
});
