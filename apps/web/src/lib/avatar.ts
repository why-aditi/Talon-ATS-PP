import { AVATAR_TOKENS } from '@talon/tokens';

/**
 * FNV-1a over the entity id, per DESIGN_SYSTEM §3: the hash is on id, not name, so a
 * rename never reshuffles a board's colors. The API returns no color of its own — a
 * hex from the wire would be a raw color value sitting outside packages/tokens.
 */
export function avatarToken(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return AVATAR_TOKENS[Math.abs(h) % AVATAR_TOKENS.length] as string;
}

/** "Maya Reyes" → "MR". Two initials, matching the reference avatars. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
