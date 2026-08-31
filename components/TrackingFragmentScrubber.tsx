"use client";

import { useEffect } from "react";

/**
 * CUSTOMER TRACKING EXPERIENCE v2.1 — closes CTE-V2-HISTORY-01 (release
 * blocker, Work re-audit of v2).
 *
 * THE DEFECT THIS FIXES: in v2, fragment scrubbing happened ONLY inside
 * components/TrackingEntryGate.tsx, which app/track/[orderId]/page.tsx
 * (Server Component) renders EXCLUSIVELY when it found no valid
 * presentation session for this order. When a valid session cookie
 * ALREADY exists (e.g. the customer re-opens their original confirmation
 * link, or a browser bookmark still carries the fragment, while their
 * 2-hour session is still live), the page instead renders the full
 * tracking view directly -- TrackingEntryGate never mounts, so no
 * `history.replaceState` ever ran, and `#<public_token>` stayed visible
 * in the address bar indefinitely.
 *
 * THE FIX: this component is mounted UNCONDITIONALLY on every render
 * path of the tracking page (see TrackingShell in
 * app/track/[orderId]/page.tsx, which wraps literally every returned
 * branch: malformed order_id, no session, RPC failure, RPC success). It
 * has exactly one job, independent of whatever else is happening on the
 * page:
 *
 *   on mount, if `location.hash` is non-empty, replace it away
 *   immediately -- REGARDLESS of whether a session already existed,
 *   was just established, was invalid, or was never attempted.
 *
 * Deliberately minimal, by design (mandat §4's "Preferred design"):
 *   1. detects any hash — a simple truthiness check, NEVER decodes it
 *      (so a malformed/undecodable fragment, mandat §6, can never throw
 *      here — this component doesn't even look at the fragment's
 *      content, only whether one is present);
 *   2. `history.replaceState(null, "", pathname + search)` — never
 *      copies the fragment anywhere else, never touches pathname/search;
 *   3. performs NO network request of any kind, and triggers NO second
 *      exchange merely because a session already exists (mandat §4) --
 *      it has no knowledge of, and no opinion on, possession/session
 *      state at all;
 *   4. renders nothing (`return null`) -- no visible UI, no log, no
 *      `console.*` call anywhere in this file (mandat §12, unchanged
 *      discipline).
 *
 * NOT a race with TrackingEntryGate's own exchange flow: TrackingEntryGate
 * now captures `location.hash` synchronously during its own RENDER phase
 * (a lazy `useState` initializer, see that file), which is guaranteed by
 * React to run before ANY effect — including this component's — ever
 * fires. So it makes no difference whether this scrubber's effect or
 * TrackingEntryGate's effect happens to run first: TrackingEntryGate
 * already has its own private copy of the original hash value by the
 * time either effect executes, and this component clearing the visible
 * URL can never cause TrackingEntryGate to see an empty hash and
 * misclassify a legitimate first-visit link as invalid.
 */
export default function TrackingFragmentScrubber() {
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  return null;
}
