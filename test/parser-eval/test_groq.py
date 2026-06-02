import sys
sys.path.insert(0, r"c:\Users\islam\Projects\NextRH-\ai-service")
from app.utils.llm import call_local_chat

print("Testing Groq...")
try:
    resp = call_local_chat([{"role": "user", "content": "Hello!"}])
    print("Response:", resp)
except Exception as e:
    print("Failed:", e)
