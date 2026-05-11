"""Quick regex-only detection test across all templates."""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import logging
logging.basicConfig(level=logging.WARNING)

from app.services.cv_generator import _extract_all_text, _detect_personal_info, _build_replacements

EMPLOYEE = {
    'name': 'Aya BEN JEMAA',
    'email': 'aya.benjemaa@nextstep.tn',
    'phone': '+216 98 772 817',
    'linkedin': 'linkedin.com/in/ayabenjemaa',
    'address': 'Tunis, Tunisia',
}

CASES = [
    ('adversarial_table_contact.docx',   'Carlos RIVERA',  '+34 612 345 678'),
    ('adversarial_long_preamble.docx',   'Jean DUPONT',    '+33 7 45 12 89 36'),
    ('adversarial_spanish.docx',         'Maria',          '+34 698 765 432'),
    ('adversarial_fontsize_heading.docx','Sophie MARTIN',  '+33 6 12 34 56 78'),
    ('Resume-JaneDoe.docx',       'Jane Doe',    '+216 27 920 721'),
    ('124-modele-cv-canadien-1-2.docx',  'LUCAS',          '555-555-5555'),
]

def test_regex_detection_across_templates():
    errors = []
    for fname, expected_name_part, expected_phone in CASES:
        path = os.path.join(os.path.dirname(__file__), '..', 'test_templates', fname)
        full, paras = _extract_all_text(path)
        detected = _detect_personal_info(full, paras)
        pairs = _build_replacements(detected, EMPLOYEE)
        old_vals = [old for old, _ in pairs]

        ok_name = any(expected_name_part.lower() in old.lower() for old in old_vals)
        ok_phone = any(expected_phone in old for old in old_vals)
        ok_email = any('@' in old for old in old_vals)

        status = 'OK' if (ok_name and ok_phone and ok_email) else 'FAIL'
        issues = []
        if not ok_name:
            issues.append(f"name '{expected_name_part}' not in {old_vals}")
        if not ok_phone:
            issues.append(
                f"phone '{expected_phone}' not in {old_vals}, detected={detected.get('phone')}"
            )
        if not ok_email:
            issues.append(f"email not found, detected={detected.get('email')}")

        print(f"  [{status}] {fname}")
        if issues:
            for issue in issues:
                print(f"         -> {issue}")
            errors.append(f"{fname}: {'; '.join(issues)}")

    print()
    print("RESULT:", "ALL PASS" if not errors else f"{len(errors)} FAILURES")
    assert not errors, "\n".join(errors)
