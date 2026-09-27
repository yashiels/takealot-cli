import { UsageError } from './errors.js';

function validPlid(value: string, input: string): number {
  const plid = Number(value);
  if (!Number.isSafeInteger(plid) || plid <= 0) {
    throw new UsageError(`invalid product reference: ${input}`);
  }
  return plid;
}

export function parsePlidRef(input: string): number {
  if (/^\d+$/.test(input)) return validPlid(input, input);
  const prefixed = /^plid(\d+)$/i.exec(input);
  if (prefixed) return validPlid(prefixed[1]!, input);

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UsageError(`invalid product reference: ${input}`);
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'takealot.com' && url.hostname !== 'www.takealot.com') ||
    url.port
  ) {
    throw new UsageError(`invalid Takealot product URL: ${input}`);
  }
  const pathMatch = /\/PLID(\d+)(?:\/|$)/i.exec(url.pathname);
  if (!pathMatch) throw new UsageError(`Takealot URL has no PLID: ${input}`);
  return validPlid(pathMatch[1]!, input);
}
