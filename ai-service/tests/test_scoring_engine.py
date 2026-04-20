"""
Tests for the Employee Scoring Engine.
Covers: project scoring (current-year only, PV bonus), certification scoring
(target-based), training scoring (linear, uncapped), formation scoring,
final score computation (uncapped), rankings, and edge cases.
"""
import pytest
from datetime import date

from app.services.scoring_engine import ScoringEngine, PROJECT_BASE_POINTS
from app.models.scoring import (
    EmployeeScoringInput,
    ProjectScoreInput,
    ScoringWeights,
    ProjectComplexity,
    ParticipantRole,
)

engine = ScoringEngine()


# ═══════════════════════════════════════════════════════════════════════════
# PROJECT SCORE TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestProjectScore:
    def test_no_projects_returns_zero(self):
        score, details = engine.compute_project_score([], 2026)
        assert score == 0.0
        assert details == []

    def test_single_medium_contributor(self):
        projects = [
            ProjectScoreInput(
                project_name="LAN SNDP",
                complexity=ProjectComplexity.MEDIUM,
                role=ParticipantRole.CONTRIBUTOR,
                completion_date=date(2026, 1, 1),
            )
        ]
        score, details = engine.compute_project_score(projects, 2026)
        # base = 2.0 * 1.0 = 2.0, × PROJECT_BASE_POINTS(10) = 20.0
        assert score == 20.0
        assert len(details) == 1
        assert details[0]["weighted_points"] == 20.0

    def test_high_complexity_lead(self):
        projects = [
            ProjectScoreInput(
                project_name="Data Center Tunisair",
                complexity=ProjectComplexity.HIGH,
                role=ParticipantRole.PROJECT_LEAD,
                completion_date=date(2026, 6, 1),
            )
        ]
        score, details = engine.compute_project_score(projects, 2026)
        # base = 3.5 * 1.5 = 5.25, × 10 = 52.5
        assert score == 52.5

    def test_multiple_projects_accumulate(self):
        projects = [
            ProjectScoreInput(
                project_name=f"Project {i}",
                complexity=ProjectComplexity.HIGH,
                role=ParticipantRole.PROJECT_LEAD,
                completion_date=date(2026, 1, 1),
            )
            for i in range(5)
        ]
        score, details = engine.compute_project_score(projects, 2026)
        # 5 * 3.5 * 1.5 * 10 = 262.5
        assert score == 262.5

    def test_score_capped_at_100(self):
        projects = [
            ProjectScoreInput(
                project_name=f"Project {i}",
                complexity=ProjectComplexity.HIGH,
                role=ParticipantRole.PROJECT_LEAD,
                completion_date=date(2026, 1, 1),
            )
            for i in range(10)
        ]
        score, _ = engine.compute_project_score(projects, 2026)
        assert score == 525.0  # 10 * 3.5 * 1.5 * 10 = 525 (uncapped)

    def test_projects_outside_score_year_are_ignored(self):
        projects = [
            ProjectScoreInput(
                project_name="Old Project",
                complexity=ProjectComplexity.MEDIUM,
                role=ParticipantRole.CONTRIBUTOR,
                completion_date=date(2020, 1, 1),  # 6 years old
            )
        ]
        score_old, details = engine.compute_project_score(projects, 2026)
        assert score_old == 0.0
        assert details == []

    def test_pv_verified_bonus(self):
        """Projects with PV verification should score 25% higher."""
        base_project = ProjectScoreInput(
            project_name="LAN SNDP",
            complexity=ProjectComplexity.HIGH,
            role=ParticipantRole.PROJECT_LEAD,
            completion_date=date(2026, 1, 1),
            pv_verified=False,
        )
        pv_project = ProjectScoreInput(
            project_name="LAN SNDP",
            complexity=ProjectComplexity.HIGH,
            role=ParticipantRole.PROJECT_LEAD,
            completion_date=date(2026, 1, 1),
            pv_verified=True,
        )
        score_no_pv, _ = engine.compute_project_score([base_project], 2026)
        score_with_pv, details = engine.compute_project_score([pv_project], 2026)
        # no PV: 3.5 * 1.5 * 10 = 52.5 ; with PV: 52.5 * 1.25 = 65.625 → rounds to 65.62
        assert score_no_pv == 52.5
        assert score_with_pv == 65.62
        assert details[0]["pv_bonus"] == 1.25


# ═══════════════════════════════════════════════════════════════════════════
# CERTIFICATION SCORE TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestCertificationScore:
    def test_zero_certifications(self):
        score, details = engine.compute_certification_score(0, 2)
        assert score == 0.0

    def test_meets_target(self):
        score, details = engine.compute_certification_score(2, 2)
        assert score == 100.0

    def test_exceeds_target_uncapped(self):
        score, details = engine.compute_certification_score(10, 2)
        assert score == 500.0  # 10/2 * 100 = 500 (uncapped)

    def test_partial_completion(self):
        score, details = engine.compute_certification_score(1, 4)
        assert score == 25.0

    def test_zero_target_safe(self):
        score, details = engine.compute_certification_score(3, 0)
        assert score == 300.0  # target becomes 1, 3/1 * 100 = 300 (uncapped)

    def test_fairness_across_targets(self):
        """Employee with 2/2 should score same as 5/5."""
        score1, _ = engine.compute_certification_score(2, 2)
        score2, _ = engine.compute_certification_score(5, 5)
        assert score1 == score2 == 100.0


# ═══════════════════════════════════════════════════════════════════════════
# TRAINING SCORE TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestTrainingScore:
    def test_zero_trainings(self):
        score, details = engine.compute_training_score(0)
        assert score == 0.0

    def test_single_training(self):
        score, details = engine.compute_training_score(1)
        assert score == 10.0  # 1 × 10 = 10

    def test_linear_scoring(self):
        """Each additional training should add the same amount."""
        scores = []
        for count in range(1, 8):
            s, _ = engine.compute_training_score(count)
            scores.append(s)

        # Check constant increment (10 points each)
        deltas = [scores[i + 1] - scores[i] for i in range(len(scores) - 1)]
        for d in deltas:
            assert abs(d - 10.0) < 0.1

    def test_at_ten(self):
        score, _ = engine.compute_training_score(10)
        assert score == 100.0  # 10 × 10 = 100

    def test_beyond_ten_uncapped(self):
        score, _ = engine.compute_training_score(15)
        assert score == 150.0  # 15 × 10 = 150 (uncapped)


# ═══════════════════════════════════════════════════════════════════════════
# FORMATION SCORE TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestFormationScore:
    def test_zero_formations(self):
        score, details = engine.compute_formation_score(0)
        assert score == 0.0

    def test_single_formation(self):
        score, details = engine.compute_formation_score(1)
        assert score == 10.0  # 1 × 10 = 10

    def test_linear_scoring(self):
        """Each formation counts equally."""
        score_5, _ = engine.compute_formation_score(5)
        assert score_5 == 50.0  # 5 × 10 = 50

    def test_at_ten(self):
        score, _ = engine.compute_formation_score(10)
        assert score == 100.0

    def test_beyond_ten_uncapped(self):
        score, _ = engine.compute_formation_score(20)
        assert score == 200.0  # 20 × 10 = 200 (uncapped)


# ═══════════════════════════════════════════════════════════════════════════
# FINAL SCORE TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestFinalScore:
    def test_empty_employee(self):
        inp = EmployeeScoringInput(
            profile_id="test-1",
            score_year=2026,
        )
        breakdown = engine.compute_final_score(inp)
        assert breakdown.final_score == 0.0

    def test_balanced_employee(self):
        inp = EmployeeScoringInput(
            profile_id="test-2",
            score_year=2026,
            projects=[
                ProjectScoreInput(
                    project_name="P1",
                    complexity=ProjectComplexity.HIGH,
                    role=ParticipantRole.PROJECT_LEAD,
                    completion_date=date(2026, 3, 1),
                    pv_verified=True,
                ),
                ProjectScoreInput(
                    project_name="P2",
                    complexity=ProjectComplexity.MEDIUM,
                    role=ParticipantRole.CONTRIBUTOR,
                    completion_date=date(2025, 6, 1),
                ),
            ],
            certification_count=2,
            certification_target=2,
            training_count=3,
        )
        breakdown = engine.compute_final_score(inp)
        assert 0 < breakdown.final_score <= 100
        assert breakdown.project_score > 0
        assert breakdown.certification_score == 100.0
        assert breakdown.training_score > 0

    def test_final_score_uncapped(self):
        """Final score can exceed 100 when sub-scores are high."""
        inp = EmployeeScoringInput(
            profile_id="test-3",
            score_year=2026,
            projects=[
                ProjectScoreInput(
                    project_name=f"P{i}",
                    complexity=ProjectComplexity.HIGH,
                    role=ParticipantRole.PROJECT_LEAD,
                    completion_date=date(2026, 1, 1),
                )
                for i in range(20)
            ],
            certification_count=100,
            certification_target=1,
            training_count=50,
        )
        breakdown = engine.compute_final_score(inp)
        assert breakdown.final_score > 100  # Uncapped

    def test_custom_weights(self):
        inp = EmployeeScoringInput(
            profile_id="test-4",
            score_year=2026,
            certification_count=5,
            certification_target=5,
            weights=ScoringWeights(
                project_weight=0.0,
                certification_weight=1.0,
                training_weight=0.0,
                formation_weight=0.0,
            ),
        )
        breakdown = engine.compute_final_score(inp)
        assert breakdown.final_score == 100.0
        assert breakdown.project_score == 0.0


# ═══════════════════════════════════════════════════════════════════════════
# RANKING TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestRankings:
    def test_empty_rankings(self):
        rankings = engine.compute_rankings([])
        assert rankings == []

    def test_single_employee(self):
        rankings = engine.compute_rankings([
            {"profile_id": "a", "final_score": 75.0}
        ])
        assert len(rankings) == 1
        assert rankings[0].rank_global == 1
        assert rankings[0].percentile == 100.0

    def test_multiple_employees_ordering(self):
        rankings = engine.compute_rankings([
            {"profile_id": "a", "final_score": 50.0},
            {"profile_id": "b", "final_score": 80.0},
            {"profile_id": "c", "final_score": 65.0},
        ])
        assert rankings[0].profile_id == "b"
        assert rankings[0].rank_global == 1
        assert rankings[1].profile_id == "c"
        assert rankings[2].profile_id == "a"
        assert rankings[2].rank_global == 3

    def test_team_rankings(self):
        all_rankings = engine.compute_rankings([
            {"profile_id": "a", "final_score": 90.0},
            {"profile_id": "b", "final_score": 70.0},
            {"profile_id": "c", "final_score": 80.0},
            {"profile_id": "d", "final_score": 60.0},
        ])
        team = engine.compute_team_rankings(all_rankings, ["b", "c"])
        assert len(team) == 2
        assert team[0].profile_id == "c"
        assert team[0].rank_in_team == 1
        assert team[1].profile_id == "b"
        assert team[1].rank_in_team == 2


# ═══════════════════════════════════════════════════════════════════════════
# EDGE CASES
# ═══════════════════════════════════════════════════════════════════════════

class TestEdgeCases:
    def test_project_without_date(self):
        """Projects without dates should not score because the year is unknown."""
        projects = [
            ProjectScoreInput(
                project_name="Undated Project",
                complexity=ProjectComplexity.MEDIUM,
                role=ParticipantRole.CONTRIBUTOR,
                completion_date=None,
            )
        ]
        score, details = engine.compute_project_score(projects, 2026)
        assert score == 0.0
        assert details == []

    def test_future_completion_date(self):
        """Projects outside the score year should be ignored."""
        projects = [
            ProjectScoreInput(
                project_name="Future Project",
                complexity=ProjectComplexity.MEDIUM,
                role=ParticipantRole.CONTRIBUTOR,
                completion_date=date(2028, 1, 1),
            )
        ]
        score, details = engine.compute_project_score(projects, 2026)
        assert score == 0.0
        assert details == []
