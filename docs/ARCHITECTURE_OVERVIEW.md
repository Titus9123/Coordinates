# ARCHITECTURE_OVERVIEW – Coordinates System Architecture

This document provides a comprehensive overview of the Coordinates system architecture, including current implementation, main workflows, key components, and planned architectural changes for SaaS transformation.

## 1. Current System Overview

### Technology Stack

The Coordinates application is built as a modern single-page application (SPA) using:

- **Frontend Framework**: React 18.2 with TypeScript
- **Build Tool**: Vite 5.1.6 for fast development and optimized production builds
- **UI Components**: Custom React components with Tailwind CSS (implied by className usage)
- **Icons**: Lucide React for iconography
- **Excel Processing**: XLSX library (SheetJS) for reading and writing Excel files
- **HTTP Client**: Native Fetch API for external API calls
- **Language**: TypeScript for type safety

### Core Services

The application is organized into modular services:

1. **Geocoding Service** (`src/services/geocoding.ts`): Hybrid geocoding engine combining GovMap and Nominatim APIs
2. **Normalization Service** (`src/services/normalization.ts`): Hebrew/Arabic address normalization and parsing
3. **Excel Service** (`src/services/excel.ts`): Excel file reading and export functionality
4. **GovMap Service** (`src/services/govmapService.ts`): Integration with Israeli government mapping API

### Application Structure

```
Coordinates/
├── src/
│   ├── services/          # Core business logic services
│   ├── types.ts           # TypeScript type definitions
│   ├── constants.ts       # Configuration constants (API URLs, boundaries)
│   ├── App.tsx            # Main application component
│   └── index.tsx          # Application entry point
├── docs/                  # Documentation (this directory)
├── package.json           # Dependencies and scripts
└── vite.config.ts         # Vite configuration
```

## 2. Main Workflow

### Excel Upload → Processing → Classification → Export

The application follows this end-to-end workflow:

#### Step 1: Excel File Upload
- User selects an Excel file via file input
- File is read using XLSX library, parsing the first worksheet
- Rows are converted to JSON objects with original column names preserved
- Address columns are auto-detected using pattern matching (street, house number, city, neighborhood)

#### Step 2: Address Extraction and Normalization
- For each row, `getAddressFromRow()` extracts address components
- `normalizeAddress()` processes the raw address:
  - Removes neighborhood tokens (נווה נוי, נווה שרון, etc.)
  - Standardizes street name formats
  - Handles address variations and abbreviations
  - Detects intersections and points of interest
  - Validates address completeness (requires street + house number)
- Normalized addresses are stored in row data structure

#### Step 3: Batch Geocoding
- Unique addresses are collected and deduplicated using cache keys
- `batchGeocode()` processes addresses with configurable concurrency (default: 3 parallel workers)
- For each address:
  - Check cache for existing results
  - If not cached, call `geocodeNetivot()`:
    1. Try GovMap API first (official Israeli government source)
    2. Validate coordinates against Netivot boundaries
    3. If GovMap fails or coordinates outside bounds, fallback to Nominatim
    4. Nominatim query includes Netivot context and bounding box constraints
  - Cache successful results
  - Update progress and trigger UI refresh
- Rate limiting: 1-second delay between API calls to respect service limits

#### Step 4: Status Classification
- `classifyRowFromCache()` determines final status for each row:
  - **SKIPPED**: Missing required address information
  - **CONFIRMED**: Original coordinates validated as correct (within 30m of geocoded result or already inside Netivot)
  - **UPDATED**: New coordinates from geocoding service
  - **NOT_FOUND**: Address not found in any geocoding service
  - **NEEDS_REVIEW**: Full address provided but geocoding failed, requires manual review
  - **PENDING**: Awaiting geocoding (intermediate state)

#### Step 5: Result Export
- User clicks export button
- `exportExcel()` generates new Excel file:
  - Preserves all original columns
  - Updates latitude/longitude columns with final coordinates
  - Adds "message" column with status information
  - File named: `{original-name}-fixed.xlsx`

## 3. Key Components

### Geocoding Engine (`geocoding.ts`)

**Hybrid Geocoding Strategy**:
- Primary: GovMap (official Israeli government mapping service)
- Fallback: Nominatim (OpenStreetMap) with city-specific constraints

**Key Functions**:
- `geocodeNetivot()`: Main geocoding orchestrator
- `geocodeWithGovmap()`: GovMap API integration
- `geocodeWithNominatim()`: Nominatim API with Netivot bounding box
- `batchGeocode()`: Concurrent batch processing with caching
- `searchNetivotAddresses()`: Real-time address search for UI autocomplete

**Smart Features**:
- Intersection detection ("רחוב א / רחוב ב" → "רחוב א & רחוב ב")
- Point of interest recognition (קבר הבאבא סאלי, מרכז קליטה, etc.)
- Address normalization with Netivot context injection
- Coordinate validation against city boundaries

### Hybrid Geocoding Layer (Ensemble Engine)

The Coordinates platform implements a sophisticated hybrid/ensemble geocoding layer designed to achieve ~99% accuracy for Israeli addresses. This layer is the core technical differentiator of the platform.

**Architecture**:

The ensemble engine operates as a multi-source geocoding orchestrator that:

1. **Calls Multiple Geocoding Sources in Parallel**:
   - **Open-Source Geocoders**: Nominatim (OpenStreetMap), Pelias (planned), libpostal for address parsing (planned)
   - **Official Government Sources**: GovMap (Israeli government mapping service)
   - **Municipal GIS Layers**: ArcGIS layers from municipalities (Netivot as initial implementation)
   - **Internal Lookups**: Cached results and pre-validated address databases

2. **Normalizes and Compares Results**:
   - All results from different sources are normalized to a common format (WGS84 coordinates, standardized address components)
   - Street names and house numbers are extracted and compared across sources
   - Confidence scores are assigned based on source reliability and result consistency

3. **Applies Heuristics for Best Result Selection**:
   - **Bounding Box Validation**: Results must fall within the target city's geographic boundaries
   - **Street/Number Matching**: Cross-validates street names and house numbers across sources
   - **Confidence Scoring**: Assigns weights based on source authority (municipal ArcGIS > GovMap > Nominatim > other OSS)
   - **Distance Clustering**: When multiple sources agree within a small radius (e.g., 30 meters), confidence increases
   - **Address Component Matching**: Validates that normalized address components match across sources

4. **Israel-First Design with Expansion Path**:
   - The ensemble engine is initially optimized for Israeli address formats, Hebrew/Arabic text, and municipal boundaries
   - The architecture is designed to be extensible to other regions by adding region-specific geocoding sources and normalization rules
   - Municipal ArcGIS layers serve as the foundation for accuracy validation and can be replicated for other cities

**Ground Truth and Benchmarking**:

The municipal ArcGIS layer for Netivot (and future cities) serves multiple critical functions:

- **Ground Truth Dataset**: Provides authoritative, verified coordinates for addresses within the municipality
- **Training Data**: Used to train and refine the ensemble engine's heuristics and confidence scoring algorithms
- **Validation Benchmark**: Enables continuous accuracy measurement against known-correct coordinates
- **Error Detection**: Identifies discrepancies between open-source geocoders and official municipal data, allowing for systematic improvement

**Current Implementation**:

The current MVP implementation uses a simplified two-tier approach (GovMap → Nominatim) as the foundation for the full ensemble engine. As the platform evolves, additional open-source geocoders (Pelias, libpostal) and municipal ArcGIS layers will be integrated, with the ensemble logic becoming increasingly sophisticated to maintain and exceed the ~99% accuracy target.

### Normalization Engine (`normalization.ts`)

**Address Processing Pipeline**:
1. Extract address components from Excel row
2. Normalize whitespace and punctuation
3. Apply replacement dictionary for known variations
4. Strip street prefixes and neighborhood tokens
5. Handle address ranges (e.g., "9-11" → midpoint "10")
6. Remove apartment suffixes (e.g., "13/1" → "13")
7. Validate address completeness (street + number required)

**Key Functions**:
- `getAddressFromRow()`: Extract address from Excel row data
- `normalizeAddress()`: Comprehensive address normalization
- `extractStreetAndNumber()`: Parse street name and house number for UI display
- `stripNeighborhoodTokens()`: Remove known Netivot neighborhood names
- `stripStreetPrefixes()`: Remove redundant street name prefixes

### Excel Service (`excel.ts`)

**Functionality**:
- `readExcel()`: Parse Excel file to JSON array
- `exportExcel()`: Generate Excel file with updated coordinates and status messages

**Features**:
- Automatic column detection and mapping
- Preservation of original data structure
- Addition of computed columns (message, updated coordinates)

### Main Application (`App.tsx`)

**State Management**:
- Row data with status tracking
- Processing state and progress indicators
- File upload and export handlers
- Filtering and search functionality

**UI Components**:
- File upload interface
- Address search (street + number lookup)
- Data table with status badges
- Statistics dashboard (total, processed, success rate)
- Export button

## 4. Planned Architecture Changes for SaaS

### Authentication and Authorization

**Current State**: No authentication; single-user, client-side only

**Planned Changes**:
- Backend API server (Node.js/Express or Python/FastAPI)
- JWT-based authentication with refresh tokens
- User registration and login endpoints
- Password reset and email verification
- OAuth integration (Google, Microsoft) for enterprise customers

**Data Model**:
```
User {
  id, email, password_hash, subscription_tier, created_at, last_login
}

Session {
  user_id, token, expires_at
}
```

### Multi-Tenant Architecture

**Current State**: All data processed in browser memory; no persistence

**Planned Changes**:
- Database layer (PostgreSQL recommended for geospatial queries)
- Row-level security: all data scoped to user_id
- Project model: users can create multiple projects
- File storage: uploaded Excel files stored in cloud storage (S3, Azure Blob)
- Result persistence: geocoding results stored in database

**Data Model**:
```
Project {
  id, user_id, name, created_at, updated_at
}

ExcelFile {
  id, project_id, filename, upload_date, row_count, status
}

GeocodingResult {
  id, excel_file_id, row_index, original_address, normalized_address,
  coordinates, status, message, geocoded_at
}
```

### API Separation

**Current State**: Monolithic React app with direct API calls to external services

**Planned Changes**:
- RESTful API backend separating business logic from frontend
- API endpoints:
  - `/api/auth/*` - Authentication
  - `/api/projects/*` - Project management
  - `/api/files/*` - File upload and management
  - `/api/geocode/*` - Geocoding operations
  - `/api/usage/*` - Usage tracking and billing
- Frontend becomes API client using fetch/axios
- API rate limiting and request validation
- Webhook support for async operations

**API Structure**:
```
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/refresh

GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
DELETE /api/projects/:id

POST   /api/files/upload
GET    /api/files/:id
GET    /api/files/:id/results

POST   /api/geocode/batch
GET    /api/geocode/status/:job_id

GET    /api/usage/current
GET    /api/usage/history
```

### Scalability Considerations

**Current Limitations**:
- Processing happens in browser (limited by device resources)
- No background job processing
- No horizontal scaling capability

**Planned Improvements**:
- Background job queue (Redis + Bull/BullMQ or AWS SQS)
- Worker processes for batch geocoding
- Caching layer (Redis) for geocoding results
- CDN for static assets
- Database connection pooling
- Load balancing for API servers

### Monitoring and Observability

**Planned Additions**:
- Application logging (Winston, Pino)
- Error tracking (Sentry)
- Performance monitoring (New Relic, Datadog)
- Usage analytics dashboard
- API metrics and alerting

### Security Enhancements

**Planned Features**:
- Input validation and sanitization
- SQL injection prevention (parameterized queries)
- XSS protection
- CORS configuration
- Rate limiting per user/IP
- API key rotation
- Audit logging for sensitive operations
- Data encryption at rest and in transit (TLS)

---

## Architecture Evolution Roadmap

1. **Phase 1 (MVP → SaaS)**: Add backend API, authentication, basic multi-tenancy
2. **Phase 2 (SaaS Foundation)**: Implement job queue, worker processes, database optimization
3. **Phase 3 (Scale)**: Add caching, CDN, load balancing, monitoring
4. **Phase 4 (Enterprise)**: Advanced security, compliance features, API marketplace

