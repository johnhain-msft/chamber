import * as path from 'node:path';

/**
 * Path utilities shared by `CanvasService` and `CanvasServer`.
 *
 * These exist because both files independently need the same path-traversal
 * guard (`isPathInside`) — CanvasService when validating tool inputs that
 * write under `.chamber/canvas`, CanvasServer when resolving HTTP requests
 * against the mind's content directory. The logic is security-critical, so
 * single-sourcing it means a Windows long-path or symlink-aware fix only has
 * to land once.
 *
 * `normalizePath` lowercases on Windows to mirror NTFS's case-insensitive
 * comparisons; on POSIX it returns the resolved absolute path unchanged.
 */

export function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isPathInside(parent: string, child: string): boolean {
  const normalizedParent = normalizePath(parent);
  const normalizedChild = normalizePath(child);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}${path.sep}`)
  );
}
