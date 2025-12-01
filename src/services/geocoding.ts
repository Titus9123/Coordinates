import { Coordinates } from "../types";
import { NOMINATIM_BASE_URL, NETIVOT_BOUNDS } from "../constants";

const geocodeCache = new Map<string, Coordinates>();

export function getCachedResult(normalizedAddress: string): Coordinates | undefined {
  return geocodeCache.get(normalizedAddress);
}

export function setCachedResult(normalizedAddress: string, coords: Coordinates): void {
  geocodeCache.set(normalizedAddress, coords);
}

// Internal helper
async function geocodeWithNominatim(normalizedAddress: string): Promise<Coordinates | null> {
  try {
    const url = `${NOMINATIM_BASE_URL}?q=${encodeURIComponent(normalizedAddress)}&format=json&limit=1`;
    const response = await fetch(url);
    if (!response.ok) return null;
    
    const data = await response.json();
    if (data && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);

      // Validate bounds
      if (
        lat >= NETIVOT_BOUNDS.minLat &&
        lat <= NETIVOT_BOUNDS.maxLat &&
        lon >= NETIVOT_BOUNDS.minLon &&
        lon <= NETIVOT_BOUNDS.maxLon
      ) {
        return { lat, lon };
      }
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

  const workers = Array(concurrency).fill(null).map(async () => {
    while (queue.length > 0) {
      const address = queue.shift();
      if (address) {
        await processItem(address);
      }
    }
  });

  await Promise.all(workers);
}