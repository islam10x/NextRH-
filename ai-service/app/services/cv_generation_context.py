"""
CV Generation — Generation Context & Debug Tracing
====================================================
Provides a structured context object that tracks every phase of the
generation pipeline: timing, decisions, warnings, and intermediate results.

In debug mode, produces a detailed JSON trace file alongside the output DOCX
so developers can diagnose why a particular replacement was or wasn't applied.
"""

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("ai_service.cv_generation_context")


@dataclass
class PhaseResult:
    """Result of a single pipeline phase."""
    name: str
    status: str = "not_started"  # not_started | running | success | failed | skipped
    duration_ms: float = 0.0
    message: str = ""
    warnings: List[str] = field(default_factory=list)
    details: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "name": self.name,
            "status": self.status,
            "duration_ms": round(self.duration_ms, 2),
        }
        if self.message:
            d["message"] = self.message
        if self.warnings:
            d["warnings"] = self.warnings
        if self.details:
            d["details"] = self.details
        if self.error:
            d["error"] = self.error
        return d


@dataclass
class GenerationContext:
    """
    Tracks the entire lifecycle of a CV generation request.

    Usage:
        ctx = GenerationContext(debug=True)
        with ctx.phase("text_extraction") as p:
            ... do work ...
            p.details["paragraphs"] = 42
        # Later:
        ctx.save_trace("/path/to/output_trace.json")
    """
    debug: bool = False
    mode: str = ""  # "placeholder" or "direct"
    template_path: str = ""
    output_path: str = ""
    employee_name: str = ""

    # Tracking
    phases: List[PhaseResult] = field(default_factory=list)
    replacements_applied: int = 0
    replacements_attempted: int = 0
    quality_issues: List[str] = field(default_factory=list)
    validation_warnings: List[str] = field(default_factory=list)
    _start_time: float = field(default_factory=time.time)
    total_duration_ms: float = 0.0

    class _PhaseContextManager:
        """Context manager for tracking a single phase."""
        def __init__(self, ctx: 'GenerationContext', name: str):
            self.ctx = ctx
            self.phase = PhaseResult(name=name)
            self.ctx.phases.append(self.phase)

        def __enter__(self) -> PhaseResult:
            self.phase.status = "running"
            self._start = time.time()
            return self.phase

        def __exit__(self, exc_type, exc_val, exc_tb):
            self.phase.duration_ms = (time.time() - self._start) * 1000
            if exc_type is not None:
                self.phase.status = "failed"
                self.phase.error = f"{exc_type.__name__}: {exc_val}"
                logger.error(
                    f"[gen_ctx] Phase '{self.phase.name}' FAILED: {self.phase.error}"
                )
                # Don't suppress the exception
                return False
            if self.phase.status == "running":
                self.phase.status = "success"
            return False

    def phase(self, name: str) -> '_PhaseContextManager':
        """Start tracking a named phase."""
        return self._PhaseContextManager(self, name)

    def skip_phase(self, name: str, reason: str) -> None:
        """Record that a phase was intentionally skipped."""
        p = PhaseResult(name=name, status="skipped", message=reason)
        self.phases.append(p)

    def warn(self, message: str) -> None:
        """Add a warning that will appear in the trace."""
        self.quality_issues.append(message)
        logger.warning(f"[gen_ctx] {message}")

    def finalize(self) -> None:
        """Call when generation is complete."""
        self.total_duration_ms = (time.time() - self._start_time) * 1000

    @property
    def failed_phases(self) -> List[PhaseResult]:
        return [p for p in self.phases if p.status == "failed"]

    @property
    def success(self) -> bool:
        """True if no critical phases failed."""
        critical = {"text_extraction", "contact_detection", "apply_replacements",
                    "placeholder_render"}
        for p in self.phases:
            if p.name in critical and p.status == "failed":
                return False
        return True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "mode": self.mode,
            "employee_name": self.employee_name,
            "template": os.path.basename(self.template_path),
            "output": os.path.basename(self.output_path),
            "total_duration_ms": round(self.total_duration_ms, 2),
            "replacements": {
                "attempted": self.replacements_attempted,
                "applied": self.replacements_applied,
            },
            "phases": [p.to_dict() for p in self.phases],
            "quality_issues": self.quality_issues,
            "validation_warnings": self.validation_warnings,
            "success": self.success,
        }

    def save_trace(self, trace_path: Optional[str] = None) -> Optional[str]:
        """
        Save the generation trace as JSON.
        Only writes in debug mode, or if there were failures.
        """
        if not self.debug and not self.failed_phases:
            return None

        if trace_path is None:
            if self.output_path:
                trace_path = self.output_path.rsplit('.', 1)[0] + '_trace.json'
            else:
                return None

        try:
            self.finalize()
            with open(trace_path, 'w', encoding='utf-8') as f:
                json.dump(self.to_dict(), f, indent=2, ensure_ascii=False)
            logger.info(f"[gen_ctx] Trace saved: {trace_path}")
            return trace_path
        except Exception as exc:
            logger.warning(f"[gen_ctx] Failed to save trace: {exc}")
            return None

    def get_summary(self) -> str:
        """Human-readable one-line summary."""
        self.finalize()
        phases_ok = sum(1 for p in self.phases if p.status == "success")
        phases_fail = sum(1 for p in self.phases if p.status == "failed")
        return (
            f"CV generation {'OK' if self.success else 'DEGRADED'} "
            f"({self.mode} mode, {self.total_duration_ms:.0f}ms, "
            f"{phases_ok} phases OK, {phases_fail} failed, "
            f"{self.replacements_applied}/{self.replacements_attempted} replacements, "
            f"{len(self.quality_issues)} issues)"
        )
