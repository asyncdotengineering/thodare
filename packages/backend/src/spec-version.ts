declare const SpecVersionBrand: unique symbol;
export type SpecVersion = number & {
  readonly [SpecVersionBrand]: typeof SpecVersionBrand;
};

export const SPEC_VERSION_LEGACY = 1 as SpecVersion;
export const SPEC_VERSION_SUPPORTS_EVENT_SOURCING = 2 as SpecVersion;
export const SPEC_VERSION_SUPPORTS_CREDENTIALS = 3 as SpecVersion;
export const SPEC_VERSION_CURRENT: SpecVersion =
  SPEC_VERSION_SUPPORTS_CREDENTIALS;

export function isLegacySpecVersion(v: SpecVersion): boolean {
  return v < SPEC_VERSION_SUPPORTS_EVENT_SOURCING;
}

export function requiresNewerWorld(v: SpecVersion): boolean {
  return v > SPEC_VERSION_CURRENT;
}
