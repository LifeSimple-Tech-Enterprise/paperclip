export const PLUGIN_ID = "github-ci-bridge";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  ciEvent: "ci_event",
} as const;

/** Maximum allowed clock skew between the sender timestamp and server time (seconds). */
export const TIMESTAMP_WINDOW_SECONDS = 300;

/** Header carrying the HMAC-SHA256 signature in "sha256=<hex>" format. */
export const SIGNATURE_HEADER = "x-paperclip-signature";

/** Header carrying the Unix-second timestamp used in the HMAC computation. */
export const TIMESTAMP_HEADER = "x-paperclip-timestamp";

/** Header carrying the idempotency key for replay detection. */
export const IDEMPOTENCY_HEADER = "x-paperclip-idempotency-key";
