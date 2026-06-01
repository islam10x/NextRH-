"""
OCR-based Certification Parser using Tesseract (with EasyOCR and LLM extraction)
Extracts certification name, issuer, expiration date, and credential ID from images
"""
import pytesseract
import cv2
import numpy as np
from PIL import Image
import re
from datetime import datetime
from typing import Optional, Dict, Any, Tuple
import logging
import fitz  # PyMuPDF for PDF support
import time

import os
import easyocr
from app.config import settings
from app.utils.llm import parse_json_object
from langchain_groq import ChatGroq

logger = logging.getLogger(__name__)

MAX_IMG_SIDE = 1600  # px

class CertificationOCR:
    """OCR service for parsing certification documents"""
    
    def __init__(self):
        # Common certification issuers for better recognition
        self.known_issuers = [
            'Microsoft', 'AWS', 'Amazon Web Services', 'Google', 'Oracle',
            'Cisco', 'CompTIA', 'PMI', 'ISACA', 'ISC2', 'EC-Council',
            'Red Hat', 'VMware', 'Salesforce', 'Adobe', 'IBM', 'SAP',
            'Barracuda', 'BarracudaCampus', 'Fortinet', 'Palo Alto', 'Check Point',
            'Rapid7', 'Nexpose', 'Qualys', 'Tenable', 'Splunk','Sophos','NVIDIA','Coursera',
            'SolarWinds',
            "Microsoft","Amazon Web Services","AWS","Google Cloud","Google","Oracle","IBM",
            "SAP","Salesforce","Cisco","Juniper Networks","Huawei","Nokia","Ericsson",
            "F5 Networks","VMware","Red Hat","HashiCorp","Nutanix","Docker","Kubernetes",
            "Cloud Native Computing Foundation","CNCF","CompTIA","Linux Professional Institute",
            "LPI","The Linux Foundation","Python Institute","ISC2","ISC^2","ISACA","GIAC","SANS",
            "EC-Council","CertNexus","PMI","Project Management Institute","AXELOS","PeopleCert",
            "ITIL","Scrum.org","Scrum Alliance","IIBA","Adobe","Apple","Meta","Intel",
            "Dell Technologies","Hewlett Packard Enterprise","HPE","HP","NetApp","Lenovo",
            "Citrix","Atlassian","ServiceNow","Palo Alto Networks","Fortinet","Check Point",
            "CyberArk","CrowdStrike","Trend Micro","Symantec","Broadcom","McAfee","Okta",
            "Databricks","Snowflake","Tableau","SAS","Cloudera","MongoDB","Elastic","UiPath",
            "Automation Anywhere","Blue Prism","Esri","Unity","Autodesk","Siemens","PTC",
            "The Open Group","TOGAF","Object Management Group","OMG","ISTQB","EXIN",
            "Blockchain Council","Kryterion","Pearson VUE","Global Knowledge","Learning Tree",
            "edX","Coursera","Udacity","Google Developers","Android","Meta Blueprint","HubSpot",
            "Shopify","Zendesk","Twilio","Kaggle","DeepLearning.AI",'DELL'
        ]
        
        # Choose OCR engine from settings (default is tesseract)
        engine = (settings.OCR_ENGINE or "tesseract").strip().lower()
        if engine not in ("tesseract", "easyocr", "both"):
            logger.warning(f"Unknown OCR_ENGINE '{settings.OCR_ENGINE}', falling back to tesseract.")
            engine = "tesseract"

        self.use_easyocr = engine in ("easyocr", "both")
        self.reader = None
        
        if self.use_easyocr:
            # Initialize EasyOCR reader
            logger.info("Initializing EasyOCR reader...")
            try:
                 # Initialize for English and French (common in CVs)
                 try:
                     import torch
                     gpu_available = torch.cuda.is_available()
                 except Exception:
                     gpu_available = False

                 self.reader = easyocr.Reader(['en', 'fr'], gpu=gpu_available)
                 logger.info(f"EasyOCR engine ready (gpu={gpu_available}).")
            except Exception as e:
                 logger.error(f"Failed to initialize EasyOCR: {e}")
                 self.reader = None
                 self.use_easyocr = False
                 self._check_tesseract()
        else:
            # Check Tesseract
            self._check_tesseract()

    def parse_certification(
        self, 
        file_path: str, 
        filename: str, 
        user_first_name: Optional[str] = None, 
        user_last_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Parse certification document and extract structured data
        
        Args:
            file_path: Path to the certification file
            filename: Original filename
            
        Returns:
            Dictionary with certification details
        """
        try:
            # Extract text with Tesseract first
            is_pdf = filename.lower().endswith('.pdf')
            embedded_text_len = 0
            if is_pdf:
                text, embedded_text_len = self._extract_text_from_pdf(file_path, use_easyocr=False)
            else:
                text = self._extract_text_from_image_with_fallbacks(file_path, use_easyocr=False)
            
            logger.info(f"Extracted text length (tesseract): {len(text)} characters")
            
            # Parse the extracted text using rules
            cleaned_text = self._clean_ocr_noise(text)
            cert_data = self._parse_text(cleaned_text)
            issue_date = self._extract_issue_date_basic(cleaned_text)

            # Decide if EasyOCR should run (based on file type + missing info)
            if self._should_run_easyocr(is_pdf, embedded_text_len, cert_data, issue_date, len(text)):
                if self.use_easyocr and self.reader:
                    logger.info("Running EasyOCR due to missing info after Tesseract.")
                    if is_pdf:
                        text, _ = self._extract_text_from_pdf(file_path, use_easyocr=True)
                    else:
                        text = self._extract_text_from_image_with_fallbacks(file_path, use_easyocr=True)
                    logger.info(f"Extracted text length with EasyOCR: {len(text)} characters")
                    cleaned_text = self._clean_ocr_noise(text)
                    cert_data = self._parse_text(cleaned_text)
                    issue_date = self._extract_issue_date_basic(cleaned_text)
                else:
                    logger.info("EasyOCR requested but not available; skipping.")

            # If embedded text exists in PDFs, prefer its extracted name to avoid OCR misspellings.
            embedded_text = self._extract_embedded_text(text)
            if embedded_text:
                embedded_name = self._select_embedded_cert_name(
                    embedded_text,
                    user_first_name=user_first_name,
                    user_last_name=user_last_name,
                    issuer_hint=cert_data.get('issuer'),
                    current_name=cert_data.get('name'),
                )
                if embedded_name:
                    cert_data['name'] = embedded_name

            # Run LLM extraction only when rule-based parsing looks incomplete.
            llm_data = {}
            needs_fallback = self._needs_more_info(cert_data, issue_date, len(cleaned_text))
            if cleaned_text and needs_fallback:
                if self._is_likely_certificate(cleaned_text):
                    logger.info("Rule-based parsing incomplete. Falling back to LLM extraction.")
                    llm_start = time.perf_counter()
                    llm_data = self._llm_fallback_extraction(cleaned_text)
                    llm_elapsed = time.perf_counter() - llm_start
                    logger.info(f"LLM extraction completed in {llm_elapsed:.2f}s")
                else:
                    logger.info("Document failed certificate gatekeeper check. Skipping LLM fallback.")
            elif not cleaned_text:
                logger.info("No OCR text extracted; skipping LLM extraction.")
            else:
                logger.info("Rule-based parsing looks sufficient. Skipping LLM fallback.")

            # Merge LLM results (LLM takes precedence when it provides a value)
            if llm_data:
                # Trust the LLM for the name if it provided one, as it's better at understanding context than regex
                llm_name = llm_data.get('name')
                if llm_name and llm_name.lower() not in ["null", "none", "", "unknown"]:
                    current_name = cert_data.get('name') or ""
                    current_norm = re.sub(r"[^a-z0-9]+", " ", current_name.lower()).strip()
                    llm_norm = re.sub(r"[^a-z0-9]+", " ", str(llm_name).lower()).strip()
                    llm_is_more_specific = (
                        current_norm
                        and current_norm in llm_norm
                        and len(llm_norm) > len(current_norm) + 8
                    )
                    if (
                        current_name in [None, "", "Unknown Certification"]
                        or self._is_low_confidence_cert_name(current_name, cert_data.get('issuer'))
                        or llm_is_more_specific
                    ):
                        if not self._is_generic_cert_name(llm_name):
                            cert_data['name'] = llm_name
                    
                llm_issuer = llm_data.get('issuer')
                if llm_issuer and not cert_data['issuer']:
                    cert_data['issuer'] = llm_issuer
                    
                llm_expiry = llm_data.get('expiration_date')
                if llm_expiry:
                    cert_data['expiration'] = llm_expiry
                    
                llm_cred_id = llm_data.get('credential_id')
                if llm_cred_id:
                    cert_data['credential_id'] = llm_cred_id
            
            if user_first_name and user_last_name:
                is_verified = self._verify_user_name(cleaned_text, user_first_name, user_last_name)
                if not is_verified:
                    logger.warning(
                        f"Name verification failed for {user_first_name} {user_last_name} (blocking upload)"
                    )
                    return {
                        'success': False,
                        'error': 'The uploaded certificate does not appear to belong to your name. Please upload a certificate that matches your profile name.',
                        'certification_name': 'Unknown Certification',
                        'issuer': None,
                        'expiration_date': None,
                        'issue_date': None,
                        'credential_id': None,
                    }

            return {
                'success': True,
                'certification_name': cert_data['name'],
                'issuer': cert_data['issuer'],
                'expiration_date': cert_data['expiration'],
                'issue_date': issue_date,
                'credential_id': cert_data.get('credential_id'),
                'raw_text': cleaned_text[:1000]  # First 1000 chars for debugging
            }
            
        except Exception as e:
            logger.error(f"Error parsing certification: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'certification_name': 'Unknown Certification',
                'issuer': None,
                'expiration_date': None
            }
            
    def _is_likely_certificate(self, text: str) -> bool:
        """Heuristic to identify certificate-like text (informational only)."""
        if not text or len(text) < 20:
            return False
            
        text_lower = text.lower()
        
        # Must contain at least one strong keyword
        strong_keywords = [
            "certif", "diplôm", "diplom", "attestation", "achievement", 
            "completion", "issued", "license", "credential"
        ]
        
        has_strong_keyword = any(kw in text_lower for kw in strong_keywords)
        
        # Or must contain a known tech issuer
        has_known_issuer = any(issuer.lower() in text_lower for issuer in self.known_issuers)
        
        return has_strong_keyword or has_known_issuer

    def _llm_fallback_extraction(self, text: str) -> Dict[str, Any]:
        """Use local LLM to extract fields from messy certificate text."""
        # Security: Truncate text to prevent massive context window processing
        truncated_text = text[:3000]
        
        prompt = f"""
You are an expert OCR document parser. Extract the certification details from the following raw text.
Focus on identifying the actual name of the credential or course, skipping generic preambles like "certifies that...".
Return ONLY a valid JSON object with EXACTLY these three keys:
- "name": The exact name of the certification, course, or diploma. (e.g. "Compellent Storage Architect Technical")
- "issuer": The organization that issued it. (e.g. "DELL", "Amazon Web Services"). If unknown, use null.
- "expiration_date": The expiration date in YYYY-MM-DD format. If an issue date is present anywhere in the document (e.g. Jun 30, 2011) and the text mentions a separate validity period (e.g. "Valid for one year"), you MUST mathematically add the duration to the issue date and output the calculated expiration date (e.g. 2012-06-30). If it does not expire or is unknown, use null.
- "credential_id": The credential ID, validation number, or certificate ID. If unknown, use null.

Do NOT include markdown formatting, backticks, or any other text. Just the JSON object.

RAW TEXT:
{truncated_text}
"""
        try:
            # We configure a timeout so a bad prompt doesn't hang the worker
            model_name = settings.GROQ_CV_MODEL
            llm = ChatGroq(
                model=model_name,
                api_key=settings.GROQ_API_KEY,
                temperature=0.0,
            )

            invoke_start = time.perf_counter()
            response = llm.invoke(prompt)
            invoke_elapsed = time.perf_counter() - invoke_start
            logger.info(f"LLM invoke completed in {invoke_elapsed:.2f}s (model={model_name})")
            content = str(getattr(response, "content", "") or "").strip()
            
            data = parse_json_object(content)
            if data and isinstance(data, dict):
                return data
                
            return {}
            
        except Exception as e:
            logger.error(f"LLM Fallback extraction failed: {str(e)}")
            return {}
    
    def _check_tesseract(self):
        """Check if Tesseract is installed and reachable"""
        try:
            pytesseract.get_tesseract_version()
        except pytesseract.TesseractNotFoundError:
            # Try common Windows paths
            possible_paths = [
                r"C:\Program Files\Tesseract-OCR\tesseract.exe",
                r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
                r"C:\Users\islam\AppData\Local\Tesseract-OCR\tesseract.exe"
            ]
            
            found = False
            for path in possible_paths:
                if os.path.exists(path):
                    pytesseract.pytesseract.tesseract_cmd = path
                    logger.info(f"Top-loading Tesseract from: {path}")
                    found = True
                    break
            
            if not found:
                logger.error("Tesseract not found. Please install Tesseract-OCR or switch to EasyOCR.")

    def _extract_text_from_image(self, file_path: str) -> str:
        """Extract text from image using Tesseract"""
        try:
            # Use PIL to read image (handles unicode paths correctly on Windows)
            with Image.open(file_path) as pil_img:
                # Convert to numpy array
                img = np.array(pil_img)
                img = self._downscale_image(img)

            # Tesseract path
            # Convert RGB to BGR for OpenCV if needed
            if len(img.shape) == 3:
                img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
                
            # Check orientation and fix rotation
            try:
                self._check_tesseract()
                osd = pytesseract.image_to_osd(img)
                match = re.search(r'Rotate: (\d+)', osd)
                if match:
                    angle = int(match.group(1))
                    if angle == 90:
                        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
                    elif angle == 180:
                        img = cv2.rotate(img, cv2.ROTATE_180)
                    elif angle == 270:
                        img = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
                    if angle != 0:
                        logger.info(f"Rotated image by {angle} degrees.")
            except Exception as e:
                logger.debug(f"OSD rotation detection skipped or failed: {str(e)}")
                
            # Convert to grayscale
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            
            # Apply thresholding
            gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]

            # Upscale to improve OCR on small text
            gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)

            # Invert if background is darker than text (common with white text on dark banner)
            if np.mean(gray) < 128:
                gray = cv2.bitwise_not(gray)

            # Perform OCR
            self._check_tesseract()
            text = pytesseract.image_to_string(gray, config="--oem 3 --psm 6")
            return text

        except Exception as e:
            logger.error(f"Error extracting text from image {file_path}: {e}")
            raise

    def _extract_text_from_image_with_fallbacks(self, file_path: str, use_easyocr: Optional[bool] = None) -> str:
        """
        More resilient image extraction:
        - Run Tesseract psm6
        - Run Tesseract psm4 (sparse text)
        - Run EasyOCR (if enabled)
        """
        texts = []

        if use_easyocr is None:
            use_easyocr = self.use_easyocr

        # Tesseract psm6
        try:
            t6 = self._extract_text_from_image(file_path)
            texts.append(t6)
        except Exception as e:
            logger.warning(f"Tesseract psm6 failed on {file_path}: {e}")

        # Tesseract psm4 (sparse text)
        try:
            with Image.open(file_path) as pil_img:
                img = np.array(pil_img)
            if len(img.shape) == 3:
                img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
            gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
            self._check_tesseract()
            t4 = pytesseract.image_to_string(gray, config="--oem 3 --psm 4")
            texts.append(t4)
        except Exception as e:
            logger.debug(f"Tesseract psm4 fallback failed on {file_path}: {e}")

        # EasyOCR (optional)
        if use_easyocr and self.reader:
            try:
                with Image.open(file_path) as pil_img:
                    img = np.array(pil_img)
                    img = self._downscale_image(img)
                logger.info(f"Using EasyOCR for image: {file_path}")
                result = self.reader.readtext(img, detail=0, paragraph=True)
                if result:
                    easyocr_text = " ".join(result).strip()
                    if easyocr_text:
                        texts.append(easyocr_text)
            except Exception as e:
                logger.warning(f"EasyOCR failed on {file_path}: {e}")

        # Combine all candidates (best effort)
        cleaned_texts = [t for t in texts if t and t.strip()]
        combined = "\n\n--- OCR CANDIDATE ---\n\n".join(cleaned_texts) if len(cleaned_texts) > 1 else (cleaned_texts[0] if cleaned_texts else "")
        logger.info(f"OCR candidates lengths: {list(map(len,cleaned_texts))} -> combined {len(combined)} chars")
        return combined

    def _downscale_image(self, img: np.ndarray) -> np.ndarray:
        """Limit max side to reduce OCR time while preserving aspect ratio."""
        if img is None:
            return img
        h, w = img.shape[:2]
        max_side = max(h, w)
        if max_side <= MAX_IMG_SIDE:
            return img
        scale = MAX_IMG_SIDE / max_side
        new_w = int(w * scale)
        new_h = int(h * scale)
        return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

    def _extract_text_from_pdf(self, file_path: str, use_easyocr: Optional[bool] = None) -> Tuple[str, int]:
        """Extract text from PDF using hybrid approach (embedded text + OCR)"""
        text = ""
        embedded_text_len_total = 0

        if use_easyocr is None:
            use_easyocr = self.use_easyocr
        
        try:
            doc = fitz.open(file_path)
            
            for page_num, page in enumerate(doc):
                # Always extract embedded text first
                embedded_text = page.get_text("text", sort=True)
                embedded_text_len_total += len(embedded_text.strip())
                
                # Also perform OCR to catch image-based content
                logger.info(f"Using hybrid extraction for page {page_num}...")
                # Increase DPI for better OCR quality
                pix = page.get_pixmap(dpi=320)  # balance quality vs speed
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                img_array = np.array(img)
                
                # Check orientation and fix rotation
                try:
                    self._check_tesseract()
                    osd = pytesseract.image_to_osd(img_array)
                    match = re.search(r'Rotate: (\d+)', osd)
                    if match:
                        angle = int(match.group(1))
                        if angle == 90:
                            img_array = cv2.rotate(img_array, cv2.ROTATE_90_CLOCKWISE)
                        elif angle == 180:
                            img_array = cv2.rotate(img_array, cv2.ROTATE_180)
                        elif angle == 270:
                            img_array = cv2.rotate(img_array, cv2.ROTATE_90_COUNTERCLOCKWISE)
                        if angle != 0:
                            logger.info(f"Rotated image by {angle} degrees.")
                except Exception as e:
                    logger.debug(f"OSD rotation detection skipped or failed: {str(e)}")
                
                # Improved preprocessing for better OCR
                gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
                
                # Try multiple preprocessing approaches and combine results
                # Approach 1: Light denoising with adaptive threshold
                denoised_light = cv2.fastNlMeansDenoising(gray, None, h=5, templateWindowSize=7, searchWindowSize=21)
                thresh1 = cv2.adaptiveThreshold(denoised_light, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
                                               cv2.THRESH_BINARY, 11, 2)
                
                # Approach 2: Otsu's thresholding (better for high-contrast documents)
                _, thresh2 = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                
                # Perform OCR on both preprocessed versions (Tesseract primary)
                self._check_tesseract()
                # Use different PSM modes for better coverage
                config1 = '--psm 3 --oem 3'  # Auto page segmentation
                config2 = '--psm 6 --oem 3'  # Assume uniform block of text
                
                text1 = pytesseract.image_to_string(thresh1, config=config1, lang='fra+eng')
                text2 = pytesseract.image_to_string(thresh2, config=config2, lang='fra+eng')
                ocr_text = text1 + "\n--- Alternative OCR ---\n" + text2

                # EasyOCR (always run when enabled)
                if use_easyocr and self.reader:
                    try:
                        result1 = self.reader.readtext(thresh1, detail=0)
                        result2 = self.reader.readtext(thresh2, detail=0)
                        easy_text = "\n".join(result1) + "\n--- Alternative OCR ---\n" + "\n".join(result2)
                        if easy_text.strip():
                            ocr_text = (
                                "TESSERACT OCR:\n" + ocr_text +
                                "\n\nEASYOCR OCR:\n" + easy_text
                            )
                    except Exception as e:
                        logger.warning(f"EasyOCR PDF OCR failed on page {page_num}: {e}")
                
                # Combine both sources intelligently
                if len(embedded_text.strip()) > 500:
                    # Use embedded text as primary, OCR as supplement
                    combined = embedded_text + "\n\n--- OCR Supplement ---\n" + ocr_text
                else:
                    # Embedded text is minimal, prefer OCR
                    combined = ocr_text + "\n\n--- Embedded Text ---\n" + embedded_text
                
                text += combined + "\n"
            
            doc.close()
            
        except Exception as e:
            logger.error(f"Error extracting text from PDF: {str(e)}")
            raise
        
        return text, embedded_text_len_total
    
    def _clean_ocr_noise(self, text: str) -> str:
        """Remove common OCR noise and artifacts"""
        # Remove lines that are mostly symbols/garbage
        lines = text.split('\n')
        clean_lines = []
        
        for line in lines:
            line = line.strip()
            if not line:
                continue
            
            # Calculate ratio of alphanumeric chars to total
            alphanum_count = sum(c.isalnum() or c.isspace() for c in line)
            total_chars = len(line)
            
            if total_chars == 0:
                continue
                
            # Keep lines that are at least 50% alphanumeric
            ratio = alphanum_count / total_chars
            if ratio >= 0.5 and total_chars > 3:
                # Remove excessive spaces
                line = re.sub(r'\s+', ' ', line)
                clean_lines.append(line)
        
        return '\n'.join(clean_lines)

    def _clean_text(self, value: str) -> str:
        """Normalize a single line for lightweight comparisons."""
        if not value:
            return ""
        value = value.replace("\xa0", " ")
        value = re.sub(r"\s+", " ", value).strip()
        value = re.sub(r"^[\-\u2013\u2014,:;|\"']+", "", value).strip()
        value = re.sub(r"[\-\u2013\u2014,:;|\"']+$", "", value).strip()
        return value

    def _should_run_easyocr(
        self,
        is_pdf: bool,
        embedded_text_len: int,
        cert_data: Dict[str, Optional[str]],
        issue_date: Optional[str],
        text_len: int
    ) -> bool:
        if not self.use_easyocr or not self.reader:
            return False

        if not self._needs_more_info(cert_data, issue_date, text_len):
            return False

        if not is_pdf:
            return True

        # For PDFs, only run EasyOCR when embedded text is sparse (image-based PDF)
        if embedded_text_len >= 200:
            logger.info("Skipping EasyOCR for PDF because embedded text looks sufficient.")
            return False
        return True

    def _needs_more_info(
        self,
        cert_data: Dict[str, Optional[str]],
        issue_date: Optional[str],
        text_len: int
    ) -> bool:
        """Heuristic to decide if EasyOCR should run after Tesseract."""
        name = cert_data.get('name') or ""
        is_unknown = name == "Unknown Certification"
        name_lower = name.lower()
        generic_exact = [
            "certificate of completion",
            "certificate of achievement",
            "certification",
            "certificate",
            "diploma",
            "diplôme",
            "attestation",
        ]
        generic_starts = [
            "id certified through",
            "valid through",
            "certificate number",
            "license number",
            "credential id",
            "date ",
            "issue date",
            "expiration date",
        ]
        is_generic = name_lower in generic_exact or any(name_lower.startswith(prefix) for prefix in generic_starts)

        issuer = cert_data.get('issuer') or ""
        issuer_in_name = bool(issuer) and (issuer.lower() in name_lower or name_lower in issuer.lower())
        is_suspicious_name = (
            len(name) > 80
            or len(name) < 5
            or issuer_in_name
            or self._is_low_confidence_cert_name(name, issuer)
        )

        missing_issuer = not issuer
        missing_issue_date = not issue_date

        return (
            is_unknown
            or is_generic
            or is_suspicious_name
            or (missing_issuer and text_len > 50)
            or missing_issue_date
        )
    
    def _parse_text(self, cleaned_text: str) -> Dict[str, Optional[str]]:
        """Parse certification details from extracted text"""
        
        # Extract certification name
        cert_name = self._extract_certification_name(cleaned_text)
        
        # Extract issuer
        issuer = self._extract_issuer(cleaned_text)
        
        # Extract expiration date
        expiration = self._extract_expiration_date(cleaned_text)

        # Extract credential ID
        credential_id = self._extract_credential_id(cleaned_text)
        
        return {
            'name': cert_name,
            'issuer': issuer,
            'expiration': expiration,
            'credential_id': credential_id
        }
    
    def _extract_certification_name(self, text: str) -> str:
        """Extract certification name from text"""
        def _is_legal_preamble(line_lower: str) -> bool:
            if not line_lower:
                return False
            if line_lower.startswith(("vu le", "vu la", "vu l'", "vu les", "vu ")):
                return True
            return any(token in line_lower for token in ["décret", "decret", "loi n", "loi n°", "fixant", "portant", "relative"])

        def _clean_candidate(value: str) -> str:
            value = self._clean_text(value)
            value = re.sub(r"\s+\bto\b$", "", value, flags=re.IGNORECASE).strip()
            value = re.sub(r"\s+", " ", value)
            return re.sub(r"[,.]$", "", value).strip()

        def _looks_like_person_name(line: str) -> bool:
            words = [w for w in re.split(r"\s+", line.strip()) if w]
            if not 2 <= len(words) <= 3:
                return False
            if any(re.search(r"\d|cert|course|credential|professional|engineer|speciali|cloud|storage|security|iso", w, re.IGNORECASE) for w in words):
                return False
            titled = sum(1 for w in words if w[:1].isupper() or w.isupper())
            return titled == len(words)

        signal_words = [
            "academic", "administrator", "architect", "auditor", "automation", "blade",
            "certified", "cloud", "course", "credential", "engineer", "foundation",
            "implementer", "iso/iec", "management", "professional", "security",
            "server", "solutions", "specialist", "specialization", "storage",
            "technical", "vsan", "vsphere", "access", "omniswitch", "lan",
        ]
        stop_words = [
            "---", "accredits that", "alternative ocr", "candidate id", "certificate id", "certification date",
            "course completion date", "date of completion", "expires", "held at",
            "in recognition", "valid for", "valid from", "valid through", "valid until",
            "verification code", "verify at", "embedded text",
        ]
        program_noise = [
            "dell emc partner program",
            "dell partner course",
            "completion certificate",
            "learning and enablement",
            "partner program",
            "training institute",
        ]

        def _has_signal(line: str) -> bool:
            lower = line.lower()
            return bool(
                any(word in lower for word in signal_words)
                or re.search(r"^(?:se\s*:|iso/iec\b|[A-Z0-9]{6,}\s*-)", line, re.IGNORECASE)
            )

        def _is_program_noise(line: str) -> bool:
            lower = line.lower()
            return any(token in lower for token in program_noise)

        def _valid_candidate(candidate: str) -> bool:
            candidate = _clean_candidate(candidate)
            if not 6 <= len(candidate) <= 150:
                return False
            if self._is_low_confidence_cert_name(candidate, issuer_hint):
                return False
            return _has_signal(candidate) or bool(re.search(r"\d", candidate))

        # 0. Priority: <CODE> - <CERTIFICATION TITLE>
        #   Example: WAF200 - Barracuda Web Application Firewall Certified Product Specialist
        # Prefer line-based matching to avoid grabbing date ranges or signatures.
        lines = [self._clean_text(line) for line in text.splitlines() if line.strip()]
        issuer_hint = self._extract_issuer(text) or ""

        if re.search(r"solar\s*v?winds?", text, re.IGNORECASE) and re.search(
            r"certified\s+professional",
            text,
            re.IGNORECASE,
        ):
            return "SolarWinds Certified Professional"

        for idx, line in enumerate(lines):
            lower = line.lower()
            if not line or any(token in lower for token in stop_words):
                continue

            code_line = re.match(r"^([A-Z0-9]{6,})\s*-\s*(.{6,120})$", line)
            if code_line and not re.search(r"\b(?:id|verification|candidate|certificate)\b", lower):
                candidate = _clean_candidate(line)
                if _valid_candidate(candidate):
                    return candidate

            if re.match(r"^SE\s*:\s*.+Credential\s+\d{4}$", line, re.IGNORECASE):
                candidate = _clean_candidate(line)
                if _valid_candidate(candidate):
                    return candidate

            if re.match(r"^ISO/IEC\s+\d+.+", line, re.IGNORECASE):
                candidate = _clean_candidate(line)
                if _valid_candidate(candidate):
                    return candidate

            if (
                issuer_hint
                and issuer_hint.lower() in lower
                and len(line.split()) <= 4
                and idx + 1 < len(lines)
            ):
                next_line = _clean_candidate(lines[idx + 1])
                if re.search(r"certified\s+professional", next_line, re.IGNORECASE):
                    return f"{issuer_hint} Certified Professional"

            context_markers = [
                "award the title of",
                "the title of",
                "has successfully completed the certification course",
                "has successfully completed the",
                "has attended the training course",
                "is certified",
                "recognized as a",
                "recognized as",
            ]
            if not any(marker in lower for marker in context_markers):
                continue

            collected = []
            for nxt in lines[idx + 1: idx + 6]:
                candidate_line = _clean_candidate(nxt)
                candidate_lower = candidate_line.lower()
                if not candidate_line or candidate_lower == "to":
                    continue
                if any(token in candidate_lower for token in stop_words):
                    break
                if re.search(
                    r"\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b.+\b\d{4}\b",
                    candidate_lower,
                ):
                    break
                if _looks_like_person_name(candidate_line) and collected:
                    break
                if _is_program_noise(candidate_line):
                    continue
                if self._is_low_confidence_cert_name(candidate_line, issuer_hint):
                    continue
                if not _has_signal(candidate_line) and not re.search(r"\d", candidate_line):
                    if collected:
                        break
                    continue
                collected.append(candidate_line)
                if re.search(r"^(?:SE\s*:|ISO/IEC\b|[A-Z0-9]{6,}\s*-)", candidate_line, re.IGNORECASE):
                    break
                if len(collected) >= 2:
                    break

            candidate = _clean_candidate(" ".join(collected))
            if _valid_candidate(candidate):
                return candidate

        if issuer_hint:
            issuer_lower = issuer_hint.lower()
            issuer_candidates = []
            for line in lines:
                lower = line.lower()
                if issuer_lower not in lower:
                    continue
                if not re.search(r"\bcertif(?:icate|ied|ication)?\b", lower):
                    continue
                if any(token in lower for token in ["valid from", "valid until", "verify this certificate", "powered by", "this certificate", "has successfully"]):
                    continue
                if _is_legal_preamble(lower):
                    continue
                if len(line) < 12:
                    continue
                issuer_candidates.append(line)
            if issuer_candidates:
                issuer_candidates.sort(key=len, reverse=True)
                candidate = re.sub(r"\s+", " ", issuer_candidates[0]).strip()
                candidate = re.sub(r"[.,]$", "", candidate).strip()
                if len(candidate) >= 12 and not self._is_generic_cert_name(candidate):
                    return candidate

        # Diploma-style documents: try to extract a diploma title from the full text first.
        diploma_title_patterns = [
            r"(dipl[ôo]me\s+national\s+de\s+[^\n.,]{5,120})",
            r"(dipl[ôo]me\s+de\s+[^\n.,]{5,120})",
            r"(licence\s+[^\n.,]{3,120})",
            r"(master\s+[^\n.,]{3,120})",
            r"(ing[ée]nieur\s+[^\n.,]{3,120})",
        ]
        for pattern in diploma_title_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                candidate = match.group(1).strip()
                candidate = re.split(
                    r"\s+(?:dans|mention|mentions|parcours|sp[eé]cialit[eé]s?)\b|[,;]",
                    candidate,
                    maxsplit=1,
                    flags=re.IGNORECASE,
                )[0].strip()
                candidate = re.sub(r"\s+", " ", candidate)
                if len(candidate) >= 12 and not self._is_generic_cert_name(candidate):
                    return candidate

        # Diploma-style documents: prefer lines that explicitly mention diploma/attestation
        diploma_keywords = [
            "attestation de diplome",
            "attestation",
            "diplome national",
            "diplome",
            "licence",
            "master",
            "ingenieur",
        ]
        institution_noise = [
            "ministere",
            "ministère",
            "universite",
            "université",
            "institut",
            "ecole",
            "école",
            "recherche scientifique",
        ]
        for idx, line in enumerate(lines):
            lower = line.lower()
            if not line or len(line) < 8:
                continue
            if _is_legal_preamble(lower):
                continue
            if any(token in lower for token in institution_noise):
                continue
            if any(keyword in lower for keyword in diploma_keywords):
                # If the next line looks like the diploma title, merge it
                candidate = line
                if idx + 1 < len(lines):
                    nxt = lines[idx + 1]
                    nxt_lower = nxt.lower()
                    if _is_legal_preamble(nxt_lower):
                        nxt = ""
                        nxt_lower = ""
                    if nxt and not any(t in nxt_lower for t in institution_noise) and len(nxt) <= 120:
                        candidate = f"{candidate} {nxt}".strip()
                candidate = re.sub(r"\s+", " ", candidate).strip()
                if len(candidate) >= 12 and not self._is_generic_cert_name(candidate):
                    return candidate

        for line in lines:
            lower = line.lower()
            if not line or len(line) < 8:
                continue
            if _is_legal_preamble(lower):
                continue
            if any(token in lower for token in ["valid from", "valid until", "verify this certificate", "certificate of achievement", "issued"]):
                continue
            if re.match(r'^\d{4}[/-]\d{1,2}[/-]\d{1,2}', line):
                continue
            dash_line = re.match(r'^([A-Z]{2,}\d{1,6}|[A-Z0-9]{3,})\s*-\s*(.+)$', line)
            if dash_line:
                if re.search(r"\b(?:id|verification|candidate|certificate)\b", lower):
                    continue
                candidate = line.strip()
                candidate = re.sub(r'\s+', ' ', candidate)
                candidate = re.sub(r'[.,]$', '', candidate).strip()
                if len(candidate) >= 10 and not self._is_generic_cert_name(candidate):
                    return candidate

        # Look for common patterns
        patterns = [
            # Recognized as a pattern (Highest Priority)
            r'recognized\s+as\s+(?:a|an)?\s*[:\-]*\s*\n*(?:[|\-]+\s*)*([A-Z][^\n]{10,80}?)(?:\s*\||\n|$)',
            # French Diploma patterns - try to keep the prefix (DIPLOME NATIONAL, etc.)
            r'((?:DIPLOME\s+NATIONAL|DIPLOME|ATTESTATION)\s+(?:D\')?.+?)(?:\s+est|,|$|\n\n)',
            # NSE certifications (Fortinet)
            r'(NSE\s+\d+\s+[A-Za-z\s]{10,60}?)(?:\n|$)',
            # AWS, Azure, GCP certifications
            r'((?:AWS|Azure|Google Cloud)\s+Certified\s+[A-Za-z\s\-]{10,60}?)(?:\n|$)',
            # "Is now a X Certified Y" pattern (common in many certs)
            r'(?:Is\s+now\s+a|has\s+achieved)[:\s]*\n*\s*([A-Z][A-Za-z\s]{10,60}?)(?:\n|held\s+on)',
            # Vendor + Certified patterns (e.g., "Sophos Certified Architect")
            r'([A-Z][a-z]+\s+Certified\s+[A-Za-z\s]{5,50}?)(?:\n|held\s+on|$)',
            # "completion of X" or "completed the course X" pattern (NVIDIA, Coursera, Dell, etc.)
            r'(?:completion\s+of|completing|completed\s+(?:the\s+course)?)[:\s]*\n*\s*([A-Z0-9][^\n]{10,80}?)(?:\n\n|\n[A-Z]|$)',
            # Credential patterns - handle multi-line names
            r'credential\s+of[:\s]*\n*\s*([A-Z][^\n]{0,100}(?:\([A-Z]{2,6}\))?)',
            # Look for abbreviations in parentheses (e.g., "Nexpose Certified Administrator (NCA)")
            r'([A-Z][A-Za-z\s]{10,60}?)\s*\(([A-Z]{2,6})\)',
            # Certificate with specific name in parentheses or after colon
            r'(?:Certificate|Certification)[:\s]+([A-Z][^\n]{10,80}?)(?:\s+\([A-Z]+\))?(?:\n|$)',
            # "has successfully completed X" pattern
            r'successfully\s+completed[:\s]*\n*\s*([A-Z][^\n]{10,80}?)(?:\n|DATE:)',
            # English Certificate patterns
            r'(?:Certificate|Certification)\s+(?:of\s+)?(?:Achievement\s+)?(.+?)(?:\s+has|\s+is\s+to\s+confirm|\n\n|\n[A-Z])',
            r'(?:This\s+certifies\s+that\s+)(.+?)(?:\n|has)',
            r'^(.+?)\s+Certificate',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE | re.DOTALL)
            if match:
                # For patterns with two groups (name + abbreviation), combine them
                if match.lastindex == 2:
                    name = f"{match.group(1).strip()} ({match.group(2).strip()})"
                else:
                    name = match.group(1).strip()
                # Clean up the name - remove newlines and extra spaces
                name = re.sub(r'\s+', ' ', name)
                # Remove trailing punctuation like dots or commas
                name = re.sub(r'[,.]$', '', name).strip()
                
                # Filter out certificate numbers and other non-names
                if any(keyword in name.upper() for keyword in ['NUMBER:', 'CERTIFICATE NUMBER', 'ID:', 'NO:', 'REF:']):
                    continue
                
                # Filter out generic phrases that aren't real certification names
                if name.lower() in ['of achievement', 'of completion', 'of attainment', 'of excellence', 'of competency']:
                    continue
                    
                # Filter out preamble mis-matches
                if name.lower().endswith("acknowledges that"):
                    continue
                
                # Filter out very short matches that are likely just keywords
                if len(name) < 10:
                    continue
                    
                # If name is just "Achievement" or "Completion", it's a generic match, keep looking
                if name.lower() in ["achievement", "completion", "attainment"] and "Certificate" in pattern:
                    continue
                if 5 < len(name) < 150:
                    return name
        
        # If no pattern matched, try specific "Certified" or "Ingénieur" pattern
        spec_match = re.search(r'([A-Z0-9].+?(?:Certified|INGENIEUR|DIPLOME)\s+.+?)(?:\s+has|\s+est|,|$)', text, re.IGNORECASE)
        if spec_match:
            name = spec_match.group(1).strip()
            return re.sub(r'[,.]$', '', name).strip()

        # Try to find lines with key words in the entire text (not just top 10)
        lines = text.split('\n')
        for i, line in enumerate(lines):
            line_lower = line.lower()
            if any(word in line_lower for word in ['certified', 'certificate', 'certification', 'achievement', 'diplôme', 'diplome', 'attestation']):
                # Special case for "DIPLOME NATIONAL..." or "ATTESTATION DE DIPLOME" which might be multi-line
                if any(k in line_lower for k in ["diplome", "diplôme", "attestation"]) and i + 1 < len(lines):
                    full_name = line.strip() + " " + lines[i+1].strip()
                    # Clean up
                    full_name = re.sub(r'\s+', ' ', full_name)
                    return re.sub(r'[,.]$', '', full_name).strip()

                # If "Achievement" is the whole line, check next line
                if line.strip().lower() == "certificate of achievement" and i + 1 < len(lines):
                    next_line = lines[i+1].strip()
                    if next_line: return next_line
                
                clean_line = line.strip()
                if 10 < len(clean_line) < 100:
                    return clean_line
        
        return "Unknown Certification"
    
    def _extract_issuer(self, text: str) -> Optional[str]:
        """Extract certification issuer from text"""
        # 1. Look for explicit issuer patterns first
        explicit_patterns = [
            r'(?:Issued\s+by|Issuer|Provided\s+by)[:\s]+(.+?)(?:\n|$)',
            r'(?:Authorized\s+by|Accredited\s+by)[:\s]+(.+?)(?:\n|$)',
            r'(?:Délivré\s+par|Etabli\s+par)[:\s]+(.+?)(?:\n|$)',
            r'Le\s+Directeur\s+de\s+(?:l\')?(.+?)(?:\s+atteste|\n|$)',
        ]
        
        for pattern in explicit_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                issuer = match.group(1).strip()
                issuer = re.sub(r'\s+', ' ', issuer)
                if 10 < len(issuer) < 200:
                    return issuer
        
        # 2. Look for institution names at the start of the document (first 500 chars)
        header = text[:500]
        inst_patterns = [
            r'((?:Institut|Université|Ecole|Lycée)\s+Supérieur[^\n]{10,100})',
            r'((?:Institut|Université|Ecole|Lycée)\s+[^\n]{10,100})',
        ]
        
        found_issuers = []
        for pattern in inst_patterns:
            matches = re.finditer(pattern, header, re.IGNORECASE)
            for m in matches:
                issuer = m.group(1).strip()
                issuer = re.sub(r'\s+', ' ', issuer)
                # Clean trailing symbols
                issuer = re.sub(r'[\~\\.,;:\-_]+$', '', issuer).strip()
                
                # Must be mostly alphabetic
                alpha_count = sum(c.isalpha() or c.isspace() for c in issuer)
                if alpha_count / max(len(issuer), 1) >= 0.7 and 15 < len(issuer) < 150:
                    found_issuers.append(issuer)
        
        if found_issuers:
            # Pick the longest clean match
            found_issuers.sort(key=len, reverse=True)
            return found_issuers[0]
        
        # 3. Fallback to known issuers list
        for issuer in self.known_issuers:
            if issuer.lower() in text.lower():
                return issuer
                
        return None

    def _extract_embedded_text(self, raw_text: str) -> str:
        """Pull embedded-text block from combined PDF text when available."""
        if not raw_text:
            return ""
        marker_embedded = "--- Embedded Text ---"
        marker_ocr_supplement = "--- OCR Supplement ---"
        if marker_embedded in raw_text:
            return raw_text.split(marker_embedded, 1)[1].strip()
        if marker_ocr_supplement in raw_text:
            return raw_text.split(marker_ocr_supplement, 1)[0].strip()
        return ""

    def _is_generic_cert_name(self, name: str) -> bool:
        """Heuristic to detect boilerplate names that should not override parsed results."""
        if not name:
            return True
        lower = str(name).strip().lower()
        if len(lower) < 6:
            return True
        generic_phrases = [
            "this certifies that",
            "certifies that",
            "certificate of completion",
            "certificate of achievement",
            "certificate of attendance",
            "certificate of participation",
            "certificate",
            "certification",
            "attestation",
            "diploma",
            "has successfully completed",
        ]
        return any(phrase in lower for phrase in generic_phrases)

    def _is_low_confidence_cert_name(self, name: str, issuer: Optional[str] = None) -> bool:
        """Detect extracted labels that are likely document boilerplate, IDs, or signer roles."""
        if self._is_generic_cert_name(name):
            return True

        lower = self._clean_text(str(name)).lower()
        if not lower:
            return True

        exact_noise = {
            "recognizes",
            "attendance record",
            "professional",
            "certified trainer",
            "veeam certified trainer",
        }
        if lower in exact_noise:
            return True

        noisy_fragments = [
            "continuing professional development",
            "certification requirements",
            "certificate requirements",
            "candidate id",
            "certificate id",
            "credential id",
            "verification code",
            "valid through",
            "vmwarevsp",
            "sales professional (vsp) group",
        ]
        if any(fragment in lower for fragment in noisy_fragments):
            return True

        if re.search(r"\b(?:ftid|id)\s*[©:@#-]", lower):
            return True

        issuer_lower = (issuer or "").strip().lower()
        if issuer_lower and issuer_lower in lower and any(role in lower for role in ["trainer", "ceo", "president"]):
            return True

        return False

    def _select_embedded_cert_name(
        self,
        embedded_text: str,
        user_first_name: Optional[str] = None,
        user_last_name: Optional[str] = None,
        issuer_hint: Optional[str] = None,
        current_name: Optional[str] = None,
    ) -> Optional[str]:
        """Pick the best cert-name candidate from embedded PDF text."""
        import difflib

        if not embedded_text:
            return None

        full_name = ""
        if user_first_name and user_last_name:
            full_name = f"{user_first_name} {user_last_name}".strip().lower()

        def looks_like_date(value: str) -> bool:
            if not value:
                return False
            return bool(re.search(
                r"(\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}\b|[A-Za-z]+\s+\d{1,2},?\s+\d{4})",
                value,
            ))

        signal_words = [
            "certified", "certification", "certificate", "specialist", "professional", "associate",
            "expert", "engineer", "architect", "administrator", "developer", "foundation",
            "foundations", "advanced", "practitioner", "nse", "forti", "aws", "azure", "google",
            "gcp", "cisco", "comptia", "pmi", "itil",
        ]

        lines = [self._clean_text(line) for line in embedded_text.splitlines()]
        candidates: list[tuple[str, int]] = []

        for line in lines:
            if not line:
                continue
            lower = line.lower()
            if full_name and full_name in lower:
                continue
            if "powered by" in lower or "tcpdf" in lower or "www" in lower or "http" in lower:
                continue

            score = 0
            if 8 <= len(line) <= 80:
                score += 2
            if issuer_hint and issuer_hint.lower() in lower:
                score += 4
            if any(word in lower for word in signal_words):
                score += 3
            if re.search(r"\b[A-Z]{2,}\b", line):
                score += 1
            if re.search(r"\d", line):
                score += 1
            if self._is_generic_cert_name(line):
                score -= 5
            if looks_like_date(line):
                score -= 4

            candidates.append((line, score))

        if not candidates:
            return None

        candidates.sort(key=lambda item: item[1], reverse=True)
        best_line, best_score = candidates[0]
        if best_score <= 0:
            return None

        if current_name and not self._is_generic_cert_name(current_name):
            ratio = difflib.SequenceMatcher(None, current_name.lower(), best_line.lower()).ratio()
            if ratio >= 0.85 and best_line.lower() != current_name.lower():
                return best_line
            return None

        return best_line
    
    def _extract_expiration_date(self, text: str) -> Optional[str]:
        """Extract expiration date from text"""
        # 1.5. Handle explicit validity ranges: "Valid from <date> until <date>"
        date_token = r'(?:\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\w+\s+\d{1,2},?\s+\d{4})'
        valid_range = re.search(
            rf'(?:Valid\s+from)\s+({date_token})\s+(?:until|to|through|till)\s+({date_token})',
            text,
            re.IGNORECASE,
        )
        if valid_range:
            normalized = self._normalize_date(valid_range.group(2).strip())
            if normalized:
                logger.info(f"Found validity range expiration date: {normalized}")
                return normalized
        # 1. Check if this looks like a diploma or permanent attestation
        is_diploma = any(k in text.lower() for k in ["diplome", "diplôme", "attestation de diplome"])
        
        # 2. Look for specific expiration patterns (explicit keywords)
        exp_patterns = [
            r'(?:Expir(?:es|ation|y)\s+(?:Date)?)[:\s]*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
            r'(?:Valid\s+(?:until|through|till))[:\s]*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
            r'(?:Expir(?:es|ation|y)\s+(?:Date)?)[:\s]*(\w+\s+\d{1,2},?\s+\d{4})',
            r'(?:Valid\s+(?:until|through|till))[:\s]*(\w+\s+\d{1,2},?\s+\d{4})',
            r'(?:Expir(?:es|ation|y))[:\s]*(\d{4}[/-]\d{1,2}[/-]\d{1,2})',
        ]
        
        for pattern in exp_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                date_str = match.group(1).strip()
                normalized = self._normalize_date(date_str)
                if normalized: 
                    logger.info(f"Found explicit expiration date: {normalized}")
                    return normalized

        # 2.5. Look for "Valid for X years" patterns and calculate the date from ANY issue date found
        validity_match = re.search(r'Valid\s+for\s+(one|two|three|four|five|1|2|3|4|5)\s+year[s]?', text, re.IGNORECASE)
        if validity_match:
            years_str = validity_match.group(1).lower()
            word_to_num = {'one': 1, '1': 1, 'two': 2, '2': 2, 'three': 3, '3': 3, 'four': 4, '4': 4, 'five': 5, '5': 5}
            years = word_to_num.get(years_str, 1)
            
            # Find the first valid date in the text to act as the issue date
            date_patterns = [
                r'\w+\s+\d{1,2},?\s+\d{4}',
                r'\d{1,2}[/-]\d{1,2}[/-]\d{2,4}',
                r'\d{4}[/-]\d{1,2}[/-]\d{1,2}'
            ]
            
            issue_date_str = None
            for pattern in date_patterns:
                dates = re.findall(pattern, text)
                if dates:
                    issue_date_str = dates[0].strip()
                    break
            issue_date_norm = self._normalize_date(issue_date_str)
            
            if issue_date_norm:
                try:
                    from datetime import datetime
                    dt = datetime.strptime(issue_date_norm, '%Y-%m-%d')
                    
                    # Add the years
                    try:
                        exp_dt = dt.replace(year=dt.year + years)
                    except ValueError:
                        # Handle leap year Feb 29
                        exp_dt = dt.replace(year=dt.year + years, day=28)
                        
                    calc_date = exp_dt.strftime('%Y-%m-%d')
                    logger.info(f"Calculated expiration date {calc_date} from issue date {issue_date_norm} + {years} years")
                    return calc_date
                except Exception as e:
                    logger.error(f"Error calculating date: {e}")

        # 3. If it's a diploma, don't try to guess an expiration date
        if is_diploma:
            logger.info("Document identified as a diploma. Skipping general date extraction for expiry.")
            return None

        # 4. Check if we only have "Issued" dates (not expiration)
        # If "Issued" is explicitly mentioned but no expiration keywords, return None
        has_issued = bool(re.search(r'(?:Issued|Issue\s+Date)[:\s]*\d', text, re.IGNORECASE))
        has_expiry_keywords = bool(re.search(r'(?:expir|valid\s+(?:until|through)|renew)', text, re.IGNORECASE))
        
        if has_issued and not has_expiry_keywords:
            logger.info("Document has 'Issued' date but no expiration keywords. Treating as non-expiring.")
            return None

        # 5. General date finding (only if we have expiry context)
        if has_expiry_keywords:
            all_date_patterns = [
                r'\d{4}[/-]\d{1,2}[/-]\d{1,2}',
                r'\d{1,2}[/-]\d{1,2}[/-]\d{2,4}',
                r'\w+\s+\d{1,2},?\s+\d{4}'
            ]
            
            found_dates = []
            for pattern in all_date_patterns:
                matches = re.finditer(pattern, text)
                for m in matches:
                    # Skip if this is part of "Issued" phrase
                    context_start = max(0, m.start() - 20)
                    context = text[context_start:m.end()]
                    if re.search(r'issued[:\s]*$', context, re.IGNORECASE):
                        continue
                    
                    normalized = self._normalize_date(m.group(0))
                    if normalized:
                        found_dates.append(normalized)
            
            if found_dates:
                unique_dates = sorted(list(set(found_dates)))
                logger.info(f"Found dates with expiry context: {unique_dates}. Selecting latest.")
                return unique_dates[-1]
        
        return None
    
    def _normalize_date(self, date_str: str) -> Optional[str]:
        """Normalize date to ISO format (YYYY-MM-DD)"""
        date_formats = [
            '%Y-%m-%d', '%Y/%m/%d',
            '%m/%d/%Y', '%d/%m/%Y', '%m-%d-%Y', '%d-%m-%Y',
            '%m/%d/%y', '%d/%m/%y', '%m-%d-%y', '%d-%m-%y',
            '%B %d, %Y', '%b %d, %Y', '%B %d %Y', '%b %d %Y',
        ]
        
        for fmt in date_formats:
            try:
                dt = datetime.strptime(date_str, fmt)
                return dt.strftime('%Y-%m-%d')
            except ValueError:
                continue
        
        return None

    def _extract_credential_id(self, text: str) -> Optional[str]:
        """Extract credential ID / validation number from text"""
        patterns = [
            r'(?:Credential\s+ID|Validation\s+Number|Certificate\s+Number|ID\s+No\.?|ID)[:\s]+([A-Za-z0-9\-]+)(?:\n|$)',
            r'(?:ID\s+Certifié|Numéro|N°|Ref)[:\s]+([A-Za-z0-9\-]+)(?:\n|$)',
            # Course codes at the start of lines (like GSTB5362WBTS)
            r'completed\s+(?:the\s+course)?[:\s]*\n*\s*([A-Z0-9]{8,15})\s+-'
        ]
        
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                cred_id = match.group(1).strip()
                if 5 <= len(cred_id) <= 40:
                    return cred_id
                    
        return None

    def _verify_user_name(self, text: str, first_name: str, last_name: str) -> bool:
        """Verify if the uploaded certificate belongs to the user via fuzzy matching"""
        import difflib
        
        # Clean up names
        first = first_name.strip().lower()
        last = last_name.strip().lower()
        
        if not first or not last:
            return True # Cannot verify
            
        full_name = f"{first} {last}"
        full_name_rev = f"{last} {first}"
        
        # Clean text
        text_lower = text.lower()
        
        # Exact match
        if first in text_lower and last in text_lower:
            return True
            
        # Fuzzy match sliding window
        words = text_lower.split()
        name_word_count = len(full_name.split())
        
        # Try windows of sizes similar to the person's name length
        for window_size in [max(1, name_word_count - 1), name_word_count, name_word_count + 1]:
            for i in range(len(words) - window_size + 1):
                window = " ".join(words[i:i + window_size])
                ratio = max(
                    difflib.SequenceMatcher(None, window, full_name).ratio(),
                    difflib.SequenceMatcher(None, window, full_name_rev).ratio()
                )
                if ratio > 0.75:
                    return True
                
        return False

    def _extract_issue_date_basic(self, text: str) -> Optional[str]:
        """
        Quick issue-date extractor: grab the first date-like token and normalize.
        This is a best-effort helper to ensure we return issue_date for downstream use.
        """
        if not text:
            return None
        date_patterns = [
            r'\d{4}[/-]\d{1,2}[/-]\d{1,2}',
            r'\d{1,2}[/-]\d{1,2}[/-]\d{2,4}',
            r'\w+\s+\d{1,2},?\s+\d{4}',
        ]
        for pattern in date_patterns:
            m = re.search(pattern, text)
            if m:
                normalized = self._normalize_date(m.group(0))
                if normalized:
                    return normalized
        return None

