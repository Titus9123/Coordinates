/**
 * Hybrid Geocoder v1
 * 
 * Implements the first version of the hybrid/ensemble geocoding engine that combines:
 * - GISService (highest accuracy, ground truth data)
 * - Nominatim (fallback for addresses not in GIS layer)
 * - Bounding box validation for Netivot
 * - Confidence scoring based on source and method
 * 
 * This is the foundation for achieving ~99% geocoding accuracy by leveraging multiple
 * data sources and intelligent result selection.
 */

import { NETIVOT_BOUNDS, NOMINATIM_BASE_URL, DEBUG_GEO } from "../constants";
import { GISService, GISLookupResult } from "./gisService";
import { geocodeNetivot } from "./geocoding";
import { normalizeStreetText } from "./normalization";
import { geocodeWithGovmap } from "./govmapService";
import { enqueueIngest } from "./ingestClient";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Geocode request type supporting different address formats.
 */
export type GeocodeRequest =
  | { kind: "STREET_NUMBER"; street: string; houseNumber: number }
  | { kind: "INTERSECTION"; rawText: string }
  | { kind: "POI"; rawText: string };

/**
 * Unified geocoding result format returned by HybridGeocoder
 */
export interface HybridGeocodingResult {
  lat: number;
  lon: number;
  confidence: number;
  source: "GIS" | "NOMINATIM" | "GOVMAP";
  method:
    | "GIS_EXACT"
    | "GIS_INTERPOLATED"
    | "NOMINATIM"
    | "NOMINATIM_BBOX_RESTRICTED"
    | "NOMINATIM_OUT_OF_BOUNDS"
    | "GEOCODE";
}

/**
 * Internal state for HybridGeocoder
 */
interface HybridGeocoderState {
  initialized: boolean;
  gisLayerPath: string;
}

// ============================================================================
// Internal State
// ============================================================================

const state: HybridGeocoderState = {
  initialized: false,
  gisLayerPath: "/gis/netivot.geojson",
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Checks if coordinates are within Netivot's bounding box.
 * 
 * @param lat - Latitude
 * @param lon - Longitude
 * @returns true if coordinates are within Netivot bounds
 */
function isWithinNetivotBounds(lat: number, lon: number): boolean {
  return (
    lat >= NETIVOT_BOUNDS.minLat &&
    lat <= NETIVOT_BOUNDS.maxLat &&
    lon >= NETIVOT_BOUNDS.minLon &&
    lon <= NETIVOT_BOUNDS.maxLon
  );
}

/**
 * Constructs a Nominatim query from street name and house number.
 * Adds Netivot and Israel context for better results.
 * 
 * Uses normalizeStreetText() for consistent street name normalization.
 * 
 * @param street - Street name
 * @param houseNumber - House number
 * @returns Formatted query string for Nominatim
 */
function buildNominatimQuery(street: string, houseNumber: number): string {
  const streetNormalized = normalizeStreetText(street);
  const addressPart = `${streetNormalized} ${houseNumber}`;
  
  // Ensure Netivot and Israel context
  return `${addressPart}, נתיבות, ישראל`;
}

/**
 * Geocodes an address using Nominatim (OpenStreetMap).
 * 
 * @param street - Street name
 * @param houseNumber - House number
 * @returns Geocoding result or null if not found
 */
async function geocodeWithNominatim(
  street: string,
  houseNumber: number
): Promise<{ lat: number; lon: number } | null> {
  try {
    const query = buildNominatimQuery(street, houseNumber);
    const url =
      `${NOMINATIM_BASE_URL}?` +
      `q=${encodeURIComponent(query)}` +
      `&format=json` +
      `&limit=1` +
      `&addressdetails=1` +
      `&accept-language=he` +
      `&countrycodes=il`;

    // #region agent log
    enqueueIngest({location:'hybridGeocoder.ts:112',message:'Before Nominatim fetch',data:{url,street,houseNumber},sourceFile:'hybridGeocoder.ts',sourceFn:'geocodeWithNominatim'});
    // #endregion

    // Add timeout to prevent hanging (8 seconds - shorter to fail faster)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 8000);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': 'Coordinates-Geocoding-App/1.0',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (error) {
      clearTimeout(timeoutId);
      // #region agent log
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      enqueueIngest({location:'hybridGeocoder.ts:125',message:'Nominatim fetch error (timeout or network)',data:{errorMessage:error instanceof Error?error.message:String(error),isTimeout,url},sourceFile:'hybridGeocoder.ts',sourceFn:'geocodeWithNominatim'});
      // #endregion
      if (isTimeout) {
        console.warn('Nominatim API request timed out after 8 seconds', { url });
      } else {
        console.warn('Nominatim API request failed', { url, error });
      }
      // Return null on timeout/error - processing will continue
      return null;
    }
    
    // #region agent log
    enqueueIngest({location:'hybridGeocoder.ts:118',message:'After Nominatim fetch',data:{status:response.status,statusText:response.statusText,ok:response.ok},sourceFile:'hybridGeocoder.ts',sourceFn:'geocodeWithNominatim'});
    // #endregion
    
    if (!response.ok) {
      // #region agent log
      let errorBody = null;
      try {
        const text = await response.clone().text();
        errorBody = text.substring(0, 500); // Limit to first 500 chars
      } catch (e) {
        // Ignore error reading body
      }
      enqueueIngest({location:'hybridGeocoder.ts:126',message:'Nominatim fetch not ok',data:{status:response.status,statusText:response.statusText,url,errorBody,isDev:import.meta.env.DEV},sourceFile:'hybridGeocoder.ts',sourceFn:'geocodeWithNominatim'});
      // #endregion
      console.error(`Nominatim API error: ${response.status} ${response.statusText}`, { url, errorBody });
      return null;
    }

    const data = await response.json();
    
    if (!data || !Array.isArray(data) || data.length === 0) {
      return null;
    }

    const item = data[0];
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return null;
    }

    return { lat, lon };
  } catch (error) {
    // #region agent log
    enqueueIngest({location:'hybridGeocoder.ts:134',message:'Nominatim geocoding error',data:{errorMessage:error instanceof Error?error.message:String(error),errorName:error instanceof Error?error.name:undefined,isCorsError:error instanceof TypeError && error.message.includes('CORS')},sourceFile:'hybridGeocoder.ts',sourceFn:'geocodeWithNominatim'});
    // #endregion
    console.error("Nominatim geocoding error:", error);
    return null;
  }
}

/**
 * Converts a GIS lookup result to the unified HybridGeocodingResult format.
 * 
 * @param gisResult - Result from GISService
 * @returns Unified geocoding result
 */
function convertGISResultToHybrid(
  gisResult: GISLookupResult
): HybridGeocodingResult {
  const method = gisResult.confidence === 1.0 ? "GIS_EXACT" : "GIS_INTERPOLATED";
  
  return {
    lat: gisResult.lat,
    lon: gisResult.lon,
    confidence: gisResult.confidence,
    source: "GIS",
    method,
  };
}

/**
 * Converts a Nominatim result to the unified HybridGeocodingResult format.
 * Applies bounding box validation and adjusts confidence accordingly.
 * 
 * @param nominatimResult - Raw result from Nominatim
 * @returns Unified geocoding result or null if out of bounds (based on requirements)
 */
function convertNominatimResultToHybrid(
  nominatimResult: { lat: number; lon: number }
): HybridGeocodingResult | null {
  const insideBounds = isWithinNetivotBounds(nominatimResult.lat, nominatimResult.lon);

  if (!insideBounds) {
    // Return result with low confidence and out-of-bounds method
    return {
      lat: nominatimResult.lat,
      lon: nominatimResult.lon,
      confidence: 0.3,
      source: "NOMINATIM",
      method: "NOMINATIM_OUT_OF_BOUNDS",
    };
  }

  // Inside bounds: return with moderate confidence
  return {
    lat: nominatimResult.lat,
    lon: nominatimResult.lon,
    confidence: 0.6,
    source: "NOMINATIM",
    method: "NOMINATIM_BBOX_RESTRICTED",
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initializes the HybridGeocoder by loading the GIS layer.
 * Must be called before using geocode().
 * 
 * @param gisLayerPath - Optional path to GIS layer (defaults to "/gis/netivot.geojson")
 * @throws Error if GIS layer cannot be loaded
 */
async function init(gisLayerPath?: string): Promise<void> {
  const layerPath = gisLayerPath || state.gisLayerPath;
  // #region agent log
  enqueueIngest({location:'hybridGeocoder.ts:203',message:'HybridGeocoder.init called',data:{layerPath,alreadyInitialized:state.initialized},sourceFile:'hybridGeocoder.ts',sourceFn:'init'});
  // #endregion
  
  try {
    // #region agent log
    enqueueIngest({location:'hybridGeocoder.ts:207',message:'Before GISService.loadLayer',data:{layerPath},sourceFile:'hybridGeocoder.ts',sourceFn:'init'});
    // #endregion
    // Load address points layer (for geocoding)
    await GISService.loadLayer(layerPath);
    // #region agent log
    enqueueIngest({location:'hybridGeocoder.ts:212',message:'After GISService.loadLayer',data:{},sourceFile:'hybridGeocoder.ts',sourceFn:'init'});
    // #endregion
    
    // Load street segments layer (for street search)
    // This ensures street search works even if not explicitly initialized elsewhere
    await GISService.ensureStreetSegmentsLoaded("/gis/שמות_רחובות_2025.geojson");
    // #region agent log
    enqueueIngest({location:'hybridGeocoder.ts:216',message:'After ensureStreetSegmentsLoaded',data:{},sourceFile:'hybridGeocoder.ts',sourceFn:'init'});
    // #endregion
    
    state.initialized = true;
    state.gisLayerPath = layerPath;
    // #region agent log
    enqueueIngest({location:'hybridGeocoder.ts:220',message:'HybridGeocoder.init completed',data:{},sourceFile:'hybridGeocoder.ts',sourceFn:'init'});
    // #endregion
  } catch (error) {
    // #region agent log
    enqueueIngest({location:'hybridGeocoder.ts:217',message:'HybridGeocoder.init failed',data:{errorMessage:error instanceof Error?error.message:String(error),errorStack:error instanceof Error?error.stack:undefined},sourceFile:'hybridGeocoder.ts',sourceFn:'init'});
    // #endregion
    console.error("Failed to initialize HybridGeocoder:", error);
    throw error;
  }
}

/**
 * Geocodes an address using the hybrid ensemble approach.
 * 
 * Geocoding flow:
 * 1. Try GIS lookup first (highest accuracy, ground truth)
 * 2. If GIS fails, try Nominatim (fallback)
 * 3. Validate Nominatim results against Netivot bounding box
 * 4. Return unified result with confidence score
 * 
 * @param street - Street name
 * @param houseNumber - House number
 * @returns Unified geocoding result or null if no match found
 */
async function geocode(
  street: string,
  houseNumber: number
): Promise<HybridGeocodingResult | null> {
  // #region agent log
  enqueueIngest({location:'hybridGeocoder.ts:235',message:'geocode called',data:{street,houseNumber,initialized:state.initialized},sourceFile:'hybridGeocoder.ts',sourceFn:'geocode'});
  // #endregion
  if (!state.initialized) {
    throw new Error(
      "HybridGeocoder not initialized. Call init() before using geocode()."
    );
  }

  if (!street || typeof houseNumber !== "number" || houseNumber <= 0) {
    return null;
  }

  // Step 1: Try GIS lookup (preferred, highest accuracy)
  // #region agent log
  enqueueIngest({location:'hybridGeocoder.ts:250',message:'Before GISService.lookupAddress',data:{street,houseNumber},sourceFile:'hybridGeocoder.ts',sourceFn:'geocode'});
  // #endregion
  const gisResult = GISService.lookupAddress(street, houseNumber);
  // #region agent log
  enqueueIngest({location:'hybridGeocoder.ts:252',message:'After GISService.lookupAddress',data:{hasResult:!!gisResult,result:gisResult},sourceFile:'hybridGeocoder.ts',sourceFn:'geocode'});
  // #endregion
  
  if (gisResult !== null) {
    if (DEBUG_GEO) {
      console.log(`GEO_CHAIN: GIS succeeded for "${street}" ${houseNumber}, source=GIS, confidence=${gisResult.confidence}`);
    }
    return convertGISResultToHybrid(gisResult);
  }
  
  if (DEBUG_GEO) {
    console.log(`GEO_CHAIN: GIS failed for "${street}" ${houseNumber}, source=GIS, continuing to GovMap`);
  }

  // Step 2: Try GovMap (official Israeli government source)
  const query = `${normalizeStreetText(street)} ${houseNumber}, נתיבות`;
  if (DEBUG_GEO) {
    console.log(`GEO_CHAIN: GovMap attempt for "${street}" ${houseNumber}, source=GOVMAP, query="${query}"`);
  }
  const govmapResult = await geocodeWithGovmap(query);
  
  if (govmapResult && !Number.isNaN(govmapResult.lat) && !Number.isNaN(govmapResult.lon)) {
    // Enforce bounds: if outside NETIVOT_BOUNDS, treat as null
    const inBounds = isWithinNetivotBounds(govmapResult.lat, govmapResult.lon);
    if (DEBUG_GEO) {
      console.log(`GEO_CHAIN: GovMap result for "${street}" ${houseNumber}, inBounds=${inBounds}, lat=${govmapResult.lat}, lon=${govmapResult.lon}`);
    }
    if (inBounds) {
      if (DEBUG_GEO) {
        console.log(`GEO_CHAIN: GovMap accepted for "${street}" ${houseNumber}`);
      }
      return {
        lat: govmapResult.lat,
        lon: govmapResult.lon,
        confidence: 0.75,
        source: "GOVMAP",
        method: "GEOCODE",
      };
    } else {
      if (DEBUG_GEO) {
        console.log(`GEO_CHAIN: GovMap rejected (out of bounds) for "${street}" ${houseNumber}, continuing to Nominatim`);
      }
    }
    // Out of bounds - treat as null and continue to Nominatim
  } else {
    if (DEBUG_GEO) {
      console.log(`GEO_CHAIN: GovMap returned null for "${street}" ${houseNumber}, continuing to Nominatim`);
    }
  }

  // Step 3: Try Nominatim (fallback)
  // #region agent log
  enqueueIngest({location:'hybridGeocoder.ts:257',message:'Before geocodeWithNominatim',data:{street,houseNumber},sourceFile:'hybridGeocoder.ts',sourceFn:'geocode'});
  // #endregion
  if (DEBUG_GEO) {
    console.log(`GEO_CHAIN: Nominatim attempt for "${street}" ${houseNumber}, source=NOMINATIM`);
  }
  const nominatimResult = await geocodeWithNominatim(street, houseNumber);
  // #region agent log
  enqueueIngest({location:'hybridGeocoder.ts:259',message:'After geocodeWithNominatim',data:{hasResult:!!nominatimResult,result:nominatimResult},sourceFile:'hybridGeocoder.ts',sourceFn:'geocode'});
  // #endregion
  
  if (nominatimResult === null) {
    if (DEBUG_GEO) {
      console.log(`GEO_CHAIN: Nominatim failed for "${street}" ${houseNumber}, source=NOMINATIM, chain exhausted`);
    }
    return null;
  }

  // Step 4: Validate bounding box and convert to unified format
  const result = convertNominatimResultToHybrid(nominatimResult);
  if (DEBUG_GEO) {
    console.log(`GEO_CHAIN: Nominatim succeeded for "${street}" ${houseNumber}, source=NOMINATIM, confidence=${result.confidence}, method=${result.method}`);
  }
  return result;
}

/**
 * Geocodes a request using the hybrid ensemble approach.
 * 
 * This is the new unified entry point that supports different address types:
 * - STREET_NUMBER: Uses existing geocode() logic (GIS + Nominatim)
 * - INTERSECTION/POI: Uses legacy geocodeNetivot() function
 * 
 * @param req - GeocodeRequest with kind and appropriate fields
 * @returns Unified geocoding result or null if no match found
 */
async function geocodeRequest(
  req: GeocodeRequest
): Promise<HybridGeocodingResult | null> {
  if (req.kind === "STREET_NUMBER") {
    // Route A: STREET_NUMBER - Use existing geocode() logic without changes
    // This ensures identical behavior to calling geocode(req.street, req.houseNumber)
    return await geocode(req.street, req.houseNumber);
  } else if (req.kind === "INTERSECTION" || req.kind === "POI") {
    // Route B/C: INTERSECTION/POI - Use proper geocoding chain (GovMap → Nominatim)
    // LEGACY is NOT a geocoding result - originalCoords are input only, not results
    // Do NOT use GISService.lookupAddress() (it needs house numbers)
    const trimmedText = req.rawText.trim();
    
    if (!trimmedText) {
      return null;
    }
    
    if (DEBUG_GEO) {
      console.log(`GEO_CHAIN: INTERSECTION/POI geocoding for "${trimmedText}", forcing re-geocoding (originalCoords ignored)`);
    }
    
    // Step 1: Try GovMap (official Israeli government source)
    const query = `${trimmedText}, נתיבות`;
    if (DEBUG_GEO) {
      console.log(`GEO_CHAIN: GovMap attempt for INTERSECTION/POI "${trimmedText}", source=GOVMAP, query="${query}"`);
    }
    const govmapResult = await geocodeWithGovmap(query);
    
    if (govmapResult && !Number.isNaN(govmapResult.lat) && !Number.isNaN(govmapResult.lon)) {
      // Enforce bounds: if outside NETIVOT_BOUNDS, treat as null and continue to Nominatim
      const inBounds = isWithinNetivotBounds(govmapResult.lat, govmapResult.lon);
      if (DEBUG_GEO) {
        console.log(`GEO_CHAIN: GovMap result for INTERSECTION/POI "${trimmedText}", inBounds=${inBounds}, lat=${govmapResult.lat}, lon=${govmapResult.lon}`);
      }
      if (inBounds) {
        if (DEBUG_GEO) {
          console.log(`GEO_CHAIN: GovMap accepted for INTERSECTION/POI "${trimmedText}"`);
        }
        return {
          lat: govmapResult.lat,
          lon: govmapResult.lon,
          confidence: 0.75,
          source: "GOVMAP",
          method: "GEOCODE",
        };
      } else {
        if (DEBUG_GEO) {
          console.log(`GEO_CHAIN: GovMap rejected (out of bounds) for INTERSECTION/POI "${trimmedText}", continuing to Nominatim`);
        }
      }
      // Out of bounds - treat as null and continue to Nominatim
    } else {
      if (DEBUG_GEO) {
        console.log(`GEO_CHAIN: GovMap returned null for INTERSECTION/POI "${trimmedText}", continuing to Nominatim`);
      }
    }
    
    // Step 2: Try Nominatim (fallback for INTERSECTION/POI)
    // Use geocodeNetivot which tries GovMap then Nominatim
    // Since GovMap already failed above, geocodeNetivot will try GovMap again (idempotent) then fallback to Nominatim
    const { geocodeNetivot } = await import("./geocoding");
    const fallbackCoords = await geocodeNetivot(trimmedText);
    
    if (!fallbackCoords) {
      if (DEBUG_GEO) {
        console.log(`GEO_CHAIN: Nominatim failed for INTERSECTION/POI "${trimmedText}", source=NOMINATIM, chain exhausted`);
      }
      return null;
    }
    
    // Convert to hybrid format with NOMINATIM source
    // Note: geocodeNetivot may return GovMap result if it succeeded on retry, but we treat it as NOMINATIM
    // since our GovMap attempt above failed. In practice, if GovMap succeeds in geocodeNetivot,
    // it means our bounds check was wrong or GovMap returned different coords - treat as NOMINATIM for consistency
    const insideBounds = isWithinNetivotBounds(fallbackCoords.lat, fallbackCoords.lon);
    if (DEBUG_GEO) {
      console.log(`GEO_CHAIN: Nominatim succeeded for INTERSECTION/POI "${trimmedText}", source=NOMINATIM, inBounds=${insideBounds}`);
    }
    
    if (!insideBounds) {
      // Return result with low confidence and out-of-bounds method
      return {
        lat: fallbackCoords.lat,
        lon: fallbackCoords.lon,
        confidence: 0.3,
        source: "NOMINATIM",
        method: "NOMINATIM_OUT_OF_BOUNDS",
      };
    }
    
    // Inside bounds: return with moderate confidence
    return {
      lat: fallbackCoords.lat,
      lon: fallbackCoords.lon,
      confidence: 0.6,
      source: "NOMINATIM",
      method: "NOMINATIM_BBOX_RESTRICTED",
    };
  }
  
  // Should not reach here due to TypeScript exhaustiveness, but return null for safety
  return null;
}

/**
 * HybridGeocoder object providing the public API.
 * This is the main export for the service.
 */
export const HybridGeocoder = {
  init,
  geocode,
  geocodeRequest,
};

/*
 * Manual Proof Checklist
 * =======================
 * 
 * 1. Start services:
 *    - npm run dev (starts Vite dev server on port 5173)
 *    - node govmap-proxy.js (starts proxy on port 4000)
 * 
 * 2. Enable debug logging:
 *    - Set DEBUG_GEO = true in src/constants.ts
 *    - Restart Vite dev server
 * 
 * 3. Test GET ASCII:
 *    curl -i "http://localhost:5173/api/govmap/geocode?q=test"
 *    Expected: HTTP 200 with JSON response
 *    Console: Look for GOVMAP_CALL log with method=GET or POST
 * 
 * 4. Test POST Hebrew:
 *    curl -i -X POST "http://localhost:5173/api/govmap/geocode" \
 *      -H "Content-Type: application/json" \
 *      --data '{"q":"רחוב התאנה 5"}'
 *    Expected: HTTP 200 with JSON response containing Hebrew address
 *    Console: Look for GOVMAP_CALL log with method=POST
 * 
 * 5. Test geocoding chain (via app UI or direct service call):
 *    - Process a STREET_NUMBER address
 *    - Console should show:
 *      * GEO_CHAIN: GIS succeeded/attempted
 *      * GEO_CHAIN: GovMap attempted/accepted/rejected
 *      * GEO_CHAIN: Nominatim attempted/result
 *      * GEO_VALIDATE: Final validation decision with all parameters
 * 
 * 6. Verify type-aware validation:
 *    - STREET_NUMBER: Can be upgraded by distance if <= 30m
 *    - INTERSECTION/POI: Never upgraded by distance
 *    - Out of bounds: Never marked CONFIRMED
 * 
 * 7. Check logs format:
 *    - All GEO_CHAIN logs start with "GEO_CHAIN:"
 *    - All GEO_VALIDATE logs start with "GEO_VALIDATE:"
 *    - All GOVMAP_CALL logs start with "GOVMAP_CALL:"
 */

