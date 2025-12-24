import * as XLSX from "xlsx";
import { AddressRow, ProcessingStatus, Coordinates } from "../types";
import { processRows } from "./rowProcessor";
import { HybridGeocoder } from "./hybridGeocoder";
import { getAddressFromRow, normalizeAddress } from "./normalization";
import { enqueueIngest } from "./ingestClient";

export const readExcel = (file: File): Promise<Record<string, any>[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: "binary" });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonData = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, {
          defval: "", // default value for empty cells
        });
        resolve(jsonData);
      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = (err) => reject(err);
    reader.readAsBinaryString(file);
  });
};

export const exportExcel = (rows: AddressRow[], originalFileName: string): void => {
  const processedData = rows.map((row) => {
    // Create a copy of the original data
    const newRow = { ...row.originalData };

    // Update latitude and longitude if we have final coordinates
    if (row.finalCoords) {
      newRow[row.detectedLatCol] = row.finalCoords.lat;
      newRow[row.detectedLonCol] = row.finalCoords.lon;
    } else if (row.status === ProcessingStatus.SKIPPED) {
      // Keep empty if skipped (or clear if it had junk)
      // Per instructions: "keep lat/lon EMPTY"
      newRow[row.detectedLatCol] = "";
      newRow[row.detectedLonCol] = "";
    }

    // Add/Update message column
    newRow["message"] = row.message;

    return newRow;
  });

  const worksheet = XLSX.utils.json_to_sheet(processedData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Fixed Addresses");

  const namePart = originalFileName.substring(0, originalFileName.lastIndexOf(".")) || originalFileName;
  const newFileName = `${namePart}-fixed.xlsx`;

  XLSX.writeFile(workbook, newFileName);
};

// ============================================================================
// High-Level Processing Pipeline
// ============================================================================

/**
 * Converts raw Excel data (Record<string, any>[]) into AddressRow[].
 * This is a helper function used internally by processExcelFile.
 * 
 * @param rawData - Raw Excel data from readExcel
 * @returns Array of AddressRow objects with initial state
 */
function convertRawDataToAddressRows(rawData: Record<string, any>[]): AddressRow[] {
  return rawData.map((data, index) => {
    const keys = Object.keys(data);
    
    // Detect latitude and longitude columns
    const detectedLatCol =
      keys.find((k) => /lat/i.test(k)) || "lat";
    const detectedLonCol =
      keys.find((k) => /lon|lng/i.test(k)) || "lon";
    
    // Extract address from row
    const rawAddr = getAddressFromRow(data);
    const normalized = normalizeAddress(rawAddr);
    
    // Extract original coordinates if present
    let originalCoords: Coordinates | undefined;
    const latVal = parseFloat(data[detectedLatCol]);
    const lonVal = parseFloat(data[detectedLonCol]);
    if (!Number.isNaN(latVal) && !Number.isNaN(lonVal)) {
      originalCoords = { lat: latVal, lon: lonVal };
    }
    
    // Determine initial message (will be updated by processRows)
    let message = "";
    if (!rawAddr || rawAddr.trim().length === 0) {
      message = "חסרה כתובת מלאה";
    } else if (!normalized) {
      message = "חסרה כתובת מלאה (אין מספר בית או שם רחוב)";
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
}

/**
 * Tracks whether HybridGeocoder has been initialized to avoid redundant init calls.
 */
let geocoderInitialized = false;

/**
 * Ensures HybridGeocoder is initialized.
 * This function is idempotent - it only initializes once.
 * 
 * @param gisLayerPath - Optional path to GIS layer (defaults to "/gis/netivot.geojson")
 */
async function ensureGeocoderInitialized(gisLayerPath?: string): Promise<void> {
  // #region agent log
  enqueueIngest({location:'excel.ts:131',message:'ensureGeocoderInitialized called',data:{geocoderInitialized,gisLayerPath},sourceFile:'excel.ts',sourceFn:'ensureGeocoderInitialized'});
  // #endregion
  if (!geocoderInitialized) {
    try {
      // #region agent log
      enqueueIngest({location:'excel.ts:134',message:'Before HybridGeocoder.init',data:{gisLayerPath},sourceFile:'excel.ts',sourceFn:'ensureGeocoderInitialized'});
      // #endregion
      await HybridGeocoder.init(gisLayerPath);
      // #region agent log
      enqueueIngest({location:'excel.ts:136',message:'After HybridGeocoder.init success',data:{},sourceFile:'excel.ts',sourceFn:'ensureGeocoderInitialized'});
      // #endregion
      geocoderInitialized = true;
    } catch (error) {
      // #region agent log
      enqueueIngest({location:'excel.ts:137',message:'HybridGeocoder.init failed',data:{errorMessage:error instanceof Error?error.message:String(error)},sourceFile:'excel.ts',sourceFn:'ensureGeocoderInitialized'});
      // #endregion
      console.error("Failed to initialize HybridGeocoder:", error);
      throw error;
    }
  }
}

/**
 * Processes an array of AddressRow objects using the HybridGeocoder.
 * 
 * This is a pure "rows in → rows out" processing function that:
 * - Takes AddressRow[] as input
 * - Calls processRows() from rowProcessor to geocode all addresses
 * - Returns updated AddressRow[] with coordinates and statuses
 * 
 * @param rows - Array of AddressRow objects to process
 * @param onProgress - Optional callback to report progress
 * @returns Processed AddressRow[] with coordinates and statuses assigned
 */
export async function processExcelRows(
  rows: AddressRow[],
  onProgress?: (processed: number, total: number) => void
): Promise<AddressRow[]> {
  return await processRows(rows, onProgress);
}

/**
 * Complete pipeline for processing an Excel file from upload to processed rows.
 * 
 * This function:
 * 1. Reads the Excel file using readExcel()
 * 2. Converts raw data to AddressRow[]
 * 3. Ensures HybridGeocoder is initialized (calls init() if needed)
 * 4. Processes all rows using processRows() (which uses HybridGeocoder)
 * 5. Returns fully processed AddressRow[] with coordinates and statuses
 * 
 * @param file - Excel file to process
 * @param gisLayerPath - Optional path to GIS layer (defaults to "/gis/netivot.geojson")
 * @returns Processed AddressRow[] with coordinates and statuses assigned
 * @throws Error if file cannot be read or geocoder cannot be initialized
 */
export async function processExcelFile(
  file: File,
  gisLayerPath?: string,
  onProgress?: (processed: number, total: number) => void
): Promise<AddressRow[]> {
  // Step 1: Read Excel file
  const rawData = await readExcel(file);
  
  // Step 2: Convert raw data to AddressRow[]
  const addressRows = convertRawDataToAddressRows(rawData);
  
  // Step 3: Ensure HybridGeocoder is initialized
  await ensureGeocoderInitialized(gisLayerPath);
  
  // Step 4: Process all rows using HybridGeocoder
  const processedRows = await processExcelRows(addressRows, onProgress);
  
  return processedRows;
}