import { Coordinates } from "../types";
import { NOMINATIM_BASE_URL, NETIVOT_BOUNDS } from "../constants";

const geocodeCache = new Map<string, Coordinates>();

export function getCachedResult(normalizedAddress: string): Coordinates | undefined {
  return geocodeCache.get(normalizedAddress);
}

export function setCachedResult(normalizedAddress: string, coords: Coordinates): void {
  geocodeCache.set(normalizedAddress, coords);
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

  return candidates.some(text =>
    text.includes("netivot") || text.includes("נתיבות")
  );
}

/**
 * Llama a Nominatim y decide si aceptar el resultado para Netivot.
 *
 * Reglas:
 * - Si el nombre dice Netivot (en display_name o address.*) → aceptar SIEMPRE.
 * - Si no menciona Netivot, aceptar solo si está dentro del bounding box.
 */
async function geocodeWithNominatim(normalizedAddress: string): Promise<Coordinates | null> {
  try {
    const url =
      `${NOMINATIM_BASE_URL}` +
      `?q=${encodeURIComponent(normalizedAddress)}` +
      `&format=json&limit=1&addressdetails=1&accept-language=he&countrycodes=il`;

    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    if (!data || data.length === 0) {
      return null;
    }

    const item = data[0];
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);

    const insideBounds = isWithinNetivotBounds(lat, lon);
    const netivotByName = isNetivotByName(item);

    if (netivotByName || insideBounds) {
      return { lat, lon };
    }

    return null;
  } catch (error) {
    console.error("Geocoding error:", error);
    return null;
  }
}

export async function batchGeocode(
  addresses: string[],
  concurrency: number,
  onProgress?: (increment: number, isCacheHit: boolean) => void
): Promise<void> {
  const queue = [...addresses];

  const processItem = async (address: string) => {
    // Check cache first
    if (geocodeCache.has(address)) {
      onProgress?.(1, true);
      return;
    }

    // Fetch from API
    const result = await geocodeWithNominatim(address);
    if (result) {
      setCachedResult(address, result);
    }

    // API Hit
    onProgress?.(1, false);

    // Simple delay to be nice to Nominatim (1 second)
    await new Promise(resolve => setTimeout(resolve, 1000));
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
