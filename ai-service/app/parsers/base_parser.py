from abc import ABC, abstractmethod
from typing import Any

class BaseParser(ABC):
    @abstractmethod
    def parse(self, file_path: str) -> str:
        """
        Parse the document and return the extracted text.
        """
        pass
    
    @abstractmethod
    def extract_metadata(self, file_path: str) -> Any:
        """
        Extract metadata from the document.
        """
        pass
