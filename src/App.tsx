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
} from "lucide-react";
import { AddressRow, ProcessingStatus } from "./types";
import { readExcel, exportExcel } from "./services/excel";
import { normalizeAddress, getAddressFromRow } from "./services/normalization";
import { batchGeocode, getCachedResult } from "./services/geocoding";

// --------------------------------------------------
// Helper: simple Netivot bounding box (approximate)
// --------------------------------------------------
const NETIVOT_BOUNDS = {
  minLat: 31.38,
  maxLat: 31.47,
  minLon: 34.55,
  maxLon: 34.63,
};

function isInsideNetivot(lat: number | null | undefined, lon: number | null | undefined): boolean {
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

// --------------------------------------------------
// Helper: clasificar una fila según el cache (parcial/final)
// --------------------------------------------------
function classifyRowFromCache(row: AddressRow, allowNotFound: boolean): AddressRow {
  const normalized = row.normalizedAddress || "";
  const hasNormalized = !!row.normalizedAddress;
  const hasNumber = hasNormalized && /\d+/.test(normalized);

  // Si ya está resuelta, no la tocamos
  if (
    row.status === ProcessingStatus.SKIPPED ||
    row.status === ProcessingStatus.CONFIRMED ||
    row.status === ProcessingStatus.UPDATED ||
    row.status === ProcessingStatus.NOT_FOUND ||
    row.status === ProcessingStatus.NEEDS_REVIEW
  ) {
    return row;
  }

  // 1) Sin dirección usable → דולג (חסרה כתובת מלאה)
  if (!hasNormalized) {
    return {
      ...row,
      status: ProcessingStatus.SKIPPED,
      message: "חסרה כתובת מלאה",
      finalCoords: undefined,
    };
  }

  // 2) Dirección sin número → también מידע חסר
  if (!hasNumber) {
    return {
      ...row,
      status: ProcessingStatus.SKIPPED,
      message: "חסרה כתובת מלאה (אין מספר בית)",
      finalCoords: undefined,
    };
  }

  const originalLat = row.originalCoords?.lat ?? null;
  const originalLon = row.originalCoords?.lon ?? null;
  const origInside = isInsideNetivot(originalLat, originalLon);

  const result = getCachedResult(normalized);

  // 3) Todavía no hay resultado de API en el cache
  if (!result) {
    if (!allowNotFound) {
      // Fase parcial: seguimos esperando resultado
      return row;
    }

    // Fase final: ya terminó la API, decidimos con lo que hay
    if (origInside) {
      return {
        ...row,
        status: ProcessingStatus.CONFIRMED,
        finalCoords: undefined,
        message: "כתובת תקינה – נעשה שימוש בקואורדינטות המקור",
      };
    }

    // Dirección completa, pero el ג'אוקודר no devuelve nada → לבדיקה, no "לא נמצא"
    return {
      ...row,
      status: ProcessingStatus.NEEDS_REVIEW,
      finalCoords: undefined,
      message: "כתובת מלאה אך לא נמצאה במאגר המיפוי – נדרש טיפול ידני",
    };
  }

  // 4) Hay resultado de API
  const newLat = result.lat;
  const newLon = result.lon;
  const newInside = isInsideNetivot(newLat, newLon);

  // Resultado fuera de נתיבות pero original dentro → nos quedamos con original
  if (!newInside && origInside) {
    return {
      ...row,
      status: ProcessingStatus.CONFIRMED,
      finalCoords: undefined,
      message: "תוצאת המפה מחוץ לנתיבות – נשמרו קואורדינטות המקור",
    };
  }

  // Si original estaba bien y el cambio es muy chico → CONFIRMED
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

  // Si llegamos aquí, de verdad actualizamos coords
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
      return <span className="px-2 py-1 rounded text-xs bg-gray-200 text-gray-700">ממתין</span>;
    case ProcessingStatus.CONFIRMED:
      return <span className="px-2 py-1 rounded text-xs bg-blue-100 text-blue-700">תקין</span>;
    case ProcessingStatus.UPDATED:
      return <span className="px-2 py-1 rounded text-xs bg-green-100 text-green-700">עודכן</span>;
    case ProcessingStatus.NEEDS_REVIEW:
      return <span className="px-2 py-1 rounded text-xs bg-yellow-100 text-yellow-700">לבדיקה</span>;
    case ProcessingStatus.NOT_FOUND:
      return <span className="px-2 py-1 rounded text-xs bg-red-100 text-red-700">לא נמצא</span>;
    case ProcessingStatus.SKIPPED:
      return (
        <span className="px-2 py-1 rounded text-xs bg-orange-100 text-orange-700">דולג (חסר)</span>
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
  const [statusFilter, setStatusFilter] = useState<ProcessingStatus | "ALL">("ALL");

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    try {
      const rawData = await readExcel(file);
      const newRows: AddressRow[] = rawData.map((data, index) => {
        const keys = Object.keys(data);
        const detectedLatCol = keys.find((k) => /lat/i.test(k)) || "lat";
        const detectedLonCol = keys.find((k) => /lon|lng/i.test(k)) || "lon";
        const rawAddr = getAddressFromRow(data);
        const normalized = normalizeAddress(rawAddr);

        let originalCoords;
        const latVal = parseFloat(data[detectedLatCol]);
        const lonVal = parseFloat(data[detectedLonCol]);
        if (!isNaN(latVal) && !isNaN(lonVal)) {
          originalCoords = { lat: latVal, lon: lonVal };
        }

        return {
          id: String(index),
          originalData: data,
          address: rawAddr,
          originalAddress: rawAddr,
          normalizedAddress: normalized,
          detectedLatCol,
          detectedLonCol,
          originalCoords,
          status: ProcessingStatus.PENDING,
          message: normalized ? "" : "חסרה כתובת מלאה",
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

    // Direcciones únicas con número de casa (para geocoding)
    const addressesToGeocode = Array.from(
      new Set(
        rows
          .filter(
            (r) =>
              r.normalizedAddress &&
              /\d+/.test(r.normalizedAddress) // debe tener número
          )
          .map((r) => r.normalizedAddress as string)
      )
    );

    setTotalUnique(addressesToGeocode.length);
    setProcessedUnique(0);
    setApiRequestsCount(0);

    // 1) Pasada inicial: marcar SKIPPED inmediato donde corresponde
    setRows((prev) => prev.map((row) => classifyRowFromCache(row, false)));

    // 2) Cada vez que avanza la API, aplicamos resultados parciales
    const applyPartialResults = () => {
      setRows((prev) => prev.map((row) => classifyRowFromCache(row, false)));
    };

    // 3) Geocoding en batch, actualizando barra + stats en tiempo real
    await batchGeocode(addressesToGeocode, 3, (count, isCacheHit) => {
      setProcessedUnique((prev) => prev + count);
      if (!isCacheHit) {
        setApiRequestsCount((prev) => prev + 1);
      }
      applyPartialResults();
    });

    // 4) Pasada final: lo que siga pendiente se resuelve a CONFIRMED / NEEDS_REVIEW
    setRows((prev) => prev.map((row) => classifyRowFromCache(row, true)));

    setIsProcessing(false);
  };

  const filteredRows = useMemo(() => {
    if (statusFilter === "ALL") return rows;
    return rows.filter((r) => r.status === statusFilter);
  }, [rows, statusFilter]);

  const stats = useMemo(() => {
    const updated =
      rows.filter(
        (r) =>
          r.status === ProcessingStatus.UPDATED ||
          r.status === ProcessingStatus.CONFIRMED
      ).length;
    const notFound = rows.filter((r) => r.status === ProcessingStatus.NOT_FOUND).length;
    const skipped = rows.filter((r) => r.status === ProcessingStatus.SKIPPED).length;
    return { updated, notFound, skipped };
  }, [rows]);

  const displayedRows = filteredRows.slice(0, 100);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 font-sans" dir="rtl">
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
        {rows.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-lg border border-dashed border-gray-300">
            <Upload className="mx-auto text-gray-400 mb-4" size={48} />
            <h3 className="text-lg font-medium text-gray-900">אין נתונים להצגה</h3>
            <p className="text-gray-500">אנא טען קובץ אקסל כדי להתחיל</p>
          </div>
        ) : (
          <>
            {/* Control & Stats Card */}
            <div className="bg-white rounded-xl border p-6 shadow-sm">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="text-lg font-semibold">{fileName}</h2>
                  <div className="text-sm text-gray-500 flex gap-4 mt-1">
                    <span>סה"כ shורות: {rows.length}</span>
                    <span>כתובות ייחודיות: {totalUnique || "-"}</span>
                    <span>בקשות API: {apiRequestsCount}</span>
                  </div>
                </div>

                {!isProcessing && rows[0].status === ProcessingStatus.PENDING && (
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
                          ? Math.round((processedUnique / totalUnique) * 100)
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
                onClick={() => setStatusFilter(ProcessingStatus.UPDATED)}
                className={`p-4 rounded-xl border text-right transition-all ${
                  statusFilter === ProcessingStatus.UPDATED
                    ? "ring-2 ring-green-500 bg-green-50"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className="flex justify-between items-start">
                  <CheckCircle className="text-green-500" />
                  <span className="text-2xl font-bold">{stats.updated}</span>
                </div>
                <span className="text-sm text-gray-600 mt-2 block">עודכנו בהצלחה / תקינים</span>
              </button>

              <button
                onClick={() => setStatusFilter(ProcessingStatus.NOT_FOUND)}
                className={`p-4 rounded-xl border text-right transition-all ${
                  statusFilter === ProcessingStatus.NOT_FOUND
                    ? "ring-2 ring-red-500 bg-red-50"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className="flex justify-between items-start">
                  <XCircle className="text-red-500" />
                  <span className="text-2xl font-bold">{stats.notFound}</span>
                </div>
                <span className="text-sm text-gray-600 mt-2 block">לא נמצאו</span>
              </button>

              <button
                onClick={() => setStatusFilter(ProcessingStatus.SKIPPED)}
                className={`p-4 rounded-xl border text-right transition-all ${
                  statusFilter === ProcessingStatus.SKIPPED
                    ? "ring-2 ring-orange-500 bg-orange-50"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className="flex justify-between items-start">
                  <AlertTriangle className="text-orange-500" />
                  <span className="text-2xl font-bold">{stats.skipped}</span>
                </div>
                <span className="text-sm text-gray-600 mt-2 block">דולגו (מידע חסר)</span>
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
                  <span className="text-2xl font-bold">{rows.length}</span>
                </div>
                <span className="text-sm text-gray-600 mt-2 block">הצג הכל</span>
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
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {parseInt(row.id) + 1}
                        </td>
                        <td
                          className="px-6 py-4 text-sm text-gray-900 max-w-xs truncate"
                          title={row.address}
                        >
                          {row.address}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500" dir="ltr">
                          {row.originalCoords
                            ? `${row.originalCoords.lat}, ${row.originalCoords.lon}`
                            : "-"}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium" dir="ltr">
                          {row.finalCoords ? (
                            <span className="text-green-600">
                              {row.finalCoords.lat}, {row.finalCoords.lon}
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
