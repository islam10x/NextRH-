"""
CV Generation — Error Hierarchy & Categorization
==================================================
Typed exception classes for every failure mode in the CV pipeline.
All exceptions carry a machine-readable ``category`` for structured logging
and a human-readable ``detail`` for API responses.

Categories:
    validation  — input data is malformed or incomplete
    template    — template file is corrupt, unsupported, or structurally invalid
    io          — file-system / temp-dir / zip read-write failures
    render      — replacement / section-build / textbox logic errors
    export      — PDF conversion failures
    external    — Groq / third-party API failures
"""


class CVGenerationError(Exception):
    """Base class for all CV generation errors."""

    category: str = "unknown"

    def __init__(self, detail: str, *, cause: Exception | None = None):
        self.detail = detail
        self.cause = cause
        super().__init__(detail)


class CVValidationError(CVGenerationError):
    """Input data failed schema or business-rule validation."""
    category = "validation"


class CVTemplateError(CVGenerationError):
    """Template file is corrupt, unsupported, or structurally invalid."""
    category = "template"


class CVIOError(CVGenerationError):
    """File-system operation (read/write/zip) failed."""
    category = "io"


class CVRenderError(CVGenerationError):
    """Replacement, section-build, or textbox logic error."""
    category = "render"


class CVExportError(CVGenerationError):
    """PDF conversion failed."""
    category = "export"


class CVExternalError(CVGenerationError):
    """Third-party API call (Groq, APILayer) failed."""
    category = "external"
