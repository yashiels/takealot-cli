import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
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

  it('registers only read-only checkout plus start and submit', () => {
    const out = execFileSync('node', [cli, 'checkout', '--help'], { encoding: 'utf8' });
    expect(out).toContain('start [options]');
    expect(out).toContain('submit [options]');
    expect(out).not.toContain('resume');
    expect(out).not.toContain('reset');
  });

  it('does not register payment endpoint commands', () => {
    const root = execFileSync('node', [cli, '--help'], { encoding: 'utf8' });
    const checkout = execFileSync('node', [cli, 'checkout', '--help'], { encoding: 'utf8' });
    const plus = execFileSync('node', [cli, 'plus', '--help'], { encoding: 'utf8' });
    const plusManage = execFileSync('node', [cli, 'plus', 'manage', '--help'], { encoding: 'utf8' });
    expect(root).not.toMatch(/^\s*ebucks\b/m);
    expect(checkout).not.toMatch(/^\s*(order|payhost|resume)\b/m);
    expect(plus).not.toMatch(/^\s*(pay|signup|reactivate|card-add|card-payment)\b/m);
    expect(plusManage).not.toMatch(/^\s*(upgrade|downgrade|card)\b/m);
  });

  it('rejects an unknown subcommand under a readable group', () => {
    const result = spawnSync('node', [cli, 'plus', 'bogus'], { encoding: 'utf8' });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('too many arguments');
  });

  it('rejects excess recommendation arguments before making a request', () => {
    const result = spawnSync(
      'node',
      [cli, 'recommend', 'home-page', 'junk', '--model', 'rfy'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('too many arguments');
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
