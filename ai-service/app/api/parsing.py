from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from app.services.cv_parser import CVParserService
from app.models.cv_data import CVData # Not used in response yet but good to have imported
from app.utils.logger import logger

router = APIRouter()
cv_parser_service = CVParserService()

@router.post("/cv", response_model=dict)
async def parse_cv(user_id: str = Form(...), file: UploadFile = File(...)):
    """
    Endpoint to upload and parse a CV.
    param user_id: ID of the user uploading the CV (to link profile).
    param file: The CV file (PDF/DOCX).
    """
    try:
        result = await cv_parser_service.parse_cv(file, user_id)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Internal server error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error parsing CV")
