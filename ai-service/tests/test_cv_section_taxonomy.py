"""Tests for the unified section taxonomy module."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from app.services.cv_section_taxonomy import (
    SECTION_KEYWORDS,
    SECTION_KEYWORDS_NORMALIZED,
    SECTION_DATA_KEY,
    LIST_BACKED_SECTIONS,
    ALL_SECTION_TYPES,
    classify_heading,
    is_section_keyword,
    normalize_text,
    keywords_for,
    SECTION_EXPERIENCE,
    SECTION_EDUCATION,
    SECTION_SKILLS,
    SECTION_CERTIFICATIONS,
    SECTION_PROJECTS,
    SECTION_LANGUAGES,
    SECTION_SUMMARY,
    SECTION_AWARDS,
    SECTION_INTERESTS,
    SECTION_REFERENCES,
    SECTION_VOLUNTEER,
    SECTION_CONTACT,
)


class TestNormalizeText:
    def test_lowercase(self):
        assert normalize_text("EXPERIENCE") == "experience"

    def test_strips_accents(self):
        assert normalize_text("Compétences") == "competences"
        assert normalize_text("Expérience") == "experience"

    def test_strips_trailing_punctuation(self):
        assert normalize_text("Skills:") == "skills"
        assert normalize_text("Skills.") == "skills"
        assert normalize_text("Skills - ") == "skills"

    def test_collapses_whitespace(self):
        assert normalize_text("  Work   Experience  ") == "work experience"

    def test_typographic_quotes(self):
        assert normalize_text("Centres d’intérêt") == "centres d'interet"

    def test_nbsp(self):
        assert normalize_text("Work Experience") == "work experience"

    def test_empty(self):
        assert normalize_text("") == ""
        assert normalize_text(None) == ""


class TestClassifyHeading:
    @pytest.mark.parametrize("text,expected", [
        # Exact matches across languages
        ("Experience", SECTION_EXPERIENCE),
        ("Expériences professionnelles", SECTION_EXPERIENCE),
        ("Berufserfahrung", SECTION_EXPERIENCE),
        ("Esperienza lavorativa", SECTION_EXPERIENCE),
        ("Experiência profissional", SECTION_EXPERIENCE),
        # Partial / extra words
        ("Professional Experience", SECTION_EXPERIENCE),
        ("Work History", SECTION_EXPERIENCE),
        ("Skills Summary", SECTION_SKILLS),
        ("Technical Skills", SECTION_SKILLS),
        ("PARCOURS PROFESSIONNEL", SECTION_EXPERIENCE),
        # Trailing punctuation
        ("SKILLS:", SECTION_SKILLS),
        ("  Education  ", SECTION_EDUCATION),
        # Multi-language
        ("Compétences", SECTION_SKILLS),
        ("Sprachen", SECTION_LANGUAGES),
        ("Idiomas", SECTION_LANGUAGES),
        ("Formation académique", SECTION_EDUCATION),
        ("Profil", SECTION_SUMMARY),
        ("References", SECTION_REFERENCES),
        ("Bénévolat", SECTION_VOLUNTEER),
        ("Centres d'intérêt", SECTION_INTERESTS),
        # Case-insensitive
        ("experience", SECTION_EXPERIENCE),
        ("EXPERIENCE", SECTION_EXPERIENCE),
        ("Experience", SECTION_EXPERIENCE),
    ])
    def test_positive_classifications(self, text, expected):
        assert classify_heading(text) == expected

    @pytest.mark.parametrize("text", [
        "",
        None,
        "Random unrelated heading",
        "Some random sentence with many words that should not match",
        "Description of a project I worked on",
        # False-positive guards: section words appear inside, but not as headings
        "Languages used in Java projects",
        "Formation continue interne pour les nouveaux developpeurs",
        # Long sentences must not match even if they contain a keyword
        "I have considerable experience working with multiple teams across the world",
    ])
    def test_negative_classifications(self, text):
        assert classify_heading(text) is None

    def test_strict_mode_rejects_unregistered_partial(self):
        # "Skills Synthesis" is partial — keyword "skills" + non-keyword extra
        assert classify_heading("Skills Synthesis") == SECTION_SKILLS
        # Strict mode rejects unregistered partials
        assert classify_heading("Skills Synthesis", allow_partial=False) is None
        # But exact registered keywords still pass in strict mode
        assert classify_heading("Professional Experience", allow_partial=False) == SECTION_EXPERIENCE
        assert classify_heading("experience", allow_partial=False) == SECTION_EXPERIENCE

    def test_max_extra_words_caps_partials(self):
        # 1 extra word allowed → "Skills Synthesis" passes
        assert classify_heading("Skills Synthesis", max_extra_words=1) == SECTION_SKILLS
        # No extra words allowed → only exact-match keywords pass
        assert classify_heading("Skills Synthesis", max_extra_words=0) is None
        # Already a registered keyword → still matches exactly
        assert classify_heading("Skills Summary", max_extra_words=0) == SECTION_SKILLS
        assert classify_heading("Experience", max_extra_words=0) == SECTION_EXPERIENCE


class TestIsSection:
    def test_truthy(self):
        assert is_section_keyword("Skills")
        assert is_section_keyword("Compétences")

    def test_falsy(self):
        assert not is_section_keyword("Random")
        assert not is_section_keyword("")
        assert not is_section_keyword(None)


class TestSchema:
    def test_all_sections_have_keywords(self):
        for section in ALL_SECTION_TYPES:
            assert section in SECTION_KEYWORDS, f"Missing keywords for {section}"
            assert SECTION_KEYWORDS[section], f"Empty keyword set for {section}"

    def test_data_keys_cover_all_sections(self):
        # Every section type that callers may render needs a known data key.
        for section in ALL_SECTION_TYPES:
            assert section in SECTION_DATA_KEY, \
                f"{section} missing from SECTION_DATA_KEY"

    def test_normalized_keywords_are_subset_normalized(self):
        for section, kws in SECTION_KEYWORDS.items():
            normalized = SECTION_KEYWORDS_NORMALIZED[section]
            for kw in kws:
                assert normalize_text(kw) in normalized

    def test_list_backed_subset_of_all(self):
        assert LIST_BACKED_SECTIONS.issubset(ALL_SECTION_TYPES)

    def test_keywords_for_unknown_section(self):
        assert keywords_for("nope") == frozenset()

    def test_keywords_for_known_section(self):
        kws = keywords_for(SECTION_EXPERIENCE)
        assert "experience" in kws
        assert "expérience professionnelle" in kws
