import fitz  # PyMuPDF
from .base_parser import BaseParser
from typing import Any, Dict

class PDFParser(BaseParser):
    def parse(self, file_path: str) -> str:
        """
        Extract text from a PDF file using PyMuPDF.
        """
        text = ""
        try:
            with fitz.open(file_path) as doc:
                for page in doc:
                    text += page.get_text()
        except Exception as e:
            raise ValueError(f"Failed to parse PDF: {e}")
        return text

    def extract_metadata(self, file_path: str) -> Dict[str, Any]:
        """
        Extract metadata from a PDF file.
        """
        metadata = {}
        try:
            with fitz.open(file_path) as doc:
                metadata = doc.metadata
        except Exception as e:
            # metadata extraction failure shouldn't necessarily block parsing
            pass
        return metadata
