import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { readFileSync } from 'node:fs';
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
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
    };
    expect(out.trim()).toBe(packageJson.version);
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

  it('registers typed wishlist add, move, and bulk-remove options', () => {
    const add = execFileSync('node', [cli, 'wishlist', 'add', '--help'], { encoding: 'utf8' });
    const move = execFileSync('node', [cli, 'wishlist', 'move', '--help'], { encoding: 'utf8' });
    const remove = execFileSync('node', [cli, 'wishlist', 'rm-items', '--help'], { encoding: 'utf8' });
    expect(add).toContain('[target] [groupId]');
    expect(add).toContain('wishlist add <id> --sku N');
    expect(add).toContain('wishlist add group <id> --file path');
    expect(add).toContain('--sku <id>');
    expect(add).toContain('--plid <id>');
    expect(move).toContain('--from <groupId>');
    expect(move).toContain('--to <groupId>');
    expect(move).toContain('--tsin <id>');
    expect(remove).toContain('<groupId>');
    expect(remove).toContain('--tsin <id>');
  });

  it('requires positional CMS route and help search values', () => {
    const cms = execFileSync('node', [cli, 'cms', 'route', '--help'], { encoding: 'utf8' });
    const help = execFileSync('node', [cli, 'help', 'search', '--help'], { encoding: 'utf8' });
    expect(cms).toContain('<link>');
    expect(help).toContain('<query>');
    expect(help).toContain('--autocomplete');
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
