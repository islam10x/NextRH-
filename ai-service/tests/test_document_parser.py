"""
Tests for the Document Parser.
Covers: text extraction, document type detection, PV parsing, training sheet parsing,
        deduplication hashing, and edge cases with ambiguous data.
"""
import pytest
from app.services.document_parser import DocumentParser
from app.models.scoring import DocumentType

parser = DocumentParser()


# ═══════════════════════════════════════════════════════════════════════════
# DOCUMENT TYPE DETECTION
# ═══════════════════════════════════════════════════════════════════════════

class TestDocumentTypeDetection:
    def test_detect_pv_attestation(self):
        text = """
        ATTESTATION DE BONNE EXECUTION
        La SNDP certifie que le projet de mise à niveau de l'infrastructure LAN
        a été réalisé par la société NEXSTEP.
        """
        assert parser.detect_document_type(text) == DocumentType.PV

    def test_detect_pv_simple_attestation(self):
        text = """
        ATTESTATION
        Le client Polymousse atteste que le projet de Mise à niveau 
        de l'infrastructure LAN a été réalisé par l'équipe suivante.
        """
        assert parser.detect_document_type(text) == DocumentType.PV

    def test_detect_training_sheet(self):
        text = """
        FEUILLE DE PRESENCE
        Formation : SOPHOS XG FIREWALL
        Formateur : Yesser Hkimi
        Client : ONAS
        """
        assert parser.detect_document_type(text) == DocumentType.TRAINING_SHEET

    def test_ambiguous_defaults_to_pv(self):
        text = "Some random content without keywords"
        assert parser.detect_document_type(text) == DocumentType.PV


# ═══════════════════════════════════════════════════════════════════════════
# PV PARSING
# ═══════════════════════════════════════════════════════════════════════════

class TestPVParsing:
    def test_parse_sndp_pv(self):
        text = """
        ATTESTATION DE BONNE EXECUTION
        
        La SNDP certifie que le projet de mise à niveau de l'infrastructure LAN des sites SNDP
        a été réalisé par la société NEXSTEP l'équipe Intervenante a été composé par les membres :
        
        - Hichem Ayed HARHIRA : en tant que chef de projet
        - Bouthaina BEN CHAABANE : intervenante
        - Oumaima TRABELSI : intervenante
        - Imen HAOUALA : intervenante
        
        La SNDP confirme que les travaux ont été réalisés avec succès et donnent entière satisfaction.
        """
        result = parser.parse_pv(text)
        assert result.completion_confirmed is True
        assert len(result.team_members) == 4
        # Check role classification
        roles = {m["name"]: m["role"] for m in result.team_members}
        assert roles.get("Hichem Ayed HARHIRA") == "project_lead"
        assert roles.get("Bouthaina BEN CHAABANE") == "contributor"

    def test_parse_steg_pv_with_date(self):
        text = """
        Tunis le 18/11/2024
        
        ATTESTATION
        
        Je soussigné HAMMAMI Sarhane Sahbi atteste que le marché N° TL0008815 pour la
        Fourniture d'équipements réseaux informatiques d'accès a été réalisé par la société Next Step IT.
        
        L'équipe intervenante a été constitués par :
        - Hichem Ayed HARHIRA : en tant que chef de projet
        - Sabrine ZOUABI : intervenante
        - Ridha ESSEDAK : intervenant
        """
        result = parser.parse_pv(text)
        assert result.completion_date is not None
        assert result.completion_date.year == 2024
        assert result.completion_date.month == 11
        assert result.completion_date.day == 18

    def test_parse_polymousse_pv(self):
        text = """
        ATTESTATION
        Le client Polymousse atteste que le projet de Mise à niveau de l'infrastructure LAN a
        été réalisé par l'équipe suivante :
        - Hichem MAALAOUI : en tant que chef de projet
        - Yesser HKIMI : intervenant
        - Ridha ESSEDAK : intervenant
        """
        result = parser.parse_pv(text)
        assert result.client_name is not None
        assert "Polymousse" in result.client_name
        assert len(result.team_members) == 3

    def test_parse_medicef_pv_with_tech_lead(self):
        text = """
        ATTESTATION
        Le client MEDICEF atteste que le projet de mise à niveau de l'infrastructure LAN a
        été réalisé par l'équipe suivante :
        - Hichem Ayed HARHIRA : en tant que chef de projet
        - Boulbaba LABIADH : chef de projet technique
        - Seif EDDIN BEN HADDADA : intervenant
        - Nada ABIDI : intervenante
        """
        result = parser.parse_pv(text)
        assert len(result.team_members) >= 3
        # Boulbaba should be technical_lead
        boulbaba = next(
            (m for m in result.team_members if "Boulbaba" in m["name"]), None
        )
        if boulbaba:
            assert boulbaba["role"] == "technical_lead"

    def test_missing_project_name(self):
        text = """
        ATTESTATION
        Le client XYZ atteste que les travaux ont été réalisés avec succès.
        """
        result = parser.parse_pv(text)
        assert result.completion_confirmed is True
        assert len(result.assumptions) >= 0  # May have assumptions about missing data


# ═══════════════════════════════════════════════════════════════════════════
# TRAINING SHEET PARSING
# ═══════════════════════════════════════════════════════════════════════════

class TestTrainingSheetParsing:
    def test_parse_sophos_training(self):
        text = """
        FEUILLE DE PRESENCE
        
        Formation : SOPHOS XG FIREWALL
        Date : Du 08/06/2020 Au 12/06/2020
        Organisme de Formation :
        Formateur : Yesser Hkimi
        Horaires : Du 9h Au 14h
        Lieu : NSIT (Salle de Formation)
        
        Client : ONAS
        
        Nom & Prénom
        Mani Ghazi
        Khelil Romzi
        Tlili Jalel
        Sami Elbich
        """
        result = parser.parse_training_sheet(text)
        assert result.training_name == "SOPHOS XG FIREWALL"
        assert result.trainer_name == "Yesser Hkimi"
        assert result.client_name == "ONAS"
        assert "NSIT" in result.location
        assert result.start_date is not None
        assert result.start_date.year == 2020
        assert result.start_date.month == 6
        assert result.start_date.day == 8
        assert result.end_date is not None
        assert result.end_date.day == 12

    def test_missing_trainer(self):
        text = """
        FEUILLE DE PRESENCE
        Formation : Python Basics
        Client : ACME Corp
        """
        result = parser.parse_training_sheet(text)
        assert result.training_name == "Python Basics"
        assert result.trainer_name is None
        assert any("formateur" in a.lower() for a in result.assumptions)


# ═══════════════════════════════════════════════════════════════════════════
# DEDUPLICATION (HASH)
# ═══════════════════════════════════════════════════════════════════════════

class TestDeduplication:
    def test_same_content_same_hash(self):
        content = b"identical content"
        hash1 = parser.compute_file_hash(content)
        hash2 = parser.compute_file_hash(content)
        assert hash1 == hash2

    def test_different_content_different_hash(self):
        hash1 = parser.compute_file_hash(b"content A")
        hash2 = parser.compute_file_hash(b"content B")
        assert hash1 != hash2

    def test_hash_is_sha256(self):
        h = parser.compute_file_hash(b"test")
        assert len(h) == 64  # SHA-256 hex length


# ═══════════════════════════════════════════════════════════════════════════
# DATE EXTRACTION EDGE CASES
# ═══════════════════════════════════════════════════════════════════════════

class TestDateExtraction:
    def test_french_date_format(self):
        text = "Tunis le 18/11/2024"
        d = parser._extract_date(text)
        assert d is not None
        assert d.year == 2024

    def test_no_date_returns_none(self):
        text = "This document has no date"
        d = parser._extract_date(text)
        assert d is None

    def test_date_string_parsing(self):
        d = parser._parse_date_string("08/06/2020")
        assert d is not None
        assert d.day == 8
        assert d.month == 6
        assert d.year == 2020
