#!/usr/bin/env python3
"""Test script to extract and display text from the diploma PDF"""

import fitz  # PyMuPDF
import sys

pdf_path = r"c:\Users\islam\Projects\NextRH\backend\file-storage\CV_Database\Anouar_Abdallah\Certificates\diplome2.pdf"

print("=" * 80)
print("PDF TEXT EXTRACTION TEST")
print("=" * 80)

try:
    doc = fitz.open(pdf_path)
    print(f"\nTotal pages: {len(doc)}")
    
    for page_num, page in enumerate(doc):
        print(f"\n--- PAGE {page_num + 1} ---")
        
        # Check if it's an image-based PDF
        text_dict = page.get_text("dict")
        has_text = any(block.get("lines") for block in text_dict.get("blocks", []) if block.get("type") == 0)
        print(f"Has embedded text: {has_text}")
        
        # Try direct text extraction
        text = page.get_text("text", sort=True)
        print(f"Text length: {len(text)} characters")
        print(f"\n--- EXTRACTED TEXT START ---")
        print(text)
        print("--- EXTRACTED TEXT END ---\n")
    
    doc.close()
    
except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
