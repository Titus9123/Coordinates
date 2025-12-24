// Use proxy endpoint in development to avoid CORS issues
// In production, this should be configured to use a server-side proxy
// If proxy fails, fallback to direct Nominatim URL (may have CORS issues in browser)
export const NOMINATIM_BASE_URL =
  import.meta.env.DEV
    ? "/api/nominatim/search"
    : "https://nominatim.openstreetmap.org/search";

// Fallback URL if proxy fails (for development)
export const NOMINATIM_DIRECT_URL = "https://nominatim.openstreetmap.org/search";

// GovMap API base URL - use proxy in development to avoid CORS issues
export const GOVMAP_BASE_URL =
  import.meta.env.DEV
    ? "/api/govmap/arcgis/rest/services/Location/FindLocation/GeocodeServer/findAddressCandidates"
    : "https://govmap.gov.il/arcgis/rest/services/Location/FindLocation/GeocodeServer/findAddressCandidates";

export const NETIVOT_BOUNDS = {
  minLat: 31.40,
  maxLat: 31.52,
  minLon: 34.55,
  maxLon: 34.72,
};

/**
 * Debug flag for geocoding chain logging.
 * Set to true to enable console.log statements for GEO_CHAIN, GEO_VALIDATE, and GOVMAP_CALL.
 */
export const DEBUG_GEO = true;

/**
 * Debug flag for telemetry/ingest logging.
 * Set to true to enable event ingestion to the ingest server.
 * When false, all ingest calls are no-ops (no network requests).
 */
export const DEBUG_INGEST = false;

/**
 * Base URL for the ingest/telemetry server.
 * Defaults to localhost development server.
 */
export const INGEST_BASE_URL = "http://127.0.0.1:7242";