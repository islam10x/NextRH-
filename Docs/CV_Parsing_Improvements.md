# CV Parsing & AI Service Improvements
**Date:** February 2026

This document summarizes the major features, bug fixes, and system improvements implemented to stabilize the CV Parsing logic, enhance the Certification OCR, and integrate verified data into the RAG pipeline.

---

## 1. RAG Integration for Verified Certifications
To prioritize human-verified data over AI-parsed CV data, the RAG (Retrieval-Augmented Generation) pipeline was updated to distinguish explicitly uploaded certifications.

*   **Database Schema Update:** Introduced an `is_uploaded` boolean flag (defaulting to `false`) to the `certifications` table to track the origin of the data.
*   **Security & Validation:** When a user uploads a certification image, the AI Service now receives the user's `first_name` and `last_name`. It performs fuzzy name matching against the extracted text to ensure the certificate belongs to the uploading user before accepting it.
*   **Credential ID Extraction:** The OCR engine was upgraded to extract the `credential_id` from certificates for robust deduplication in the database.
*   **RAG Ingestion Tagging:** The `etl_ingest.py` script was updated to fetch the `is_uploaded` flag. Chunks generated from verified, user-uploaded certificates are explicitly tagged with `[Verified via direct upload]` in the natural language payload to ensure the LLM prioritizes them during retrieval.

## 2. Robust CV Parsing Logic (`TemplateCVParser`)
The deterministic CV parsing logic (`app/parsers/template_parser.py`) was entirely overhauled to handle destructive table layouts and misaligned visual layers that caused merged/corrupted JSON arrays.

*   **Education Parsing & Project Shielding:**
    *   *The Bug:* Certain CVs (e.g., `cv_ak_abidi.pdf`) rendered text layers entirely out of reading order (e.g., printing the degree before the date despite them sitting side-by-side). Additionally, some CVs (like Aya's) used identical table columns ("Année", "Client", "Projet") for both Education and Projects, causing them to merge in the JSON output.
    *   *The Fix:* Integrated PyMuPDF's spatial `find_tables()` engine to graphically infer table bounds instead of relying on the corrupted text stream. Added explicit exclusionary header checks (`projet`, `project`, `client`) to forcefully prevent Project tables from being scooped into the Education array.
*   **Experience Extraction:**
    *   *The Bug:* The parser was ignoring experience blocks if the date was a standalone year (`2023`) or a raw numeric format (`10/2023`). It also scrambled layout spacing while separating the company name from the job title.
    *   *The Fix:* Expanded the `_extract_date_from_line` regex engine to broadly accept `MM/YYYY`, standalone `YYYY`, and malformed UTF-8 characters for the word "présent". Fixed the stripping logic to preserve column spacing.
*   **Certification Un-Mashing:**
    *   Upgraded the internal date extraction tools to recognize standalone years so it can accurately bifurcate contiguous strings like `Endpoint_Security (CISCO) 2023` into their correct `name` and `date_obtained` keys without relying on Gemini fallbacks.

## 3. OCR Engine Resilience (`CertificationOCR`)
The OCR pipeline was fortified to prevent hallucinated data and failed extractions on varying document types.

*   **Hybrid PDF Text Extraction:** Digitally born PDFs (like Cisco certificates) often resulted in truncated or hallucinated text when forced through Tesseract OCR. The parser now uses a "hybrid approach": it first attempts to extract the native text layer directly via `PyMuPDF`. If the text layer is rich enough, it bypasses the image-based OCR entirely, resulting in 100% accurate reads for digital PDFs.
*   **Automatic Image Rotation Correction:** Scanned physical certificates were failing when users uploaded them sideways or upside down. The system now utilizes Tesseract's `image_to_osd()` function to dynamically detect text orientation skew and uses OpenCV to mathematically rotate the image back to 0 degrees before processing.
*   **Regex Tuning:** Relaxed overly aggressive regex boundary rules that were arbitrarily clipping the ends off of lengthy Cisco and Dell certification titles.

## 4. Stability Improvements
*   **Windows `uvicorn` Hot-Reloading Freeze:** Identified and bypassed a critical Windows multiprocessing bug where `uvicorn --reload` would permanently freeze the AI Service background workers. The service start script (`run_local.bat`) was updated to invoke the python file directly.
