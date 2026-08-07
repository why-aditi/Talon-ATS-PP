export { TOKENS, token, type TokenName } from './tokens.generated';

/**
 * Avatar fills, indexed by a stable hash of the entity id (DESIGN_SYSTEM §3) so a
 * rename never reshuffles a board's colors. Exported as token names, not hex —
 * a component that received hex would be holding a raw color value.
 */
export const AVATAR_TOKENS = [
  '--color-avatar-1',
  '--color-avatar-2',
  '--color-avatar-3',
  '--color-avatar-4',
  '--color-avatar-5',
  '--color-avatar-6',
  '--color-avatar-7',
  '--color-avatar-8',
] as const;
