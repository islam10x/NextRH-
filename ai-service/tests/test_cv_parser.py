import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.services.cv_parser import CVParserService
import os

client = TestClient(app)

def test_read_main():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"message": "Welcome to the AI CV Parser Service"}

# Mock parsing for PDF
def test_parse_pdf_mock():
    # This is a basic test to ensure the endpoint exists and returns 400/error on invalid input
    # or proceeds if we could mock the file.
    # Since we don't have a real PDF here easily, we rely on the behavior of the service.
    
    # Test valid endpoint with no file (should fail validation)
    response = client.post("/api/v1/parsing/cv")
    assert response.status_code == 422 # Unprocessable Entity (missing file)

def test_service_initialization():
    service = CVParserService()
    assert service.pdf_parser is not None
    assert service.docx_parser is not None

if __name__ == "__main__":
    # verification script
    print("Running tests...")
    test_read_main()
    test_service_initialization()
    print("Tests passed!")
