"""
Document Parser for PV (Attestation de Bonne Exécution) and Training Sheets.
Uses OCR + regex + LLM fallback to extract structured data from scanned PDFs.

When regex fails to identify key fields, the LLM is invoked to infer
missing information from the raw text, following the same pattern used
in the certification OCR pipeline.
"""
import re
import hashlib
import logging
from typing import Optional, Dict, Any, Tuple
from datetime import datetime, date

import fitz  # PyMuPDF
from app.models.scoring import ParsedPV, ParsedTrainingSheet, DocumentType
from app.config import settings
from app.utils.llm import parse_json_object, call_local_chat

logger = logging.getLogger(__name__)


class DocumentParser:
    """Parses PV and Training Sheet PDFs into structured data."""

    # ── Regex Patterns ───────────────────────────────────────────────────

    # PV patterns
    PV_KEYWORDS = re.compile(
        r"attestation\s+de\s+bonne\s+ex[eé]cution|"
        r"attestation|"
        r"certifie\s+que|"
        r"atteste\s+que",
        re.IGNORECASE,
    )
    PROJECT_PATTERN = re.compile(
        r"(?:le\s+)?projet\s+(?:de\s+)?(.+?)(?:\s+a\s+[eé]t[eé]|\s+r[eé]alis[eé])",
        re.IGNORECASE,
    )
    CLIENT_PATTERN = re.compile(
        r"(?:le\s+client|la\s+soci[eé]t[eé]|client)\s+([A-ZÀ-Ü][A-Za-zÀ-ü\s\-\.]+?)(?:\s+atteste|\s+certifie|\s+confirme)",
        re.IGNORECASE,
    )
    COMPLETION_PATTERN = re.compile(
        r"(?:r[eé]alis[eé]s?\s+avec\s+succ[eè]s|bonne\s+ex[eé]cution|entière\s+satisfaction|travaux\s+ont\s+[eé]t[eé]\s+r[eé]alis[eé]s)",
        re.IGNORECASE,
    )
    DATE_PATTERNS = [
        re.compile(r"(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})"),
        re.compile(r"(?:le\s+)?(\d{1,2})\s+(\w+)\s+(\d{4})", re.IGNORECASE),
        re.compile(r"[Tt]unis\s+le\s+(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})"),
    ]
    TEAM_MEMBER_PATTERN = re.compile(
        r"-\s*([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü]+)+)\s*:\s*(.*?)(?:\n|$)",
        re.MULTILINE,
    )
    MARKET_PATTERN = re.compile(
        r"march[eé]\s+[Nn°]+\s*(\S+)",
        re.IGNORECASE,
    )

    # Training sheet patterns
    TRAINING_KEYWORDS = re.compile(
        r"feuille\s+de\s+pr[eé]sence|"
        r"formation\s*:|"
        r"formateur\s*:",
        re.IGNORECASE,
    )
    TRAINING_NAME_PATTERN = re.compile(
        r"[Ff]ormation\s*:\s*(.+?)(?:\n|$)",
    )
    TRAINER_PATTERN = re.compile(
        r"[Ff]ormateur\s*:\s*(.+?)(?:\n|$)",
    )
    TRAINING_CLIENT_PATTERN = re.compile(
        r"[Cc]lient\s*:\s*(.+?)(?:\n|$)",
    )
    LOCATION_PATTERN = re.compile(
        r"[Ll]ieu\s*:\s*(.+?)(?:\n|$)",
    )
    TRAINING_DATE_PATTERN = re.compile(
        r"[Dd]ate\s*:\s*[Dd]u\s+(\d{1,2}[/\-]\d{1,2}[/\-]\d{4})\s+[Aa]u\s+(\d{1,2}[/\-]\d{1,2}[/\-]\d{4})",
    )
    PARTICIPANT_PATTERN = re.compile(
        r"^([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü][a-zà-ü]*)*)\s*$",
        re.MULTILINE,
    )

    FRENCH_MONTHS = {
        "janvier": 1, "février": 2, "mars": 3, "avril": 4,
        "mai": 5, "juin": 6, "juillet": 7, "août": 8,
        "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12,
        "fevrier": 2, "aout": 8,
    }

    # ── Public API ───────────────────────────────────────────────────────

    def compute_file_hash(self, file_bytes: bytes) -> str:
        """Compute SHA-256 hash of file content for deduplication."""
        return hashlib.sha256(file_bytes).hexdigest()

    def detect_document_type(self, text: str) -> DocumentType:
        """Classify document as PV or Training Sheet based on content."""
        pv_score = len(self.PV_KEYWORDS.findall(text))
        training_score = len(self.TRAINING_KEYWORDS.findall(text))

        # Training sheets have specific form fields
        if training_score > 0 and ("Formateur" in text or "formateur" in text):
            return DocumentType.TRAINING_SHEET
        if pv_score > 0:
            return DocumentType.PV

        # Fallback: check for more specific indicators
        if "feuille de présence" in text.lower() or "feuille de presence" in text.lower():
            return DocumentType.TRAINING_SHEET
        return DocumentType.PV

    def extract_text_from_pdf(self, file_path: str) -> str:
        """Extract text from PDF using PyMuPDF, with OCR fallback."""
        try:
            doc = fitz.open(file_path)
            full_text = ""
            for page in doc:
                text = page.get_text("text")
                if text.strip():
                    full_text += text + "\n"
                else:
                    # OCR fallback for scanned pages
                    full_text += self._ocr_page(page) + "\n"
            doc.close()
            return full_text.strip()
        except Exception as e:
            logger.error(f"Failed to extract text from PDF: {e}")
            raise

    def parse_pv(self, text: str) -> ParsedPV:
        """Parse a PV (Attestation de Bonne Exécution) from extracted text."""
        assumptions = []
        result = ParsedPV(raw_text=text[:2000])

        # 1. Extract project name
        project_match = self.PROJECT_PATTERN.search(text)
        if project_match:
            result.project_name = project_match.group(1).strip()
        else:
            # Try alternative: look for quoted project names or after "projet"
            alt = re.search(r"projet\s+(.+?)(?:\.|,|\n)", text, re.IGNORECASE)
            if alt:
                result.project_name = alt.group(1).strip()
                assumptions.append("Nom du projet extrait via pattern alternatif")

        # 2. Extract client name
        client_match = self.CLIENT_PATTERN.search(text)
        if client_match:
            result.client_name = client_match.group(1).strip()
        else:
            # Try: "Le client X atteste" or organization name from header
            alt_client = re.search(
                r"(?:La|Le)\s+([A-ZÀ-Ü][A-Za-zÀ-ü\s\-\.]+?)\s+(?:certifie|atteste|confirme)",
                text,
            )
            if alt_client:
                result.client_name = alt_client.group(1).strip()
                assumptions.append("Client extrait via pattern alternatif")

        # 3. Extract organization context (e.g., SNDP, STEG)
        org_match = re.search(
            r"(?:SOCIETE|société|la\s+)([A-ZÀ-Ü\s]+?)(?:\s+atteste|\s+certifie|\s+confirme)",
            text,
            re.IGNORECASE,
        )
        if org_match:
            result.organization_context = org_match.group(1).strip()

        # 4. Completion confirmation
        result.completion_confirmed = bool(self.COMPLETION_PATTERN.search(text))

        # 5. Extract date
        result.completion_date = self._extract_date(text)
        if not result.completion_date:
            assumptions.append("Date non trouvée dans le document")

        # 6. Extract team members with roles
        result.team_members = self._extract_team_members(text)

        # 7. Market reference (specific to some PVs like STEG)
        market_match = self.MARKET_PATTERN.search(text)
        if market_match:
            if not result.project_name:
                result.project_name = f"Marché {market_match.group(1)}"
                assumptions.append("Nom de projet dérivé du numéro de marché")

        result.assumptions = assumptions
        return result

    def parse_training_sheet(self, text: str) -> ParsedTrainingSheet:
        """Parse a Training Attendance Sheet (Feuille de Présence)."""
        assumptions = []
        result = ParsedTrainingSheet(raw_text=text[:2000])

        # 1. Training name
        name_match = self.TRAINING_NAME_PATTERN.search(text)
        if name_match:
            result.training_name = name_match.group(1).strip()

        # 2. Trainer name
        trainer_match = self.TRAINER_PATTERN.search(text)
        if trainer_match:
            result.trainer_name = trainer_match.group(1).strip()

        # 3. Client name
        client_match = self.TRAINING_CLIENT_PATTERN.search(text)
        if client_match:
            result.client_name = client_match.group(1).strip()

        # 4. Location
        loc_match = self.LOCATION_PATTERN.search(text)
        if loc_match:
            result.location = loc_match.group(1).strip()

        # 5. Dates
        date_match = self.TRAINING_DATE_PATTERN.search(text)
        if date_match:
            result.start_date = self._parse_date_string(date_match.group(1))
            result.end_date = self._parse_date_string(date_match.group(2))

        # 6. Participants (from the attendance table)
        # Look for names in the Nom & Prénom column area
        participants = []
        name_section = re.findall(
            r"(?:^|\n)\s*([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü][a-zà-ü]*)+)\s*(?:\n|$)",
            text,
        )
        # Filter out known non-participant names (trainer, form header items)
        trainer_normalized = (result.trainer_name or "").lower().strip()
        for name in name_section:
            normalized = name.strip()
            if (
                normalized.lower() != trainer_normalized
                and len(normalized) > 3
                and not any(
                    kw in normalized.lower()
                    for kw in ["formation", "formateur", "journée", "signature", "société", "next step", "formulaire"]
                )
            ):
                if normalized not in participants:
                    participants.append(normalized)

        result.participants = participants
        result.participant_count = len(participants)

        if not result.training_name:
            assumptions.append("Nom de formation non trouvé, vérification manuelle requise")
        if not result.trainer_name:
            assumptions.append("Nom du formateur non identifié")

        result.assumptions = assumptions
        logger.info(
            "Training sheet regex parse: training_name=%s trainer_name=%s start_date=%s participant_count=%s assumptions=%s",
            bool(result.training_name),
            bool(result.trainer_name),
            result.start_date.isoformat() if result.start_date else None,
            result.participant_count,
            assumptions,
        )
        return result

    def parse_document(self, file_path: str, file_bytes: bytes) -> Dict[str, Any]:
        """
        Main entry point: detect type, parse, and return structured data with hash.
        
        Returns:
            {
                "document_type": "pv" | "training_sheet",
                "file_hash": str,
                "parsed_data": ParsedPV | ParsedTrainingSheet,
                "is_duplicate": False  (caller checks against DB)
            }
        """
        file_hash = self.compute_file_hash(file_bytes)
        text = self.extract_text_from_pdf(file_path)
        doc_type = self.detect_document_type(text)

        if doc_type == DocumentType.TRAINING_SHEET:
            parsed = self.parse_training_sheet(text)
            # LLM fallback for missing fields
            if self._training_needs_llm(parsed):
                logger.info(
                    "Training sheet parsing incomplete after regex: missing_training_name=%s missing_trainer_name=%s missing_start_date=%s — invoking LLM inference",
                    not parsed.training_name,
                    not parsed.trainer_name,
                    not parsed.start_date,
                )
                parsed = self._llm_infer_training(text, parsed)
            logger.info(
                "Training sheet final parse: training_name=%s trainer_name=%s start_date=%s participant_count=%s assumptions=%s",
                bool(parsed.training_name),
                bool(parsed.trainer_name),
                parsed.start_date.isoformat() if parsed.start_date else None,
                parsed.participant_count,
                parsed.assumptions,
            )
            if not parsed.trainer_name:
                logger.warning(
                    "Training sheet parsing finished without trainer_name; backend validation should reject this document"
                )
        else:
            parsed = self.parse_pv(text)
            # LLM fallback for missing fields
            if self._pv_needs_llm(parsed):
                logger.info("PV has missing fields — invoking LLM inference")
                parsed = self._llm_infer_pv(text, parsed)

        return {
            "document_type": doc_type.value,
            "file_hash": file_hash,
            "parsed_data": parsed.model_dump(mode="json"),
            "raw_text_preview": text[:500],
        }

    # ── Private Helpers ──────────────────────────────────────────────────

    def _ocr_page(self, page) -> str:
        """OCR a single PDF page using Tesseract if available."""
        try:
            import pytesseract
            from PIL import Image
            import io

            pix = page.get_pixmap(dpi=300)
            img_bytes = pix.tobytes("png")
            img = Image.open(io.BytesIO(img_bytes))
            text = pytesseract.image_to_string(img, lang="fra+eng")
            return text
        except Exception as e:
            logger.warning(f"OCR fallback failed: {e}")
            return ""

    def _extract_date(self, text: str) -> Optional[date]:
        """Try multiple date patterns to find a date in the text."""
        # Pattern: "Tunis le DD/MM/YYYY"
        tunis_match = re.search(
            r"[Tt]unis\s+le\s+(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})", text
        )
        if tunis_match:
            try:
                return date(
                    int(tunis_match.group(3)),
                    int(tunis_match.group(2)),
                    int(tunis_match.group(1)),
                )
            except ValueError:
                pass

        # Pattern: DD/MM/YYYY anywhere
        date_match = re.search(r"(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})", text)
        if date_match:
            day, month, year = (
                int(date_match.group(1)),
                int(date_match.group(2)),
                int(date_match.group(3)),
            )
            try:
                return date(year, month, day)
            except ValueError:
                # Try swapping day/month
                try:
                    return date(year, day, month)
                except ValueError:
                    pass

        # Pattern: "DD month YYYY" in French
        fr_date = re.search(
            r"(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre)\s+(\d{4})",
            text,
            re.IGNORECASE,
        )
        if fr_date:
            month_num = self.FRENCH_MONTHS.get(fr_date.group(2).lower())
            if month_num:
                try:
                    return date(int(fr_date.group(3)), month_num, int(fr_date.group(1)))
                except ValueError:
                    pass

        return None

    def _parse_date_string(self, date_str: str) -> Optional[date]:
        """Parse a DD/MM/YYYY date string."""
        for fmt in ("%d/%m/%Y", "%d-%m-%Y"):
            try:
                return datetime.strptime(date_str.strip(), fmt).date()
            except ValueError:
                continue
        return None

    def _extract_team_members(self, text: str) -> list:
        """Extract team members and their roles from PV text."""
        members = []
        # Pattern: "- Name NAME : role"
        pattern = re.compile(
            r"-\s*([A-ZÀ-Üa-zà-ü][A-Za-zÀ-ü\s]+?)\s*:\s*(.*?)(?:\n|$)",
            re.MULTILINE,
        )
        for match in pattern.finditer(text):
            name = match.group(1).strip()
            role_text = match.group(2).strip().lower()

            # Classify role
            if "chef de projet" in role_text and "technique" not in role_text:
                role = "project_lead"
            elif "chef de projet technique" in role_text:
                role = "technical_lead"
            else:
                role = "contributor"

            members.append({"name": name, "role": role})

        return members

    # ── LLM Fallback Inference ───────────────────────────────────────────

    def _pv_needs_llm(self, parsed: ParsedPV) -> bool:
        """Check if the PV has critical missing fields that LLM could fill."""
        return (
            not parsed.project_name
            or not parsed.client_name
            or not parsed.completion_date
            or not parsed.team_members
        )

    def _training_needs_llm(self, parsed: ParsedTrainingSheet) -> bool:
        """Check if the training sheet has critical missing fields."""
        return (
            not parsed.training_name
            or not parsed.trainer_name
            or not parsed.start_date
        )

    def _llm_infer_pv(self, text: str, current: ParsedPV) -> ParsedPV:
        """Use local LLM to infer missing PV fields from the raw text."""
        try:
            prompt = (
                "Tu es un assistant qui extrait des informations de documents administratifs tunisiens.\n"
                "Voici le texte extrait d'un PV (Attestation de Bonne Exécution).\n"
                "Extrais les informations suivantes en JSON :\n"
                '- "project_name": nom du projet (null si inconnu)\n'
                '- "client_name": nom du client/société qui a commandé le projet (null si inconnu)\n'
                '- "completion_date": date au format YYYY-MM-DD (null si inconnue)\n'
                '- "organization_context": contexte organisationnel (null si inconnu)\n'
                '- "team_members": liste des membres de l\'équipe qui ont réalisé le projet.\n'
                '  Format: [{"name": "Prénom NOM", "role": "project_lead|technical_lead|contributor"}]\n'
                '  Règles de classification du rôle :\n'
                '  - "chef de projet" (sans "technique") → "project_lead"\n'
                '  - "chef de projet technique" → "technical_lead"\n'
                '  - "intervenant", "intervenante" ou tout autre rôle → "contributor"\n'
                '  Retourne [] si aucun membre trouvé.\n\n'
                "Retourne UNIQUEMENT un objet JSON valide, sans markdown ni backticks.\n\n"
                f"Texte du document :\n{text[:3000]}"
            )

            preferred_model = (
                str(settings.LOCAL_SCORING_MODEL or "").strip()
                or str(settings.GROQ_SCORING_MODEL or "").strip()
            )
            raw = call_local_chat(
                messages=[{"role": "user", "content": prompt}],
                model=preferred_model or None,
                temperature=0.0,
                timeout=settings.GROQ_TIMEOUT_SECONDS,
                max_tokens=1000,
                disable_streaming=True,
            )
            data = parse_json_object(raw)

            if not data:
                return current

            if not current.project_name and data.get("project_name"):
                current.project_name = data["project_name"]
                current.assumptions.append("Nom du projet inféré par IA")
            if not current.client_name and data.get("client_name"):
                current.client_name = data["client_name"]
                current.assumptions.append("Client inféré par IA")
            if not current.completion_date and data.get("completion_date"):
                try:
                    current.completion_date = date.fromisoformat(data["completion_date"])
                    current.assumptions.append("Date de complétion inférée par IA")
                except (ValueError, TypeError):
                    pass
            if not current.organization_context and data.get("organization_context"):
                current.organization_context = data["organization_context"]
            # Always merge team_members from LLM if regex found nothing
            if not current.team_members and data.get("team_members"):
                members_raw = data["team_members"]
                if isinstance(members_raw, list):
                    valid_roles = {"project_lead", "technical_lead", "contributor"}
                    current.team_members = [
                        {
                            "name": m.get("name", "").strip(),
                            "role": m.get("role", "contributor")
                            if m.get("role") in valid_roles
                            else "contributor",
                        }
                        for m in members_raw
                        if isinstance(m, dict) and m.get("name")
                    ]
                    if current.team_members:
                        current.assumptions.append("Membres d'équipe inférés par IA")

            return current
        except Exception as e:
            logger.warning(f"LLM inference for PV failed: {e}")
            current.assumptions.append(f"Inférence IA échouée: {e}")
            return current

    def _llm_infer_training(self, text: str, current: ParsedTrainingSheet) -> ParsedTrainingSheet:
        """Use LLM to infer missing training sheet fields from the raw text."""
        try:
            prompt = (
                "Tu es un assistant qui extrait des informations de feuilles de présence de formation.\n"
                "Voici le texte extrait d'une feuille de présence.\n"
                "Extrais les informations suivantes en JSON :\n"
                '- "training_name": nom de la formation (null si inconnu)\n'
                '- "trainer_name": nom du formateur (null si inconnu)\n'
                '- "client_name": nom du client (null si inconnu)\n'
                '- "location": lieu de la formation (null si inconnu)\n'
                '- "start_date": date de début au format YYYY-MM-DD (null si inconnue)\n'
                '- "end_date": date de fin au format YYYY-MM-DD (null si inconnue)\n\n'
                "Retourne UNIQUEMENT un objet JSON valide, sans markdown ni backticks.\n\n"
                f"Texte du document :\n{text[:3000]}"
            )

            preferred_model = (
                str(settings.LOCAL_SCORING_MODEL or "").strip()
                or str(settings.GROQ_SCORING_MODEL or "").strip()
            )
            raw = call_local_chat(
                messages=[{"role": "user", "content": prompt}],
                model=preferred_model or None,
                temperature=0.0,
                timeout=settings.GROQ_TIMEOUT_SECONDS,
                max_tokens=1000,
                disable_streaming=True,
            )
            data = parse_json_object(raw)

            if not data:
                return current

            # Merge conservatively
            if not current.training_name and data.get("training_name"):
                current.training_name = data["training_name"]
                current.assumptions.append("Nom de formation inféré par IA")
            if not current.trainer_name and data.get("trainer_name"):
                current.trainer_name = data["trainer_name"]
                current.assumptions.append("Formateur inféré par IA")
            if not current.client_name and data.get("client_name"):
                current.client_name = data["client_name"]
            if not current.location and data.get("location"):
                current.location = data["location"]
            if not current.start_date and data.get("start_date"):
                try:
                    current.start_date = date.fromisoformat(data["start_date"])
                    current.assumptions.append("Date de début inférée par IA")
                except (ValueError, TypeError):
                    pass
            if not current.end_date and data.get("end_date"):
                try:
                    current.end_date = date.fromisoformat(data["end_date"])
                except (ValueError, TypeError):
                    pass

            return current
        except Exception as e:
            logger.warning(f"LLM inference for training sheet failed: {e}")
            current.assumptions.append(f"Inférence IA échouée: {e}")
            return current
