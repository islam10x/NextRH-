"""
Pydantic models for the Employee Scoring System.
Covers: parsed document data, scoring inputs/outputs, targets, and rankings.
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import date, datetime
from enum import Enum


# ── Enums ────────────────────────────────────────────────────────────────────

class ProjectComplexity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ParticipantRole(str, Enum):
    CONTRIBUTOR = "contributor"
    TECHNICAL_LEAD = "technical_lead"
    PROJECT_LEAD = "project_lead"


class DocumentType(str, Enum):
    PV = "pv"
    TRAINING_SHEET = "training_sheet"


# ── Parsed Document Models ───────────────────────────────────────────────────

class ParsedPV(BaseModel):
    """Structured data extracted from a PV (Attestation de Bonne Exécution)."""
    project_name: Optional[str] = None
    client_name: Optional[str] = None
    organization_context: Optional[str] = None
    completion_confirmed: bool = False
    completion_date: Optional[date] = None
    team_members: List[Dict[str, str]] = Field(default_factory=list)
    raw_text: Optional[str] = None
    assumptions: List[str] = Field(default_factory=list)


class ParsedTrainingSheet(BaseModel):
    """Structured data extracted from a training attendance sheet (Feuille de Présence)."""
    training_name: Optional[str] = None
    trainer_name: Optional[str] = None
    client_name: Optional[str] = None
    location: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    participants: List[str] = Field(default_factory=list)
    participant_count: int = 0
    raw_text: Optional[str] = None
    assumptions: List[str] = Field(default_factory=list)


# ── Scoring Models ───────────────────────────────────────────────────────────

class ScoringWeights(BaseModel):
    """Configurable weight fractions for the final score formula.
    Weights must sum to 1.0 (or close). Each weight determines the
    proportion of the final score attributed to its axis.
    E.g. project_weight=0.35 means projects account for 35% of the final score."""
    project_weight: float = 0.35
    certification_weight: float = 0.25
    training_weight: float = 0.20
    formation_weight: float = 0.20


class ScoringTarget(BaseModel):
    """Annual certification target set by managers for an employee.
    The certification score is normalized as (count / target) × 100."""
    profile_id: str
    target_year: int
    certification_target: int = 2


class ProjectScoreInput(BaseModel):
    """Input for computing a single project's contribution to score."""
    project_name: str
    complexity: ProjectComplexity = ProjectComplexity.MEDIUM
    role: ParticipantRole = ParticipantRole.CONTRIBUTOR
    completion_date: Optional[date] = None
    pv_verified: bool = False


class EmployeeScoringInput(BaseModel):
    """All data needed to compute an employee's score."""
    profile_id: str
    score_year: int
    projects: List[ProjectScoreInput] = Field(default_factory=list)
    certification_count: int = 0
    certification_target: int = 2
    training_count: int = 0
    formation_count: int = 0
    weights: ScoringWeights = Field(default_factory=ScoringWeights)


class ScoreBreakdown(BaseModel):
    """Detailed score breakdown for transparency."""
    project_score: float = 0.0
    certification_score: float = 0.0
    training_score: float = 0.0
    formation_score: float = 0.0
    final_score: float = 0.0
    project_details: List[Dict[str, Any]] = Field(default_factory=list)
    certification_details: Dict[str, Any] = Field(default_factory=dict)
    training_details: Dict[str, Any] = Field(default_factory=dict)
    formation_details: Dict[str, Any] = Field(default_factory=dict)
    weights_used: ScoringWeights = Field(default_factory=ScoringWeights)
    current_year_only: bool = True


class EmployeeRanking(BaseModel):
    """Ranking info for a single employee."""
    profile_id: str
    employee_name: Optional[str] = None
    final_score: float
    rank_global: Optional[int] = None
    rank_in_team: Optional[int] = None
    percentile: Optional[float] = None
    breakdown: Optional[ScoreBreakdown] = None


class LeaderboardResponse(BaseModel):
    """Full leaderboard response."""
    year: int
    total_employees: int
    rankings: List[EmployeeRanking]
