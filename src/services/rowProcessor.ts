import { getAddressFromRow, normalizeAddress } from "./normalization";

export type RowStatus =
  | "UPDATED" // הקואורדינטות עודכנו
  | "CONFIRMED" // כתובת תקינה, הקואורדינטות המקוריות סבירות
  | "NOT_FOUND" // כתובת מלאה אך לא נמצאה במיפוי
  | "SKIPPED_MISSING"; // חסרה כתובת מלאה

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

/**
 * Decide si una dirección es incompleta (no se puede geocodificar de forma fiable).
 *
 * Casos típicos:
 * - vacío
 * - solo "נתיבות" / "Netivot"
 * - algo muy corto sin número ni palabra de calle (ej: "הרב צבאן", "סשה ארגוב")
 */
function isIncompleteAddress(normalized: string): boolean {
  const trimmed = normalized.trim();
  if (!trimmed) return true;

  const noSpaces = trimmed.replace(/\s+/g, "").toLowerCase();
  if (noSpaces === "נתיבות" || noSpaces === "netivot") {
    return true;
  }

  const hasNumber = /\d+/.test(trimmed);
  const hasStreetKeyword = /(רחוב|שכונת|שכו'|שכונה|שד'|כיכר|כביש)/.test(trimmed);

  // Sin número y sin palabra de calle/barrio → probablemente es solo un nombre
  if (!hasNumber && !hasStreetKeyword) {
    const parts = trimmed.split(/\s+/);
    if (parts.length <= 2) {
      return true;
    }
  }

  return false;
}

/**
 * Procesa una fila de origen y devuelve el resultado de geocodificación +
 * estado lógico, sin confiar en las coordenadas originales para validar.
 */
export async function processRow(
  row: SourceRow,
  geocodeFn: (address: string) => Promise<GeocodeResult>,
  isInsideNetivot: (lat: number, lon: number) => boolean
): Promise<ProcessedRow> {
  const address = getAddressFromRow(row.rawData);
  const normalized = normalizeAddress(address);

  const origLat = row.originalLat;
  const origLon = row.originalLon;

  // 1) Sin dirección usable → חסרה כתובת מלאה
  if (!normalized || isIncompleteAddress(normalized)) {
    return {
      status: "SKIPPED_MISSING",
      message: "חסרה כתובת מלאה",
      originalLat: origLat,
      originalLon: origLon,
      newLat: null,
      newLon: null,
    };
  }

  // 2) Dirección completa → intentamos geocoding
  const result = await geocodeFn(normalized);

  // 2A) No hay resultado del geocoder → dirección completa pero el mapa no la conoce
  if (!result) {
    return {
      status: "NOT_FOUND",
      message: "כתובת מלאה אך לא נמצאה במאגר המיפוי – נדרש טיפול ידני",
      originalLat: origLat,
      originalLon: origLon,
      newLat: null,
      newLon: null,
    };
  }

  const newLat = result.lat;
  const newLon = result.lon;
  const newInside = isInsideNetivot(newLat, newLon);

  // 2B) Resultado fuera de Netivot → no lo aceptamos
  if (!newInside) {
    return {
      status: "NOT_FOUND",
      message: "כתובת מלאה אך לא נמצאה במאגר המיפוי – נדרש טיפול ידני",
      originalLat: origLat,
      originalLon: origLon,
      newLat: null,
      newLon: null,
    };
  }

  // 3) Resultado dentro de Netivot → ahora decidimos UPDATED vs CONFIRMED
  let status: RowStatus = "UPDATED";
  let message = "הקואורדינטות עודכנו בהצלחה";

  // Si también hay coords originales y están MUY cerca y dentro de נתיבות,
  // podemos considerarlas "confirmadas" y no como cambio fuerte.
  if (
    typeof origLat === "number" &&
    typeof origLon === "number" &&
    isInsideNetivot(origLat, origLon)
  ) {
    const dist = distanceMeters(origLat, origLon, newLat, newLon);
    if (dist <= 30) {
      status = "CONFIRMED";
      message = "הקואורדינטות המקוריות תקינות (שינוי זניח)";
      // Podemos dejar newLat/newLon como null si quieres conservar solo las originales en la exportación:
      return {
        status,
        message,
        originalLat: origLat,
        originalLon: origLon,
        newLat: null,
        newLon: null,
      };
    }
  }

  // Por defecto → actualizamos con las nuevas coordenadas
  return {
    status,
    message,
    originalLat: origLat,
    originalLon: origLon,
    newLat,
    newLon,
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
