/**
 * Workflow-safe recursive redaction.
 *
 * Passthrough command output and typed --json alike are walked and any
 * credential is masked — but functional handles an agent needs to complete a
 * workflow (form fields echoed back on submit, `tal_initiation_id`, `order_id`,
 * 3DS challenge URLs, and signed invoice/download URLs) are preserved intact.
 * Nothing here ever throws on an arbitrary shape.
 */

export const REDACTED = '«redacted»';

/** Credential key names (lowercased, exact or suffix `*_token`) — always masked. */
const CREDENTIAL_KEYS = new Set([
  'jwt',
  'tal_jwt',
  'access_token',
  'id_token',
  'refresh_token',
  'refreshtoken',
  'csrf_token',
  'csrftoken',
  'x-csrf-token',
  'password',
  'otp',
  '__cf_bm',
  'cf_bm',
  'cookie',
  'set-cookie',
  'authorization',
  'did',
  'cdid',
  'tal-did',
  'access_key',
  'private_key',
  'id_number',
  'pan',
  'cvv',
  'cvc',
  'card_number',
  'cardnumber',
]);

/**
 * Functional-handle keys that are NEVER redacted — an agent needs them to
 * complete a flow. Everything under a key on this list is passed through
 * verbatim (it may itself be an opaque server token; that is the point).
 */
const FUNCTIONAL_KEYS = new Set([
  'tal_initiation_id',
  'order_id',
  'orderid',
  'sections', // data-section form layouts round-tripped on submit
  'pay_request_id',
  'checksum',
]);

/**
 * Auth-bearing URL query params stripped from EVERY URL — functional or not. A
 * bearer/access_token must never survive on any URL, even a signed invoice/3DS
 * one. Functional SIGNATURE params (PAY_REQUEST_ID, CHECKSUM, signature, expiry,
 * tal_initiation_id, …) are NOT in this set, so they survive intact and the
 * download/challenge still works.
 */
const URL_AUTH_PARAMS = new Set(['access_token', 'jwt', 'id_token', 'token', 'auth', 'bearer', 'authorization']);

/** A value that "looks like" a bearer/JWT/api secret and should be masked. */
function looksSecret(v: string): boolean {
  if (v.length < 12) return false;
  if (/^Bearer\s+/i.test(v)) return true;
  if (/^sk-[A-Za-z0-9]/.test(v)) return true;
  // JWT: three base64url segments separated by dots.
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(v)) return true;
  return false;
}

function keyIsCredential(key: string): boolean {
  const k = key.toLowerCase();
  if (CREDENTIAL_KEYS.has(k)) return true;
  if (k.endsWith('_token') || k.endsWith('token')) return true;
  if (k.startsWith('refresh')) return true;
  if (k.startsWith('csrf')) return true;
  return false;
}

function keyIsFunctional(key: string): boolean {
  return FUNCTIONAL_KEYS.has(key.toLowerCase());
}

/** Field ids/titles whose `value` in a data-section form carries a secret. */
const SECRET_FIELD_RE =
  /(pass(word|wd|code)|otp|one[_-]?time|\bpin\b|cvv|cvc|card[_-]?number|\bpan\b|id[_-]?number|account[_-]?number|secret|token|security[_-]?code)/i;

/**
 * A data-section field object `{field_id|title|name, value}` whose id/title marks
 * the sibling `value` as sensitive (password/OTP/CVV/PAN/id number). The
 * sensitivity lives in the id, not the generic key `value`, so key-based
 * redaction alone misses it.
 */
function fieldIsSecret(obj: Record<string, unknown>): boolean {
  for (const k of ['field_id', 'title', 'name', 'id', 'label']) {
    const v = obj[k];
    if (typeof v === 'string' && SECRET_FIELD_RE.test(v)) return true;
  }
  return false;
}

/**
 * Strip auth-bearing query params (access_token/jwt/token/…) from a url string.
 * Signature params that make a signed download/challenge URL work — PAY_REQUEST_ID,
 * CHECKSUM, signature, expiry — are NOT in the auth-param set, so they survive:
 * ordinary tokens get masked while functional signed URLs stay usable.
 */
/** Strip auth params from a URL fragment (`#a=b&c=d` or `#/path?a=b`). */
function stripFragmentAuthParams(hash: string): { hash: string; changed: boolean } {
  if (!hash || hash === '#') return { hash, changed: false };
  const frag = hash.slice(1); // drop '#'
  const qIdx = frag.indexOf('?');
  let prefix = '';
  let qs = frag;
  if (qIdx >= 0) {
    prefix = frag.slice(0, qIdx + 1); // keep the `path?`
    qs = frag.slice(qIdx + 1);
  } else if (!frag.includes('=')) {
    return { hash, changed: false }; // a plain #anchor, no params
  }
  const params = new URLSearchParams(qs);
  let changed = false;
  for (const k of [...params.keys()]) {
    if (URL_AUTH_PARAMS.has(k.toLowerCase())) {
      params.set(k, REDACTED);
      changed = true;
    }
  }
  return changed ? { hash: '#' + prefix + params.toString(), changed: true } : { hash, changed: false };
}

/** Public: redact auth-credential params from a URL's query AND fragment. */
export function redactUrl(value: string): string {
  return stripUrlAuthParams(value);
}

/** Strip a URL down to `protocol//host/pathname` — no query, no fragment. */
export function safeUrlPath(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '«unparseable-url»';
  }
}

function stripUrlAuthParams(value: string): string {
  try {
    const u = new URL(value);
    let changed = false;
    for (const p of [...u.searchParams.keys()]) {
      if (URL_AUTH_PARAMS.has(p.toLowerCase())) {
        u.searchParams.set(p, REDACTED);
        changed = true;
      }
    }
    // Also strip OAuth-implicit-style tokens carried in the fragment.
    const frag = stripFragmentAuthParams(u.hash);
    if (frag.changed) {
      u.hash = frag.hash;
      changed = true;
    }
    return changed ? u.toString() : value;
  } catch {
    return value;
  }
}

export interface RedactOptions {
  /** When true, return the value untouched (the `--unsafe-raw` opt-in). */
  unsafe?: boolean;
}

/**
 * Return a redacted deep copy of `data`. Credentials are masked; functional
 * handles (see FUNCTIONAL_KEYS + signed URLs) are preserved. Cycles are handled.
 */
export function redact<T>(data: T, opts: RedactOptions = {}): T {
  if (opts.unsafe) return data;
  const seen = new WeakSet<object>();

  const walk = (value: unknown, key: string | undefined, functional: boolean): unknown => {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      if (functional) return value; // functional handle / signed URL — untouched
      if (key && keyIsCredential(key)) return REDACTED;
      if (looksSecret(value)) return REDACTED;
      if (value.includes('://')) return stripUrlAuthParams(value);
      return value;
    }
    if (typeof value !== 'object') return value;

    if (seen.has(value as object)) return '«cycle»';
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((v) => walk(v, key, functional));
    }
    const out: Record<string, unknown> = {};
    // Data-section field: mask its `value` when the sibling id/title is sensitive.
    const secretField = fieldIsSecret(value as Record<string, unknown>);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const kl = k.toLowerCase();
      if (secretField && (kl === 'value' || kl === 'values')) {
        out[k] = REDACTED;
        continue;
      }
      const childFunctional = keyIsFunctional(k);
      if (!childFunctional && keyIsCredential(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(v, k, childFunctional);
    }
    return out;
  };

  return walk(data, undefined, false) as T;
}

/** Redact a free-text message (e.g. an error) by masking embedded secrets. */
export function redactText(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/g, REDACTED);
}
