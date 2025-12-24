# FEATURES_BOARD – Product Feature Backlog

This document tracks all planned features for the Coordinates SaaS platform, organized by development phase.

## MVP – Required for the First Paying Customer

| ID | Feature | Description | Status |
|---|---|---|---|
| F-MVP-001 | Excel File Upload and Parsing | Support for uploading Excel files (.xlsx, .xls) with automatic column detection for address fields (street, house number, city, neighborhood). Handles various column name variations in Hebrew and English. | ✅ Complete |
| F-MVP-002 | Hebrew/Arabic Address Normalization | Intelligent normalization engine that removes neighborhood tokens, standardizes street formats, handles abbreviations, detects intersections, and recognizes points of interest. Ensures consistent address format for geocoding. | ✅ Complete |
| F-MVP-003 | Hybrid Geocoding Engine Foundation (GovMap + Nominatim) | Two-tier geocoding system: primary GovMap API for official Israeli data, fallback to Nominatim with city-specific bounding box constraints. Includes result caching to minimize API calls. This is the foundation for the full ensemble engine targeting ~99% accuracy. | ✅ Complete |
| F-MVP-004 | Netivot Boundary Validation | Validates that geocoded coordinates fall within Netivot's geographic boundaries using bounding box checks. Prevents false positives from nearby cities. | ✅ Complete |
| F-MVP-005 | Status Workflow and Classification | Comprehensive status system (PENDING, CONFIRMED, UPDATED, NOT_FOUND, NEEDS_REVIEW, SKIPPED) with automatic classification based on geocoding results, coordinate validation, and address completeness. | ✅ Complete |
| F-MVP-006 | Ensemble Geocoding Engine Architecture | Build the core hybrid/ensemble geocoding layer that calls multiple open-source geocoders (Nominatim, Pelias, libpostal) and municipal ArcGIS layers in parallel, normalizes results, and applies heuristics (bounding boxes, street/number matching, confidence scores) to select the best result. Foundation for achieving ~99% accuracy target. | 🔄 Planned |

## PRO – Features that Make the SaaS Profitable

| ID | Feature | Description | Status |
|---|---|---|---|
| F-PRO-001 | User Authentication and Multi-Tenant Architecture | Secure user registration, login, and session management. Multi-tenant data isolation ensuring users can only access their own projects and data. Role-based access control for team accounts. | 🔄 Planned |
| F-PRO-002 | FREE and PRO Subscription Tiers | Two-tier pricing model: FREE tier with limited monthly geocoding requests (e.g., 100 addresses/month), PRO tier with unlimited or high-volume limits. Subscription management, upgrade/downgrade flows, and payment processing integration. | 🔄 Planned |
| F-PRO-003 | Usage Limits and Billing Integration | Track geocoding requests per user, enforce subscription limits, and integrate with payment providers (Stripe, PayPal) for automated billing. Usage dashboard showing current month's consumption and billing history. | 🔄 Planned |
| F-PRO-004 | REST API for Programmatic Access | RESTful API endpoints for geocoding single addresses or batch processing. API key management, rate limiting, and webhook support for asynchronous batch completion notifications. Documentation with code examples. | 🔄 Planned |
| F-PRO-005 | Project Management and History | Allow users to create multiple projects, each containing multiple Excel files. Project history with timestamps, status summaries, and ability to re-download results. Project sharing and collaboration features for team accounts. | 🔄 Planned |
| F-PRO-006 | Accuracy Benchmark Suite with Labeled Dataset | Create an internal accuracy benchmark suite using a labeled dataset of known-correct addresses (using municipal ArcGIS layers as ground truth). Automated testing framework that measures geocoding accuracy, tracks improvements over time, and identifies systematic errors. Critical for maintaining and validating the ~99% accuracy target. | 🔄 Planned |
| F-PRO-007 | Accuracy Tracking and Reporting Dashboard | Real-time accuracy metrics dashboard showing geocoding success rates, error types, and accuracy trends over time. Per-user accuracy reports, comparison against benchmark dataset, and alerts when accuracy drops below target thresholds. Enables transparency and continuous improvement of the ensemble geocoding engine. | 🔄 Planned |

## FUTURE – National and International Scale

| ID | Feature | Description | Status |
|---|---|---|---|
| F-FUTURE-001 | Multi-City Support (All Israeli Cities) | Expand beyond Netivot to support all major Israeli cities (Tel Aviv, Jerusalem, Haifa, Be'er Sheva, etc.). City-specific normalization rules, boundary data, and localized address format handling. City selector in UI and API. Each city's ArcGIS layer integrated as ground truth for maintaining ~99% accuracy across all municipalities. | 🔄 Planned |
| F-FUTURE-002 | Full ArcGIS Layer Integration for All Cities | Integrate municipal ArcGIS services as primary geocoding source for all supported Israeli cities, serving as ground truth datasets. Priority-based ensemble chain: Municipal ArcGIS → GovMap → Nominatim → Pelias → libpostal. Ensures the ~99% accuracy target is maintained as the platform scales to national coverage. | 🔄 Planned |
| F-FUTURE-003 | Advanced Analytics and Reporting | Dashboard with geocoding success rates, processing time metrics, error analysis, and usage trends. Exportable reports for compliance and auditing. Geographic visualization of geocoded addresses on interactive maps. Accuracy metrics broken down by city, geocoding source, and address type. | 🔄 Planned |
| F-FUTURE-004 | Real-Time Geocoding API with Webhooks | High-performance API endpoint for real-time single-address geocoding with sub-second response times using the ensemble engine. Webhook notifications for batch job completion, error alerts, and usage limit warnings. WebSocket support for live progress updates. | 🔄 Planned |
| F-FUTURE-005 | International Expansion and Multi-Language Support | Support for additional countries and languages (Arabic-speaking countries, multilingual regions). International geocoding providers (Google Maps, HERE, Mapbox) integrated into the ensemble engine. Multi-currency billing, localized UI, and compliance with international data protection regulations (GDPR, etc.). Maintains high-accuracy targets through region-specific ensemble configurations. | 🔄 Planned |

---

**Legend:**
- ✅ Complete: Feature is implemented and tested
- 🔄 Planned: Feature is planned but not yet implemented
- 🚧 In Progress: Feature is currently under development
- ⚠️ Blocked: Feature is blocked by dependencies or external factors

## MVP IMPLEMENTATION ROADMAP (TECHNICAL)

This roadmap breaks down the MVP into sequential, concrete engineering tasks that can be executed one by one in Cursor. Each task is designed to be completable in a single session and moves the product toward a sellable MVP with ~99% geocoding accuracy.

### Task 1: Refactor Normalization Service for Extensibility

**Files to Modify:**
- `src/services/normalization.ts`

**What to Implement:**
- Extract neighborhood patterns, street prefixes, and replacement dictionaries into separate, easily configurable constants or configuration objects
- Create a `NormalizationConfig` interface/type that can be extended for different cities
- Refactor `normalizeAddress()` to accept an optional city-specific config parameter
- Add unit test structure (create `src/services/__tests__/normalization.test.ts`) with at least 5 test cases covering edge cases
- Ensure all normalization functions are pure (no side effects) and well-documented with JSDoc comments

**Success Criteria:**
- Normalization logic is modular and can be extended for other cities
- Code is testable and maintainable
- Existing functionality remains unchanged

---

### Task 2: Create GIS Lookup Service for ArcGIS Integration

**Files to Create:**
- `src/services/gisService.ts`
- `src/types/gis.ts` (if types file doesn't exist, add to `src/types.ts`)

**Files to Modify:**
- `src/types.ts` (add GIS-related types if not in separate file)

**What to Implement:**
- Create `GisLookupResult` interface with fields: `lat`, `lon`, `confidence`, `source`, `addressMatch`, `metadata`
- Implement `lookupAddressInGisLayer()` function that:
  - Accepts normalized address string and city name (default: "Netivot")
  - For MVP, creates a mock/stub that returns structured results matching the interface
  - Includes error handling for network failures and invalid responses
  - Returns `null` if address not found in GIS layer
- Add configuration constants for ArcGIS endpoint URLs (placeholder for now, will be configured later)
- Add JSDoc documentation explaining the GIS layer's role as ground truth data

**Success Criteria:**
- GIS service interface is defined and ready for real ArcGIS integration
- Mock implementation returns properly structured results
- Error handling is comprehensive

---

### Task 3: Create HybridGeocoder v1 (Ensemble Engine Foundation)

**Files to Create:**
- `src/services/hybridGeocoder.ts`
- `src/types/geocoding.ts` (or add to existing types file)

**Files to Modify:**
- `src/types.ts` (add `GeocodingResult`, `GeocodingSource`, `ConfidenceScore` types)

**What to Implement:**
- Create `GeocodingResult` interface with: `coordinates`, `source`, `confidence`, `addressMatch`, `withinBounds`, `metadata`
- Create `HybridGeocoder` class with method `geocode(address: string, city: string): Promise<GeocodingResult | null>`
- Implement ensemble logic:
  1. Call GIS lookup service (highest priority, ground truth)
  2. Call GovMap service in parallel
  3. Call Nominatim service in parallel
  4. Collect all results (non-null)
  5. Apply heuristics:
     - If GIS result exists and within bounds → use it (confidence: 0.99)
     - If GovMap result within bounds → use it (confidence: 0.85)
     - If Nominatim result within bounds → use it (confidence: 0.70)
     - If multiple results agree within 30m → boost confidence
     - If results disagree significantly → flag for review (confidence: 0.50)
  6. Return best result with confidence score
- Add result caching to avoid duplicate API calls
- Include comprehensive error handling (network failures, timeouts, invalid responses)

**Success Criteria:**
- Hybrid geocoder returns results with confidence scores
- Multiple sources are queried in parallel for performance
- Heuristics correctly prioritize GIS > GovMap > Nominatim
- Results are cached appropriately

---

### Task 4: Fix and Enhance Classification Logic

**Files to Modify:**
- `src/App.tsx` (specifically `classifyRowFromCache` function)
- `src/types.ts` (ensure `AddressRow` includes `confidence` field)

**What to Implement:**
- Update `AddressRow` interface to include optional `confidence?: number` field (0.0 to 1.0)
- Refactor `classifyRowFromCache()` to:
  - Accept `GeocodingResult` from hybrid geocoder (with confidence score)
  - Use confidence score in classification decisions:
    - Confidence >= 0.90 → CONFIRMED or UPDATED (depending on original coords)
    - Confidence 0.70-0.89 → UPDATED (with note about moderate confidence)
    - Confidence 0.50-0.69 → NEEDS_REVIEW (low confidence, manual check recommended)
    - Confidence < 0.50 or no result → NOT_FOUND
  - Compare new coordinates with original coordinates:
    - If within 30m and original was inside bounds → CONFIRMED
    - If > 30m difference → UPDATED (with distance noted in message)
  - Store confidence score in row data for UI display
- Update status messages to include confidence information when relevant
- Add edge case handling for missing original coordinates

**Success Criteria:**
- Classification uses confidence scores from hybrid geocoder
- Status messages are informative and include confidence context
- All status types are correctly assigned based on heuristics

---

### Task 5: Stabilize Excel Import/Export with Error Handling

**Files to Modify:**
- `src/services/excel.ts`
- `src/App.tsx` (file upload and export handlers)

**What to Implement:**
- Enhance `readExcel()` function:
  - Add validation for file size (max 10MB for MVP)
  - Add validation for file type (only .xlsx, .xls)
  - Add error handling for corrupted files, empty sheets, missing columns
  - Return structured error objects instead of throwing raw errors
  - Add progress callback for large files (optional, for future)
- Enhance `exportExcel()` function:
  - Validate that rows array is not empty
  - Add error handling for write failures
  - Preserve original file structure more accurately (column order, formatting hints)
  - Add validation that required columns (lat, lon, message) exist or can be created
- Update `App.tsx` file handlers:
  - Display user-friendly error messages for file upload failures
  - Show loading state during file processing
  - Validate file before processing begins
- Add unit tests for edge cases (empty file, missing columns, invalid data types)

**Success Criteria:**
- Excel import/export handles errors gracefully
- User sees clear error messages for common issues
- File processing is robust and doesn't crash on edge cases

---

### Task 6: Standardize Result Schema and Data Flow

**Files to Modify:**
- `src/types.ts` (standardize all result types)
- `src/services/geocoding.ts` (update to use standardized types)
- `src/services/hybridGeocoder.ts` (ensure output matches schema)

**What to Implement:**
- Create comprehensive type definitions:
  - `StandardGeocodingResult`: Final result format with all required fields
  - `GeocodingSource`: Enum for source types (GIS, GOVMAP, NOMINATIM, CACHE)
  - `ProcessingStatus`: Ensure all statuses are properly typed
  - `AddressRow`: Complete interface with all fields (original, normalized, coords, status, confidence, message, metadata)
- Ensure all geocoding services return results in `StandardGeocodingResult` format
- Update cache to store standardized format
- Create utility function `normalizeGeocodingResult()` to convert any geocoding service result to standard format
- Add validation function `validateGeocodingResult()` to ensure result integrity
- Update all code paths to use standardized types (remove any `any` types related to geocoding)

**Success Criteria:**
- All geocoding results use consistent schema
- Type safety is enforced throughout the codebase
- No `any` types in geocoding-related code

---

### Task 7: UI Updates for Status and Confidence Display

**Files to Modify:**
- `src/App.tsx` (UI components, table rendering, status badges)

**What to Implement:**
- Update `StatusBadge` component to:
  - Display confidence score as a small badge or tooltip when confidence < 0.90
  - Use color coding: green (high confidence), yellow (medium), orange (low), red (not found)
  - Show confidence percentage (e.g., "85%") for UPDATED and NEEDS_REVIEW statuses
- Add confidence indicator in data table:
  - Add optional "Confidence" column (can be toggled on/off)
  - Display as progress bar or percentage
  - Tooltip explaining what confidence means
- Update statistics dashboard to show:
  - Average confidence score across all geocoded addresses
  - Breakdown by confidence ranges (high/medium/low)
  - Success rate (addresses with confidence >= 0.70)
- Enhance status messages in table to be more informative:
  - Include source information (e.g., "Updated via GovMap")
  - Include confidence context (e.g., "High confidence match")
- Add visual indicator for addresses that need review (NEEDS_REVIEW status)

**Success Criteria:**
- Users can see confidence scores for geocoded addresses
- UI clearly communicates data quality and reliability
- Status information is informative and actionable

---

### Task 8: Comprehensive Error Handling and Logging

**Files to Create:**
- `src/utils/logger.ts`
- `src/utils/errorHandler.ts`

**Files to Modify:**
- All service files (`geocoding.ts`, `hybridGeocoder.ts`, `gisService.ts`, `normalization.ts`, `excel.ts`)
- `src/App.tsx` (error boundaries and user-facing error messages)

**What to Implement:**
- Create logging utility:
  - `logger.ts` with functions: `logInfo()`, `logError()`, `logWarning()`, `logDebug()`
  - For MVP: console-based logging (structured JSON format)
  - Include context: timestamp, service name, error type, user action
  - Add log levels (can be configured via environment variable)
- Create error handler utility:
  - `errorHandler.ts` with function `handleGeocodingError(error: Error, context: string): UserFriendlyError`
  - Categorize errors: network errors, API errors, validation errors, unknown errors
  - Convert technical errors to user-friendly messages
  - Log technical details while showing friendly messages to users
- Update all service functions to:
  - Use logger for all errors and important events
  - Use error handler for user-facing errors
  - Include context in error messages (which address, which service, etc.)
- Add error boundary in `App.tsx` to catch React errors gracefully
- Add retry logic for transient network errors (max 2 retries with exponential backoff)

**Success Criteria:**
- All errors are logged with sufficient context
- Users see friendly error messages
- Technical errors are captured for debugging
- System is resilient to transient failures

---

### Task 9: Add Accuracy Benchmarking Infrastructure

**Files to Create:**
- `src/utils/accuracyBenchmark.ts`
- `src/data/testAddresses.ts` (or JSON file with test dataset)

**Files to Modify:**
- `src/services/hybridGeocoder.ts` (add accuracy tracking hooks)

**What to Implement:**
- Create test dataset:
  - `testAddresses.ts` or `testAddresses.json` with at least 50 known-correct addresses for Netivot
  - Each entry: `{ address: string, expectedLat: number, expectedLon: number, source: "GIS" }`
  - Use real addresses from Netivot ArcGIS layer (or manually verified addresses)
- Create benchmark utility:
  - `accuracyBenchmark.ts` with function `runAccuracyBenchmark(): Promise<BenchmarkResults>`
  - For each test address:
    1. Call hybrid geocoder
    2. Calculate distance from expected coordinates
    3. Mark as correct if within 30m threshold
    4. Track which source provided the result
  - Calculate metrics:
    - Overall accuracy percentage
    - Accuracy by source (GIS, GovMap, Nominatim)
    - Average distance error
    - Success rate (addresses found vs. not found)
  - Return `BenchmarkResults` with all metrics
- Add accuracy tracking in hybrid geocoder:
  - Optional callback parameter for accuracy measurement
  - Log accuracy metrics when benchmark mode is enabled
- Create simple CLI script or UI button to run benchmark (for development/testing)

**Success Criteria:**
- Benchmark can measure geocoding accuracy against known-correct addresses
- Metrics are calculated and reported clearly
- Infrastructure is ready for continuous accuracy monitoring

---

### Task 10: Optimize Batch Processing Performance

**Files to Modify:**
- `src/services/geocoding.ts` (batch processing logic)
- `src/services/hybridGeocoder.ts` (ensure it's optimized for batch use)
- `src/App.tsx` (progress tracking and UI updates)

**What to Implement:**
- Optimize `batchGeocode()` function:
  - Increase default concurrency from 3 to 5 (test performance impact)
  - Implement request queuing to avoid overwhelming external APIs
  - Add rate limiting per API source (different limits for GovMap vs. Nominatim)
  - Implement intelligent caching: check cache before any API calls
  - Add progress callbacks with detailed information (current/total, cache hits, API calls)
- Optimize hybrid geocoder for batch processing:
  - Reuse HTTP connections where possible
  - Batch API calls when supported by external services
  - Implement request deduplication (same address requested multiple times in batch)
- Update UI progress indicators:
  - Show detailed progress: "Processing 45/100 (30 from cache, 15 API calls)"
  - Show estimated time remaining
  - Show which addresses are currently being processed
  - Allow cancellation of batch processing
- Add performance metrics:
  - Track average time per address
  - Track cache hit rate
  - Track API call counts per source
  - Display metrics in UI after batch completion

**Success Criteria:**
- Batch processing is faster and more efficient
- Users see detailed progress information
- System respects API rate limits
- Performance metrics are visible

---

### Task 11: Add Result Validation and Quality Checks

**Files to Create:**
- `src/utils/resultValidator.ts`

**Files to Modify:**
- `src/services/hybridGeocoder.ts` (add validation step)
- `src/App.tsx` (display validation warnings)

**What to Implement:**
- Create result validator:
  - `resultValidator.ts` with function `validateGeocodingResult(result: GeocodingResult, address: string, city: string): ValidationResult`
  - Validation checks:
    1. Coordinates are valid numbers (not NaN, within reasonable bounds for Israel)
    2. Coordinates are within city boundaries (use existing boundary validation)
    3. Street name matches (fuzzy matching between input and result)
    4. House number matches (if provided in input)
    5. Confidence score is reasonable for the result quality
  - Return `ValidationResult` with: `isValid: boolean`, `warnings: string[]`, `errors: string[]`
- Integrate validator into hybrid geocoder:
  - Run validation after selecting best result
  - Adjust confidence score based on validation results
  - Flag results with validation warnings for manual review
- Update UI to show validation warnings:
  - Display warning badges for addresses with validation issues
  - Show validation details in tooltip or expanded view
  - Allow users to manually override validation flags

**Success Criteria:**
- Results are validated before being returned to users
- Validation issues are clearly communicated
- System catches common geocoding errors automatically

---

### Task 12: Prepare MVP Build and Deployment Configuration

**Files to Create:**
- `.env.example` (environment variable template)
- `DEPLOYMENT.md` (deployment instructions)

**Files to Modify:**
- `package.json` (ensure build scripts are correct)
- `vite.config.ts` (optimize for production build)
- `README.md` (update with MVP setup instructions)

**What to Implement:**
- Create environment configuration:
  - `.env.example` with all required environment variables:
    - API endpoints (GovMap, Nominatim, future ArcGIS)
    - Feature flags (enable/disable GIS lookup, enable benchmark mode)
    - Logging level
    - Cache configuration
  - Document which variables are required vs. optional
- Optimize production build:
  - Ensure `vite.config.ts` is configured for production optimizations
  - Test that build produces working bundle
  - Verify that all assets are included correctly
  - Check bundle size and optimize if needed
- Create deployment documentation:
  - `DEPLOYMENT.md` with step-by-step instructions for:
    - Building the application
    - Setting environment variables
    - Deploying to static hosting (Netlify, Vercel, etc.)
    - Testing the deployed application
  - Include troubleshooting section for common deployment issues
- Update README:
  - Add "Quick Start" section for MVP
  - Document current limitations (single city, no auth, etc.)
  - Add "MVP Features" section listing what's included
  - Include setup instructions and prerequisites
- Create simple health check endpoint or page:
  - Verify that all services are accessible
  - Display version information
  - Show configuration status (which features are enabled)

**Success Criteria:**
- Application can be built and deployed easily
- Environment configuration is documented
- Deployment process is clear and repeatable
- MVP is ready for first customer demo

---

### Task 13: Create MVP Documentation and User Guide

**Files to Create:**
- `docs/MVP_USER_GUIDE.md`
- `docs/API_DOCUMENTATION.md` (for internal API, not public API yet)

**What to Implement:**
- Create user guide:
  - Step-by-step instructions for uploading Excel files
  - Explanation of status types and what they mean
  - How to interpret confidence scores
  - How to handle addresses that need review
  - Export instructions and result file format
  - Troubleshooting common issues
  - Screenshots or screen recordings of key workflows
- Create internal API documentation:
  - Document all service functions and their signatures
  - Explain the hybrid geocoding flow
  - Document configuration options
  - Include code examples for key operations
- Add inline code documentation:
  - Ensure all public functions have JSDoc comments
  - Document complex algorithms (normalization, ensemble logic, classification)
  - Add usage examples in comments where helpful

**Success Criteria:**
- Users can follow the guide to use the MVP successfully
- Developers can understand the codebase architecture
- Documentation is clear and comprehensive

---

### Task 14: Final MVP Testing and Quality Assurance

**Files to Create:**
- `tests/integration/geocoding.test.ts` (if test structure exists)
- `tests/data/sampleAddresses.xlsx` (test Excel file)

**What to Implement:**
- Create comprehensive test suite:
  - Unit tests for normalization service (at least 20 test cases)
  - Unit tests for hybrid geocoder (test all heuristics and edge cases)
  - Integration tests for full geocoding workflow (upload → process → export)
  - Test with real Excel files (various formats, edge cases)
- Test accuracy benchmark:
  - Run benchmark on test dataset
  - Verify accuracy is above 95% (target 99%, but 95% is acceptable for MVP)
  - Document any systematic errors found
- Test error handling:
  - Simulate network failures
  - Test with invalid Excel files
  - Test with addresses that will fail geocoding
  - Verify user-friendly error messages appear
- Performance testing:
  - Test with Excel files of various sizes (10, 100, 1000 addresses)
  - Measure processing time and memory usage
  - Verify system remains responsive during batch processing
- User acceptance testing:
  - Create test scenarios based on real use cases
  - Test with actual Netivot addresses (if available)
  - Verify all MVP features work end-to-end
  - Document any bugs or issues found

**Success Criteria:**
- All critical functionality is tested
- Accuracy benchmark shows >95% success rate
- System handles errors gracefully
- Performance is acceptable for MVP scale (up to 1000 addresses)
- MVP is ready for first customer

---

**Roadmap Execution Notes:**
- Tasks should be completed in order, as later tasks depend on earlier ones
- Each task is designed to be completable in 1-2 Cursor sessions
- After completing a task, test thoroughly before moving to the next
- Update feature status in the MVP section above as tasks are completed
- If a task reveals issues with earlier tasks, iterate and fix before proceeding

