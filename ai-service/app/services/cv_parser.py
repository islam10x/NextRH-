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
            
            # 1. Save metadata.json locally (as snapshot)
            # In production, this should ideally be S3 or a persistent volume
            # For now, saving to 'uploads' folder
            os.makedirs(settings.UPLOAD_FOLDER, exist_ok=True)
            meta_filename = f"{os.path.splitext(filename)[0]}_metadata.json"
            meta_path = os.path.join(settings.UPLOAD_FOLDER, meta_filename)
            with open(meta_path, "w", encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            logger.info(f"Saved metadata snapshot to {meta_path}")

            # 2. Send to Backend
            await self.send_to_backend(user_id, result)

            return result

        except Exception as e:
            logger.error(f"Error parsing CV {filename}: {str(e)}")
            raise e
        finally:
            # Clean up temp file
            if os.path.exists(temp_path):
                os.remove(temp_path)

    async def send_to_backend(self, user_id: str, data: Dict[str, Any]):
        """
        Sends the parsed data to the Node.js backend to populate the database.
        """
        url = f"{settings.BACKEND_URL}/cv/process"
        payload = {
            "userId": user_id,
            "data": data
        }
        
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                logger.info(f"Successfully sent CV data to backend for user {user_id}")
            except httpx.HTTPError as e:
                logger.error(f"Failed to send data to backend: {e}")
                # We don't raise here to allow the immediate response to return `result` locally,
                # but in production, we might want to queue this or alert.
                pass
