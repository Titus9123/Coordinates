# BUGS_LOG – Error Tracking Log

This document tracks bugs, errors, and issues discovered in the Coordinates platform. Each entry includes a description, reproduction steps, severity assessment, and current status.

## Purpose

The Bugs Log serves as a centralized record of all known issues in the system, enabling systematic tracking, prioritization, and resolution. It helps maintain product quality and provides transparency for stakeholders about current system limitations.

---

## Bug Entries

| ID | Description | Steps to Reproduce | Severity | Status |
|---|---|---|---|---|
| BUG-001 | Address Misclassification for Intersection Queries | 1. Upload Excel file with intersection address format (e.g., "רחוב הרצל / רחוב ויצמן")<br>2. Process the file through geocoding<br>3. Observe that some intersection addresses are classified as NOT_FOUND even when valid coordinates exist in Nominatim<br><br>**Root Cause**: The intersection detection regex may not handle all Hebrew intersection formats, and the query normalization might strip critical intersection markers before geocoding. | Medium | 🔄 Open |
| BUG-002 | External API Failure Handling Causes Silent Failures | 1. Simulate GovMap API timeout or 500 error (or disconnect network during processing)<br>2. Upload Excel file with addresses<br>3. Start batch processing<br>4. Observe that some rows remain in PENDING status without clear error indication<br><br>**Root Cause**: Error handling in `geocodeWithGovmap` and `geocodeWithNominatim` returns `null` on failure, but the batch processing logic doesn't distinguish between "not found" and "API error", leading to ambiguous status classification. | High | 🔄 Open |
| BUG-003 | Excel Parsing Errors with Non-Standard Column Headers | 1. Upload Excel file where address column is named in Arabic script or contains special characters<br>2. System attempts to auto-detect columns using pattern matching<br>3. Some rows fail to extract addresses correctly, resulting in SKIPPED status even when address data exists in alternative columns<br><br>**Root Cause**: The `getAddressFromRow` function in `normalization.ts` uses case-insensitive regex patterns that may not match all column name variations, especially for Arabic text or unconventional naming conventions. | Medium | 🔄 Open |

---

## Severity Guidelines

- **Critical**: System crash, data loss, security vulnerability, or complete feature failure
- **High**: Major functionality broken, significant user impact, workaround available but difficult
- **Medium**: Partial functionality affected, moderate user impact, workaround available
- **Low**: Minor UI issues, edge cases, cosmetic problems, minimal user impact

## Status Guidelines

- **Open**: Bug is identified and logged, awaiting investigation or fix
- **In Progress**: Bug is being actively worked on
- **Resolved**: Bug fix is complete and verified
- **Won't Fix**: Bug is acknowledged but will not be addressed (with justification)
- **Duplicate**: Bug is a duplicate of another entry

---

## Notes

- Bugs should be logged immediately upon discovery
- Include as much context as possible in the "Steps to Reproduce" section
- Update status when bug resolution progresses
- Link related bugs in the description if applicable
- For resolved bugs, add resolution notes and verification steps

