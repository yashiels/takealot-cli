import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WatchError } from './errors.js';

interface LockOwner {
  pid: number;
  nonce: string;
  host: string;
  acquiredAt: number;
}

interface DirectoryLockOptions {
  timeoutMs: number;
  error: (owner: LockOwner | null) => Error;
  now?: () => number;
}

export interface DirectoryLockHandle {
  assertHeld(): void;
}

export class LockLostError extends WatchError {
  constructor(directory: string) {
    super(`lock ownership was lost for ${directory}`, 'lock_lost');
    this.name = 'LockLostError';
  }
}

const HOSTNAME = os.hostname();
const ownerPath = (directory: string): string => path.join(directory, 'owner.json');
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function ownerOf(directory: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(ownerPath(directory), 'utf8')) as LockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function publish(directory: string, nonce: string, acquiredAt: number): boolean {
  const parent = path.dirname(directory);
  const staging = `${directory}.new.${process.pid}.${nonce}`;
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.writeFileSync(
      ownerPath(staging),
      JSON.stringify({ pid: process.pid, nonce, host: HOSTNAME, acquiredAt }),
      { mode: 0o600 },
    );
    fs.renameSync(staging, directory);
    return true;
  } catch {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {}
    return false;
  }
}

function deadSameHost(owner: LockOwner | null): owner is LockOwner {
  return owner !== null && owner.host === HOSTNAME && !processIsAlive(owner.pid);
}

function removeDeadLock(directory: string): boolean {
  const owner = ownerOf(directory);
  if (!deadSameHost(owner)) return false;
  const claimed = `${directory}.dead.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(directory, claimed);
  } catch {
    return false;
  }
  if (ownerOf(claimed)?.nonce !== owner.nonce) {
    try {
      fs.renameSync(claimed, directory);
    } catch {}
    return false;
  }
  try {
    fs.rmSync(claimed, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function release(directory: string, nonce: string): void {
  if (ownerOf(directory)?.nonce !== nonce) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {}
}

export async function withDirectoryLock<T>(
  directory: string,
  options: DirectoryLockOptions,
  fn: (lock: DirectoryLockHandle) => Promise<T>,
): Promise<T> {
  const nonce = crypto.randomUUID();
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  let delay = 20;
  for (;;) {
    const acquiredAt = now();
    if (publish(directory, nonce, acquiredAt)) break;
    if (removeDeadLock(directory) && publish(directory, nonce, now())) break;
    if (now() >= deadline) throw options.error(ownerOf(directory));
    await wait(delay);
    delay = Math.min(Math.round(delay * 1.5), 200);
  }
  const lock: DirectoryLockHandle = {
    assertHeld: () => {
      if (ownerOf(directory)?.nonce !== nonce) throw new LockLostError(directory);
    },
  };
  try {
    return await fn(lock);
  } finally {
    release(directory, nonce);
  }
}
