import { Coordinates } from "../types";
import { NOMINATIM_BASE_URL, NETIVOT_BOUNDS } from "../constants";
import { geocodeWithGovmap } from "./govmapService";
import { GISService } from "./gisService";
import { HybridGeocoder } from "./hybridGeocoder";
import { normalizeStreetText } from "./normalization";
import { enqueueIngest } from "./ingestClient";

const geocodeCache = new Map<string, Coordinates>();

export function getCachedResult(normalizedAddress: string): Coordinates | undefined {
  return geocodeCache.get(normalizedAddress);
}

export function setCachedResult(normalizedAddress: string, coords: Coordinates): void {
  geocodeCache.set(normalizedAddress, coords);
}

/**
 * Devuelve el parámetro viewbox de Nominatim para Netivot,
 * en el formato: left,top,right,bottom
 */
function getNetivotViewboxParam(): string {
  const left = NETIVOT_BOUNDS.minLon;
  const right = NETIVOT_BOUNDS.maxLon;
  const top = NETIVOT_BOUNDS.maxLat;
  const bottom = NETIVOT_BOUNDS.minLat;
  return `${left},${top},${right},${bottom}`;
}

/**
 * Verifica si las coordenadas están dentro del bounding box definido para Netivot.
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
 * Intenta decidir si un resultado de Nominatim pertenece realmente a Netivot
 * basándose en los campos de dirección y el display_name, NO solo en coordenadas.
 */
function isNetivotByName(nominatimItem: any): boolean {
  if (!nominatimItem) return false;

  const displayName: string = String(nominatimItem.display_name ?? "");
  const address = nominatimItem.address ?? {};

  const candidates: string[] = [
    displayName,
    address.city,
    address.town,
    address.village,
    address.suburb,
    address.city_district,
    address.state,
  ]
    .filter(Boolean)
    .map((v: any) => String(v).toLowerCase());

  return candidates.some((text) => text.includes("netivot") || text.includes("נתיבות"));
}

/**
 * Normaliza el texto de consulta para Nominatim, añadiendo contexto de Netivot/Israel.
 */
function ensureNetivotContext(query: string): string {
  let q = query.trim().replace(/\s+/g, " ");
  const lower = q.toLowerCase();

  const hasNetivot = lower.includes("netivot") || lower.includes("נתיבות");
  const hasIsrael = lower.includes("israel") || lower.includes("ישראל");

  if (hasNetivot && hasIsrael) {
    return q;
  }

  if (hasNetivot && !hasIsrael) {
    return `${q}, ישראל`;
  }

  // No menciona Netivot → forzamos ciudad + país
  return `${q}, נתיבות, ישראל`;
}

/**
 * Elimina sufijos de ciudad tipo "נתיבות" o "Netivot" para operar sobre el núcleo
 * de la descripción (útil para detectar intersecciones).
 */
function stripCityTokens(raw: string): string {
  return raw
    .replace(/[,\s]+נתיבות.*$/i, "")
    .replace(/[,\s]+netivot.*$/i, "")
    .trim();
}

/**
 * Detecta si el texto describe una intersección tipo:
 * - "רחוב א / רחוב ב"
 * - "רחוב א פינת רחוב ב"
 * 
 * Uses normalizeStreetText() for consistent street name normalization when
 * constructing intersection queries.
 */
function detectIntersection(raw: string): string | null {
  const withoutCity = stripCityTokens(raw);
  const normalized = withoutCity.replace(/\s+/g, " ").trim();

  const slashMatch = normalized.match(/^(.+?\D)\s*[\/\\]\s*(\D.+)$/);
  if (slashMatch) {
    const street1 = normalizeStreetText(slashMatch[1].trim());
    const street2 = normalizeStreetText(slashMatch[2].trim());
    if (street1 && street2) {
      return `${street1} & ${street2}`;
    }
  }

  const pinatMatch = normalized.match(/^(.+?)\s*פינת\s+(.+)$/);
  if (pinatMatch) {
    const street1 = normalizeStreetText(pinatMatch[1].trim());
    const street2 = normalizeStreetText(pinatMatch[2].trim());
    if (street1 && street2) {
      return `${street1} & ${street2}`;
    }
  }

  return null;
}

/**
 * Detecta puntos de interés conocidos en Netivot y devuelve una consulta canónica
 * para Nominatim (sin ciudad/país, que se añaden luego).
 */
function detectPoi(raw: string): string | null {
  const normalized = raw.replace(/\s+/g, " ").trim();

  const poiPatterns: Array<{ pattern: RegExp; baseQuery: string }> = [
    {
      pattern: /(קבר|הקבר).*באבא\s+סאלי|באבא\s+סאלי/i,
      baseQuery: "קבר הבאבא סאלי",
    },
    {
      pattern: /מרכז\s+קליטה/i,
      baseQuery: "מרכז קליטה",
    },
    {
      pattern: /שוק\s+ישן|סמילו/i,
      baseQuery: "שוק ישן",
    },
  ];

  for (const { pattern, baseQuery } of poiPatterns) {
    if (pattern.test(normalized)) {
      return baseQuery;
    }
  }

  return null;
}

/**
 * Simplifica el "núcleo" de la dirección dentro de Netivot.
 */
function normalizeNetivotCore(raw: string): string {
  let core = stripCityTokens(raw);

  core = core.replace(/["']/g, "").replace(/\s+/g, " ").trim();
  if (!core) return "";

  const segments = core
    .split(/[,-]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length > 1) {
    core = segments[segments.length - 1];
  }

  core = core.replace(/^(שכו'?|שכונת|שכונה)\s+/i, "").trim();
  core = core.replace(/^מערב(\s+העיר)?\s*/i, "").trim();

  core = core.replace(/\s+/g, " ").trim();

  return core;
}

/**
 * Construye un conjunto de queries candidatas para Nominatim.
 */
function buildNominatimQueries(rawAddress: string): string[] {
  const trimmed = rawAddress.trim();
  if (!trimmed) return [];

  const queries: string[] = [];

  const poiQuery = detectPoi(trimmed);
  if (poiQuery) {
    queries.push(ensureNetivotContext(poiQuery));
  }

  const intersectionQuery = detectIntersection(trimmed);
  if (intersectionQuery) {
    queries.push(ensureNetivotContext(intersectionQuery));
  }

  queries.push(ensureNetivotContext(trimmed));

  const core = normalizeNetivotCore(trimmed);
  if (core && core !== trimmed) {
    queries.push(ensureNetivotContext(core));
  }

  return Array.from(new Set(queries));
}

/**
 * Geocoding con Nominatim limitado al bbox de נתיבות.
 */
async function geocodeWithNominatim(normalizedAddress: string): Promise<Coordinates | null> {
  try {
    const queries = buildNominatimQueries(normalizedAddress);
    if (queries.length === 0) {
      return null;
    }

    const viewbox = getNetivotViewboxParam();

    for (const query of queries) {
      const url =
        `${NOMINATIM_BASE_URL}` +
        `?q=${encodeURIComponent(query)}` +
        `&format=json` +
        `&limit=1` +
        `&addressdetails=1` +
        `&accept-language=he` +
        `&countrycodes=il` +
        `&viewbox=${encodeURIComponent(viewbox)}` +
        `&bounded=1`;

      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      if (!data || data.length === 0) {
        continue;
      }

      const item = data[0];
      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lon);

      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        continue;
      }

      const insideBounds = isWithinNetivotBounds(lat, lon);
      const netivotByName = isNetivotByName(item);

      if (netivotByName || insideBounds) {
        return { lat, lon };
      }
    }

    return null;
  } catch (error) {
    console.error("Geocoding error:", error);
    return null;
  }
}

/**
 * Geocoder híbrido: GovMap primero, luego Nominatim.
 */
export async function geocodeNetivot(normalizedAddress: string): Promise<Coordinates | null> {
  // 1) GovMap (base oficial de ישראל)
  const govResult = await geocodeWithGovmap(normalizedAddress);
  if (govResult && !Number.isNaN(govResult.lat) && !Number.isNaN(govResult.lon)) {
    if (isWithinNetivotBounds(govResult.lat, govResult.lon)) {
      return { lat: govResult.lat, lon: govResult.lon };
    }
  }

  // 2) Fallback: Nominatim
  return geocodeWithNominatim(normalizedAddress);
}

/**
 * Geocoding en lote con cache + GovMap+Nominatim.
 */
export async function batchGeocode(
  addresses: string[],
  concurrency: number,
  onProgress?: (increment: number, isCacheHit: boolean) => void
): Promise<void> {
  const queue = [...addresses];

  const processItem = async (address: string) => {
    if (geocodeCache.has(address)) {
      onProgress?.(1, true);
      return;
    }

    const result = await geocodeNetivot(address);
    if (result) {
      setCachedResult(address, result);
    }

    onProgress?.(1, false);

    // Pequeña pausa para no abusar de los servicios externos
    await new Promise((resolve) => setTimeout(resolve, 1000));
  };

  const workers = Array(concurrency)
    .fill(null)
    .map(async () => {
      while (queue.length > 0) {
        const address = queue.shift();
        if (address) {
          await processItem(address);
        }
      }
    });

  await Promise.all(workers);
}

/* ------------------------------------------------------------------
 * BÚSQUEDA MANUAL DE DIRECCIONES EN NETIVOT (GIS-based)
 * -----------------------------------------------------------------*/

export interface NetivotAddressSuggestion {
  id: string;
  displayName: string;
  x: number;
  y: number;
  lat: number;
  lon: number;
}

/**
 * Tracks whether GIS layer has been loaded for search functionality.
 */
let gisSearchInitialized = false;

/**
 * Ensures GIS layer is loaded for search functionality.
 * This is a lightweight initialization that only loads if not already loaded.
 * 
 * Note: If HybridGeocoder.init() has already been called, the GIS layer
 * should already be loaded. This function will attempt to load it if needed,
 * but will gracefully handle cases where it's already loaded.
 */
async function ensureGISSearchInitialized(): Promise<void> {
  // #region agent log
  enqueueIngest({location:'geocoding.ts:354',message:'ensureGISSearchInitialized called',data:{gisSearchInitialized},sourceFile:'geocoding.ts',sourceFn:'ensureGISSearchInitialized'});
  // #endregion
  if (!gisSearchInitialized) {
    try {
      // Try to load the address points layer (for geocoding)
      // If HybridGeocoder.init() was already called, this might fail
      // or be a no-op, which is fine - we'll catch and continue
      // #region agent log
      enqueueIngest({location:'geocoding.ts:360',message:'Before GISService.loadLayer in ensureGISSearch',data:{},sourceFile:'geocoding.ts',sourceFn:'ensureGISSearchInitialized'});
      // #endregion
      await GISService.loadLayer("/public/gis/netivot.geojson");
      // #region agent log
      enqueueIngest({location:'geocoding.ts:363',message:'After GISService.loadLayer in ensureGISSearch',data:{},sourceFile:'geocoding.ts',sourceFn:'ensureGISSearchInitialized'});
      // #endregion
      
      // Load the street segments layer (for street search)
      await GISService.ensureStreetSegmentsLoaded("/public/gis/שמות_רחובות_2025.geojson");
      // #region agent log
      enqueueIngest({location:'geocoding.ts:366',message:'After ensureStreetSegmentsLoaded in ensureGISSearch',data:{},sourceFile:'geocoding.ts',sourceFn:'ensureGISSearchInitialized'});
      // #endregion
      
      gisSearchInitialized = true;
    } catch (error) {
      // #region agent log
      enqueueIngest({location:'geocoding.ts:369',message:'ensureGISSearchInitialized error caught',data:{errorMessage:error instanceof Error?error.message:String(error)},sourceFile:'geocoding.ts',sourceFn:'ensureGISSearchInitialized'});
      // #endregion
      // If load fails, it might be because:
      // 1. Layer is already loaded (some implementations might throw)
      // 2. File doesn't exist
      // 3. Network error
      // In any case, we'll try to use searchStreets which will return empty
      // if the layer isn't actually loaded
      console.warn("GIS layer load attempt failed (may already be loaded):", error);
      // Mark as initialized anyway to avoid repeated load attempts
      gisSearchInitialized = true;
    }
  }
}

export async function searchNetivotAddresses(query: string): Promise<NetivotAddressSuggestion[]> {
  const trimmed = query.trim();
  
  // Return empty list if query is too short
  if (!trimmed || trimmed.length < 2) {
    return [];
  }

  try {
    // Ensure GIS is initialized
    await ensureGISSearchInitialized();

    // Search for streets using GIS
    const streets = GISService.searchStreets(trimmed, 20);

    // Map GIS street results to NetivotAddressSuggestion format
    // The UI expects this format and will extract street names from displayName
    return streets.map((street, index) => ({
      id: `gis-street-${index}-${street.streetName}`,
      displayName: street.streetName,
      x: 0,
      y: 0,
      lat: 0, // Coordinates not needed for street search
      lon: 0, // Coordinates not needed for street search
    }));
  } catch (error) {
    console.error("searchNetivotAddresses error:", error);
    // Return empty array on error instead of throwing
    return [];
  }
}

/* ------------------------------------------------------------------
 * MANUAL COORDINATE LOOKUP FOR NETIVOT ADDRESSES
 * -----------------------------------------------------------------*/

/**
 * Tracks whether HybridGeocoder has been initialized for manual lookup.
 */
let manualGeocoderInitialized = false;

/**
 * Ensures HybridGeocoder is initialized for manual coordinate lookup.
 * This function is idempotent - it only initializes once.
 */
async function ensureManualGeocoderInitialized(): Promise<void> {
  if (!manualGeocoderInitialized) {
    try {
      await HybridGeocoder.init();
      manualGeocoderInitialized = true;
    } catch (error) {
      console.error("Failed to initialize HybridGeocoder for manual lookup:", error);
      throw error;
    }
  }
}

/**
 * Finds coordinates for a Netivot address (street + house number).
 * 
 * This is a thin wrapper around HybridGeocoder that:
 * - Ensures HybridGeocoder is initialized
 * - Calls HybridGeocoder.geocode() with the street name and house number
 * - Returns Coordinates | null (extracts lat/lon from HybridGeocodingResult)
 * 
 * @param streetName - Street name (e.g. "רפיח ים")
 * @param houseNumber - House number (e.g. 12)
 * @returns Coordinates object with lat/lon, or null if not found
 * @throws Error only for unexpected errors (not for "not found" cases)
 */
export async function findNetivotAddressCoords(
  streetName: string,
  houseNumber: number
): Promise<Coordinates | null> {
  try {
    // Ensure HybridGeocoder is initialized
    await ensureManualGeocoderInitialized();
    
    // Call HybridGeocoder.geocode()
    const result = await HybridGeocoder.geocode(streetName, houseNumber);
    
    // If result is null, return null (not found)
    if (result === null) {
      return null;
    }
    
    // Extract and return coordinates
    return {
      lat: result.lat,
      lon: result.lon,
    };
  } catch (error) {
    // Log unexpected errors
    console.error("Error in findNetivotAddressCoords:", error);
    // Re-throw unexpected errors (not "not found" cases)
    throw error;
  }
}
