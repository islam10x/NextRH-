from pydantic import BaseModel
from typing import Optional
from datetime import date

class Certification(BaseModel):
    name: str
    issuer: Optional[str] = None
    date_obtained: Optional[date] = None
    expiration_date: Optional[date] = None
    credential_id: Optional[str] = None
    url: Optional[str] = None
