export enum ProcessingStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  UPDATED = "UPDATED",
  NEEDS_REVIEW = "NEEDS_REVIEW",
  NOT_FOUND = "NOT_FOUND",
  SKIPPED = "SKIPPED",
}

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface AddressRow {
  id: string;
  originalData: Record<string, any>;
  address: string;            // resolved address string used in UI
  originalAddress: string;    // as read from the file
  normalizedAddress: string | null;
  detectedLatCol: string;
  detectedLonCol: string;
  originalCoords?: Coordinates;
  finalCoords?: Coordinates;
  status: ProcessingStatus;
  message: string;
}