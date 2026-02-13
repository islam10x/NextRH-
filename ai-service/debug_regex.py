
import re

text = """Mi~istère de l'Enseignement \nSupérieur et de la Recherche Scientifique \nInstitut Supérieur des Etudes \nTechnologiques \nen Communications de Tunis \nQ et'cem \nA'. , \\ ~ \n\\ 'w \\ ... , t. i' \\ 0 \\. \n~ .J~ r.:--JJJ \n-\n4.,.t~1 \\::A':"I..;.ù.I ~WI ~I \n(JoIÙfo. ~~I.j4I1 ~ \nATTESTATION DE DIPLOME \nIl \nVu la Loi n° 2008-19 du 25 février 2008, relative à l'enseignement supérieur \nVu la Loi nO 92-50 du 18 mai 1992, relative'aux instituts supérieurs des études technologiques \nVu le Décret nO 98-1065 du Il ma'"""

patterns = [
    r'(?:Issued\s+by|Issuer|Provided\s+by)[:\s]+(.+?)(?:\n\s*\n|$)',
    r'(?:Authorized\s+by|Accredited\s+by)[:\s]+(.+?)(?:\n\s*\n|$)',
    r'(?:Délivré\s+par|Etabli\s+par)[:\s]+(.+?)(?:\n\s*\n|$)',
    # Flexible institution names with OCR fault tolerance
    r'((?:Institut|Université|Ecole|Lycée|M[i~\s\w]*stère|Mi~istère)\b(?:(?!\n\s*\n|\n\s*Vu\s+|ATTESTATION|DIPLOME).)+)',
]

for i, p in enumerate(patterns):
    print(f"\n--- Testing Pattern {i} ---")
    print(f"Pattern: {p}")
    matches = list(re.finditer(p, text, re.IGNORECASE | re.DOTALL))
    print(f"Matches found: {len(matches)}")
    for j, m in enumerate(matches):
        print(f"  Match {j}: '{m.group(0)}'")
        print(f"  Capture {j}: '{m.group(1)}'")
