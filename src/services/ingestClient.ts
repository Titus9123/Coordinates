/**
 * Safe telemetry/ingest client with strict throttling and fail-safe mechanisms.
 * 
 * Features:
 * - Rate limiting: max 2 requests/second, max concurrency: 1
 * - Batching: accumulates up to 25 events or 500ms, whichever comes first
 * - Fail-safe: disables for 60s after 3 consecutive failures or ERR_INSUFFICIENT_RESOURCES
 * - Opt-in: only active when DEBUG_INGEST is true
 */

import { DEBUG_INGEST, INGEST_BASE_URL } from "../constants";

// Module-level state
let eventQueue: Array<Record<string, unknown>> = [];
let isSending = false;
let consecutiveFailures = 0;
let disabledUntil: number | null = null;
let sessionId: string | null = null;

// Generate stable session ID once per page load
function getSessionId(): string {
  if (!sessionId) {
    // Try to use crypto.randomUUID if available, otherwise generate a simple ID
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      sessionId = crypto.randomUUID();
    } else {
      // Fallback: generate a simple UUID-like string
      sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    }
  }
  return sessionId;
}

/**
 * Enqueues an event for ingestion.
 * If DEBUG_INGEST is false, this is a no-op.
 * 
 * @param event - Event data to send
 */
export function enqueueIngest(event: Record<string, unknown>): void {
  // If ingest is disabled, do nothing
  if (!DEBUG_INGEST) {
    return;
  }

  // If ingest is in cooldown, do nothing
  if (disabledUntil !== null && Date.now() < disabledUntil) {
    if (DEBUG_INGEST) {
      const remaining = Math.ceil((disabledUntil - Date.now()) / 1000);
      console.log(`INGEST: disabled (cooldown ${remaining}s remaining), queuedCount=${eventQueue.length}`);
    }
    return;
  }

  // Reset cooldown if it has expired
  if (disabledUntil !== null && Date.now() >= disabledUntil) {
    disabledUntil = null;
    consecutiveFailures = 0;
    if (DEBUG_INGEST) {
      console.log("INGEST: cooldown expired, re-enabling");
    }
  }

  // Add event to queue
  eventQueue.push({
    ...event,
    timestamp: Date.now(),
  });

  // Trigger send if not already sending
  if (!isSending) {
    scheduleSend();
  }
}

/**
 * Schedules the next send operation with rate limiting.
 */
function scheduleSend(): void {
  if (isSending || eventQueue.length === 0) {
    return;
  }

  // Rate limit: max 2 requests per second = 500ms between requests
  setTimeout(() => {
    sendBatch();
  }, 500);
}

/**
 * Sends a batch of events.
 * Batches up to 25 events or sends immediately if queue has been waiting 500ms.
 */
async function sendBatch(): Promise<void> {
  if (isSending || eventQueue.length === 0) {
    return;
  }

  // Check cooldown
  if (disabledUntil !== null && Date.now() < disabledUntil) {
    return;
  }

  isSending = true;

  // Take up to 25 events from queue
  const batch = eventQueue.splice(0, 25);
  const batchSize = batch.length;

  try {
    const sessionId = getSessionId();
    const url = `${INGEST_BASE_URL}/ingest/${sessionId}`;

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: batch }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      // Success: reset failure counter
      consecutiveFailures = 0;
      if (DEBUG_INGEST) {
        console.log(`INGEST: sent batch successfully, batchSize=${batchSize}, queuedCount=${eventQueue.length}`);
      }
    } else {
      // HTTP error: increment failure counter
      consecutiveFailures++;
      if (DEBUG_INGEST) {
        console.log(`INGEST: HTTP error status=${response.status}, consecutiveFailures=${consecutiveFailures}`);
      }
      checkFailSafe();
    }
  } catch (error) {
    // Network error or timeout
    consecutiveFailures++;
    
    const isResourceError = 
      error instanceof Error && (
        error.message.includes("ERR_INSUFFICIENT_RESOURCES") ||
        error.message.includes("Failed to fetch") ||
        error.name === "AbortError"
      );

    if (DEBUG_INGEST) {
      console.log(`INGEST: fetch error, consecutiveFailures=${consecutiveFailures}, isResourceError=${isResourceError}`);
    }

    // If resource error, immediately trigger fail-safe
    if (isResourceError) {
      triggerFailSafe();
    } else {
      checkFailSafe();
    }
  } finally {
    isSending = false;

    // Schedule next send if queue has more events
    if (eventQueue.length > 0) {
      scheduleSend();
    }
  }
}

/**
 * Checks if fail-safe should be triggered (3 consecutive failures).
 */
function checkFailSafe(): void {
  if (consecutiveFailures >= 3) {
    triggerFailSafe();
  }
}

/**
 * Triggers fail-safe: disables ingest for 60 seconds.
 */
function triggerFailSafe(): void {
  disabledUntil = Date.now() + 60000; // 60 seconds
  if (DEBUG_INGEST) {
    console.log(`INGEST: fail-safe triggered, disabled until ${new Date(disabledUntil).toISOString()}, queuedCount=${eventQueue.length}`);
  }
  // Clear queue to prevent memory buildup
  eventQueue = [];
}

/*
 * Manual Proof Checklist
 * =======================
 * 
 * 1) With DEBUG_INGEST=false:
 *    - Process a large Excel file (100+ rows)
 *    - Expected: ZERO network requests to 127.0.0.1:7242
 *    - Verify: Check browser DevTools Network tab, filter by "7242"
 *    - Result: No requests should appear
 * 
 * 2) With DEBUG_INGEST=true:
 *    - Process a large Excel file (100+ rows)
 *    - Expected: Requests are rate-limited (max 2 per second)
 *    - Verify: Check Network tab, requests should be spaced ~500ms apart
 *    - Verify: Check console for "INGEST:" logs showing batchSize and queuedCount
 *    - Result: No request storms, batches of up to 25 events
 * 
 * 3) With ingest server down (or port 7242 not listening):
 *    - Set DEBUG_INGEST=true
 *    - Process a few rows
 *    - Expected: After 3 failures, ingest disables for 60s
 *    - Verify: Console shows "INGEST: fail-safe triggered, disabled until..."
 *    - Verify: App continues processing normally (no crashes)
 *    - Result: Ingest gracefully degrades, app remains functional
 * 
 * 4) Distance validation bug fix:
 *    - Create test case: originalCoords exist, distance=1000m, confidence=1.0
 *    - Expected: finalStatus=NEEDS_REVIEW (never CONFIRMED)
 *    - Verify: Check GEO_VALIDATE log shows finalStatus=NEEDS_REVIEW
 *    - Verify: Message includes distance warning
 *    - Result: Large distances (>500m) prevent CONFIRMED status
 */

