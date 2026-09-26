import { Command, Option } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalFlags, program, run } from '../cli.js';

interface CommandCollision {
  path: string[];
  pathLabel: string;
  sharedOptions: Option[];
}

const globalOptionNames = new Set(['json', 'verbose']);
const allCommands: Command[] = [];
const collisions: CommandCollision[] = [];

function collectCommands(parent: Command, path: string[] = []): void {
  allCommands.push(parent);
  for (const child of parent.commands) {
    const childPath = [...path, child.name()];
    const parentOptionNames = new Set(parent.options.map((option) => option.attributeName()));
    const sharedOptions = child.options.filter(
      (option) =>
        parentOptionNames.has(option.attributeName()) &&
        !globalOptionNames.has(option.attributeName()),
    );
    if (sharedOptions.length > 0) {
      collisions.push({ path: childPath, pathLabel: childPath.join(' '), sharedOptions });
    }
    collectCommands(child, childPath);
  }
}

function commandAt(path: string[]): Command {
  let command = program;
  for (const name of path) {
    command = command.commands.find((candidate) => candidate.name() === name)!;
  }
  return command;
}

function resetOptionValues(): void {
  for (const command of allCommands) {
    for (const option of command.options) {
      command.setOptionValue(option.attributeName(), undefined);
    }
  }
}

function optionValue(option: Option): string {
  if (option.attributeName() === 'query') return 'key=value';
  if (option.attributeName() === 'file') return '/tmp/takealot-options.json';
  return '4242';
}

function appendOption(argv: string[], option: Option): void {
  argv.push(option.long ?? option.short!);
  if (option.required || option.optional) argv.push(optionValue(option));
}

collectCommands(program);

afterEach(() => {
  process.exitCode = undefined;
  resetOptionValues();
  vi.restoreAllMocks();
});

describe('global option positions', () => {
  it.each([
    { label: 'root --json', flag: 'json', path: ['cart'], argv: ['--json', 'cart'] },
    { label: 'leaf --json', flag: 'json', path: ['cart'], argv: ['cart', '--json'] },
    {
      label: 'group --json',
      flag: 'json',
      path: ['wishlist', 'list'],
      argv: ['wishlist', '--json', 'list'],
    },
    { label: 'root --verbose', flag: 'verbose', path: ['cart'], argv: ['--verbose', 'cart'] },
    { label: 'leaf --verbose', flag: 'verbose', path: ['cart'], argv: ['cart', '--verbose'] },
    {
      label: 'group --verbose',
      flag: 'verbose',
      path: ['wishlist', 'list'],
      argv: ['wishlist', '--verbose', 'list'],
    },
  ])('$label reaches the selected command', async ({ flag, path, argv }) => {
    resetOptionValues();
    const target = commandAt(path);
    let received: ReturnType<typeof globalFlags> | undefined;
    target.action((...args: unknown[]) => {
      received = globalFlags(args.at(-1) as Command);
    });
    await program.parseAsync(['node', 'takealot', ...argv]);
    expect(received?.[flag as keyof NonNullable<typeof received>]).toBe(true);
  });
});

describe('misplaced ancestor options', () => {
  it('binds wishlist add options to add because wishlist does not define them', async () => {
    resetOptionValues();
    const add = commandAt(['wishlist', 'add']);
    const wishlist = add.parent!;
    expect(wishlist.options.map((option) => option.attributeName())).not.toContain('confirm');
    expect(wishlist.options.map((option) => option.attributeName())).not.toContain('file');
    let received:
      | { target: string | undefined; groupId: string | undefined; options: Record<string, unknown> }
      | undefined;
    add.action((target: string | undefined, groupId: string | undefined, options: Record<string, unknown>) => {
      received = { target, groupId, options };
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await program.parseAsync([
      'node',
      'takealot',
      'wishlist',
      'add',
      '--file',
      '/tmp/takealot-options.json',
      '--confirm',
      'group',
      '42',
      '--json',
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(received).toEqual({
      target: 'group',
      groupId: '42',
      options: expect.objectContaining({ confirm: true, file: '/tmp/takealot-options.json' }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parent and subcommand option collisions', () => {
  it('discovers every current collision without a hand-maintained command list', () => {
    expect(collisions).toHaveLength(37);
    expect(collisions.map((collision) => collision.pathLabel)).toEqual(
      expect.arrayContaining(['wishlist add', 'wishlist move', 'wishlist rm-items']),
    );
  });

  it.each(collisions)(
    '$pathLabel routes shared options to the subcommand',
    async ({ path, sharedOptions }) => {
      for (const command of allCommands) {
        command.action((...args: unknown[]) =>
          run(args.at(-1) as Command, async () => undefined),
        );
      }
      const target = commandAt(path);
      const parent = target.parent!;
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      for (const sharedOption of sharedOptions) {
        resetOptionValues();
        process.exitCode = undefined;
        const argv = [...path];
        for (const argument of target.registeredArguments) {
          if (argument.required) argv.push(argument.name().endsWith('Id') ? '42' : 'value');
        }
        for (const mandatoryOption of target.options) {
          if (
            mandatoryOption.mandatory &&
            mandatoryOption.attributeName() !== sharedOption.attributeName()
          ) {
            appendOption(argv, mandatoryOption);
          }
        }
        appendOption(argv, sharedOption);
        await program.parseAsync(['node', 'takealot', ...argv]);
        expect(target.getOptionValue(sharedOption.attributeName())).not.toBeUndefined();
        expect(parent.getOptionValue(sharedOption.attributeName())).toBeUndefined();

        resetOptionValues();
        process.exitCode = undefined;
        const ancestorArgv = path.slice(0, -1);
        appendOption(ancestorArgv, sharedOption);
        if (sharedOption.variadic) ancestorArgv.push('--json');
        ancestorArgv.push(path.at(-1)!);
        for (const argument of target.registeredArguments) {
          if (argument.required)
            ancestorArgv.push(argument.name().endsWith('Id') ? '42' : 'value');
        }
        for (const mandatoryOption of target.options) {
          appendOption(ancestorArgv, mandatoryOption);
        }
        await program.parseAsync(['node', 'takealot', ...ancestorArgv]);
        expect(process.exitCode).toBe(4);
        expect(parent.getOptionValueSource(sharedOption.attributeName())).toBe('cli');
      }
    },
  );
});
