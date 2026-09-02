/**
 * Mocked-but-stable Android device identity.
 *
 * Takealot binds device trust to a server-assigned `did` echoed on every request
 * as the `TAL-Did` header + `did` cookie. The device fingerprint (Android
 * build fields → User-Agent) must stay STABLE across runs, or the device risks
 * being de-trusted and re-challenged for 2FA. So the profile is created once
 * with realistic defaults and reused verbatim; only an explicit `config.deviceProfile`
 * override changes it.
 */

import * as crypto from 'node:crypto';
import type { Config, DeviceProfile } from '../types.js';

/**
 * Default mocked device. Kept in lock-step with the User-Agent the CLI presents.
 * The API version + app version/build are bumped together (see api-client DEFAULTS).
 */
export const DEFAULT_DEVICE_PROFILE: DeviceProfile = {
  androidRelease: '14',
  brand: 'samsung',
  model: 'SM-S928B',
  appVersion: '4.2.2',
  appBuild: '800750',
};

/** The effective device profile: defaults overlaid with any config override. */
export function resolveDeviceProfile(config: Config): DeviceProfile {
  return { ...DEFAULT_DEVICE_PROFILE, ...(config.deviceProfile ?? {}) };
}

/** The mobile User-Agent, built from the device profile (mirrors the real app). */
export function buildUserAgent(p: DeviceProfile): string {
  return `TAL-Android/${p.appVersion} (fi.android.takealot; build:${p.appBuild}; ${p.androidRelease}; ${p.brand}; ${p.model}; Phone)`;
}

/** Stable hash of a profile, used to bind a persisted 2FA challenge to its UA. */
export function profileHash(p: DeviceProfile): string {
  return crypto
    .createHash('sha256')
    .update([p.androidRelease, p.brand, p.model, p.appVersion, p.appBuild].join('|'))
    .digest('hex')
    .slice(0, 16);
}
