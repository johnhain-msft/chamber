import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { isPathInside, normalizePath } from './canvasPaths';

describe('canvasPaths', () => {
  describe('isPathInside', () => {
    it('returns true for a direct subpath of parent', () => {
      const parent = path.resolve('/tmp/chamber-test');
      const child = path.join(parent, 'mind-1', 'canvas.html');
      expect(isPathInside(parent, child)).toBe(true);
    });

    it('returns true when child equals parent (canonical form)', () => {
      const parent = path.resolve('/tmp/chamber-test');
      expect(isPathInside(parent, parent)).toBe(true);
    });

    it('rejects a parent-directory traversal via ..', () => {
      const parent = path.resolve('/tmp/chamber-test/mind-1');
      const escape = path.join(parent, '..', 'other-mind', 'leak.html');
      expect(isPathInside(parent, escape)).toBe(false);
    });

    it('rejects a sibling whose normalized path shares a prefix substring', () => {
      const parent = path.resolve('/tmp/chamber-test');
      const sibling = path.resolve('/tmp/chamber-test-evil/file.html');
      expect(isPathInside(parent, sibling)).toBe(false);
    });
  });

  describe('normalizePath', () => {
    it('returns an absolute path', () => {
      const result = normalizePath('relative/path');
      expect(path.isAbsolute(result)).toBe(true);
    });
  });
});
