/**
 * Auto-load env files before any test runs so the live-SMTP test can pick
 * up provider credentials without forcing `node --env-file=...`.
 *
 * Load order (later wins, but never overrides shell-set vars):
 *   1. ../../.env.dev          (workspace-wide, shared across packages)
 *   2. .env                    (package-local defaults)
 *   3. .env.test               (package-local test config)
 *   4. .env.test.local         (personal secrets, gitignored)
 *
 * Uses Vite's built-in `loadEnv` for package-local files (vite is already
 * a vitest peer), and a tiny manual parser for the workspace `.env.dev`
 * which sits outside the package root.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';

function applyEnv(record: Record<string, string>): void {
  for (const [key, value] of Object.entries(record)) {
    // Shell-set values always win so developers can opt out of any file
    // by exporting the key in their shell.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// 1. Workspace-wide .env.dev (lives at D:/projects/packages/.env.dev)
const workspaceEnv = resolve(process.cwd(), '../.env.dev');
if (existsSync(workspaceEnv)) {
  applyEnv(parseDotenv(readFileSync(workspaceEnv, 'utf8')));
}

// 2-4. Package-local .env / .env.test / .env.test.local
applyEnv(loadEnv('test', process.cwd(), ''));
