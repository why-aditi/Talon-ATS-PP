/**
 * RFC 9457 problem+json — the error shape for every endpoint (ARCHITECTURE §7).
 *
 * It lives here rather than in the api package because the ui switches on
 * `type`: §7.3 needs an Error state with inline retry and §9 edge case 1 needs
 * a distinct type for "authenticated but not provisioned". If both streams
 * invented an envelope they would have to reconcile in this same file later.
 *
 * `type` is an open string, not an enum. The stable values are declared by the
 * endpoints that emit them; enumerating them before any route exists would be
 * inventing a contract nobody has specced.
 */
import { z } from 'zod';

export const ProblemSchema = z
  .object({
    /** Stable URI reference the client switches on. */
    type: z.string(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    /** Correlates a report with server logs. */
    requestId: z.string().optional(),
  })
  // RFC 9457 §3.2 permits extension members, and the first one needed is
  // field-level detail on the 400 from a rejected query param. Stripping them
  // would silently drop the part of the error a user can act on.
  .passthrough();
export type Problem = z.infer<typeof ProblemSchema>;
