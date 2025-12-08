import React, { useState, useMemo } from "react";
import {
  Upload,
  Download,
  Play,
  CheckCircle,
  AlertTriangle,
  MapPin,
  XCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import { AddressRow, ProcessingStatus } from "./types";
import { readExcel, exportExcel } from "./services/excel";
import {
  normalizeAddress,
  getAddressFromRow,
  extractStreetAndNumber,
} from "./services/normalization";
import {
  batchGeocode,
  getCachedResult,
  searchNetivotAddresses,
} from "./services/geocoding";

// --------------------------------------------------
// Helper: simple Netivot bounding box (approximate)
// --------------------------------------------------
const NETIVOT_BOUNDS = {
  minLat: 31.38,
  maxLat: 31.47,
  minLon: 34.55,
  maxLon: 34.63,
};

function isInsideNetivot(
  lat: number | null | undefined,
  lon: number | null | undefined
): boolean {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  return (
    lat >= NETIVOT_BOUNDS.minLat &&
    lat <= NETIVOT_BOUNDS.maxLat &&
    lon >= NETIVOT_BOUNDS.minLon &&
    lon <= NETIVOT_BOUNDS.maxLon
  );
}

// --------------------------------------------------
// Helper: distance between two coords (meters)
// --------------------------------------------------
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

// --------------------------------------------------
// Helper: detectar POI / intersección / lugar descriptivo
// --------------------------------------------------
function isLikelyPoiOrIntersection(
  text: string | undefined | null
): boolean {
  if (!text) return false;
  const value = String(text).trim();
  if (!value) return false;

  const poiKeywords = [
    "קבר",
    "באבא",
    "בבא",
    "מרכז",
    "סנטר",
    "קניון",
    "פארק",
    "גינה",
    "גן",
    "בית כנסת",
    "כולל",
    "אולם",
    "בית ספר",
    "ישיבה",
    "מכללה",
    "אוניברסיטה",
    "מרפאה",
    "בית חולים",
    "תחנה",
    "צומת",
    "כיכר",
    "שוק",
    "מגדל",
    "גשר",
    "מקווה",
  ];
  const poiRegex = new RegExp(poiKeywords.join("|"));
  if (poiRegex.test(value)) return true;

  if (/[\/]/.test(value)) return true;
  if (/\bפינת\b/.test(value)) return true;

  return false;
}

// --------------------------------------------------
// Helper: construir la key de cache para geocoding
// --------------------------------------------------
function getCacheKey(row: AddressRow): string {
  const normalized = row.normalizedAddress?.trim();
  if (normalized) {
    return normalized;
  }

  const raw = (row.address || row.originalAddress || "").trim();
  if (!raw) return "";

  if (!/נתיבות|netivot/i.test(raw)) {
    return `${raw} נתיבות`;
  }

  return raw;
}

// --------------------------------------------------
// Helpers: reglas para "חסרה כתובת מלאה"
// --------------------------------------------------
function isCityOnlyAddress(address: string | null | undefined): boolean {
  if (!address) return true;
  const cleaned = address.replace(/[,"']/g, "").trim();
  return cleaned === "נתיבות" || /^netivot\s*$/i.test(cleaned);
}

function isAddressAcceptableWithoutHouseNumber(
  address: string | null | undefined
): boolean {
  if (!address) return false;
  const normalized = address.replace(/\s+/g, " ").trim();

  if (isLikelyPoiOrIntersection(normalized)) {
    return true;
  }

  const hasCityName = /נתיבות|netivot/i.test(normalized);
  if (!hasCityName) {
    return false;
  }

  let withoutCity = normalized.replace(/נתיבות/gi, "");
  withoutCity = withoutCity.replace(/netivot/gi, "");
  withoutCity = withoutCity.replace(/[,"']/g, "").trim();

  if (!withoutCity) {
    return false;
  }

  return true;
}

function isMissingFullAddress(rawAddress: string | null | undefined): boolean {
  const addr = (rawAddress || "").trim();
  if (!addr) {
    return true;
  }

  if (isCityOnlyAddress(addr)) {
    return true;
  }

  const hasHouseNumber = /\d/.test(addr);
  if (hasHouseNumber) {
    return false;
  }

  if (isAddressAcceptableWithoutHouseNumber(addr)) {
    return false;
  }

  return true;
}

// --------------------------------------------------
// Helper: clasificar una fila según el cache (parcial/final)
// --------------------------------------------------
function classifyRowFromCache(
  row: AddressRow,
  allowNotFound: boolean
): AddressRow {
  const cacheKey = getCacheKey(row);
  const raw = (row.address || row.originalAddress || "").trim();
  const addressForRules =
    (row.normalizedAddress && row.normalizedAddress.trim().length > 0
      ? row.normalizedAddress
      : raw) || "";

  const missingAddress = isMissingFullAddress(addressForRules);

  if (
    row.status === ProcessingStatus.SKIPPED ||
    row.status === ProcessingStatus.CONFIRMED ||
    row.status === ProcessingStatus.UPDATED ||
    row.status === ProcessingStatus.NOT_FOUND ||
    row.status === ProcessingStatus.NEEDS_REVIEW
  ) {
    return row;
  }

  if (missingAddress) {
    if (!allowNotFound) {
      return row;
    }

    const message = isCityOnlyAddress(addressForRules)
      ? "חסרה כתובת מלאה"
      : "חסרה כתובת מלאה (אין מספר בית)";

    return {
      ...row,
      status: ProcessingStatus.SKIPPED,
      message,
      finalCoords: undefined,
    };
  }

  const originalLat = row.originalCoords?.lat ?? null;
  const originalLon = row.originalCoords?.lon ?? null;
  const origInside = isInsideNetivot(originalLat, originalLon);

  const result = cacheKey ? getCachedResult(cacheKey) : null;

  if (!result) {
    if (!allowNotFound) {
      return row;
    }

    if (origInside) {
      return {
        ...row,
        status: ProcessingStatus.CONFIRMED,
        finalCoords: undefined,
        message: "כתובת תקינה – נעשה שימוש בקואורדינטות המקור",
      };
    }

    return {
      ...row,
      status: ProcessingStatus.NEEDS_REVIEW,
      finalCoords: undefined,
      message:
        "כתובת מלאה אך לא נמצאה במאגר המיפוי – נדרש טיפול ידני",
    };
  }

  const newLat = result.lat;
  const newLon = result.lon;
  const newInside = isInsideNetivot(newLat, newLon);

  if (!newInside && origInside) {
    return {
      ...row,
      status: ProcessingStatus.CONFIRMED,
      finalCoords: undefined,
      message: "תוצאת המפה מחוץ לנתיבות – נשמרו קואורדינטות המקור",
    };
  }

  if (origInside && originalLat !== null && originalLon !== null) {
    const dist = distanceMeters(originalLat, originalLon, newLat, newLon);
    if (dist <= 30) {
      return {
        ...row,
        status: ProcessingStatus.CONFIRMED,
        finalCoords: undefined,
        message: "הקואורדינטות המקוריות תקינות (שינוי זניח)",
      };
    }
  }

  return {
    ...row,
    status: ProcessingStatus.UPDATED,
    finalCoords: result,
    message: 'עודכן ע"י Nominatim',
  };
}

function StatusBadge({ status }: { status: ProcessingStatus }) {
  switch (status) {
    case ProcessingStatus.PENDING:
      return (
        <span className="px-2 py-1 rounded text-xs bg-gray-200 text-gray-700">
          ממתין
        </span>
      );
    case ProcessingStatus.CONFIRMED:
      return (
        <span className="px-2 py-1 rounded text-xs bg-blue-100 text-blue-700">
          תקין
        </span>
      );
    case ProcessingStatus.UPDATED:
      return (
        <span className="px-2 py-1 rounded text-xs bg-green-100 text-green-700">
          עודכן
        </span>
      );
    case ProcessingStatus.NEEDS_REVIEW:
      return (
        <span className="px-2 py-1 rounded text-xs bg-yellow-100 text-yellow-700">
          לבדיקה
        </span>
      );
    case ProcessingStatus.NOT_FOUND:
      return (
        <span className="px-2 py-1 rounded text-xs bg-red-100 text-red-700">
          לא נמצא
        </span>
      );
    case ProcessingStatus.SKIPPED:
      return (
        <span className="px-2 py-1 rounded text-xs bg-orange-100 text-orange-700">
          דולג (חסר)
        </span>
      );
    default:
      return null;
  }
}

function App() {
  const [rows, setRows] = useState<AddressRow[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [fileName, setFileName] = useState("");
  const [processedUnique, setProcessedUnique] = useState(0);
  const [totalUnique, setTotalUnique] = useState(0);
  const [apiRequestsCount, setApiRequestsCount] = useState(0);
  const [statusFilter, setStatusFilter] =
    useState<ProcessingStatus | "ALL">("ALL");

  // ------------------------------------------------------------------
  // Estado para búsqueda de calle/número usando GovMap/OSM (NO depende del archivo)
  // ------------------------------------------------------------------
  const [streetQuery, setStreetQuery] = useState("");
  const [streetSuggestions, setStreetSuggestions] = useState<string[]>([]);
  const [selectedStreet, setSelectedStreet] = useState<string | null>(null);

  const [numberQuery, setNumberQuery] = useState("");
  const [numberSuggestions, setNumberSuggestions] = useState<string[]>([]);
  const [selectedNumber, setSelectedNumber] = useState<string | null>(null);

  const [isStreetLoading, setIsStreetLoading] = useState(false);
  const [isNumberLoading, setIsNumberLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // ------------------------------------------------------------------
  // Handlers GovMap: calle
  // ------------------------------------------------------------------
  const performStreetSearch = async (query: string) => {
    const q = query.trim();
    if (q.length < 2) {
      setStreetSuggestions([]);
      setSearchError(null);
      return;
    }

    try {
      setIsStreetLoading(true);
      setSearchError(null);
      const results = await searchNetivotAddresses(q);

      const streetsSet = new Set<string>();
      for (const item of results) {
        const { street } = extractStreetAndNumber(item.displayName);
        if (street) {
          streetsSet.add(street);
        }
      }

      const streets = Array.from(streetsSet).sort((a, b) =>
        a.localeCompare(b, "he")
      );
      setStreetSuggestions(streets);
    } catch (error) {
      console.error("Street search failed", error);
      setSearchError("אירעה שגיאה בחיפוש הרחוב.");
      setStreetSuggestions([]);
    } finally {
      setIsStreetLoading(false);
    }
  };

  // ------------------------------------------------------------------
  // Handlers GovMap: número
  // ------------------------------------------------------------------
  const performNumberSearch = async (street: string, numberPart: string) => {
    const qPart = numberPart.trim();
    if (!street || !qPart) {
      setNumberSuggestions([]);
      return;
    }

    try {
      setIsNumberLoading(true);
      setSearchError(null);
      const results = await searchNetivotAddresses(`${street} ${qPart}`);

      const numbersSet = new Set<string>();
      for (const item of results) {
        const { street: s, number } = extractStreetAndNumber(
          item.displayName
        );
        if (s === street && number) {
          numbersSet.add(number);
        }
      }

      const nums = Array.from(numbersSet).sort((a, b) => {
        const an = parseInt(a, 10);
        const bn = parseInt(b, 10);
        if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
        return a.localeCompare(b, "he");
      });
      setNumberSuggestions(nums);
    } catch (error) {
      console.error("Number search failed", error);
      setSearchError("אירעה שגיאה בחיפוש מספר הבית.");
      setNumberSuggestions([]);
    } finally {
      setIsNumberLoading(false);
    }
  };

  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    try {
      const rawData = await readExcel(file);
      const newRows: AddressRow[] = rawData.map((data, index) => {
        const keys = Object.keys(data);
        const detectedLatCol =
          keys.find((k) => /lat/i.test(k)) || "lat";
        const detectedLonCol =
          keys.find((k) => /lon|lng/i.test(k)) || "lon";
        const rawAddr = getAddressFromRow(data);
        const normalized = normalizeAddress(rawAddr);

        let originalCoords;
        const latVal = parseFloat(data[detectedLatCol]);
        const lonVal = parseFloat(data[detectedLonCol]);
        if (!isNaN(latVal) && !isNaN(lonVal)) {
          originalCoords = { lat: latVal, lon: lonVal };
        }

        const addressForRules =
          (normalized && normalized.trim().length > 0
            ? normalized
            : rawAddr) || "";
        const missingAddress =
          isMissingFullAddress(addressForRules);

        let message = "";
        if (missingAddress) {
          message = isCityOnlyAddress(addressForRules)
            ? "חסרה כתובת מלאה"
            : "חסרה כתובת מלאה (אין מספר בית)";
        }

        return {
          id: String(index),
          originalData: data,
          address: rawAddr,
          originalAddress: rawAddr,
          normalizedAddress: normalized ?? undefined,
          detectedLatCol,
          detectedLonCol,
          originalCoords,
          status: ProcessingStatus.PENDING,
          message,
        };
      });

      setRows(newRows);
      setProcessedUnique(0);
      setTotalUnique(0);
      setApiRequestsCount(0);
      setStatusFilter("ALL");
    } catch (error) {
      console.error("Error reading file", error);
      alert("Error reading file");
    }
  };

  const startProcessing = async () => {
    if (isProcessing) return;
    if (rows.length === 0) return;

    setIsProcessing(true);

    const addressesToGeocode = Array.from(
      new Set(
        rows
          .map((row) => {
            const cacheKey = getCacheKey(row);
            if (!cacheKey) return null;

            const raw = (row.address || row.originalAddress || "").trim();
            const addressForRules =
              (row.normalizedAddress &&
              row.normalizedAddress.trim().length > 0
                ? row.normalizedAddress
                : raw) || "";

            if (isMissingFullAddress(addressForRules)) {
              return null;
            }

            return cacheKey;
          })
          .filter((v): v is string => !!v)
      )
    );

    setTotalUnique(addressesToGeocode.length);
    setProcessedUnique(0);
    setApiRequestsCount(0);

    setRows((prev) => prev.map((row) => classifyRowFromCache(row, false)));

    const applyPartialResults = () => {
      setRows((prev) => prev.map((row) => classifyRowFromCache(row, false)));
    };

    await batchGeocode(addressesToGeocode, 3, (count, isCacheHit) => {
      setProcessedUnique((prev) => prev + count);
      if (!isCacheHit) {
        setApiRequestsCount((prev) => prev + 1);
      }
      applyPartialResults();
    });

    setRows((prev) => prev.map((row) => classifyRowFromCache(row, true)));

    setIsProcessing(false);
  };

  const filteredRows = useMemo(() => {
    if (statusFilter === "ALL") return rows;

    if (statusFilter === ProcessingStatus.NOT_FOUND) {
      return rows.filter(
        (r) =>
          r.status === ProcessingStatus.NOT_FOUND ||
          r.status === ProcessingStatus.NEEDS_REVIEW
      );
    }

    return rows.filter((r) => r.status === statusFilter);
  }, [rows, statusFilter]);

  const stats = useMemo(() => {
    const updated = rows.filter(
      (r) =>
        r.status === ProcessingStatus.UPDATED ||
        r.status === ProcessingStatus.CONFIRMED
    ).length;

    const notFound = rows.filter(
      (r) =>
        r.status === ProcessingStatus.NOT_FOUND ||
        r.status === ProcessingStatus.NEEDS_REVIEW
    ).length;

    const skipped = rows.filter(
      (r) => r.status === ProcessingStatus.SKIPPED
    ).length;
    return { updated, notFound, skipped };
  }, [rows]);

  const displayedRows = filteredRows.slice(0, 100);

  return (
    <div
      className="min-h-screen bg-gray-50 text-gray-800 font-sans"
      dir="rtl"
    >
      {/* Header */}
      <header className="bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-600 rounded-lg text-white">
              <MapPin size={24} />
            </div>
            <h1 className="text-xl font-bold text-gray-900">
              מתקן קואורדינטות (Netivot Fixer)
            </h1>
          </div>
          <div className="flex gap-3">
            {rows.length > 0 && !isProcessing && (
              <button
                onClick={() => exportExcel(rows, fileName)}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded shadow transition-colors"
              >
                <Download size={18} />
                <span>ייצוא לאקסל</span>
              </button>
            )}
            <label className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded shadow cursor-pointer transition-colors">
              <Upload size={18} />
              <span>טען קובץ</span>
              <input
                type="file"
                accept=".xlsx,.csv"
                className="hidden"
                onChange={handleFileUpload}
                disabled={isProcessing}
              />
            </label>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Búsqueda de calle ומספר בנתיבות (GovMap/OSM) */}
        <section className="bg-white rounded-xl border p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Search className="w-5 h-5" />
            <h2 className="font-semibold text-sm">
              חיפוש רחוב ומספר בנתיבות (GovMap)
            </h2>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            החיפוש מתבסס על GovMap / OpenStreetMap ויכול לפעול גם ללא קובץ
            אקסל.
          </p>

          <div className="flex flex-col md:flex-row gap-4">
            {/* Buscador de calle */}
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">
                חיפוש רחוב
              </label>
              <input
                type="text"
                className="w-full border rounded px-2 py-1 text-sm"
                placeholder="התחל להקליד שם רחוב..."
                value={streetQuery}
                onChange={(e) => {
                  const value = e.target.value;
                  setStreetQuery(value);
                  setSelectedStreet(null);
                  setSelectedNumber(null);
                  setNumberQuery("");
                  setNumberSuggestions([]);
                  performStreetSearch(value);
                }}
              />

              <div className="border rounded mt-1 max-h-40 overflow-auto text-sm bg-white">
                {isStreetLoading ? (
                  <div className="px-2 py-1 text-gray-500 text-xs">
                    מחפש רחובות...
                  </div>
                ) : streetSuggestions.length === 0 ? (
                  <div className="px-2 py-1 text-gray-500 text-xs">
                    {streetQuery.trim().length < 2
                      ? "הקלד לפחות 2 תווים לחיפוש"
                      : "לא נמצאו רחובות תואמים במפה"}
                  </div>
                ) : (
                  streetSuggestions.map((street) => (
                    <button
                      key={street}
                      type="button"
                      className={
                        "w-full text-right px-2 py-1 hover:bg-blue-50 " +
                        (street === selectedStreet
                          ? "bg-blue-100 font-semibold"
                          : "")
                      }
                      onClick={() => {
                        setSelectedStreet(street);
                        setSelectedNumber(null);
                        setNumberQuery("");
                        setNumberSuggestions([]);
                      }}
                    >
                      {street}
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Lista de números de la calle seleccionada */}
            <div className="w-full md:w-48">
              <label className="block text-sm font-medium mb-1">
                {selectedStreet
                  ? `מספרים ב־${selectedStreet}`
                  : "בחר רחוב ואז מספר"}
              </label>

              <input
                type="text"
                className="w-full border rounded px-2 py-1 text-sm"
                placeholder="סינון לפי מספר..."
                value={numberQuery}
                onChange={(e) => {
                  const value = e.target.value;
                  setNumberQuery(value);
                  const trimmed = value.trim();
                  setSelectedNumber(trimmed || null);
                  if (selectedStreet) {
                    performNumberSearch(selectedStreet, value);
                  } else {
                    setNumberSuggestions([]);
                  }
                }}
                disabled={!selectedStreet}
              />

              <div className="border rounded mt-1 max-h-40 overflow-auto text-sm bg-white">
                {!selectedStreet ? (
                  <div className="px-2 py-1 text-gray-500 text-xs">
                    לא נבחר רחוב
                  </div>
                ) : isNumberLoading ? (
                  <div className="px-2 py-1 text-gray-500 text-xs">
                    מחפש מספרי בתים...
                  </div>
                ) : numberSuggestions.length === 0 ? (
                  <div className="px-2 py-1 text-gray-500 text-xs">
                    לא נמצאו מספרים במפת הכתובות (תוכל עדיין להקליד מספר
                    ידנית)
                  </div>
                ) : (
                  numberSuggestions.map((num) => (
                    <button
                      key={num}
                      type="button"
                      className={
                        "w-full text-right px-2 py-1 hover:bg-green-50 " +
                        (num === selectedNumber
                          ? "bg-green-100 font-semibold"
                          : "")
                      }
                      onClick={() => {
                        setSelectedNumber(num);
                        setNumberQuery(num);
                      }}
                    >
                      {num}
                    </button>
                  ))
                )}
              </div>

              {selectedStreet && selectedNumber && (
                <p className="text-xs text-gray-600 mt-2">
                  נבחר: {selectedStreet} {selectedNumber}
                </p>
              )}
            </div>
          </div>

          {searchError && (
            <p className="text-xs text-red-600 mt-2">{searchError}</p>
          )}
        </section>

        {rows.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-lg border border-dashed border-gray-300">
            <Upload
              className="mx-auto text-gray-400 mb-4"
              size={48}
            />
            <h3 className="text-lg font-medium text-gray-900">
              אין נתונים להצגה
            </h3>
            <p className="text-gray-500">
              אנא טען קובץ אקסל כדי להתחיל בעיבוד אוטומטי
            </p>
          </div>
        ) : (
          <>
            {/* Control & Stats Card */}
            <div className="bg-white rounded-xl border p-6 shadow-sm">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="text-lg font-semibold">
                    {fileName}
                  </h2>
                  <div className="text-sm text-gray-500 flex gap-4 mt-1">
                    <span>סה"כ שורות: {rows.length}</span>
                    <span>
                      כתובות ייחודיות: {totalUnique || "-"}
                    </span>
                    <span>בקשות API: {apiRequestsCount}</span>
                  </div>
                </div>

                {!isProcessing &&
                  rows[0].status ===
                    ProcessingStatus.PENDING && (
                    <button
                      onClick={startProcessing}
                      className="flex items-center gap-2 px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-md transition-all text-lg font-medium"
                    >
                      <Play size={20} />
                      התחל עיבוד
                    </button>
                  )}

                {isProcessing && (
                  <div className="w-full md:w-1/2 mt-4 md:mt-0">
                    <div className="flex justify-between text-sm mb-1">
                      <span>מעבד כתובות...</span>
                      <span>
                        {totalUnique > 0
                          ? Math.round(
                              (processedUnique / totalUnique) * 100
                            )
                          : 0}
                        %
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2.5">
                      <div
                        className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300"
                        style={{
                          width:
                            totalUnique > 0
                              ? `${(processedUnique / totalUnique) * 100}%`
                              : "0%",
                        }}
                      ></div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Filter Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <button
                onClick={() =>
                  setStatusFilter(ProcessingStatus.UPDATED)
                }
                className={`p-4 rounded-xl border text-right transition-all ${
                  statusFilter === ProcessingStatus.UPDATED
                    ? "ring-2 ring-green-500 bg-green-50"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className="flex justify-between items-start">
                  <CheckCircle className="text-green-500" />
                  <span className="text-2xl font-bold">
                    {stats.updated}
                  </span>
                </div>
                <span className="text-sm text-gray-600 mt-2 block">
                  עודכנו בהצלחה / תקינים
                </span>
              </button>

              <button
                onClick={() =>
                  setStatusFilter(ProcessingStatus.NOT_FOUND)
                }
                className={`p-4 rounded-xl border text-right transition-all ${
                  statusFilter === ProcessingStatus.NOT_FOUND
                    ? "ring-2 ring-red-500 bg-red-50"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className="flex justify-between items-start">
                  <XCircle className="text-red-500" />
                  <span className="text-2xl font-bold">
                    {stats.notFound}
                  </span>
                </div>
                <span className="text-sm text-gray-600 mt-2 block">
                  לא נמצאו / נדרש טיפול ידני
                </span>
              </button>

              <button
                onClick={() =>
                  setStatusFilter(ProcessingStatus.SKIPPED)
                }
                className={`p-4 rounded-xl border text-right transition-all ${
                  statusFilter === ProcessingStatus.SKIPPED
                    ? "ring-2 ring-orange-500 bg-orange-50"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className="flex justify-between items-start">
                  <AlertTriangle className="text-orange-500" />
                  <span className="text-2xl font-bold">
                    {stats.skipped}
                  </span>
                </div>
                <span className="text-sm text-gray-600 mt-2 block">
                  דולגו (מידע חסר)
                </span>
              </button>

              <button
                onClick={() => setStatusFilter("ALL")}
                className={`p-4 rounded-xl border text-right transition-all ${
                  statusFilter === "ALL"
                    ? "ring-2 ring-blue-500 bg-blue-50"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className="flex justify_between items-start">
                  <RefreshCw className="text-blue-500" />
                  <span className="text-2xl font-bold">
                    {rows.length}
                  </span>
                </div>
                <span className="text-sm text-gray-600 mt-2 block">
                  הצג הכל
                </span>
              </button>
            </div>

            {/* Table */}
            <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        #
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        כתובת מקורית
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        קואורדינטות מקור
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        קואורדינטות חדשות
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        סטטוס
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        הודעה
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {displayedRows.map((row) => (
                      <tr
                        key={row.id}
                        className="hover:bg-gray-50"
                      >
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {parseInt(row.id) + 1}
                        </td>
                        <td
                          className="px-6 py-4 text-sm text-gray-900 max-w-xs truncate"
                          title={row.address}
                        >
                          {row.address}
                        </td>
                        <td
                          className="px-6 py-4 whitespace-nowrap text-sm text-gray-500"
                          dir="ltr"
                        >
                          {row.originalCoords
                            ? `${row.originalCoords.lat}, ${row.originalCoords.lon}`
                            : "-"}
                        </td>
                        <td
                          className="px-6 py-4 whitespace-nowrap text-sm font-medium"
                          dir="ltr"
                        >
                          {row.finalCoords ? (
                            <span className="text-green-600">
                              {row.finalCoords.lat},{" "}
                              {row.finalCoords.lon}
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <StatusBadge status={row.status} />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {row.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredRows.length > 100 && (
                <div className="px-6 py-4 bg-gray-50 border-t text-sm text-gray-500 text-center">
                  מציג 100 שורות ראשונות מתוך {filteredRows.length}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
