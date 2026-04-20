"""
API endpoints for Employee Scoring System.
Handles document parsing, score computation, and ranking.
"""
import os
import logging
from typing import Optional
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Body
from pydantic import BaseModel

from app.services.document_parser import DocumentParser
from app.services.scoring_engine import ScoringEngine
from app.models.scoring import (
    EmployeeScoringInput,
    ScoreBreakdown,
    LeaderboardResponse,
    EmployeeRanking,
)

logger = logging.getLogger(__name__)

router = APIRouter()

document_parser = DocumentParser()
scoring_engine = ScoringEngine()


# ── Document Parsing Endpoints ───────────────────────────────────────────────


@router.post("/parse-document")
async def parse_document(
    file: UploadFile = File(...),
    user_id: str = Form(...),
):
    """
    Parse a PV (Attestation) or Training Sheet PDF.
    Auto-detects document type and extracts structured data.
    Returns parsed fields + file hash for deduplication.
    """
    allowed_extensions = [".pdf"]
    file_ext = os.path.splitext(file.filename or "")[1].lower()
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"Seuls les fichiers PDF sont acceptés. Type reçu: {file_ext}",
        )

    temp_path = None
    try:
        file_bytes = await file.read()
        if len(file_bytes) == 0:
            raise HTTPException(status_code=400, detail="Fichier vide")

        # Save temporarily
        os.makedirs("uploads", exist_ok=True)
        temp_path = f"uploads/{user_id}_scoring_{file.filename}"
        with open(temp_path, "wb") as f:
            f.write(file_bytes)

        # Parse
        result = document_parser.parse_document(temp_path, file_bytes)
        result["original_filename"] = file.filename

        logger.info(
            f"Document parsed: type={result['document_type']}, "
            f"hash={result['file_hash'][:16]}..., user={user_id}"
        )

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error parsing document: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Erreur lors de l'analyse du document: {str(e)}",
        )
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


@router.post("/check-duplicate")
async def check_duplicate(file_hash: str = Form(...)):
    """
    Check if a document hash already exists (for frontend pre-check).
    The actual DB check happens in the NestJS backend; this is a utility endpoint.
    """
    return {"file_hash": file_hash, "message": "Hash received. Check against DB in backend."}


# ── Score Computation Endpoints ──────────────────────────────────────────────


@router.post("/compute-score", response_model=ScoreBreakdown)
async def compute_score(scoring_input: EmployeeScoringInput):
    """
    Compute an employee's score breakdown.
    
    Input: EmployeeScoringInput (projects, cert count, training count, weights, targets)
    Output: ScoreBreakdown with project/cert/training scores + final score
    """
    try:
        breakdown = scoring_engine.compute_final_score(scoring_input)
        logger.info(
            f"Score computed for profile={scoring_input.profile_id}: "
            f"final={breakdown.final_score}"
        )
        return breakdown
    except Exception as e:
        logger.error(f"Error computing score: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Erreur lors du calcul du score: {str(e)}",
        )


class BatchScoreRequest(BaseModel):
    employees: list[EmployeeScoringInput]


class BatchScoreResponse(BaseModel):
    scores: list[dict]
    rankings: list[EmployeeRanking]


@router.post("/compute-scores-batch", response_model=BatchScoreResponse)
async def compute_scores_batch(request: BatchScoreRequest):
    """
    Compute scores for multiple employees and return rankings.
    Used for leaderboard generation.
    """
    try:
        all_scores = []
        for emp_input in request.employees:
            breakdown = scoring_engine.compute_final_score(emp_input)
            all_scores.append({
                "profile_id": emp_input.profile_id,
                "final_score": breakdown.final_score,
                "breakdown": breakdown,
            })

        rankings = scoring_engine.compute_rankings(all_scores)

        return BatchScoreResponse(
            scores=[
                {
                    "profile_id": s["profile_id"],
                    "final_score": s["final_score"],
                    "project_score": s["breakdown"].project_score,
                    "certification_score": s["breakdown"].certification_score,
                    "training_score": s["breakdown"].training_score,
                    "formation_score": s["breakdown"].formation_score,
                }
                for s in all_scores
            ],
            rankings=rankings,
        )
    except Exception as e:
        logger.error(f"Error computing batch scores: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Erreur lors du calcul batch: {str(e)}",
        )
