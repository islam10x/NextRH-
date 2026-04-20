"""
Scoring Engine for the Employee Scoring System.

Sub-scores are NOT capped — they can exceed 100 to reward high performers.
- Projects  → sum(10 × complexité × rôle × PV) for projects dated in the score year
- Certifications → (count / target) × 100
- Trainings → count × 10
- Formations dispensées (pour clients) → count × 10

Final score = w_p×ProjectScore + w_c×CertScore + w_t×TrainingScore + w_f×FormationScore
where weights are fractions summing to 1.0 (e.g. 0.35, 0.25, 0.20, 0.20).
"""
import logging
from typing import List, Dict, Any, Optional
from datetime import date, datetime

from app.models.scoring import (
    EmployeeScoringInput,
    ProjectScoreInput,
    ScoreBreakdown,
    ScoringWeights,
    ProjectComplexity,
    ParticipantRole,
    EmployeeRanking,
    LeaderboardResponse,
)

logger = logging.getLogger(__name__)


# ── Constants ────────────────────────────────────────────────────────────────

COMPLEXITY_WEIGHTS: Dict[ProjectComplexity, float] = {
    ProjectComplexity.LOW: 1.0,
    ProjectComplexity.MEDIUM: 2.0,
    ProjectComplexity.HIGH: 3.5,
}

ROLE_MULTIPLIERS: Dict[ParticipantRole, float] = {
    ParticipantRole.CONTRIBUTOR: 1.0,
    ParticipantRole.TECHNICAL_LEAD: 1.3,
    ParticipantRole.PROJECT_LEAD: 1.5,
}

# Points per project unit: each project earns BASE × complexity × role × pv_bonus
PROJECT_BASE_POINTS = 10

# PV verification bonus: projects backed by an official PV score 25% higher
PV_BONUS_MULTIPLIER = 1.25

# Trainings/formations: linear, uncapped (count × POINTS_PER_UNIT)
TRAINING_POINTS = 10   # Each training = 10 pts
FORMATION_POINTS = 10  # Each formation = 10 pts


class ScoringEngine:
    """Computes employee scores with yearly reset semantics. Scores are uncapped."""

    # ── Project Score (0–100) ────────────────────────────────────────────

    def compute_project_score(
        self,
        projects: List[ProjectScoreInput],
        score_year: int,
    ) -> tuple[float, List[Dict[str, Any]]]:
        """
        Compute project score with yearly reset and PV bonus.

        Each project earns: PROJECT_BASE_POINTS × complexity × role × pv_bonus.
        Only projects dated in score_year are counted.
        Score = sum of all project points. Uncapped.
        """
        relevant_projects = [
            proj for proj in projects
            if proj.completion_date and proj.completion_date.year == score_year
        ]

        if not relevant_projects:
            return 0.0, []

        total_raw = 0.0
        details = []

        for proj in relevant_projects:
            # Base points
            complexity_w = COMPLEXITY_WEIGHTS.get(proj.complexity, 2.0)
            role_m = ROLE_MULTIPLIERS.get(proj.role, 1.0)
            base_points = complexity_w * role_m

            # PV verification bonus
            pv_bonus = PV_BONUS_MULTIPLIER if proj.pv_verified else 1.0

            weighted_points = PROJECT_BASE_POINTS * base_points * pv_bonus
            total_raw += weighted_points

            details.append({
                "project_name": proj.project_name,
                "complexity": proj.complexity.value,
                "role": proj.role.value,
                "pv_verified": proj.pv_verified,
                "base_points": round(base_points, 2),
                "pv_bonus": round(pv_bonus, 2),
                "weighted_points": round(weighted_points, 2),
            })

        # Sum of project points (uncapped)
        return round(total_raw, 2), details

    # ── Certification Score (0–100) ──────────────────────────────────────

    def compute_certification_score(
        self,
        cert_count: int,
        target: int,
    ) -> tuple[float, Dict[str, Any]]:
        """
        Certification score: (count / target) × 100, uncapped.
        If target is 0 or negative, treat as 1 to avoid division by zero.
        """
        effective_target = max(target, 1)
        ratio = cert_count / effective_target
        score = round(ratio * 100, 2)

        details = {
            "certifications_count": cert_count,
            "target": target,
            "effective_target": effective_target,
            "ratio": round(ratio, 4),
            "score": score,
        }
        return score, details

    # ── Training Score (0–100) ───────────────────────────────────────────

    def compute_training_score(
        self,
        training_count: int,
    ) -> tuple[float, Dict[str, Any]]:
        """
        Training score: count × TRAINING_POINTS. Uncapped.
        Each training = 10 points.
        """
        score = round(training_count * TRAINING_POINTS, 2) if training_count > 0 else 0.0

        details = {
            "training_count": training_count,
            "points_per_training": TRAINING_POINTS,
            "score": score,
        }
        return score, details

    # ── Formation Score (0–100) ──────────────────────────────────────────

    def compute_formation_score(
        self,
        formation_count: int,
    ) -> tuple[float, Dict[str, Any]]:
        """
        Formation score (formations dispensées pour clients).
        count × FORMATION_POINTS. Uncapped.
        """
        score = round(formation_count * FORMATION_POINTS, 2) if formation_count > 0 else 0.0

        details = {
            "formation_count": formation_count,
            "points_per_formation": FORMATION_POINTS,
            "score": score,
        }
        return score, details

    # ── Final Score ──────────────────────────────────────────────────────

    def compute_final_score(
        self, scoring_input: EmployeeScoringInput
    ) -> ScoreBreakdown:
        """
        Compute the complete employee score breakdown.

        Sub-scores are uncapped. Final score = weighted sum (uncapped).
        Weights are fractions that sum to 1.0.
        """
        w = scoring_input.weights

        # Project score (0–100)
        proj_score, proj_details = self.compute_project_score(
            scoring_input.projects, scoring_input.score_year
        )

        # Certification score (0–100)
        cert_score, cert_details = self.compute_certification_score(
            scoring_input.certification_count, scoring_input.certification_target
        )

        # Training score (0–100) — assigned by manager, completed by employee
        train_score, train_details = self.compute_training_score(
            scoring_input.training_count
        )

        # Formation score (0–100) — formations dispensées pour clients
        formation_score, formation_details = self.compute_formation_score(
            scoring_input.formation_count
        )

        # Weighted final (uncapped)
        final = (
            w.project_weight * proj_score
            + w.certification_weight * cert_score
            + w.training_weight * train_score
            + w.formation_weight * formation_score
        )

        return ScoreBreakdown(
            project_score=proj_score,
            certification_score=cert_score,
            training_score=train_score,
            formation_score=formation_score,
            final_score=round(final, 2),
            project_details=proj_details,
            certification_details=cert_details,
            training_details=train_details,
            formation_details=formation_details,
            weights_used=w,
            current_year_only=True,
        )

    # ── Ranking ──────────────────────────────────────────────────────────

    def compute_rankings(
        self, scores: List[Dict[str, Any]]
    ) -> List[EmployeeRanking]:
        """
        Compute global rankings and percentiles from a list of employee scores.

        Args:
            scores: List of dicts with {profile_id, employee_name, final_score, breakdown}

        Returns:
            Sorted list of EmployeeRanking (rank 1 = highest)
        """
        if not scores:
            return []

        # Sort by final_score descending
        sorted_scores = sorted(scores, key=lambda x: x["final_score"], reverse=True)
        total = len(sorted_scores)

        rankings = []
        for idx, entry in enumerate(sorted_scores):
            rank = idx + 1
            # Percentile: % of employees scored below this one
            percentile = ((total - rank) / total) * 100 if total > 1 else 100.0

            rankings.append(
                EmployeeRanking(
                    profile_id=entry["profile_id"],
                    employee_name=entry.get("employee_name"),
                    final_score=entry["final_score"],
                    rank_global=rank,
                    percentile=round(percentile, 1),
                    breakdown=entry.get("breakdown"),
                )
            )

        return rankings

    def compute_team_rankings(
        self,
        all_rankings: List[EmployeeRanking],
        team_profile_ids: List[str],
    ) -> List[EmployeeRanking]:
        """
        Assign team-specific ranks to employees within a team.

        Args:
            all_rankings: Global rankings (already sorted)
            team_profile_ids: Profile IDs belonging to the team

        Returns:
            Team members with rank_in_team assigned
        """
        team_set = set(team_profile_ids)
        team_members = [r for r in all_rankings if r.profile_id in team_set]

        # Sort within team
        team_members.sort(key=lambda x: x.final_score, reverse=True)
        for idx, member in enumerate(team_members):
            member.rank_in_team = idx + 1

        return team_members
