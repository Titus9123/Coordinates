import { getAddressFromRow, normalizeAddress } from "./normalization";

export type RowStatus =
  | "UPDATED"          // עודכנו בהצלחה
  | "CONFIRMED"        // כתובת תקינה, coords מקור נשמרו
  | "NOT_FOUND"        // לא נמצאו
  | "SKIPPED_MISSING"; // דולגו (מידע חסר)

export type ProcessedRow = {
  status: RowStatus;
  message: string;
  originalLat: number | null;
  originalLon: number | null;
  newLat: number | null;
  newLon: number | null;
};

type GeocodeResult = {
  lat: number;
  lon: number;
} | null;

type SourceRow = {
  // adapta estos nombres a tus columnas reales
  originalLat: number | null;
  originalLon: number | null;
  rawData: Record<string, any>;
};

export async function processRow(
  row: SourceRow,
  geocodeFn: (address: string) => Promise<GeocodeResult>,
  isInsideNetivot: (lat: number, lon: number) => boolean
): Promise<ProcessedRow> {
  const address = getAddressFromRow(row.rawData);
  const normalized = normalizeAddress(address);

  // 1) Sin dirección usable → דולגו (מידע חסר)
  if (!normalized) {
    return {
      status: "SKIPPED_MISSING",
      message: "חסרה כתובת מלאה",
      originalLat: row.originalLat,
      originalLon: row.originalLon,
      newLat: null,
      newLon: null,
    };
  }

  // 2) Dirección sin número → también מידע חסר (no quemamos requests)
  const hasNumber = /\d+/.test(normalized);
  if (!hasNumber) {
    return {
      status: "SKIPPED_MISSING",
      message: "חסרה כתובת מלאה (אין מספר בית)",
      originalLat: row.originalLat,
      originalLon: row.originalLon,
      newLat: null,
      newLon: null,
    };
  }

  // 3) Solo aquí llamamos a la API de geocoding
  const result = await geocodeFn(normalized);

  const origLat = row.originalLat;
  const origLon = row.originalLon;

  const origInside =
    typeof origLat === "number" &&
    typeof origLon === "number" &&
    isInsideNetivot(origLat, origLon);

  if (!result) {
    // 4A) No hay resultado de API
    if (origInside) {
      // Dirección y coords originales dentro de נתיבות → la damos por buena
      return {
        status: "CONFIRMED",
        message: "כתובת תקינה – נעשה שימוש בקואורדינטות המקור",
        originalLat: origLat,
        originalLon: origLon,
        newLat: null,
        newLon: null,
      };
    }

    // 4B) Nada dentro de נתיבות → realmente לא נמצא
    return {
      status: "NOT_FOUND",
      message: "לא נמצאה התאמה במפה לכתובת",
      originalLat: origLat,
      originalLon: origLon,
      newLat: null,
      newLon: null,
    };
  }

  // 5) Hay resultado de API
  const newLat = result.lat;
  const newLon = result.lon;
  const newInside = isInsideNetivot(newLat, newLon);

  if (!newInside && origInside) {
    // API te llevó fuera de נתיבות → nos quedamos con la original
    return {
      status: "CONFIRMED",
      message: "תוצאת המפה מחוץ לנתיבות – נשמרו קואורדינטות המקור",
      originalLat: origLat,
      originalLon: origLon,
      newLat: null,
      newLon: null,
    };
  }

  // Aquí puedes añadir un cálculo de distancia para decidir si es realmente “UPDATED”
  const isFar =
    origLat != null &&
    origLon != null &&
    distanceMeters(origLat, origLon, newLat, newLon) > 30; // por ejemplo 30m

  if (isFar) {
    return {
      status: "UPDATED",
      message: "הקואורדינטות עודכנו בהצלחה",
      originalLat: origLat,
      originalLon: origLon,
      newLat,
      newLon,
    };
  }

  // Está muy cerca → tratamos como CONFIRMED, sin cambiar apenas nada
  return {
    status: "CONFIRMED",
    message: "הקואורדינטות המקוריות תקינות (שינוי זניח)",
    originalLat: origLat,
    originalLon: origLon,
    newLat: null,
    newLon: null,
  };
}

// Haversine sencilla:
function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
