import * as XLSX from "xlsx";
import { AddressRow, ProcessingStatus } from "../types";

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