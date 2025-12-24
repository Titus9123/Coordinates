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
import { AddressRow, ProcessingStatus, Coordinates } from "./types";
import { readExcel, exportExcel, processExcelFile } from "./services/excel";
import {
  normalizeAddress,
  getAddressFromRow,
  extractStreetAndNumber,
} from "./services/normalization";
import {
  getCachedResult,
  searchNetivotAddresses,
  findNetivotAddressCoords,
} from "./services/geocoding";
import { GISService } from "./services/gisService";
import { enqueueIngest } from "./services/ingestClient";

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
// NOTE: This function is no longer used - replaced by rowProcessor.ts logic
// Keeping for reference but marked as unused to avoid linter warnings
// --------------------------------------------------
// @ts-ignore - Unused function kept for reference
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
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const [allHouseNumbers, setAllHouseNumbers] = useState<string[]>([]); // All house numbers for selected street
  const [selectedNumber, setSelectedNumber] = useState<string | null>(null);

  const [isStreetLoading, setIsStreetLoading] = useState(false);
  const [isNumberLoading, setIsNumberLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Manual coordinate lookup state
  const [manualCoords, setManualCoords] = useState<Coordinates | null>(null);
  const [manualCoordsError, setManualCoordsError] = useState<string | null>(null);
  const [isManualCoordsLoading, setIsManualCoordsLoading] = useState(false);

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
  const loadHouseNumbersForStreet = async (street: string) => {
    // #region agent log
    enqueueIngest({location:'App.tsx:409',message:'loadHouseNumbersForStreet called',data:{street},sourceFile:'App.tsx',sourceFn:'loadHouseNumbersForStreet'});
    // #endregion
    if (!street) {
      setNumberSuggestions([]);
      setAllHouseNumbers([]);
      return;
    }

    try {
      setIsNumberLoading(true);
      setSearchError(null);
      
      // Ensure address layer is loaded
      // #region agent log
      enqueueIngest({location:'App.tsx:421',message:'Before GISService.loadLayer in loadHouseNumbers',data:{street},sourceFile:'App.tsx',sourceFn:'loadHouseNumbersForStreet'});
      // #endregion
      await GISService.loadLayer("/public/gis/netivot.geojson");
      // #region agent log
      enqueueIngest({location:'App.tsx:424',message:'After GISService.loadLayer in loadHouseNumbers',data:{street},sourceFile:'App.tsx',sourceFn:'loadHouseNumbersForStreet'});
      // #endregion
      
      // Get all house numbers for this street from the address points layer
      const houseNumbers = GISService.listHouseNumbers(street);
      // #region agent log
      enqueueIngest({location:'App.tsx:427',message:'After listHouseNumbers',data:{street,houseNumbersCount:houseNumbers.length},sourceFile:'App.tsx',sourceFn:'loadHouseNumbersForStreet'});
      // #endregion
      
      // Convert to strings and sort
      const nums = houseNumbers.map(String).sort((a, b) => {
        const an = parseInt(a, 10);
        const bn = parseInt(b, 10);
        if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
        return a.localeCompare(b, "he");
      });
      
      setAllHouseNumbers(nums);
      // If there's no filter query, show all numbers
      const currentQuery = numberQuery.trim().toLowerCase();
      if (!currentQuery) {
        setNumberSuggestions(nums);
      } else {
        // Filter based on existing query
        const filtered = nums.filter((num) =>
          num.toLowerCase().includes(currentQuery)
        );
        setNumberSuggestions(filtered);
      }
    } catch (error) {
      console.error("Failed to load house numbers:", error);
      setSearchError("אירעה שגיאה בטעינת מספרי הבתים.");
      setNumberSuggestions([]);
      setAllHouseNumbers([]);
    } finally {
      setIsNumberLoading(false);
    }
  };

  const performNumberSearch = (street: string, numberPart: string) => {
    const qPart = numberPart.trim().toLowerCase();
    
    // If no query, show all house numbers for the street
    if (!qPart) {
      if (allHouseNumbers.length > 0) {
        setNumberSuggestions(allHouseNumbers);
      } else if (street) {
        // Load house numbers if not already loaded
        loadHouseNumbersForStreet(street);
      }
      return;
    }

    // Filter all house numbers based on the query
    const filtered = allHouseNumbers.filter((num) =>
      num.toLowerCase().includes(qPart)
    );
    
    setNumberSuggestions(filtered);
    
    // If we have no results and haven't loaded yet, try loading
    if (filtered.length === 0 && allHouseNumbers.length === 0 && street) {
      loadHouseNumbersForStreet(street);
    }
  };

  // ------------------------------------------------------------------
  // Handler: Manual coordinate lookup
  // ------------------------------------------------------------------
  const handleManualCoordsLookup = async () => {
    // Validate that both street and number are selected
    if (!selectedStreet || !selectedNumber) {
      setManualCoordsError("בחר רחוב ומספר בית קודם");
      setManualCoords(null);
      return;
    }

    // Parse house number
    const houseNumber = parseInt(selectedNumber, 10);
    if (isNaN(houseNumber) || houseNumber <= 0) {
      setManualCoordsError("מספר בית לא תקין");
      setManualCoords(null);
      return;
    }

    // Set loading state
    setIsManualCoordsLoading(true);
    setManualCoordsError(null);
    setManualCoords(null);

    try {
      // Call the helper function
      const coords = await findNetivotAddressCoords(selectedStreet, houseNumber);

      if (coords) {
        // Success: set coordinates
        setManualCoords(coords);
        setManualCoordsError(null);
      } else {
        // Not found: set error message
        setManualCoordsError("לא נמצאו קואורדינטות לכתובת הזו במאגר");
        setManualCoords(null);
      }
    } catch (error) {
      // Unexpected error: log and show generic message
      console.error("Error in manual coordinate lookup:", error);
      setManualCoordsError("אירעה שגיאה בחיפוש הקואורדינטות. אנא נסה שוב.");
      setManualCoords(null);
    } finally {
      setIsManualCoordsLoading(false);
    }
  };

  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setUploadedFile(file);
    setError(null);
    
    try {
      // Read Excel to get initial row count and preview
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
          normalizedAddress: normalized ?? null,
          detectedLatCol,
          detectedLonCol,
          originalCoords,
          finalCoords: undefined,
          status: ProcessingStatus.PENDING,
          message,
        };
      });

      setRows(newRows);
      setProcessedUnique(0);
      setTotalUnique(newRows.length);
      setApiRequestsCount(0);
      setStatusFilter("ALL");
    } catch (error) {
      console.error("Error reading file", error);
      setError("שגיאה בקריאת הקובץ");
      alert("Error reading file");
    }
  };

  const startProcessing = async () => {
    // #region agent log
    enqueueIngest({location:'App.tsx:553',message:'startProcessing called',data:{isProcessing,hasFile:!!uploadedFile},sourceFile:'App.tsx',sourceFn:'startProcessing'});
    // #endregion
    if (isProcessing) return;
    if (!uploadedFile) {
      setError("אנא בחר קובץ תחילה");
      return;
    }

    setIsProcessing(true);
    setError(null);
    setProcessedUnique(0);

    try {
      // #region agent log
      enqueueIngest({location:'App.tsx:565',message:'Before processExcelFile',data:{fileName:uploadedFile.name,fileSize:uploadedFile.size},sourceFile:'App.tsx',sourceFn:'startProcessing'});
      // #endregion
      // Process the Excel file using the new pipeline with progress callback
      const processedRows = await processExcelFile(uploadedFile, undefined, (processed, total) => {
        setProcessedUnique(processed);
        setTotalUnique(total);
      });
      // #region agent log
      enqueueIngest({location:'App.tsx:568',message:'After processExcelFile',data:{rowsCount:processedRows.length,geocodedCount:processedRows.filter(r=>r.finalCoords!==undefined).length},sourceFile:'App.tsx',sourceFn:'startProcessing'});
      // #endregion
      
      setRows(processedRows);
      setProcessedUnique(processedRows.length);
      setTotalUnique(processedRows.length);
      
      // Count API requests (approximate: one per row that was geocoded)
      const geocodedCount = processedRows.filter(
        (row) => row.finalCoords !== undefined
      ).length;
      setApiRequestsCount(geocodedCount);
    } catch (error) {
      // #region agent log
      enqueueIngest({location:'App.tsx:577',message:'Error in startProcessing',data:{errorMessage:error instanceof Error?error.message:String(error),errorStack:error instanceof Error?error.stack:undefined},sourceFile:'App.tsx',sourceFn:'startProcessing'});
      // #endregion
      console.error("Error processing file:", error);
      setError("שגיאה בעיבוד הקובץ. אנא נסה שוב.");
      // Keep existing rows on error
    } finally {
      setIsProcessing(false);
    }
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
    const confirmed = rows.filter(
      (r) => r.status === ProcessingStatus.CONFIRMED
    ).length;

    const updated = rows.filter(
      (r) => r.status === ProcessingStatus.UPDATED
    ).length;

    const needsReview = rows.filter(
      (r) => r.status === ProcessingStatus.NEEDS_REVIEW
    ).length;

    const notFound = rows.filter(
      (r) => r.status === ProcessingStatus.NOT_FOUND
    ).length;

    const skipped = rows.filter(
      (r) => r.status === ProcessingStatus.SKIPPED
    ).length;
    
    return { confirmed, updated, needsReview, notFound, skipped };
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
                  setAllHouseNumbers([]);
                  setNumberSuggestions([]);
                  setSelectedNumber(null);
                  setNumberQuery("");
                  setNumberSuggestions([]);
                  // Clear manual coords when street changes
                  setManualCoords(null);
                  setManualCoordsError(null);
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
                      onClick={async () => {
                        setSelectedStreet(street);
                        setSelectedNumber(null);
                        setNumberQuery("");
                        setNumberSuggestions([]);
                        setAllHouseNumbers([]);
                        // Clear manual coords when street changes
                        setManualCoords(null);
                        setManualCoordsError(null);
                        // Load house numbers for the selected street
                        await loadHouseNumbersForStreet(street);
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
                  // Clear manual coords when number changes
                  if (trimmed !== selectedNumber) {
                    setManualCoords(null);
                    setManualCoordsError(null);
                  }
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
                    {selectedStreet
                      ? "לא נמצאו מספרים במפת הכתובות (תוכל עדיין להקליד מספר ידנית)"
                      : "לא נבחר רחוב"}
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
                        // Clear manual coords when number changes
                        setManualCoords(null);
                        setManualCoordsError(null);
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

              {/* Action button and result display */}
              {selectedStreet && selectedNumber && (
                <div className="mt-3 space-y-2">
                  <button
                    type="button"
                    onClick={handleManualCoordsLookup}
                    disabled={isManualCoordsLoading}
                    className={`w-full px-4 py-2 rounded text-sm font-medium transition-colors ${
                      isManualCoordsLoading
                        ? "bg-gray-400 text-gray-200 cursor-not-allowed"
                        : "bg-blue-600 hover:bg-blue-700 text-white"
                    }`}
                  >
                    {isManualCoordsLoading ? "מחפש קואורדינטות..." : "מצא קואורדינטות"}
                  </button>

                  {/* Loading state */}
                  {isManualCoordsLoading && (
                    <p className="text-xs text-gray-500 text-center">
                      מחפש קואורדינטות...
                    </p>
                  )}

                  {/* Success: Display coordinates */}
                  {!isManualCoordsLoading && manualCoords && (
                    <div className="p-3 bg-green-50 border border-green-200 rounded text-sm">
                      <p className="font-medium text-green-800 mb-1">
                        קואורדינטות:
                      </p>
                      <p className="text-green-700 font-mono" dir="ltr">
                        {manualCoords.lat.toFixed(6)}, {manualCoords.lon.toFixed(6)}
                      </p>
                    </div>
                  )}

                  {/* Error: Display error message */}
                  {!isManualCoordsLoading && manualCoordsError && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded text-sm">
                      <p className="text-red-700">{manualCoordsError}</p>
                    </div>
                  )}
                </div>
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
                  rows.length > 0 &&
                  (rows[0].status === ProcessingStatus.PENDING ||
                    rows.some((r) => r.status === ProcessingStatus.PENDING)) && (
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
                      <span>מעבד כתובות באמצעות HybridGeocoder...</span>
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
                
                {error && (
                  <div className="w-full mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                    {error}
                  </div>
                )}
              </div>
            </div>

            {/* Filter Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <button
                onClick={() =>
                  setStatusFilter(ProcessingStatus.CONFIRMED)
                }
                className={`p-4 rounded-xl border text-right transition-all ${
                  statusFilter === ProcessingStatus.CONFIRMED
                    ? "ring-2 ring-green-500 bg-green-50"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className="flex justify-between items-start">
                  <CheckCircle className="text-green-500" />
                  <span className="text-2xl font-bold">
                    {stats.confirmed}
                  </span>
                </div>
                <span className="text-sm text-gray-600 mt-2 block">
                  מאושרים (דיוק גבוה)
                </span>
              </button>

              <button
                onClick={() =>
                  setStatusFilter(ProcessingStatus.NEEDS_REVIEW)
                }
                className={`p-4 rounded-xl border text-right transition-all ${
                  statusFilter === ProcessingStatus.NEEDS_REVIEW
                    ? "ring-2 ring-yellow-500 bg-yellow-50"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className="flex justify-between items-start">
                  <AlertTriangle className="text-yellow-500" />
                  <span className="text-2xl font-bold">
                    {stats.needsReview}
                  </span>
                </div>
                <span className="text-sm text-gray-600 mt-2 block">
                  נדרש ביקורת
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
                <div className="flex justify-between items-start">
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
