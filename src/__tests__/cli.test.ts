import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

// Resolve compiled CLI entrypoint relative to this test file (ESM-safe)
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

// Skip live-API tests in CI where network may be unavailable
const isCI = process.env['CI'] === 'true';

describe('takealot-cli smoke tests', () => {
  it('should exit 0 on --help', () => {
    const out = execFileSync('node', [cli, '--help'], { encoding: 'utf8' });
    expect(out).toContain('search');
  });

  it('should print version on --version', () => {
    const out = execFileSync('node', [cli, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  it.skipIf(isCI)('should search without auth (live API)', () => {
    const out = execFileSync('node', [cli, 'search', 'test', '--limit', '1', '--json'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    const parsed = JSON.parse(out) as { products: unknown[] };
    expect(Array.isArray(parsed.products)).toBe(true);
    expect(parsed.products.length).toBeGreaterThanOrEqual(1);
  });
});
