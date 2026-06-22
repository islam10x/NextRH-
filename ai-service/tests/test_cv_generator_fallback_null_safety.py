import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.services.cv_generator_fallback import (
    _build_section_content,
    _build_full_replacement_map,
    _groq_generate_skills,
)


def test_build_section_content_projects_handles_null_entries():
    result = _build_section_content(
        'projects',
        {
            'projects': [
                None,
                {'name': 'MyApp', 'skills': None, 'description': 'A cool app'},
            ]
        },
    )

    assert result is not None
    assert any(item['text'] == 'MyApp' for item in result)


@patch('app.services.cv_generator_fallback._call_cv_local_llm')
def test_groq_generate_skills_handles_null_entries(mock_llm):
    mock_llm.return_value = 'Python, AWS'

    result = _groq_generate_skills(
        {
            'skills': [None, 'Python', {'name': 'Terraform'}],
            'certifications': [None, {'name': 'AWS Architect'}],
            'education': [None, {'degree': 'CS Degree'}],
            'projects': [None, {'name': 'Platform', 'description': None}],
        },
        api_key='fake-key',
    )

    assert result == 'Python, AWS'


def test_build_section_content_languages_and_interests_filter_null_entries():
    lang_result = _build_section_content('languages', {'languages': [None, {'name': 'French'}]})
    interest_result = _build_section_content('interests', {'interests': [None, {'name': 'Reading'}]})

    assert lang_result == [{'text': 'French', 'bold': False, 'bullet': False}]
    assert interest_result == [{'text': 'Reading', 'bold': False, 'bullet': True}]


def test_build_full_replacement_map_always_returns_a_list():
    result = _build_full_replacement_map(
        {'name': 'Itai Gerbi', 'email': 'itai@example.com'},
        {'experience': [], 'education': [], 'summary_paras': ['Old summary']},
        {'name': 'Jazil Gafsi', 'email': 'user3@nextrh.com', 'summary': 'New summary'},
    )

    assert isinstance(result, list)
    assert any(old == 'itai@example.com' and new == 'user3@nextrh.com' for old, new in result)