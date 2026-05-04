import os
import sys


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.api.generation import _profile_to_fallback_payload


def test_profile_to_fallback_payload_rebuilds_address_from_location_fields():
    profile = {
        "name": "Jazil Gafsi",
        "address": "",
        "city": "Tunis",
        "country": "Tunisia",
        "location": "Mutuelle-ville",
        "postalCode": "1082",
        "street": "31, Rue 1er Juin",
    }

    payload = _profile_to_fallback_payload(profile)

    assert payload["address"] == "31, Rue 1er Juin, 1082, Tunis, Tunisia, Mutuelle-ville"
