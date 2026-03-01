"""
OCR-based Certification Parser using Tesseract (with EasyOCR and llm fallback)
Extracts certification name, issuer, expiration date, and credential ID from images
"""
import pytesseract
import cv2
import numpy as np
from PIL import Image
import re
from datetime import datetime
from typing import Optional, Dict, Any
import logging
import fitz  # PyMuPDF for PDF support
import io

import os
import easyocr
from app.config import settings
from app.utils.llm import resolve_llm_model, parse_json_object
from langchain_ollama import ChatOllama
import json

logger = logging.getLogger(__name__)


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
        
        self.use_easyocr = settings.OCR_ENGINE == "easyocr"
        self.reader = None
        
        if self.use_easyocr:
            # Initialize EasyOCR reader
            logger.info("Initializing EasyOCR reader...")
            try:
                 # Initialize for English and French (common in CVs)
                 self.reader = easyocr.Reader(['en', 'fr'], gpu=False)
            except Exception as e:
                 logger.error(f"Failed to initialize EasyOCR: {e}")
                 self.reader = None
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
            # Extract text based on file type
            if filename.lower().endswith('.pdf'):
                text = self._extract_text_from_pdf(file_path)
            else:
                text = self._extract_text_from_image(file_path)
            
            logger.info(f"Extracted text length: {len(text)} characters")
            
            # Parse the extracted text using rules
            cleaned_text = self._clean_ocr_noise(text)
            cert_data = self._parse_text(cleaned_text)
            
            # 1. Determine if rules failed or if data is incomplete
            is_unknown = cert_data['name'] == "Unknown Certification"
            name_lower = cert_data['name'].lower()
            generic_exact = ["certificate of completion", "certificate of achievement", "certification", "certificate", "diploma", "diplôme", "attestation"]
            generic_starts = ["id certified through", "valid through", "certificate number", "license number", "credential id", "date ", "issue date", "expiration date"]
            is_generic = name_lower in generic_exact or any(name_lower.startswith(prefix) for prefix in generic_starts)
            
            # If the parser confidently grabbed the issuer's name as the cert name, it's a mistake worth falling back for
            issuer_in_name = bool(cert_data['issuer']) and (cert_data['issuer'].lower() in cert_data['name'].lower() or cert_data['name'].lower() in cert_data['issuer'].lower())
            
            is_suspicious_name = len(cert_data['name']) > 80 or len(cert_data['name']) < 5 or issuer_in_name
            
            missing_issuer = not cert_data['issuer']
            missing_expiry = not cert_data['expiration']
            
            needs_fallback = is_unknown or is_generic or is_suspicious_name or (missing_issuer and len(text) > 50) or missing_expiry
            
            # 2. Gatekeeper: Ensure it is likely a certificate before burning LLM cycles
            if needs_fallback:
                if self._is_likely_certificate(cleaned_text):
                    logger.info("Rule-based parsing incomplete. Falling back to LLM extraction.")
                    llm_data = self._llm_fallback_extraction(cleaned_text)
                    
                    # Merge LLM results (LLM takes precedence if rule engine failed)
                    if llm_data:
                        # Trust the LLM for the name if it provided one, as it's better at understanding context than regex
                        llm_name = llm_data.get('name')
                        if llm_name and llm_name.lower() not in ["null", "none", "", "unknown"]:
                            cert_data['name'] = llm_name
                            
                        llm_issuer = llm_data.get('issuer')
                        if llm_issuer and not (cert_data['issuer'] and not missing_issuer):
                            cert_data['issuer'] = llm_issuer
                            
                        llm_expiry = llm_data.get('expiration_date')
                        if llm_expiry:
                            cert_data['expiration'] = llm_expiry
                            
                        llm_cred_id = llm_data.get('credential_id')
                        if llm_cred_id:
                            cert_data['credential_id'] = llm_cred_id
                else:
                    logger.info("Document failed certificate gatekeeper check. Skipping LLM fallback.")
            
            if user_first_name and user_last_name:
                is_verified = self._verify_user_name(cleaned_text, user_first_name, user_last_name)
                if not is_verified:
                    logger.warning(f"Name verification failed for {user_first_name} {user_last_name}")
                    return {
                        'success': False,
                        'error': 'Name verification failed. The certificate does not appear to belong to you.',
                        'certification_name': cert_data['name'],
                        'issuer': cert_data['issuer'],
                    }

            return {
                'success': True,
                'certification_name': cert_data['name'],
                'issuer': cert_data['issuer'],
                'expiration_date': cert_data['expiration'],
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
        """Security guard to prevent LLM DDoS on non-certificate text dumps."""
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
            llm = ChatOllama(
                model=resolve_llm_model(),
                base_url=settings.OLLAMA_URL,
                temperature=0.0,
                timeout=15.0  # 15 second strict timeout
            )
            
            response = llm.invoke(prompt)
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
        """Extract text from image using Tesseract or EasyOCR"""
        try:
            # Use PIL to read image (handles unicode paths correctly on Windows)
            with Image.open(file_path) as pil_img:
                # Convert to numpy array
                img = np.array(pil_img)
            
            # EasyOCR path
            if self.use_easyocr and self.reader:
                logger.info(f"Using EasyOCR for image: {file_path}")
                result = self.reader.readtext(img, detail=0)
                return " ".join(result)
            
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
            
            # Perform OCR
            self._check_tesseract()
            text = pytesseract.image_to_string(gray)
            return text

        except Exception as e:
            logger.error(f"Error extracting text from image {file_path}: {e}")
            raise

    def _extract_text_from_pdf(self, file_path: str) -> str:
        """Extract text from PDF using hybrid approach (embedded text + OCR)"""
        text = ""
        
        try:
            doc = fitz.open(file_path)
            
            for page_num, page in enumerate(doc):
                # Always extract embedded text first
                embedded_text = page.get_text("text", sort=True)
                
                # Also perform OCR to catch image-based content
                logger.info(f"Using hybrid extraction for page {page_num}...")
                # Increase DPI for better OCR quality
                pix = page.get_pixmap(dpi=400)  # Increased from 300 to 400
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
                ocr_results = []
                
                # Approach 1: Light denoising with adaptive threshold
                denoised_light = cv2.fastNlMeansDenoising(gray, None, h=5, templateWindowSize=7, searchWindowSize=21)
                thresh1 = cv2.adaptiveThreshold(denoised_light, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
                                               cv2.THRESH_BINARY, 11, 2)
                
                # Approach 2: Otsu's thresholding (better for high-contrast documents)
                _, thresh2 = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                
                # Perform OCR on both preprocessed versions
                if self.use_easyocr and self.reader:
                    result1 = self.reader.readtext(thresh1, detail=0)
                    result2 = self.reader.readtext(thresh2, detail=0)
                    ocr_text = "\n".join(result1) + "\n--- Alternative OCR ---\n" + "\n".join(result2)
                else:
                    self._check_tesseract()
                    # Use different PSM modes for better coverage
                    config1 = '--psm 3 --oem 3'  # Auto page segmentation
                    config2 = '--psm 6 --oem 3'  # Assume uniform block of text
                    
                    text1 = pytesseract.image_to_string(thresh1, config=config1, lang='fra+eng')
                    text2 = pytesseract.image_to_string(thresh2, config=config2, lang='fra+eng')
                    ocr_text = text1 + "\n--- Alternative OCR ---\n" + text2
                
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
        
        return text
    
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
    
    def _extract_expiration_date(self, text: str) -> Optional[str]:
        """Extract expiration date from text"""
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
