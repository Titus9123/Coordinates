/**
 * GIS Lookup Service
 * 
 * Provides geocoding functionality using municipal ArcGIS layers stored as GeoJSON.
 * This service serves as the ground truth data source for achieving ~99% geocoding accuracy.
 * 
 * Features:
 * - Loads GeoJSON files from local public directory or remote URLs
 * - Exact street name matching with normalization
 * - House number lookup with linear interpolation for missing numbers
 * - Confidence scoring based on match type (exact vs. interpolated)
 * 
 * Uses two separate GIS datasets:
 * 1. netivot.geojson - Address points with house numbers (for precise geocoding)
 * 2. שמות_רחובות_2025.geojson - Street segments with street names (for fast street search)
 */

import { normalizeStreetText } from "./normalization";
import { enqueueIngest } from "./ingestClient";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Address feature from netivot.geojson (address points with house numbers)
 */
interface AddressFeature {
  streetName: string;
  normalizedStreetName: string;
  houseNumber: number | null;
  lat: number;
  lon: number;
}

/**
 * Street segment from שמות_רחובות_2025.geojson (street names only)
 */
interface StreetSegment {
  streetName: string;
  normalizedStreetName: string;
}

/**
 * GIS Lookup Result
 */
export interface GISLookupResult {
  lat: number;
  lon: number;
  confidence: number;
  source: "GIS";
}

// ============================================================================
// Internal State
// ============================================================================

/**
 * Address points dataset (from netivot.geojson)
 * Used for precise geocoding with house numbers
 */
let addressFeatures: AddressFeature[] = [];
let addressLayerLoaded = false;
let addressLayerPath: string | null = null;

/**
 * Cached unique list of normalized street names for fuzzy matching.
 * Populated once when first needed, then reused.
 */
let _uniqueStreetCandidates: string[] | null = null;

/**
 * Street segments dataset (from שמות_רחובות_2025.geojson)
 * Used for fast and complete street name search
 */
let streetSegments: StreetSegment[] = [];
let streetSegmentsLoaded = false;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalizes a street name for comparison.
 * 
 * Now delegates to the unified normalizeStreetText() function for consistency
 * across all street name normalization in the codebase.
 * 
 * @param streetName - Raw street name to normalize
 * @returns Normalized street name for matching
 */
function normalizeStreetName(streetName: string): string {
  return normalizeStreetText(streetName);
}

/**
 * Extracts street name and house number from a GeoJSON feature.
 * Handles various GeoJSON property structures.
 * 
 * @param feature - GeoJSON feature object
 * @returns Object with street name and house number, or null if invalid
 */
function extractAddressFromFeature(feature: any): { streetName: string; houseNumber: number | null } | null {
  if (!feature || !feature.properties) {
    return null;
  }

  const props = feature.properties;
  
  // Try common property names for street (in Hebrew and English)
  const streetName =
    props.street ||
    props.רחוב ||
    props.street_name ||
    props.שם_רחוב ||
    props.str_name ||
    props.address ||
    props.כתובת ||
    "";

  if (!streetName || typeof streetName !== "string") {
    return null;
  }

  // Try common property names for house number
  const houseNumberRaw =
    props.house_number ||
    props.number ||
    props.מספר ||
    props.בית ||
    props.House ||
    props.housenumber ||
    props.houseNumber ||
    null;

  let houseNumber: number | null = null;
  if (houseNumberRaw !== null && houseNumberRaw !== undefined) {
    const parsed = typeof houseNumberRaw === "number" 
      ? houseNumberRaw 
      : parseInt(String(houseNumberRaw), 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      houseNumber = parsed;
    }
  }

  return { streetName, houseNumber };
}

/**
 * Extracts street name from a street segment feature (שמות_רחובות_2025.geojson).
 * Reads from properties["רחוב"].
 * 
 * @param feature - GeoJSON feature object
 * @returns Street name or null if invalid
 */
function extractStreetNameFromSegment(feature: any): string | null {
  if (!feature || !feature.properties) {
    return null;
  }

  const props = feature.properties;
  
  // Read street name from properties["רחוב"]
  const streetName = props.רחוב || props.street || props.street_name || "";

  if (!streetName || typeof streetName !== "string" || streetName.trim().length === 0) {
    return null;
  }

  return streetName.trim();
}

/**
 * Extracts coordinates from a GeoJSON feature.
 * Handles Point, LineString, and Polygon geometries.
 * 
 * @param feature - GeoJSON feature object
 * @returns Object with lat/lon, or null if invalid
 */
function extractCoordinatesFromFeature(feature: any): { lat: number; lon: number } | null {
  if (!feature || !feature.geometry) {
    return null;
  }

  const geometry = feature.geometry;

  // Handle Point geometry (most common for addresses)
  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const [lon, lat] = geometry.coordinates;
    if (typeof lat === "number" && typeof lon === "number" && 
        !Number.isNaN(lat) && !Number.isNaN(lon)) {
      return { lat, lon };
    }
  }

  // Handle LineString: use first coordinate
  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0) {
    const [lon, lat] = geometry.coordinates[0];
    if (typeof lat === "number" && typeof lon === "number" && 
        !Number.isNaN(lat) && !Number.isNaN(lon)) {
      return { lat, lon };
    }
  }

  // Handle Polygon: use first coordinate of first ring
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0) {
    const ring = geometry.coordinates[0];
    if (Array.isArray(ring) && ring.length > 0) {
      const [lon, lat] = ring[0];
      if (typeof lat === "number" && typeof lon === "number" && 
          !Number.isNaN(lat) && !Number.isNaN(lon)) {
        return { lat, lon };
      }
    }
  }

  return null;
}

/**
 * Performs linear interpolation between two house numbers to estimate coordinates.
 * 
 * @param lowerNumber - Lower house number
 * @param lowerCoords - Coordinates for lower house number
 * @param upperNumber - Upper house number
 * @param upperCoords - Coordinates for upper house number
 * @param targetNumber - Target house number to interpolate
 * @returns Interpolated coordinates
 */
function interpolateCoordinates(
  lowerNumber: number,
  lowerCoords: { lat: number; lon: number },
  upperNumber: number,
  upperCoords: { lat: number; lon: number },
  targetNumber: number
): { lat: number; lon: number } {
  // Calculate interpolation factor (0 = lower, 1 = upper)
  const factor = (targetNumber - lowerNumber) / (upperNumber - lowerNumber);
  
  // Interpolate latitude and longitude
  const lat = lowerCoords.lat + (upperCoords.lat - lowerCoords.lat) * factor;
  const lon = lowerCoords.lon + (upperCoords.lon - lowerCoords.lon) * factor;
  
  return { lat, lon };
}

// ============================================================================
// Address Points Layer (netivot.geojson)
// ============================================================================

/**
 * Loads the address points layer from netivot.geojson.
 * Parses the GeoJSON and stores address features in memory for fast lookup.
 * 
 * @param pathOrUrl - Path to GeoJSON file (defaults to "/public/gis/netivot.geojson") or URL
 * @throws Error if file cannot be loaded or parsed
 */
export async function loadLayer(pathOrUrl?: string): Promise<void> {
  // Default to netivot.geojson if not provided
  const layerPath = pathOrUrl || "/public/gis/netivot.geojson";
  // #region agent log
  enqueueIngest({location:'gisService.ts:263',message:'loadLayer called',data:{layerPath,alreadyLoaded:addressLayerLoaded,currentPath:addressLayerPath},sourceFile:'gisService.ts',sourceFn:'loadLayer'});
  // #endregion
  
  // If already loaded with the same path, skip reload
  if (addressLayerLoaded && addressLayerPath === layerPath) {
    // #region agent log
    enqueueIngest({location:'gisService.ts:268',message:'loadLayer skipped (already loaded)',data:{layerPath},sourceFile:'gisService.ts',sourceFn:'loadLayer'});
    // #endregion
    return;
  }

  try {
    // Determine if it's a URL or local path
    const isUrl = layerPath.startsWith("http://") || layerPath.startsWith("https://");
    
    // For local files in public directory, remove leading slash if present and use relative path
    const fetchPath = isUrl 
      ? layerPath 
      : layerPath.startsWith("/") 
        ? layerPath.substring(1) 
        : layerPath;
    // #region agent log
    enqueueIngest({location:'gisService.ts:283',message:'Before fetch GIS layer',data:{fetchPath,isUrl},sourceFile:'gisService.ts',sourceFn:'loadLayer'});
    // #endregion

    const response = await fetch(fetchPath);
    // #region agent log
    enqueueIngest({location:'gisService.ts:285',message:'After fetch GIS layer',data:{status:response.status,statusText:response.statusText,ok:response.ok},sourceFile:'gisService.ts',sourceFn:'loadLayer'});
    // #endregion
    
    if (!response.ok) {
      throw new Error(`Failed to load GIS layer: ${response.status} ${response.statusText}`);
    }

    const geoJson = await response.json();
    // #region agent log
    enqueueIngest({location:'gisService.ts:291',message:'GIS layer JSON parsed',data:{type:geoJson?.type,featuresCount:Array.isArray(geoJson?.features)?geoJson.features.length:0},sourceFile:'gisService.ts',sourceFn:'loadLayer'});
    // #endregion

    if (!geoJson || geoJson.type !== "FeatureCollection" || !Array.isArray(geoJson.features)) {
      throw new Error("Invalid GeoJSON format: expected FeatureCollection with features array");
    }

    // Parse and store address features
    const features: AddressFeature[] = [];

    for (const feature of geoJson.features) {
      const address = extractAddressFromFeature(feature);
      const coords = extractCoordinatesFromFeature(feature);

      if (!address || !coords) {
        // Skip features without valid address or coordinates
        continue;
      }

      const normalizedStreetName = normalizeStreetName(address.streetName);

      features.push({
        streetName: address.streetName,
        normalizedStreetName,
        houseNumber: address.houseNumber,
        lat: coords.lat,
        lon: coords.lon,
      });
    }

    // Update store
    addressFeatures = features;
    addressLayerLoaded = true;
    addressLayerPath = layerPath;
    // #region agent log
    enqueueIngest({location:'gisService.ts:321',message:'GIS layer loaded successfully',data:{featuresCount:features.length,layerPath},sourceFile:'gisService.ts',sourceFn:'loadLayer'});
    // #endregion

    console.log(`Address points layer loaded: ${features.length} features from ${layerPath}`);
  } catch (error) {
    // #region agent log
    enqueueIngest({location:'gisService.ts:325',message:'GIS layer load failed',data:{errorMessage:error instanceof Error?error.message:String(error),errorStack:error instanceof Error?error.stack:undefined,layerPath},sourceFile:'gisService.ts',sourceFn:'loadLayer'});
    // #endregion
    console.error("Error loading address points layer:", error);
    throw error;
  }
}

/**
 * Checks if a street exists in the loaded address points layer.
 * 
 * @param streetName - Street name to check (will be normalized)
 * @returns true if street exists, false otherwise
 */
export function streetExists(streetName: string): boolean {
  if (!addressLayerLoaded || !streetName) {
    return false;
  }

  const normalized = normalizeStreetName(streetName);
  
  return addressFeatures.some(
    (feature) => feature.normalizedStreetName === normalized
  );
}

/**
 * Checks if a specific house number exists for a given street.
 * 
 * @param streetName - Street name (will be normalized)
 * @param houseNumber - House number to check
 * @returns true if exact house number exists for the street, false otherwise
 */
export function numberExists(streetName: string, houseNumber: number): boolean {
  if (!addressLayerLoaded || !streetName || typeof houseNumber !== "number" || houseNumber <= 0) {
    return false;
  }

  const normalized = normalizeStreetName(streetName);
  
  return addressFeatures.some(
    (feature) =>
      feature.normalizedStreetName === normalized &&
      feature.houseNumber !== null &&
      feature.houseNumber === houseNumber
  );
}

/**
 * Finds the best matching street name from candidates using fuzzy matching.
 * 
 * Scoring rules (deterministic and bounded):
 * - Exact match: score = 1.0
 * - StartsWith match: score = 0.85 (candidate starts with input or vice versa)
 * - Token overlap: score = (2 * intersectionCount) / (tokenCountA + tokenCountB), min 0.5
 * 
 * Returns the candidate with highest score, or null if best score < 0.7.
 * 
 * @param normalizedInput - Normalized input street name
 * @param candidates - Array of candidate normalized street names
 * @returns Best match and score, or null if no good match
 */
function findBestStreetNameMatch(
  normalizedInput: string,
  candidates: string[]
): { best: string | null; score: number } {
  if (!normalizedInput || candidates.length === 0) {
    return { best: null, score: 0 };
  }

  let bestCandidate: string | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    let score = 0;

    // Exact match: score = 1.0
    if (candidate === normalizedInput) {
      score = 1.0;
    }
    // StartsWith match: prefer specificity (shorter length difference)
    else if (candidate.startsWith(normalizedInput)) {
      // Candidate starts with input: score = 0.85 if length difference <= 3, else 0.75
      const lengthDiff = candidate.length - normalizedInput.length;
      score = lengthDiff <= 3 ? 0.85 : 0.75;
    }
    else if (normalizedInput.startsWith(candidate)) {
      // Input starts with candidate: score = 0.85 if length difference <= 3, else 0.60
      // (generic prefix should not dominate)
      const lengthDiff = normalizedInput.length - candidate.length;
      score = lengthDiff <= 3 ? 0.85 : 0.60;
    }
    // Token overlap score
    else {
      // Split both strings on spaces into tokens, ignore empty tokens
      const inputTokens = normalizedInput.split(/\s+/).filter(t => t.length > 0);
      const candidateTokens = candidate.split(/\s+/).filter(t => t.length > 0);

      if (inputTokens.length === 0 || candidateTokens.length === 0) {
        score = 0;
      } else {
        // Count intersection of tokens (identical tokens shared)
        const inputSet = new Set(inputTokens);
        const candidateSet = new Set(candidateTokens);
        let intersectionCount = 0;

        for (const token of inputSet) {
          if (candidateSet.has(token)) {
            intersectionCount++;
          }
        }

        // Token overlap score: (2 * intersectionCount) / (tokenCountA + tokenCountB)
        const totalTokens = inputTokens.length + candidateTokens.length;
        score = totalTokens > 0 ? (2 * intersectionCount) / totalTokens : 0;

        // If score < 0.5, treat as 0
        if (score < 0.5) {
          score = 0;
        }
        // If token overlap score >= 0.80, add specificity bonus
        else if (score >= 0.80) {
          // Bonus for longer candidates (more specific): min(0.05, (len(candidate) - len(normalizedInput)) * 0.005)
          const lengthDiff = candidate.length - normalizedInput.length;
          if (lengthDiff > 0) {
            const bonus = Math.min(0.05, lengthDiff * 0.005);
            score = Math.min(1.0, score + bonus);
          }
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  // Return null if best score < 0.7
  if (bestScore < 0.7) {
    return { best: null, score: bestScore };
  }

  return { best: bestCandidate, score: bestScore };
}

/**
 * Looks up an address in the address points layer.
 * 
 * Matching logic:
 * 1. Exact match (street + house number): confidence = 1.0
 * 2. Street exists, number missing: linear interpolation, confidence = 0.8
 * 3. If exact street match fails, try fuzzy street name matching
 * 4. If fuzzy match found, reduce confidence by 0.1 (exact=1.0->0.9, interpolated=0.8->0.7)
 * 5. No match: returns null
 * 
 * @param streetName - Street name (will be normalized)
 * @param houseNumber - House number
 * @returns GIS lookup result with coordinates and confidence, or null if not found
 */
export function lookupAddress(
  streetName: string,
  houseNumber: number
): GISLookupResult | null {
  if (!addressLayerLoaded || !streetName || typeof houseNumber !== "number" || houseNumber <= 0) {
    return null;
  }

  const normalized = normalizeStreetName(streetName);
  
  // #region agent log
  enqueueIngest({location:'gisService.ts:403',message:'GIS lookupAddress called',data:{streetName,normalized,houseNumber,totalFeatures:addressFeatures.length},sourceFile:'gisService.ts',sourceFn:'lookupAddress'});
  // #endregion

  // Find all features for this street (exact match first)
  let streetFeatures = addressFeatures.filter(
    (feature) => feature.normalizedStreetName === normalized && feature.houseNumber !== null
  );
  
  // #region agent log
  enqueueIngest({location:'gisService.ts:415',message:'GIS lookupAddress street features found',data:{streetName,normalized,houseNumber,streetFeaturesCount:streetFeatures.length,allStreetNames:Array.from(new Set(addressFeatures.map(f=>f.normalizedStreetName))).slice(0,10)},sourceFile:'gisService.ts',sourceFn:'lookupAddress'});
  // #endregion

  let fuzzyUsed = false;

  // If exact match fails, try fuzzy matching
  if (streetFeatures.length === 0) {
    // Ensure candidate list is initialized (build once, reuse)
    if (_uniqueStreetCandidates === null) {
      _uniqueStreetCandidates = Array.from(
        new Set(addressFeatures.map(f => f.normalizedStreetName).filter(Boolean))
      );
    }

    // Call findBestStreetNameMatch
    const fuzzyResult = findBestStreetNameMatch(normalized, _uniqueStreetCandidates);

    if (fuzzyResult.best === null) {
      // No good fuzzy match found - return null (same as current behavior)
      // #region agent log
      const similarStreets = addressFeatures
        .map(f => f.normalizedStreetName)
        .filter(name => name.includes(normalized) || normalized.includes(name))
        .slice(0, 5);
      enqueueIngest({location:'gisService.ts:420',message:'GIS lookupAddress street not found (exact and fuzzy)',data:{streetName,normalized,houseNumber,similarStreets,fuzzyScore:fuzzyResult.score},sourceFile:'gisService.ts',sourceFn:'lookupAddress'});
      // #endregion
      return null;
    }

    // Fuzzy match found - use the best candidate
    fuzzyUsed = true;
    streetFeatures = addressFeatures.filter(
      (feature) => feature.normalizedStreetName === fuzzyResult.best && feature.houseNumber !== null
    );

    // Minimal observability: log when fuzzy matching is used
    console.log(`GIS fuzzy street match: input=${normalized} best=${fuzzyResult.best} score=${fuzzyResult.score.toFixed(2)}`);
  }

  // Sort features by house number for interpolation
  const sortedFeatures = [...streetFeatures].sort(
    (a, b) => (a.houseNumber || 0) - (b.houseNumber || 0)
  );

  // Try exact match first
  const exactMatch = sortedFeatures.find(
    (feature) => feature.houseNumber === houseNumber
  );

  if (exactMatch) {
    // If fuzzy match was used, reduce confidence by 0.1 (1.0 -> 0.9)
    const confidence = fuzzyUsed ? 0.9 : 1.0;
    return {
      lat: exactMatch.lat,
      lon: exactMatch.lon,
      confidence,
      source: "GIS",
    };
  }

  // No exact match - try interpolation
  // Find the two closest house numbers (one below, one above)
  let lowerIndex = -1;
  let upperIndex = -1;

  for (let i = 0; i < sortedFeatures.length; i++) {
    const num = sortedFeatures[i].houseNumber || 0;
    if (num < houseNumber) {
      lowerIndex = i;
    } else if (num > houseNumber && upperIndex === -1) {
      upperIndex = i;
      break;
    }
  }

  // Need both lower and upper bounds for interpolation
  if (lowerIndex === -1 || upperIndex === -1) {
    // Cannot interpolate (target is outside range or only one bound exists)
    return null;
  }

  const lowerFeature = sortedFeatures[lowerIndex];
  const upperFeature = sortedFeatures[upperIndex];

  const interpolated = interpolateCoordinates(
    lowerFeature.houseNumber || 0,
    { lat: lowerFeature.lat, lon: lowerFeature.lon },
    upperFeature.houseNumber || 0,
    { lat: upperFeature.lat, lon: upperFeature.lon },
    houseNumber
  );

  // If fuzzy match was used, reduce confidence by 0.1 (0.8 -> 0.7)
  const confidence = fuzzyUsed ? 0.7 : 0.8;

  return {
    lat: interpolated.lat,
    lon: interpolated.lon,
    confidence,
    source: "GIS",
  };
}

// ============================================================================
// Street Segments Layer (שמות_רחובות_2025.geojson)
// ============================================================================

/**
 * Loads the street segments layer from שמות_רחובות_2025.geojson.
 * Parses the GeoJSON and stores unique street names for fast search.
 * 
 * @param pathOrUrl - Path to GeoJSON file (defaults to "/public/gis/שמות_רחובות_2025.geojson") or URL
 * @throws Error if file cannot be loaded or parsed
 */
async function loadStreetSegmentsLayer(pathOrUrl?: string): Promise<void> {
  // Default to שמות_רחובות_2025.geojson if not provided
  const layerPath = pathOrUrl || "/public/gis/שמות_רחובות_2025.geojson";
  
  // If already loaded, skip reload (idempotent)
  if (streetSegmentsLoaded && streetSegments.length > 0) {
    return;
  }

  try {
    // Determine if it's a URL or local path
    const isUrl = layerPath.startsWith("http://") || layerPath.startsWith("https://");
    
    // For local files in public directory, remove leading slash if present and use relative path
    const fetchPath = isUrl 
      ? layerPath 
      : layerPath.startsWith("/") 
        ? layerPath.substring(1) 
        : layerPath;

    const response = await fetch(fetchPath);
    
    if (!response.ok) {
      throw new Error(`Failed to load street segments layer: ${response.status} ${response.statusText}`);
    }

    const geoJson = await response.json();

    if (!geoJson || geoJson.type !== "FeatureCollection" || !Array.isArray(geoJson.features)) {
      throw new Error("Invalid GeoJSON format: expected FeatureCollection with features array");
    }

    // Parse and store unique street names
    const streetNameSet = new Set<string>(); // Track by original name
    const normalizedSet = new Set<string>(); // Track by normalized name to avoid duplicates

    for (const feature of geoJson.features) {
      const streetName = extractStreetNameFromSegment(feature);

      if (!streetName) {
        // Skip features without valid street name
        continue;
      }

      const normalized = normalizeStreetName(streetName);

      // Only add if we haven't seen this normalized street name before
      if (normalized && !normalizedSet.has(normalized)) {
        normalizedSet.add(normalized);
        streetNameSet.add(streetName);
      }
    }

    // Convert to array of StreetSegment objects
    streetSegments = Array.from(streetNameSet).map((streetName) => ({
      streetName,
      normalizedStreetName: normalizeStreetName(streetName),
    }));

    streetSegmentsLoaded = true;

    console.log(`Street segments layer loaded: ${streetSegments.length} unique streets from ${layerPath}`);
  } catch (error) {
    console.error("Error loading street segments layer:", error);
    throw error;
  }
}

/**
 * Ensures the street segments layer is loaded.
 * This is a helper function that loads the layer if it hasn't been loaded yet.
 * 
 * @param pathOrUrl - Optional path to street segments GeoJSON file
 */
async function ensureStreetSegmentsLoaded(pathOrUrl?: string): Promise<void> {
  if (!streetSegmentsLoaded || streetSegments.length === 0) {
    await loadStreetSegmentsLayer(pathOrUrl);
  }
}

/**
 * Searches for streets in the street segments layer that match a query.
 * 
 * NOTE: This function requires that the street segments layer be loaded beforehand.
 * Call ensureStreetSegmentsLoaded() or loadStreetSegmentsLayer() before using this function.
 * 
 * Returns unique street names where the normalized street name starts with
 * the normalized query. Uses the same normalization logic as other GIS functions
 * to ensure consistency.
 * 
 * @param query - Search query (will be normalized)
 * @param maxResults - Maximum number of results to return (default: 20)
 * @returns Array of unique street names matching the query
 */
export function searchStreets(query: string, maxResults: number = 20): { streetName: string }[] {
  // If street segments not loaded, return empty array
  if (!streetSegmentsLoaded || streetSegments.length === 0) {
    console.warn("Street segments layer not loaded. Call ensureStreetSegmentsLoaded() first.");
    return [];
  }

  if (!query || typeof query !== "string") {
    return [];
  }

  // Normalize the query using the same logic as street matching
  const normalizedQuery = normalizeStreetName(query);
  
  if (normalizedQuery.length < 2) {
    return [];
  }

  // Collect matching street names from street segments
  const results: string[] = [];
  
  for (const segment of streetSegments) {
    if (segment.normalizedStreetName.startsWith(normalizedQuery)) {
      // Use the original (non-normalized) street name for display
      results.push(segment.streetName);
    }
  }

  // Ensure uniqueness, sort, and limit results
  const uniqueResults = Array.from(new Set(results))
    .sort((a, b) => a.localeCompare(b, "he"))
    .slice(0, maxResults)
    .map((streetName) => ({ streetName }));

  return uniqueResults;
}

/**
 * Lists all house numbers for a given street from the address points layer.
 * 
 * @param streetName - Street name (will be normalized)
 * @returns Array of house numbers in ascending order, or empty array if street not found or no house numbers
 */
export function listHouseNumbers(streetName: string): number[] {
  if (!addressLayerLoaded || !streetName) {
    return [];
  }

  const normalized = normalizeStreetName(streetName);
  
  // Find all features for this street with valid house numbers
  const houseNumbers = addressFeatures
    .filter(
      (feature) =>
        feature.normalizedStreetName === normalized &&
        feature.houseNumber !== null &&
        feature.houseNumber > 0
    )
    .map((feature) => feature.houseNumber!)
    .filter((num, index, arr) => arr.indexOf(num) === index) // Remove duplicates
    .sort((a, b) => a - b); // Sort ascending

  return houseNumbers;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * GIS Service object providing all public functions.
 * This is the main export for the service.
 */
export const GISService = {
  loadLayer,
  streetExists,
  numberExists,
  lookupAddress,
  searchStreets,
  listHouseNumbers,
  // Internal helper for initialization (can be used by callers that need to ensure street segments are loaded)
  ensureStreetSegmentsLoaded,
};
