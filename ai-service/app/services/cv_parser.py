import os
import json
import httpx
from typing import Dict, Any, Union
from app.parsers.pdf_parser import PDFParser
from app.parsers.docx_parser import DocxParser
from app.parsers.template_parser import TemplateCVParser
from app.config import settings
from app.utils.logger import logger
from fastapi import UploadFile

class CVParserService:
    def __init__(self):
        self.pdf_parser = PDFParser()
        self.docx_parser = DocxParser()
        self.template_parser = TemplateCVParser()

    async def parse_cv(self, file: UploadFile, user_id: str) -> Dict[str, Any]:
        """
        Main entry point to parse a CV file.
        Uses the deterministic TemplateCVParser.
        Sends data to backend.
        """
        filename = file.filename
        content_type = file.content_type
        
        logger.info(f"Parsing CV: {filename} ({content_type}) for user {user_id}")
        
        # Save temp file
        temp_path = f"/tmp/{filename}" # In production use tempfile
        if os.name == 'nt':
             temp_path = os.path.join(os.environ['TEMP'], filename)

        try:
            with open(temp_path, "wb") as buffer:
                content = await file.read()
                buffer.write(content)
            
            # Use deterministic template parser
            structured_data = self.template_parser.parse(temp_path)
            
            # Extract metadata
            metadata = {}
            if filename.lower().endswith('.pdf'):
                 metadata = self.pdf_parser.extract_metadata(temp_path)
            elif filename.lower().endswith('.docx'):
                 metadata = self.docx_parser.extract_metadata(temp_path)

            result = {
                "structured_data": structured_data,
                "metadata": metadata,
                "filename": filename
            }
            
            return result

        except Exception as e:
            logger.error(f"Error parsing CV {filename}: {str(e)}")
            raise e
        finally:
            # Clean up temp file
            if os.path.exists(temp_path):
                os.remove(temp_path)
