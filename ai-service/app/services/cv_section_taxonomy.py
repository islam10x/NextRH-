"""
cv_section_taxonomy.py — Single source of truth for CV section detection.

Before this module existed, three separate files defined overlapping but
divergent sets of section synonyms:

  - template_tagger._HEADING_KEYWORDS  (EN+FR, ~80 entries)
  - cv_generator._SECTION_KEYWORDS     (EN+FR, smaller subset)
  - cv_generator_fallback._SECTION_MAP (EN/FR/ES/DE/IT/PT, ~130 entries)

A bug fix in one never propagated to the others, and the lists drifted apart.
This module consolidates them and exposes a single classifier so the parser,
the template tagger, the primary generator, and the fallback generator all
agree on what counts as an "Experience" or "Skills" heading.

Public API
----------
SECTION_KEYWORDS               canonical {section_type: frozenset[str]}
SECTION_KEYWORDS_NORMALIZED    accent-stripped, lowercased version for matching
classify_heading(text)         returns the section_type or None
is_section_keyword(text)       True if text matches any known section heading
normalize_text(text)           public utility (NFKD-strip + lowercase + collapse)
SectionType                    enum-like Literal of canonical section names
"""

from __future__ import annotations

import re
import unicodedata
from typing import Dict, FrozenSet, Optional


# ─── Canonical section types ──────────────────────────────────────────────
# These are the only labels the rest of the pipeline recognizes.
SECTION_SUMMARY = "summary"
SECTION_EXPERIENCE = "experience"
SECTION_EDUCATION = "education"
SECTION_SKILLS = "skills"
SECTION_PROJECTS = "projects"
SECTION_CERTIFICATIONS = "certifications"
SECTION_LANGUAGES = "languages"
SECTION_AWARDS = "awards"
SECTION_INTERESTS = "interests"
SECTION_REFERENCES = "references"
SECTION_VOLUNTEER = "volunteer"
SECTION_CONTACT = "contact"

ALL_SECTION_TYPES: FrozenSet[str] = frozenset({
    SECTION_SUMMARY, SECTION_EXPERIENCE, SECTION_EDUCATION, SECTION_SKILLS,
    SECTION_PROJECTS, SECTION_CERTIFICATIONS, SECTION_LANGUAGES, SECTION_AWARDS,
    SECTION_INTERESTS, SECTION_REFERENCES, SECTION_VOLUNTEER, SECTION_CONTACT,
})

# Sections whose data is a list — used by callers that decide whether to
# render at all when the list is empty.
LIST_BACKED_SECTIONS: FrozenSet[str] = frozenset({
    SECTION_EXPERIENCE, SECTION_EDUCATION, SECTION_PROJECTS,
    SECTION_CERTIFICATIONS, SECTION_LANGUAGES, SECTION_AWARDS,
    SECTION_INTERESTS, SECTION_REFERENCES, SECTION_VOLUNTEER, SECTION_SKILLS,
})

# Map section_type → name of the data key used by the rendering context.
SECTION_DATA_KEY: Dict[str, str] = {
    SECTION_EXPERIENCE: "work_experiences",
    SECTION_EDUCATION: "educations",
    SECTION_PROJECTS: "projects",
    SECTION_CERTIFICATIONS: "certifications",
    SECTION_SKILLS: "skills",
    SECTION_LANGUAGES: "languages",
    SECTION_AWARDS: "awards",
    SECTION_INTERESTS: "interests",
    SECTION_REFERENCES: "references",
    SECTION_VOLUNTEER: "volunteer",
    SECTION_SUMMARY: "professional_summary",
    SECTION_CONTACT: "contact",
}


# ─── Keyword catalog (multi-language) ─────────────────────────────────────
# Languages covered: EN, FR, ES, DE, IT, PT.  Add new locales here only —
# never duplicate this dict elsewhere in the codebase.

SECTION_KEYWORDS: Dict[str, FrozenSet[str]] = {
    SECTION_EXPERIENCE: frozenset({
        # EN
        "experience", "experiences",
        "work experience", "work experiences",
        "professional experience", "professional experiences",
        "employment", "employment history", "work history",
        "career", "career history", "career summary",
        "professional background", "professional history", "work background",
        "job history", "relevant experience", "relevant work experience",
        # FR
        "expérience", "expériences",
        "expérience professionnelle", "expériences professionnelles",
        "parcours", "parcours professionnel",
        "emploi", "emplois", "postes", "postes occupés", "postes occupes",
        "historique professionnel", "fonctions",
        "expérience professionnelle générale dans le domaine de l'informatique",
        "experience professionnelle generale dans le domaine de l'informatique",
        # ES
        "experiencia", "experiencia laboral", "experiencia profesional",
        "experiencia de trabajo", "trayectoria profesional",
        # DE
        "berufserfahrung", "berufliche erfahrung", "arbeitserfahrung",
        "tätigkeiten", "werdegang", "beruflicher werdegang",
        # IT
        "esperienza", "esperienza lavorativa", "esperienza professionale",
        # PT
        "experiência", "experiência profissional", "experiência de trabalho",
    }),
    SECTION_EDUCATION: frozenset({
        # EN
        "education", "academic", "academics",
        "academic background", "academic history", "academic training",
        "academic qualifications", "qualifications", "schooling",
        "studies", "training", "educational background",
        # FR
        "formation", "formations", "études", "etudes",
        "diplômes", "diplomes", "scolarité", "scolarite",
        "académique", "academique", "études", "etudes",
        "parcours académique", "parcours academique",
        "expérience académique", "experience academique",
        "formation académique", "formation academique",
        "formation et diplômes", "formation et diplomes", "éducation",
        # ES
        "educación", "formación", "formación académica", "estudios",
        "titulación",
        # DE
        "ausbildung", "bildung", "studium", "schulbildung",
        "akademischer hintergrund", "qualifikationen",
        # IT
        "istruzione", "formazione", "studi", "percorso formativo",
        # PT
        "educação", "formação acadêmica", "formação",
    }),
    SECTION_CERTIFICATIONS: frozenset({
        "certification", "certifications", "certificat", "certificats",
        "attestation", "attestations", "certificats et diplômes",
        "professional certifications", "awards", "honors",
    }),
    SECTION_SKILLS: frozenset({
        # EN
        "skills", "technical skills", "competencies", "core competencies",
        "expertise", "technical expertise", "areas of expertise",
        "technologies", "tools", "tech stack",
        "key skills", "key competencies",
        "skill set", "skillset", "skills summary", "skills & expertise",
        "abilities", "professional skills",
        # FR
        "compétences", "competences",
        "compétences techniques", "competences techniques",
        "compétences professionnelles", "competences professionnelles",
        "compétences clés", "competences cles",
        "compétences supplémentaires", "competences supplementaires",
        "savoir-faire", "savoir faire", "outils",
        "technologies utilisées", "technologies utilisees",
        # ES
        "habilidades", "habilidades técnicas", "competencias", "aptitudes",
        "conocimientos técnicos", "conocimientos",
        # DE
        "kenntnisse", "fähigkeiten", "kompetenzen",
        "technische kenntnisse", "schlüsselkompetenzen",
        # IT
        "competenze", "competenze tecniche", "abilità", "conoscenze",
        # PT
        "competências", "aptidões", "conhecimentos técnicos",
    }),
    SECTION_CERTIFICATIONS: frozenset({
        # EN
        "certifications", "certification", "certificates", "certificate",
        "licenses", "licenses & certifications",
        "licenses and certifications", "credentials", "accreditations",
        "professional certifications",
        # FR
        "certificats", "certificats obtenus", "attestations",
        "habilitations", "formations certifiantes",
        # ES
        "certificaciones", "certificados", "licencias y certificaciones",
        # DE
        "zertifikate", "zertifizierungen", "lizenzen",
        # IT
        "certificazioni", "licenze",
        # PT
        "certificações", "certificados",
    }),
    SECTION_PROJECTS: frozenset({
        # EN
        "projects", "project", "key project", "key projects", "selected projects",
        "notable projects", "project experience",
        "personal projects", "academic projects", "portfolio",
        # FR
        "projets", "projets clés", "projets cles",
        "projets sélectionnés", "projets selectionnes",
        "projets réalisés", "projets realises", "réalisations", "realisations",
        "missions", "réalisations professionnelles", "realisations professionnelles",
        "expérience professionnelle générale dans les projets similaires à la mission objet de l'appel d'offres",
        "experience professionnelle generale dans les projets similaires a la mission objet de l'appel d'offres",
        "expérience professionnelle générale dans les projets similaires",
        # ES
        "proyectos", "proyectos clave", "proyectos destacados",
        "proyectos personales", "proyectos académicos",
        # DE
        "projekte", "projekterfahrung", "schlüsselprojekte",
        # IT
        "progetti", "progetti chiave", "progetti personali",
        # PT
        "projetos", "projetos principais", "projetos pessoais",
    }),
    SECTION_SUMMARY: frozenset({
        # EN
        "summary", "professional summary", "executive summary",
        "profile", "professional profile", "personal profile",
        "about", "about me", "objective", "career objective",
        "overview", "personal statement", "professional statement",
        # FR
        "résumé", "resume", "résumé professionnel", "resume professionnel",
        "profil", "profil professionnel",
        "synthèse", "synthese", "présentation", "presentation", "objectif",
        # ES
        "perfil profesional", "perfil", "resumen", "objetivo profesional",
        "objetivo",
        # DE
        "zusammenfassung", "über mich", "kurzprofil", "berufliches profil",
        # IT
        "profilo professionale", "profilo", "sommario", "obiettivo",
        # PT
        "resumo profissional", "resumo", "perfil profissional",
    }),
    SECTION_CONTACT: frozenset({
        # EN
        "contact", "contact information", "contact info", "contact details",
        "personal info", "personal information", "personal details",
        # FR
        "contact", "coordonnées", "coordonnees",
        "informations personnelles", "informations de contact",
        "détails personnels", "details personnels",
        # ES
        "contacto", "datos personales", "información de contacto",
        # DE
        "kontakt", "kontaktdaten", "persönliche daten",
        # IT
        "contatti", "informazioni personali",
        # PT
        "contato", "informações pessoais",
    }),
    SECTION_LANGUAGES: frozenset({
        # EN
        "languages", "language skills", "linguistic skills",
        "spoken languages", "language proficiency",
        # FR
        "langues", "langue", "langues parlées", "langues parlees",
        "compétences linguistiques", "competences linguistiques",
        # ES
        "idiomas", "lenguas", "idiomas hablados",
        # DE
        "sprachen", "sprachkenntnisse", "sprachliche kenntnisse",
        # IT
        "lingue", "competenze linguistiche", "conoscenze linguistiche",
        # PT
        "idiomas", "línguas", "competências linguísticas",
    }),
    SECTION_AWARDS: frozenset({
        # EN
        "awards", "honors", "honours", "distinctions",
        "recognitions", "prizes", "achievements", "accomplishments",
        # FR
        "récompenses", "recompenses", "prix", "distinctions",
        # ES
        "premios", "reconocimientos", "logros",
        # DE
        "auszeichnungen", "preise",
        # IT
        "premi", "riconoscimenti",
        # PT
        "prêmios", "conquistas",
    }),
    SECTION_INTERESTS: frozenset({
        # EN
        "interests", "hobbies", "activities", "personal interests",
        "extracurricular", "extracurricular activities", "hobbies & interests",
        # FR
        "loisirs", "centres d'intérêt", "centres d'interet",
        "activités", "activites", "passions",
        # ES
        "intereses", "aficiones", "pasatiempos",
        "actividades extracurriculares",
        # DE
        "interessen", "hobbys", "freizeit", "freizeitaktivitäten",
        # IT
        "interessi", "hobby", "attività", "attività extracurriculari",
        # PT
        "interesses", "hobbies", "atividades", "atividades extracurriculares",
    }),
    SECTION_REFERENCES: frozenset({
        # EN
        "references", "referees", "professional references",
        # FR
        "références", "references", "références professionnelles",
        "references professionnelles",
        # ES
        "referencias", "referencias profesionales",
        # DE
        "referenzen",
        # IT
        "referenze",
        # PT
        "referências",
    }),
    SECTION_VOLUNTEER: frozenset({
        # EN
        "volunteer", "volunteering", "voluntary work", "community service",
        "volunteer experience",
        # FR
        "bénévolat", "benevolat", "engagement associatif",
        # ES
        "voluntariado",
        # DE
        "ehrenamt", "freiwilligenarbeit",
        # IT
        "volontariato",
        # PT
        "voluntariado",
    }),
}


# ─── Normalization helpers ────────────────────────────────────────────────

# Characters we collapse to ASCII space before matching.
_TYPOGRAPHIC_QUOTES = {
    "‘": "'", "’": "'",
    "“": '"', "”": '"',
    " ": " ",  # NBSP
}

_PUNCT_TRAIL_RE = re.compile(r"[\s:.;,\-–—!?]+$")


def normalize_text(text: Optional[str]) -> str:
    """Lower-cased, accent-stripped, whitespace-collapsed form for matching.

    Handles typographic quotes & non-breaking space which leak in from
    Word/PDF extraction.  Trailing punctuation (e.g. ``"Skills:"``) is
    stripped because it carries no semantic weight at the heading level.
    """
    if not text:
        return ""
    s = text
    for src, tgt in _TYPOGRAPHIC_QUOTES.items():
        s = s.replace(src, tgt)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower().strip()
    s = _PUNCT_TRAIL_RE.sub("", s)
    s = re.sub(r"\s+", " ", s)
    return s


# Pre-normalize keyword sets once at import time.
SECTION_KEYWORDS_NORMALIZED: Dict[str, FrozenSet[str]] = {
    section: frozenset(normalize_text(kw) for kw in keywords)
    for section, keywords in SECTION_KEYWORDS.items()
}

# Reverse lookup: every normalized keyword → its section.  Built once;
# enables O(1) exact-match classification.
_KEYWORD_TO_SECTION: Dict[str, str] = {}
for _section, _kws in SECTION_KEYWORDS_NORMALIZED.items():
    for _kw in _kws:
        # First-write-wins: if the same word maps to two sections, the
        # earlier (canonical) section keeps it.  Order in SECTION_KEYWORDS
        # matters here — experience > education > skills > … is intentional.
        _KEYWORD_TO_SECTION.setdefault(_kw, _section)


# ─── Heading classification ───────────────────────────────────────────────

# When the user-provided text is several words long, we accept a heading
# match only if a known keyword forms a *whole-word* prefix or suffix —
# never a mid-string substring — to avoid "Languages used in Java" being
# classified as the Languages section.
_WORD_BOUNDARY_RE = re.compile(r"\b\w+\b", re.UNICODE)


def classify_heading(
    text: Optional[str],
    *,
    allow_partial: bool = True,
    max_extra_words: int = 2,
) -> Optional[str]:
    """Return the canonical section type for *text* or None.

    Args:
        text: raw heading string from the document.
        allow_partial: if True, headings like "Professional Experience" or
            "Skills Summary" still classify even when they aren't an exact
            match for a keyword.  Set False to accept *only* exact keyword
            matches (i.e. the input string after normalization must be a
            registered keyword verbatim).
        max_extra_words: when allow_partial is True, this caps how many
            non-keyword tokens may surround the keyword.  Default 2 — that
            allows real headings like "Professional Experience" or
            "Skills Summary" but rejects sentences such as "Languages used
            in Java projects" or "Description of a project I worked on".
    """
    norm = normalize_text(text)
    if not norm:
        return None

    # Exact match — fast path.  Accepts both single- and multi-word
    # registered keywords (e.g. "experience" and "professional experience").
    section = _KEYWORD_TO_SECTION.get(norm)
    if section is not None:
        return section

    if not allow_partial:
        return None

    tokens = _WORD_BOUNDARY_RE.findall(norm)
    if not tokens:
        return None

    # Try multi-word keywords first (greedy: longest keyword wins).  For
    # multi-word keywords we require the heading to consist of *only* the
    # keyword plus up to ``max_extra_words`` adjacent qualifier words.
    sorted_keywords = sorted(_KEYWORD_TO_SECTION.keys(), key=len, reverse=True)
    for kw in sorted_keywords:
        kw_token_count = len(kw.split())
        if len(tokens) > kw_token_count + max_extra_words:
            continue  # too many extra words → likely a sentence, not a heading
        if " " in kw:
            pattern = r"(?:^|\b)" + re.escape(kw) + r"(?:\b|$)"
            if re.search(pattern, norm):
                return _KEYWORD_TO_SECTION[kw]
        else:
            if kw in tokens:
                return _KEYWORD_TO_SECTION[kw]
    return None


def is_section_keyword(text: Optional[str]) -> bool:
    """True if *text* (after normalization) classifies as a known section."""
    return classify_heading(text) is not None


def keywords_for(section_type: str) -> FrozenSet[str]:
    """Return the original (unnormalized) keyword set for a section type.

    Useful for callers that want to render translated section titles or
    build display labels.  Returns an empty frozenset for unknown sections.
    """
    return SECTION_KEYWORDS.get(section_type, frozenset())
