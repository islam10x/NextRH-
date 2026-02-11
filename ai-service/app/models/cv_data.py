from pydantic import BaseModel, Field
from typing import List, Optional, Dict
from datetime import date
from .certification import Certification

class Education(BaseModel):
    institution: Optional[str] = None
    degree: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    description: Optional[str] = None

class Experience(BaseModel):
    company: Optional[str] = None
    title: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    description: Optional[str] = None
    skills_used: List[str] = []

class CVData(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    skills: List[str] = []
    education: List[Education] = []
    experience: List[Experience] = []
    certifications: List[Certification] = []
    languages: List[str] = []
    summary: Optional[str] = None
    metadata: Dict[str, str] = {}
