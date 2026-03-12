import asyncio
import os
import fitz
from app.ocr.certification_ocr import CertificationOCR

def run():
    ocr = CertificationOCR()
    file_path = r"c:\Users\islam\Projects\NextRH\ai-service\templates\CV + DIP + CERTIF EYA BEN JEMAA-4.pdf"
    print(f"Testing extraction on {file_path}")
    try:
        text, _ = ocr._extract_text_from_pdf(file_path)
        cleaned = ocr._clean_ocr_noise(text)
        data = ocr._parse_text(cleaned)
        print("EXTRACTION SUCCESS!!!")
        print("NAME:", data.get('name'))
        print("CREDENTIAL ID:", data.get('credential_id'))
        print("CLEANED PREVIEW:", repr(cleaned[:1000]))
    except Exception as e:
        print("ERROR:", e)

if __name__ == "__main__":
    run()
