// ── Build & Feature Flags ─────────────────────────────────────────────
// Central flags consumed by main.js and (via preload) the renderer.
// Flip these to ship a different build target.

const IS_MAS_BUILD = process.env.CLIPSTACK_TARGET === "mas";
const IS_PRODUCTION = process.env.NODE_ENV === "production" || !!process.defaultApp === false;

// Pro / IAP — keep entirely off until StoreKit is wired.
const PRO_UI_ENABLED = false;     // shows upgrade buttons, subscription modal
const PRO_FEATURES_UNLOCKED = false; // gates transforms, export, tags, snippets-as-pro, image actions

// Network / sharing — never ship without a vetted, transparent replacement.
const SHARING_ENABLED = false;        // ngrok, public links, etc.
const IMAGE_URL_FETCH_ENABLED = false; // silent outbound on clipboard event

// MAS sandbox can't shell out to AppleScript or synthesize keystrokes
// reliably, so the auto-paste path is disabled there.
const AUTO_PASTE_ENABLED = !IS_MAS_BUILD;
const SOURCE_APP_PROBE_ENABLED = !IS_MAS_BUILD;

// Free-tier limits
const FREE_HISTORY_LIMIT = 100;
const FREE_SNIPPET_LIMIT = 10;
const FREE_TAG_LIMIT_PER_ITEM = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const HISTORY_RETENTION_DAYS = 30;

module.exports = {
  IS_MAS_BUILD,
  IS_PRODUCTION,
  PRO_UI_ENABLED,
  PRO_FEATURES_UNLOCKED,
  SHARING_ENABLED,
  IMAGE_URL_FETCH_ENABLED,
  AUTO_PASTE_ENABLED,
  SOURCE_APP_PROBE_ENABLED,
  FREE_HISTORY_LIMIT,
  FREE_SNIPPET_LIMIT,
  FREE_TAG_LIMIT_PER_ITEM,
  MAX_IMAGE_BYTES,
  HISTORY_RETENTION_DAYS,
};
