from fastapi import APIRouter, UploadFile, File, Form, HTTPException, BackgroundTasks
from app.services.cv_parser import CVParserService
from app.models.cv_data import CVData # Not used in response yet but good to have imported
from app.ocr.certification_ocr import CertificationOCR
from app.utils.logger import logger
from app.rag.etl_ingest import sync_metadata_files_to_qdrant
import os

router = APIRouter()
cv_parser_service = CVParserService()
cert_ocr_service = CertificationOCR()


@router.post("/cv")
async def parse_cv(
    file: UploadFile = File(...),
    user_id: str = Form(...),
    background_tasks: BackgroundTasks = None,
):
    """Parse CV and return structured data"""
    try:
        result = await cv_parser_service.parse_cv(file, user_id)
        # Kick off embedding refresh for this user in the background.
        if background_tasks:
            background_tasks.add_task(sync_metadata_files_to_qdrant)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Internal server error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error parsing CV")


@router.post("/certification")
async def parse_certification(file: UploadFile = File(...), user_id: str = Form(...)):
    """Parse certification using OCR and return structured data"""
    logger.info(f"Received certification parsing request for user: {user_id}, file: {file.filename}")
    
    # Validate file type
    allowed_extensions = ['.png', '.jpg', '.jpeg', '.pdf']
    file_ext = os.path.splitext(file.filename)[1].lower()
    
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Allowed types: {', '.join(allowed_extensions)}"
        )
    
    temp_path = None
    try:
        # Save uploaded file temporarily
        temp_path = f"uploads/{user_id}_{file.filename}"
        os.makedirs("uploads", exist_ok=True)
        
        with open(temp_path, "wb") as f:
            content = await file.read()
            f.write(content)
        
        # Parse the certification
        result = cert_ocr_service.parse_certification(temp_path, file.filename)
        
        logger.info(f"Certification parsing result: {result}")
        
        return result
        
    except Exception as e:
        logger.error(f"Error parsing certification: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
    
    finally:
        # Clean up temp file
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
