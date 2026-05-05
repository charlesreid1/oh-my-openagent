import { relative, resolve, isAbsolute } from "node:path"

import { ALLOWED_EXTENSIONS } from "./constants"

function hasAllowedExtension(filePath: string): boolean {
  return ALLOWED_EXTENSIONS.some(
    ext => filePath.toLowerCase().endsWith(ext.toLowerCase())
  )
}

function hasSisyphusSegment(filePath: string): boolean {
  return /\.sisyphus[/\\]/i.test(filePath)
}

/**
 * Cross-platform path validator for Prometheus file writes.
 * Uses path.resolve/relative instead of string matching to handle:
 * - Windows backslashes (e.g., .sisyphus\\plans\\x.md)
 * - Mixed separators (e.g., .sisyphus\\plans/x.md)
 * - Case-insensitive directory/extension matching
 * - Absolute paths to .sisyphus/ in other projects (ctx.directory may differ)
 * - Nested project paths (e.g., parent/.sisyphus/... when ctx.directory is parent)
 */
export function isAllowedFile(filePath: string, workspaceRoot: string): boolean {
  // 1. Resolve to absolute path
  const resolved = resolve(workspaceRoot, filePath)

  // 2. Get relative path from workspace root
  const rel = relative(workspaceRoot, resolved)

  // 3. If path escapes workspace root, still allow if it targets a .sisyphus/*.md file.
  // ctx.directory (workspaceRoot) may not match the project directory when the plugin
  // is loaded globally or from a different project than the one being worked on.
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return hasSisyphusSegment(resolved) && hasAllowedExtension(resolved)
  }

  // 4. Check if .sisyphus/ or .sisyphus\ exists anywhere in the path (case-insensitive)
  // This handles both direct paths (.sisyphus/x.md) and nested paths (project/.sisyphus/x.md)
  if (!hasSisyphusSegment(rel)) {
    return false
  }

  // 5. Check extension matches one of ALLOWED_EXTENSIONS (case-insensitive)
  if (!hasAllowedExtension(resolved)) {
    return false
  }

  return true
}
