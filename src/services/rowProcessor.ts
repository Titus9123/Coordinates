/**
 * Row Processor Service
 * 
 * Processes AddressRow objects using the HybridGeocoder to assign coordinates
 * and status based on geocoding results and confidence scores.
 * 
 * This service integrates the hybrid geocoding engine (GIS + Nominatim) into
 * the row processing workflow, enabling ~99% accuracy through ensemble geocoding.
 */

import { AddressRow, ProcessingStatus, Coordinates } from "../types";
import { HybridGeocoder, HybridGeocodingResult } from "./hybridGeocoder";
import { extractStreetAndNumber, normalizeAddress } from "./normalization";
import { NETIVOT_BOUNDS, DEBUG_GEO } from "../constants";
import { enqueueIngest } from "./ingestClient";

// ============================================================================
// Address Type Classification
// ============================================================================

/**
 * Address type enum for routing processing logic.
 * 
 * Address typing exists to handle different address formats (street+number,
 * intersections, POIs) without forcing all inputs through the same
 * normalization pipeline that requires a house number.
 */
export enum AddressType {
  STREET_NUMBER = "STREET_NUMBER",
  INTERSECTION = "INTERSECTION",
  POI = "POI",
  UNKNOWN = "UNKNOWN",
}

/**
 * Classifies raw address text into an address type.
 * 
 * This is a pure, deterministic function that does not call geocoders or
 * normalizers. It applies rules in order (first match wins).
 * 
 * @param rawText - Raw address text to classify
 * @returns AddressType classification
 */
function classifyAddressType(rawText: string): AddressType {
  if (!rawText || rawText.trim().length === 0) {
    return AddressType.UNKNOWN;
  }

  const trimmed = rawText.trim();
  
  // Rule 1: INTERSECTION detection (first match wins)
  // Check for "/" between two non-empty tokens
  const slashMatch = trimmed.match(/^(.+?\S)\s*[\/\\]\s*(\S.+)$/);
  if (slashMatch && slashMatch[1].trim() && slashMatch[2].trim()) {
    return AddressType.INTERSECTION;
  }
  
  // Check for Hebrew word "פינת"
  if (/\bפינת\b/.test(trimmed)) {
    return AddressType.INTERSECTION;
  }
  
  // Check for patterns like "רחוב X ו-רחוב Y" or "רחוב X ורחוב Y"
  const veMatch = trimmed.match(/רחוב\s+([^\s]+)\s+ו-?רחוב\s+([^\s]+)/);
  if (veMatch) {
    return AddressType.INTERSECTION;
  }
  
  // Rule 2: STREET_NUMBER detection
  // Must contain at least one digit adjacent to a street-like token
  // Hebrew suffix letters (א, ב, ג) after the number are allowed
  // Must NOT trigger if the number is clearly a stop number (preceded by "תחנה")
  
  // Check if there's a stop number pattern - if so, don't classify as STREET_NUMBER
  if (/\bתחנה\s*\d+/.test(trimmed)) {
    // Has stop number, but might still be intersection - already checked above
    // Continue to other checks
  } else {
    // Look for digit patterns that could be house numbers
    // Pattern: non-digit, then digit (possibly with Hebrew letter suffix)
    const houseNumberMatch = trimmed.match(/\S+\s+(\d+[א-ת]?)\b/);
    if (houseNumberMatch) {
      // Found a number that looks like a house number (not a stop number)
      return AddressType.STREET_NUMBER;
    }
    
    // Also check for digit at end of string (common pattern: "רחוב א 5")
    const endNumberMatch = trimmed.match(/(\S+)\s+(\d+[א-ת]?)\s*$/);
    if (endNumberMatch && endNumberMatch[1].trim() && endNumberMatch[2].trim()) {
      return AddressType.STREET_NUMBER;
    }
  }
  
  // Rule 3: POI detection
  // rawText contains no valid house number (already checked above)
  // AND was NOT classified as INTERSECTION (already checked above)
  // AND rawText length > 3 characters
  // AND does NOT contain vague proximity words without a real POI name
  
  // Check for vague proximity phrases (ליד, סמוך, בקרבת) without a real POI
  // These should be UNKNOWN, not POI, because they're too vague to geocode
  const proximityWords = /\b(ליד|סמוך|בסמוך|בקרבת|קרוב|ליד|לידו|לידה)\b/;
  if (proximityWords.test(trimmed)) {
    // Has proximity word but no house number and no intersection pattern
    // This is too vague - classify as UNKNOWN
    return AddressType.UNKNOWN;
  }
  
  if (trimmed.length > 3) {
    return AddressType.POI;
  }
  
  // Rule 4: UNKNOWN fallback
  return AddressType.UNKNOWN;
}

// Helper: distance between two coords (meters)
function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Checks if an address is incomplete and cannot be geocoded reliably.
 * 
 * @param normalizedAddress - Normalized address string
 * @returns true if address is incomplete
 */
function isIncompleteAddress(normalizedAddress: string | null): boolean {
  if (!normalizedAddress || normalizedAddress.trim().length === 0) {
    return true;
  }

  const trimmed = normalizedAddress.trim();
  const noSpaces = trimmed.replace(/\s+/g, "").toLowerCase();
  
  // Only city name, no street
  if (noSpaces === "נתיבות" || noSpaces === "netivot") {
    return true;
  }

  // Check if it has both street and number
  const { street, number } = extractStreetAndNumber(trimmed);
  
  if (!street || street.trim().length === 0) {
    return true;
  }

  if (!number || number.trim().length === 0) {
    return true;
  }

  return false;
}

/**
 * Parses house number from string, handling Hebrew letter suffixes.
 * 
 * @param numberStr - House number as string (e.g., "12", "12א")
 * @returns Parsed house number or null if invalid
 */
function parseHouseNumber(numberStr: string | null): number | null {
  if (!numberStr || numberStr.trim().length === 0) {
    return null;
  }

  // Extract numeric part (remove Hebrew letter suffixes like "12א" -> "12")
  const numericMatch = numberStr.match(/^(\d+)/);
  if (!numericMatch) {
    return null;
  }

  const parsed = parseInt(numericMatch[1], 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

/**
 * Maps confidence score from HybridGeocoder to ProcessingStatus.
 * 
 * Different thresholds for GIS vs non-GIS sources:
 * - GIS: CONFIRMED >= 0.8, NEEDS_REVIEW >= 0.6
 * - Non-GIS: CONFIRMED >= 0.9, NEEDS_REVIEW >= 0.6
 * 
 * @param result - Geocoding result with source and confidence
 * @returns Appropriate ProcessingStatus based on confidence level and source
 */
function mapConfidenceToStatus(result: HybridGeocodingResult, inBounds: boolean): ProcessingStatus {
  const { confidence, source } = result;
  
  if (source === "GIS") {
    if (confidence >= 0.8) {
      return ProcessingStatus.CONFIRMED;
    } else if (confidence >= 0.6) {
      return ProcessingStatus.NEEDS_REVIEW;
    } else {
      return ProcessingStatus.NOT_FOUND;
    }
  } else if (source === "GOVMAP") {
    // GovMap trust: if inBounds and confidence >= 0.75, treat as CONFIRMED
    if (inBounds && confidence >= 0.75) {
      return ProcessingStatus.CONFIRMED;
    } else if (confidence >= 0.6) {
      return ProcessingStatus.NEEDS_REVIEW;
    } else {
      return ProcessingStatus.NOT_FOUND;
    }
  } else {
    // Non-GIS sources (NOMINATIM, GOVMAP)
    // LEGACY is NOT a geocoding result - originalCoords are input only
    if (confidence >= 0.9) {
      return ProcessingStatus.CONFIRMED;
    } else if (confidence >= 0.6) {
      return ProcessingStatus.NEEDS_REVIEW;
    } else {
      return ProcessingStatus.NOT_FOUND;
    }
  }
}

/**
 * Generates a user-friendly message based on geocoding result.
 * 
 * @param result - Geocoding result from HybridGeocoder
 * @param hasOriginalCoords - Whether the row had original coordinates
 * @returns Human-readable message in Hebrew
 */
function generateMessage(
  result: HybridGeocodingResult | null,
  _hasOriginalCoords: boolean
): string {
  if (!result) {
    return "כתובת מלאה אך לא נמצאה במאגר המיפוי – נדרש טיפול ידני";
  }

  const { source, method, confidence } = result;

  // High confidence GIS results
  if (source === "GIS" && confidence >= 0.9) {
    if (method === "GIS_EXACT") {
      return "כתובת נמצאה במאגר GIS העירוני (דיוק גבוה)";
    } else {
      return "כתובת נמצאה במאגר GIS באמצעות אינטרפולציה (דיוק בינוני-גבוה)";
    }
  }

  // Medium confidence GIS results
  if (source === "GIS" && confidence >= 0.5) {
    return "כתובת נמצאה במאגר GIS (דיוק בינוני)";
  }

  // GovMap results
  if (source === "GOVMAP") {
    return "כתובת נמצאה ב-GovMap (דיוק בינוני)";
  }

  // Nominatim results
  if (source === "NOMINATIM") {
    if (method === "NOMINATIM_BBOX_RESTRICTED") {
      return "כתובת נמצאה ב-Nominatim ומוגבלת לתחום נתיבות (דיוק בינוני)";
    } else if (method === "NOMINATIM_OUT_OF_BOUNDS") {
      return "כתובת נמצאה ב-Nominatim אך מחוץ לתחום נתיבות (דיוק נמוך)";
    } else {
      return "כתובת נמצאה ב-Nominatim (דיוק בינוני)";
    }
  }

  // Fallback message
  if (confidence >= 0.9) {
    return "כתובת תקינה – נעשה שימוש בקואורדינטות";
  } else if (confidence >= 0.5) {
    return "כתובת נמצאה אך נדרש ביקורת ידנית (דיוק בינוני)";
  } else {
    return "כתובת נמצאה אך עם דיוק נמוך – נדרש טיפול ידני";
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Processes a single AddressRow using address type-based routing.
 * 
 * Processing flow:
 * 1. Classify address type (STREET_NUMBER, INTERSECTION, POI, UNKNOWN)
 * 2. Route by type:
 *    - STREET_NUMBER: Use existing pipeline (normalize → extract → HybridGeocoder)
 *    - INTERSECTION/POI: Route directly to geocodeNetivot() (bypasses normalization)
 *    - UNKNOWN: Mark as SKIPPED
 * 3. Apply status and coordinate validation
 * 
 * INTERSECTION/POI bypass normalization because they don't follow the
 * "street + number" format required by normalizeAddress().
 * 
 * @param row - AddressRow to process
 * @returns Updated AddressRow with coordinates and status
 */
export async function processRow(row: AddressRow): Promise<AddressRow> {
  // Step 1: Extract address from row
  const rawAddress = row.normalizedAddress || row.address || row.originalAddress || "";
  
  if (!rawAddress || rawAddress.trim().length === 0) {
    const skippedRow: AddressRow & { _processingMetadata?: { source: null; confidence: null; inBounds: boolean; addressType: AddressType } } = {
      ...row,
      status: ProcessingStatus.SKIPPED,
      message: "חסרה כתובת מלאה",
      finalCoords: undefined,
      _processingMetadata: {
        source: null,
        confidence: null,
        inBounds: false,
        addressType: AddressType.UNKNOWN,
      },
    };
    return skippedRow;
  }

  // Step 1.5: Log if originalCoords exist (LEGACY input detected)
  // OriginalCoords are NOT used as geocoding results - full re-geocoding is forced
  const hasOriginalCoords = row.originalCoords !== undefined;
  if (hasOriginalCoords && DEBUG_GEO) {
    console.log(`GEO_CHAIN: Row has originalCoords (LEGACY input detected), forcing full re-geocoding through GIS → GovMap → Nominatim chain`);
  }

  // Step 2: Classify address type (routing decision point)
  const addressType = classifyAddressType(rawAddress);

  // Step 3: Route by address type
  if (addressType === AddressType.STREET_NUMBER) {
    // Route A: STREET_NUMBER - Use existing pipeline without changes
    return await processStreetNumberAddress(row, rawAddress);
  } else if (addressType === AddressType.INTERSECTION || addressType === AddressType.POI) {
    // Route B/C: INTERSECTION/POI - Route directly to geocodeNetivot()
    // Must NOT call normalizeAddress(), extractStreetAndNumber(), or parseHouseNumber()
    return await processIntersectionOrPoi(row, rawAddress, addressType);
  } else {
    // Route D: UNKNOWN - Mark as SKIPPED
    // Message must NOT mention "missing house number" unless text looks like street without number
    const looksLikeStreetWithoutNumber = /\bרחוב\b/.test(rawAddress) && !/\d/.test(rawAddress);
    const skippedRow: AddressRow & { _processingMetadata?: { source: null; confidence: null; inBounds: boolean; addressType: AddressType } } = {
      ...row,
      status: ProcessingStatus.SKIPPED,
      message: looksLikeStreetWithoutNumber 
        ? "חסרה כתובת מלאה (אין מספר בית)"
        : "כתובת לא מזוהה",
      finalCoords: undefined,
      _processingMetadata: {
        source: null,
        confidence: null,
        inBounds: false,
        addressType: AddressType.UNKNOWN,
      },
    };
    return skippedRow;
  }
}

/**
 * Processes a STREET_NUMBER address using the existing pipeline.
 * This maintains backward compatibility with the original flow.
 * 
 * FIX (Prompt 1 regression): The street name extraction preserves the full
 * normalized street string from normalizeAddress(). The normalized address
 * format is "street number, נתיבות", and extractStreetAndNumber() correctly
 * extracts the complete street name (after prefix stripping) from this format.
 * This matches the pre-Prompt 1 behavior exactly.
 */
async function processStreetNumberAddress(row: AddressRow, rawAddress: string): Promise<AddressRow> {
  // Normalize address (existing logic)
  // normalizeAddress() returns format: "street number, נתיבות"
  // Example: "רחוב א 5" → normalizeAddress() → "א 5, נתיבות"
  const normalized = normalizeAddress(rawAddress);
  
  if (!normalized || isIncompleteAddress(normalized)) {
    return {
      ...row,
      status: ProcessingStatus.SKIPPED,
      message: "חסרה כתובת מלאה (אין מספר בית או שם רחוב)",
      finalCoords: undefined,
    };
  }

  // Extract street name and house number (existing logic)
  // extractStreetAndNumber() extracts from normalized format "street number, נתיבות"
  // Example: extractStreetAndNumber("א 5, נתיבות") → { street: "א", number: "5" }
  // The street name is the complete normalized street (after prefix stripping),
  // which matches the pre-Prompt 1 behavior exactly.
  const { street, number } = extractStreetAndNumber(normalized);
  
  if (!street || street.trim().length === 0) {
    return {
      ...row,
      status: ProcessingStatus.SKIPPED,
      message: "חסרה כתובת מלאה (אין שם רחוב)",
      finalCoords: undefined,
    };
  }

  const houseNumber = parseHouseNumber(number);
  
  // Only reject for missing house number when addressType === STREET_NUMBER
  if (!houseNumber || houseNumber <= 0) {
    return {
      ...row,
      status: ProcessingStatus.SKIPPED,
      message: "חסרה כתובת מלאה (אין מספר בית)",
      finalCoords: undefined,
    };
  }

  // Call HybridGeocoder (existing logic)
  let geocodingResult: HybridGeocodingResult | null = null;
  // #region agent log
  enqueueIngest({location:'rowProcessor.ts:212',message:'Before HybridGeocoder.geocode',data:{street,houseNumber,rowId:row.id},sourceFile:'rowProcessor.ts',sourceFn:'processStreetNumberAddress'});
  // #endregion
  
  try {
    geocodingResult = await HybridGeocoder.geocode(street, houseNumber);
    // #region agent log
    enqueueIngest({location:'rowProcessor.ts:215',message:'After HybridGeocoder.geocode',data:{hasResult:!!geocodingResult,result:geocodingResult,rowId:row.id},sourceFile:'rowProcessor.ts',sourceFn:'processStreetNumberAddress'});
    // #endregion
  } catch (error) {
    // #region agent log
    enqueueIngest({location:'rowProcessor.ts:217',message:'HybridGeocoder.geocode error',data:{errorMessage:error instanceof Error?error.message:String(error),rowId:row.id},sourceFile:'rowProcessor.ts',sourceFn:'processStreetNumberAddress'});
    // #endregion
    console.error("Error in HybridGeocoder.geocode:", error);
    return {
      ...row,
      status: ProcessingStatus.NOT_FOUND,
      message: "שגיאה בגיאוקודינג – נדרש טיפול ידני",
      finalCoords: undefined,
    };
  }

  if (!geocodingResult) {
    const notFoundRow: AddressRow & { _processingMetadata?: { source: null; confidence: null; inBounds: boolean; addressType: AddressType } } = {
      ...row,
      status: ProcessingStatus.NOT_FOUND,
      message: "כתובת מלאה אך לא נמצאה במאגר המיפוי – נדרש טיפול ידני",
      finalCoords: undefined,
      _processingMetadata: {
        source: null,
        confidence: null,
        inBounds: false,
        addressType: AddressType.STREET_NUMBER,
      },
    };
    return notFoundRow;
  }

  return applyGeocodingResult(row, geocodingResult, AddressType.STREET_NUMBER);
}

/**
 * Processes an INTERSECTION or POI address by routing through HybridGeocoder.geocodeRequest().
 * This bypasses normalization which would reject these address types.
 * 
 * Updated to use HybridGeocoder.geocodeRequest() instead of direct geocodeNetivot() call
 * to ensure all geocoding goes through the single HybridGeocoder orchestrator.
 */
async function processIntersectionOrPoi(
  row: AddressRow, 
  rawAddress: string, 
  addressType: AddressType
): Promise<AddressRow> {
  // Route through HybridGeocoder.geocodeRequest() with raw or minimally trimmed address
  // HybridGeocoder will internally call geocodeNetivot() for INTERSECTION/POI
  const trimmedAddress = rawAddress.trim();
  
  try {
    // Use HybridGeocoder.geocodeRequest() instead of direct geocodeNetivot() call
    const geocodingResult = await HybridGeocoder.geocodeRequest(
      addressType === AddressType.INTERSECTION
        ? { kind: "INTERSECTION", rawText: trimmedAddress }
        : { kind: "POI", rawText: trimmedAddress }
    );
    
    if (geocodingResult) {
      // Use the same validation logic as STREET_NUMBER (but without distance upgrade)
      return applyGeocodingResult(row, geocodingResult, addressType);
    } else {
      const notFoundRow: AddressRow & { _processingMetadata?: { source: null; confidence: null; inBounds: boolean; addressType: AddressType } } = {
        ...row,
        status: ProcessingStatus.NOT_FOUND,
        message: "כתובת מלאה אך לא נמצאה במאגר המיפוי – נדרש טיפול ידני",
        finalCoords: undefined,
        _processingMetadata: {
          source: null,
          confidence: null,
          inBounds: false,
          addressType,
        },
      };
      return notFoundRow;
    }
  } catch (error) {
    console.error("Error geocoding intersection/POI:", error);
    return {
      ...row,
      status: ProcessingStatus.NOT_FOUND,
      message: "שגיאה בגיאוקודינג – נדרש טיפול ידני",
      finalCoords: undefined,
    };
  }
}

/**
 * Checks if coordinates are within Netivot bounds.
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
 * Applies geocoding result to row with status and coordinate validation.
 * Type-aware validation with bounds checking and distance-based upgrades.
 * 
 * @param row - Address row to update
 * @param geocodingResult - Geocoding result from HybridGeocoder
 * @param addressType - Address type (STREET_NUMBER, INTERSECTION, POI)
 * @returns Updated row with status and coordinates
 */
function applyGeocodingResult(
  row: AddressRow,
  geocodingResult: HybridGeocodingResult,
  addressType: AddressType
): AddressRow {
  const finalCoords: Coordinates = {
    lat: geocodingResult.lat,
    lon: geocodingResult.lon,
  };

  // Always enforce Netivot bounds for any final coordinates before marking CONFIRMED
  const inBounds = isWithinNetivotBounds(finalCoords.lat, finalCoords.lon);
  
  // Map confidence to status (different thresholds for GIS vs non-GIS, with GovMap trust)
  let status = mapConfidenceToStatus(geocodingResult, inBounds);
  
  // If out of bounds, never mark as CONFIRMED
  if (!inBounds) {
    if (status === ProcessingStatus.CONFIRMED) {
      status = ProcessingStatus.NEEDS_REVIEW;
    }
  }
  
  // Distance-based validation: calculate distance if original coords exist
  const hasOriginalCoords = row.originalCoords !== undefined;
  let distance: number | undefined = undefined;
  
  if (hasOriginalCoords && row.originalCoords) {
    distance = distanceMeters(
      row.originalCoords.lat,
      row.originalCoords.lon,
      finalCoords.lat,
      finalCoords.lon
    );
  }
  
  // Special rules for trusted sources: Force CONFIRMED and ignore distance downgrade
  const isIntersectionOrPoi = addressType === AddressType.INTERSECTION || addressType === AddressType.POI;
  const isTrustedSource = geocodingResult.source === "GIS" || geocodingResult.source === "GOVMAP";
  
  // Rule 1: INTERSECTION/POI force-confirm (unchanged)
  if (isIntersectionOrPoi && inBounds && isTrustedSource && geocodingResult.confidence >= 0.7) {
    // Force CONFIRMED for bus stops from trusted sources, ignore distance-based downgrade
    status = ProcessingStatus.CONFIRMED;
  } 
  // Rule 2: STREET_NUMBER with GIS high confidence - force CONFIRMED, ignore distance
  else if (addressType === AddressType.STREET_NUMBER && geocodingResult.source === "GIS" && inBounds && geocodingResult.confidence >= 0.9) {
    // Force CONFIRMED for GIS high-confidence STREET_NUMBER, ignore distance-based downgrade entirely
    status = ProcessingStatus.CONFIRMED;
  }
  // Rule 3: STREET_NUMBER with GOVMAP - allow CONFIRMED, only downgrade if extreme distance
  else if (addressType === AddressType.STREET_NUMBER && geocodingResult.source === "GOVMAP" && inBounds && geocodingResult.confidence >= 0.75) {
    // GOVMAP trusted source: only downgrade if distance is extreme (> 3000m)
    if (hasOriginalCoords && row.originalCoords && distance !== undefined && distance > 3000) {
      if (status === ProcessingStatus.CONFIRMED) {
        status = ProcessingStatus.NEEDS_REVIEW;
      }
    }
    // Otherwise, allow CONFIRMED status (already set by mapConfidenceToStatus for confidence >= 0.75)
  }
  // Rule 4: Apply distance-based downgrade for other cases
  else {
    // Apply distance-based downgrade only when not force-confirmed above
    if (hasOriginalCoords && row.originalCoords && distance !== undefined) {
      // Source-aware and type-aware distance downgrade thresholds
      let maxAllowedDistance: number;
      if (addressType === AddressType.STREET_NUMBER) {
        if (geocodingResult.source === "GIS") {
          maxAllowedDistance = 1000;  // GIS: downgrade only if distance > 1000m (but overridden by Rule 2)
        } else if (geocodingResult.source === "GOVMAP") {
          maxAllowedDistance = 1200;  // GOVMAP: downgrade only if distance > 1200m (but overridden by Rule 3)
        } else {
          maxAllowedDistance = 500;   // Nominatim/Legacy: keep stricter threshold
        }
      } else {
        // INTERSECTION/POI (only applies if not force-confirmed above)
        maxAllowedDistance = 1500;  // INTERSECTION/POI: downgrade only if distance > 1500m
      }
      
      if (distance > maxAllowedDistance) {
        if (status === ProcessingStatus.CONFIRMED) {
          status = ProcessingStatus.NEEDS_REVIEW;
        }
      }
    }
  }
  
  // Distance-based upgrade: expanded for STREET_NUMBER and now available for INTERSECTION/POI
  if (hasOriginalCoords && row.originalCoords && inBounds && distance !== undefined) {
    if (addressType === AddressType.STREET_NUMBER) {
      // For STREET_NUMBER: if inBounds AND distance <= 100m, allow upgrade to CONFIRMED
      if (distance <= 100 && status !== ProcessingStatus.CONFIRMED) {
        if (status === ProcessingStatus.NOT_FOUND) {
          status = ProcessingStatus.NEEDS_REVIEW;
        } else if (status === ProcessingStatus.NEEDS_REVIEW) {
          status = ProcessingStatus.CONFIRMED;
        }
      }
    } else if (addressType === AddressType.INTERSECTION || addressType === AddressType.POI) {
      // For INTERSECTION/POI: if inBounds AND distance <= 250m, allow upgrade to CONFIRMED
      if (distance <= 250 && status !== ProcessingStatus.CONFIRMED) {
        if (status === ProcessingStatus.NOT_FOUND) {
          status = ProcessingStatus.NEEDS_REVIEW;
        } else if (status === ProcessingStatus.NEEDS_REVIEW) {
          status = ProcessingStatus.CONFIRMED;
        }
      }
    }
  }
  
  // Generate message with bounds and distance info
  let message = generateMessage(geocodingResult, hasOriginalCoords);
  
  // Add bounds warning if out of bounds
  if (!inBounds) {
    message += " (מחוץ לתחום נתיבות)";
  }
  
  // Add distance warning if distance exceeds the threshold for this source/type
  // Skip warning for force-confirmed cases (originalCoords are not ground truth for trusted sources)
  if (hasOriginalCoords && row.originalCoords && distance !== undefined) {
    const isForceConfirmedIntersectionPoi = isIntersectionOrPoi && inBounds && isTrustedSource && geocodingResult.confidence >= 0.7;
    const isForceConfirmedStreetNumberGIS = addressType === AddressType.STREET_NUMBER && geocodingResult.source === "GIS" && inBounds && geocodingResult.confidence >= 0.9;
    const isForceConfirmedStreetNumberGovmap = addressType === AddressType.STREET_NUMBER && geocodingResult.source === "GOVMAP" && inBounds && geocodingResult.confidence >= 0.75;
    
    // Only show warning if not force-confirmed (trusted sources ignore distance)
    if (!(isForceConfirmedIntersectionPoi || isForceConfirmedStreetNumberGIS || isForceConfirmedStreetNumberGovmap)) {
      let maxAllowedDistance: number;
      if (addressType === AddressType.STREET_NUMBER) {
        if (geocodingResult.source === "GIS") {
          maxAllowedDistance = 1000;
        } else if (geocodingResult.source === "GOVMAP") {
          maxAllowedDistance = 1200;
        } else {
          maxAllowedDistance = 500;
        }
      } else {
        maxAllowedDistance = 1500;
      }
      
      if (distance > maxAllowedDistance) {
        message += " (⚠ distance too large vs original coords)";
      }
    }
  }
  
  // Add distance validation note if upgrade was applied
  if (hasOriginalCoords && row.originalCoords && inBounds && distance !== undefined) {
    const upgradeThreshold = addressType === AddressType.STREET_NUMBER ? 100 : 250;
    if (distance <= upgradeThreshold && status === ProcessingStatus.CONFIRMED) {
      message += " (אומת מול קואורדינטות מקוריות)";
    }
  }
  
  // Final post-processing: Upgrade medium-accuracy trusted sources from NEEDS_REVIEW to CONFIRMED
  // This is a safe, minimal upgrade that only affects rows that would otherwise be NEEDS_REVIEW
  let mediumAccuracyAutoConfirmed = false;
  if (status === ProcessingStatus.NEEDS_REVIEW 
      && addressType === AddressType.STREET_NUMBER 
      && inBounds 
      && (geocodingResult.source === "GIS" || geocodingResult.source === "GOVMAP")
      && geocodingResult.confidence >= 0.75) {
    status = ProcessingStatus.CONFIRMED;
    mediumAccuracyAutoConfirmed = true;
  }
  
  // Optional narrow exception: Upgrade low-confidence NOMINATIM POI from NEEDS_REVIEW to CONFIRMED
  // Only applies when all other validation rules have been applied and status is still NEEDS_REVIEW
  let nominatimLowConfidenceAutoConfirmed = false;
  if (status === ProcessingStatus.NEEDS_REVIEW
      && addressType === AddressType.POI
      && geocodingResult.source === "NOMINATIM"
      && inBounds
      && geocodingResult.confidence >= 0.6) {
    status = ProcessingStatus.CONFIRMED;
    nominatimLowConfidenceAutoConfirmed = true;
  }
  
  // Debug logging for validation decision (log AFTER all rules applied, including post-processing)
  if (DEBUG_GEO) {
    // Calculate maxAllowedDistance for logging
    let maxAllowedDistance: number | undefined = undefined;
    let distanceDowngradeIgnored = false;
    let distanceWarning = false;
    
    if (hasOriginalCoords && row.originalCoords && distance !== undefined) {
      // Check if distance downgrade is ignored due to trusted source rules
      const isForceConfirmedIntersectionPoi = isIntersectionOrPoi && inBounds && isTrustedSource && geocodingResult.confidence >= 0.7;
      const isForceConfirmedStreetNumberGIS = addressType === AddressType.STREET_NUMBER && geocodingResult.source === "GIS" && inBounds && geocodingResult.confidence >= 0.9;
      const isForceConfirmedStreetNumberGovmap = addressType === AddressType.STREET_NUMBER && geocodingResult.source === "GOVMAP" && inBounds && geocodingResult.confidence >= 0.75;
      
      if (isForceConfirmedIntersectionPoi || isForceConfirmedStreetNumberGIS || isForceConfirmedStreetNumberGovmap) {
        // Distance downgrade is ignored for force-confirmed cases
        distanceDowngradeIgnored = true;
        
        // Calculate what the threshold would have been for warning purposes
        if (addressType === AddressType.STREET_NUMBER) {
          if (geocodingResult.source === "GIS") {
            maxAllowedDistance = 1000;
          } else if (geocodingResult.source === "GOVMAP") {
            maxAllowedDistance = 1200;
          } else {
            maxAllowedDistance = 500;
          }
        } else {
          maxAllowedDistance = 1500;
        }
        
        // Set distanceWarning if distance exceeds threshold (but downgrade is ignored)
        if (isForceConfirmedStreetNumberGIS || isForceConfirmedStreetNumberGovmap) {
          if (distance > maxAllowedDistance) {
            distanceWarning = true;
          }
        }
      } else {
        // Normal case: distance downgrade applies
        if (addressType === AddressType.STREET_NUMBER) {
          if (geocodingResult.source === "GIS") {
            maxAllowedDistance = 1000;
          } else if (geocodingResult.source === "GOVMAP") {
            maxAllowedDistance = 1200;
          } else {
            maxAllowedDistance = 500;
          }
        } else {
          maxAllowedDistance = 1500;
        }
      }
    }
    const upgradeThreshold = addressType === AddressType.STREET_NUMBER ? 100 : (addressType === AddressType.INTERSECTION || addressType === AddressType.POI ? 250 : undefined);
    console.log(`GEO_VALIDATE: addressType=${addressType}, source=${geocodingResult.source}, confidence=${geocodingResult.confidence}, inBounds=${inBounds}, hasOriginalCoords=${hasOriginalCoords}, distance=${distance !== undefined ? distance.toFixed(1) + 'm' : 'N/A'}, maxAllowedDistance=${maxAllowedDistance !== undefined ? maxAllowedDistance + 'm' : 'N/A'}, upgradeThreshold=${upgradeThreshold !== undefined ? upgradeThreshold + 'm' : 'N/A'}, distanceDowngradeIgnored=${distanceDowngradeIgnored}, distanceWarning=${distanceWarning}, mediumAccuracyAutoConfirmed=${mediumAccuracyAutoConfirmed}, nominatimLowConfidenceAutoConfirmed=${nominatimLowConfidenceAutoConfirmed}, finalStatus=${status}`);
  }
  
  // Store metadata temporarily for statistics collection
  const resultRow: AddressRow & { _processingMetadata?: { source: string; confidence: number; inBounds: boolean; addressType: AddressType } } = {
    ...row,
    status,
    finalCoords,
    message,
    _processingMetadata: {
      source: geocodingResult.source,
      confidence: geocodingResult.confidence,
      inBounds,
      addressType,
    },
  };
  
  return resultRow;
}

/**
 * Statistics collector for processing summary
 */
interface ProcessingStats {
  totalRows: number;
  byStatus: Record<string, number>;
  byAddressType: Record<string, number>;
  bySource: Record<string, number>;
  needsReviewByReason: Record<string, number>;
  needsReviewNominatim: number;
  outOfBounds: number;
}

/**
 * Computes confidence bucket for statistics
 */
function getConfidenceBucket(confidence: number): string {
  if (confidence >= 0.9) return ">=0.9";
  if (confidence >= 0.75) return "0.75-0.89";
  if (confidence >= 0.7) return "0.70-0.74";
  if (confidence >= 0.6) return "0.60-0.69";
  return "<0.60";
}

/**
 * Computes reasonKey for NEEDS_REVIEW rows
 */
function computeReasonKey(
  addressType: AddressType,
  source: string | null,
  inBounds: boolean,
  confidence: number | null
): string {
  const confBucket = confidence !== null ? getConfidenceBucket(confidence) : "unknown";
  return `${addressType}|${source || "null"}|inBounds=${inBounds}|confBucket=${confBucket}`;
}

/**
 * Processes multiple AddressRow objects in sequence.
 * 
 * @param rows - Array of AddressRow objects to process
 * @param onProgress - Optional callback to report progress (called after each row is processed)
 * @returns Array of updated AddressRow objects
 */
export async function processRows(
  rows: AddressRow[],
  onProgress?: (processed: number, total: number) => void
): Promise<AddressRow[]> {
  const results: AddressRow[] = [];
  const stats: ProcessingStats = {
    totalRows: rows.length,
    byStatus: {},
    byAddressType: {},
    bySource: {},
    needsReviewByReason: {},
    needsReviewNominatim: 0,
    outOfBounds: 0,
  };
  
  // #region agent log
  enqueueIngest({location:'rowProcessor.ts:269',message:'processRows started',data:{totalRows:rows.length},sourceFile:'rowProcessor.ts',sourceFn:'processRows'});
  // #endregion
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // #region agent log
    enqueueIngest({location:'rowProcessor.ts:275',message:'Processing row',data:{rowIndex:i,totalRows:rows.length,rowId:row.id,address:row.address},sourceFile:'rowProcessor.ts',sourceFn:'processRows'});
    // #endregion
    
    const processed = await processRow(row);
    results.push(processed);
    
    // Collect statistics
    const finalStatus = processed.status;
    stats.byStatus[finalStatus] = (stats.byStatus[finalStatus] || 0) + 1;
    
    // Extract metadata from processed row
    const rowMetadata = (processed as any)._processingMetadata;
    let addressType: AddressType;
    let source: string | null = null;
    let confidence: number | null = null;
    let inBounds = false;
    
    if (rowMetadata) {
      addressType = rowMetadata.addressType;
      source = rowMetadata.source;
      confidence = rowMetadata.confidence;
      inBounds = rowMetadata.inBounds;
      
      if (source) {
        stats.bySource[source] = (stats.bySource[source] || 0) + 1;
      }
      
      if (!inBounds) {
        stats.outOfBounds++;
      }
      
      if (finalStatus === ProcessingStatus.NEEDS_REVIEW) {
        const reasonKey = computeReasonKey(addressType, source, inBounds, confidence);
        stats.needsReviewByReason[reasonKey] = (stats.needsReviewByReason[reasonKey] || 0) + 1;
        
        if (source === "NOMINATIM") {
          stats.needsReviewNominatim++;
        }
      }
      
      // Clean up metadata
      delete (processed as any)._processingMetadata;
    } else {
      // No metadata - classify address type from address for statistics
      const rawAddress = processed.normalizedAddress || processed.address || processed.originalAddress || "";
      addressType = classifyAddressType(rawAddress);
    }
    
    stats.byAddressType[addressType] = (stats.byAddressType[addressType] || 0) + 1;
    
    // Report progress after each row
    if (onProgress) {
      onProgress(i + 1, rows.length);
    }
    
    // #region agent log
    enqueueIngest({location:'rowProcessor.ts:280',message:'Row processed',data:{rowIndex:i,totalRows:rows.length,rowId:row.id,status:processed.status,hasCoords:!!processed.finalCoords},sourceFile:'rowProcessor.ts',sourceFn:'processRows'});
    // #endregion
  }
  
  // Print summary
  console.log("=== PROCESSING SUMMARY ===");
  console.log(JSON.stringify(stats, null, 2));
  
  // #region agent log
  enqueueIngest({location:'rowProcessor.ts:285',message:'processRows completed',data:{totalRows:rows.length,processedRows:results.length},sourceFile:'rowProcessor.ts',sourceFn:'processRows'});
  // #endregion
  
  return results;
}
