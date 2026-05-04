import os
import sys


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.cv_generator_fallback import _build_replacements


def test_build_replacements_does_not_crash_when_employee_address_missing():
    detected = {"address": "Paris, France"}
    employee = {"name": "Test User", "address": ""}

    pairs = _build_replacements(detected, employee)

    assert ("Paris, France", "") in pairs


def test_build_replacements_keeps_complex_employee_address():
    detected = {"address": "Montreal, Canada"}
    employee = {
        "name": "Test User",
        "address": "31, Rue 1er Juin, Mutuelle-ville, 1082, Tunis",
    }

    pairs = _build_replacements(detected, employee)

    assert ("Montreal, Canada", "31, Rue 1er Juin, Mutuelle-ville, 1082, Tunis") in pairs


def test_build_replacements_splits_address_across_template_two_lines():
    detected = {
        "address": "Madison, WI 12131",
        "address_preceding_line": "234 5th Ave,",
    }
    employee = {
        "name": "Test User",
        "address": "31, Rue 1er Juin, Mutuelle-ville, 1082, Tunis",
    }

    pairs = _build_replacements(detected, employee)

    assert ("234 5th Ave,", "31, Rue 1er Juin") in pairs
    assert ("Madison, WI 12131", "Mutuelle-ville, 1082, Tunis") in pairs


def test_build_replacements_clears_preceding_line_when_employee_has_no_address():
    detected = {
        "address": "Madison, WI 12131",
        "address_preceding_line": "234 5th Ave,",
    }
    employee = {"name": "Test User", "address": ""}

    pairs = _build_replacements(detected, employee)

    assert ("Madison, WI 12131", "") in pairs
    assert ("234 5th Ave,", "") in pairs
