/**
 * Lets the header's "Open map" button start the planet dive while the landing hero is mounted.
 * The landing page registers `start`; everything else falls back to a plain link.
 */
export const diveBridge: { start: (() => void) | null } = { start: null };
