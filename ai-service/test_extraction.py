
import sys
import os

# Add the project root to sys.path so we can import app
sys.path.append(os.path.abspath('c:/Users/islam/Projects/NextRH/ai-service'))

from app.ocr.certification_ocr import CertificationOCR
import logging

# Setup basic logging
logging.basicConfig(level=logging.INFO)

def test_extraction():
    ocr = CertificationOCR()
    
    raw_text = """Mi~istère de l'Enseignement \nSupérieur et de la Recherche Scientifique \nInstitut Supérieur des Etudes \nTechnologiques \nen Communications de Tunis \nQ et'cem \nA'. , \\ ~ \n\\ 'w \\ ... , t. i' \\ 0 \\. \n~ .J~ r.:--JJJ \n-\n4.,.t~1 \\::A':"I..;.ù.I ~WI ~I \n(JoIÙfo. ~~I.j4I1 ~ \nATTESTATION DE DIPLOME \nIl \nVu la Loi n° 2008-19 du 25 février 2008, relative à l'enseignement supérieur \nVu la Loi nO 92-50 du 18 mai 1992, relative'aux instituts supérieurs des études technologiques \nVu le Décret nO 98-1065 du Il ma'"""
    
    print("\n--- Testing Extraction (ATTESTATION DE DIPLOME) ---")
    result = ocr._parse_text(raw_text)
    
    print(f"Certification Name: {result['name']}")
    print(f"Issuer: {result['issuer']}")
    print(f"Expiration Date: {result['expiration']}")
    print("--------------------------\n")

if __name__ == "__main__":
    test_extraction()
