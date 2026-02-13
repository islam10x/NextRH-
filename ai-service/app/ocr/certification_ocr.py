"""
OCR-based Certification Parser using Tesseract (with EasyOCR fallback)
Extracts certification name, issuer, and expiration date from images
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
            "Shopify","Zendesk","Twilio","Kaggle","DeepLearning.AI"
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

    def parse_certification(self, file_path: str, filename: str) -> Dict[str, Any]:
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
            
            # Parse the extracted text
            cert_data = self._parse_text(text)
            
            return {
                'success': True,
                'certification_name': cert_data['name'],
                'issuer': cert_data['issuer'],
                'expiration_date': cert_data['expiration'],
                'raw_text': text[:500]  # First 500 chars for debugging
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
    
    def _parse_text(self, text: str) -> Dict[str, Optional[str]]:
        """Parse certification details from extracted text"""
        
        # Clean OCR noise first
        cleaned_text = self._clean_ocr_noise(text)
        
        # Extract certification name
        cert_name = self._extract_certification_name(cleaned_text)
        
        # Extract issuer
        issuer = self._extract_issuer(cleaned_text)
        
        # Extract expiration date
        expiration = self._extract_expiration_date(cleaned_text)
        
        return {
            'name': cert_name,
            'issuer': issuer,
            'expiration': expiration
        }
    
    def _extract_certification_name(self, text: str) -> str:
        """Extract certification name from text"""
        # Look for common patterns
        patterns = [
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
            # "completion of X" pattern (NVIDIA, Coursera, etc.)
            r'(?:completion\s+of|completing)[:\s]*\n*\s*([A-Z][^\n]{10,80}?)(?:\n\n|\n[A-Z]|$)',
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
