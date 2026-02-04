# AI-Driven CV Management System - Complete File Structure
## With Docker, NextOra Integration, Auto-Sync, and Microservices Architecture

---

## 📁 Project Root Structure

```
cv-management-system/
│
├── docker-compose.yml                 # Main orchestration file
├── .env.example                       # Environment variables template
├── .env                              # Environment variables (git-ignored)
├── .gitignore                        # Git ignore rules
├── README.md                         # Project documentation
├── package.json                      # Root package.json for scripts
│
├── backend/                          # NestJS Backend Service
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── nest-cli.json
│   ├── .env.example
│   │
│   ├── src/
│   │   ├── main.ts                   # Application entry point
│   │   ├── app.module.ts             # Root module
│   │   ├── app.controller.ts
│   │   ├── app.service.ts
│   │   │
│   │   ├── config/                   # Configuration
│   │   │   ├── database.config.ts
│   │   │   ├── storage.config.ts
│   │   │   ├── queue.config.ts       # Queue/Redis config
│   │   │   ├── ai.config.ts
│   │   │   └── nextora.config.ts
│   │   │
│   │   ├── auth/                     # Authentication Module
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── guards/
│   │   │   │   ├── jwt-auth.guard.ts
│   │   │   │   └── roles.guard.ts
│   │   │   ├── strategies/
│   │   │   │   └── jwt.strategy.ts
│   │   │   └── decorators/
│   │   │       └── roles.decorator.ts
│   │   │
│   │   ├── users/                    # User Management
│   │   │   ├── users.module.ts
│   │   │   ├── users.controller.ts
│   │   │   ├── users.service.ts
│   │   │   ├── entities/
│   │   │   │   └── user.entity.ts
│   │   │   └── dto/
│   │   │       ├── create-user.dto.ts
│   │   │       └── update-user.dto.ts
│   │   │
│   │   ├── employees/                # Employee Profiles
│   │   │   ├── employees.module.ts
│   │   │   ├── employees.controller.ts
│   │   │   ├── employees.service.ts
│   │   │   ├── entities/
│   │   │   │   ├── employee-profile.entity.ts
│   │   │   │   ├── education.entity.ts
│   │   │   │   ├── work-experience.entity.ts
│   │   │   │   └── metadata-snapshot.entity.ts
│   │   │   └── dto/
│   │   │       ├── create-employee.dto.ts
│   │   │       └── update-employee.dto.ts
│   │   │
│   │   ├── skills/                   # Skills Management
│   │   │   ├── skills.module.ts
│   │   │   ├── skills.controller.ts
│   │   │   ├── skills.service.ts
│   │   │   ├── entities/
│   │   │   │   ├── skill.entity.ts
│   │   │   │   └── employee-skill.entity.ts
│   │   │   └── dto/
│   │   │       ├── create-skill.dto.ts
│   │   │       └── assign-skill.dto.ts
│   │   │
│   │   ├── certifications/           # Certifications
│   │   │   ├── certifications.module.ts
│   │   │   ├── certifications.controller.ts
│   │   │   ├── certifications.service.ts
│   │   │   ├── entities/
│   │   │   │   ├── certification.entity.ts
│   │   │   │   └── certification-alert.entity.ts
│   │   │   └── dto/
│   │   │       ├── create-certification.dto.ts
│   │   │       └── update-certification.dto.ts
│   │   │
│   │   ├── training/                 # Training Sessions
│   │   │   ├── training.module.ts
│   │   │   ├── training.controller.ts
│   │   │   ├── training.service.ts
│   │   │   ├── entities/
│   │   │   │   └── training-session.entity.ts
│   │   │   └── dto/
│   │   │       └── create-training.dto.ts
│   │   │
│   │   ├── projects/                 # Projects Realized
│   │   │   ├── projects.module.ts
│   │   │   ├── projects.controller.ts
│   │   │   ├── projects.service.ts
│   │   │   ├── entities/
│   │   │   │   ├── project.entity.ts
│   │   │   │   ├── project-participant.entity.ts
│   │   │   │   └── project-technology.entity.ts
│   │   │   └── dto/
│   │   │       ├── create-project.dto.ts
│   │   │       └── add-participant.dto.ts
│   │   │
│   │   ├── teams/                    # Team Management
│   │   │   ├── teams.module.ts
│   │   │   ├── teams.controller.ts
│   │   │   ├── teams.service.ts
│   │   │   ├── entities/
│   │   │   │   ├── team.entity.ts
│   │   │   │   └── team-member.entity.ts
│   │   │   └── dto/
│   │   │       └── create-team.dto.ts
│   │   │
│   │   ├── cv/                       # CV Management
│   │   │   ├── cv.module.ts
│   │   │   ├── cv.controller.ts
│   │   │   ├── cv.service.ts
│   │   │   ├── entities/
│   │   │   │   ├── cv-document.entity.ts
│   │   │   │   ├── cv-template.entity.ts
│   │   │   │   └── generated-cv.entity.ts
│   │   │   └── dto/
│   │   │       ├── upload-cv.dto.ts
│   │   │       └── generate-cv.dto.ts
│   │   │
│   │   ├── file-storage/             # File Storage Service
│   │   │   ├── file-storage.module.ts
│   │   │   ├── file-storage.service.ts
│   │   │   ├── file-upload.service.ts
│   │   │   ├── folder-manager.service.ts
│   │   │   └── metadata.service.ts   # Manages metadata.json files
│   │   │
│   │   ├── sync/                     # Auto-Sync Module (File ↔ DB)
│   │   │   ├── sync.module.ts
│   │   │   ├── sync.controller.ts  # Receives webhooks from watchdog
│   │   │   ├── sync.service.ts       # Orchestrates file → DB sync
│   │   │   └── sync-processor.service.ts  # Processes sync events
│   │   │
│   │   ├── queue/                    # Background Jobs (Bull/Redis)
│   │   │   ├── queue.module.ts
│   │   │   ├── processors/
│   │   │   │   ├── cv-parse.processor.ts      # Processes CV parsing jobs
│   │   │   │   ├── cert-parse.processor.ts    # Processes cert parsing jobs
│   │   │   │   └── embedding.processor.ts     # Generates embeddings
│   │   │   └── producers/
│   │   │       └── sync-job.producer.ts       # Creates sync jobs
│   │   │
│   │   ├── rag/                      # RAG Search System
│   │   │   ├── rag.module.ts
│   │   │   ├── rag.controller.ts
│   │   │   ├── services/
│   │   │   │   ├── rag.service.ts
│   │   │   │   ├── embedding.service.ts
│   │   │   │   ├── vector-store.service.ts
│   │   │   │   └── llm.service.ts
│   │   │   ├── entities/
│   │   │   │   └── ai-search-query.entity.ts
│   │   │   └── dto/
│   │   │       └── search-query.dto.ts
│   │   │
│   │   ├── notifications/            # Notification System
│   │   │   ├── notifications.module.ts
│   │   │   ├── notifications.controller.ts
│   │   │   ├── notifications.service.ts
│   │   │   ├── entities/
│   │   │   │   └── notification.entity.ts
│   │   │   └── dto/
│   │   │       └── create-notification.dto.ts
│   │   │
│   │   ├── audit/                    # Audit Logging
│   │   │   ├── audit.module.ts
│   │   │   ├── audit.service.ts
│   │   │   └── entities/
│   │   │       └── audit-log.entity.ts
│   │   │
│   │   ├── nextora/                  # NextOra Integration
│   │   │   ├── nextora.module.ts
│   │   │   ├── nextora.controller.ts
│   │   │   ├── nextora.service.ts
│   │   │   ├── webhooks/
│   │   │   │   └── nextora-webhook.controller.ts
│   │   │   └── dto/
│   │   │       ├── nextora-query.dto.ts
│   │   │       └── nextora-update.dto.ts
│   │   │
│   │   ├── jobs/                     # Scheduled Jobs (Cron)
│   │   │   ├── jobs.module.ts
│   │   │   ├── certification-checker.job.ts
│   │   │   ├── folder-sync.job.ts
│   │   │   └── embedding-generator.job.ts
│   │   │
│   │   ├── common/                   # Shared Resources
│   │   │   ├── decorators/
│   │   │   │   ├── current-user.decorator.ts
│   │   │   │   └── roles.decorator.ts
│   │   │   ├── filters/
│   │   │   │   └── http-exception.filter.ts
│   │   │   ├── interceptors/
│   │   │   │   └── logging.interceptor.ts
│   │   │   ├── pipes/
│   │   │   │   └── validation.pipe.ts
│   │   │   └── utils/
│   │   │       ├── date.utils.ts
│   │   │       └── file.utils.ts
│   │   │
│   │   └── database/                 # Database
│   │       ├── database.module.ts
│   │       ├── database.provider.ts
│   │       ├── migrations/
│   │       │   ├── 1706000000000-InitialSchema.ts
│   │       │   ├── 1706000001000-AddVectorSupport.ts
│   │       │   └── 1706000002000-AddNextOraIntegration.ts
│   │       └── seeds/
│   │           ├── 1-users.seed.ts
│   │           ├── 2-skills.seed.ts
│   │           └── 3-templates.seed.ts
│   │
│   └── test/                         # Tests
│       ├── app.e2e-spec.ts
│       ├── jest-e2e.json
│       └── unit/
│           ├── auth.service.spec.ts
│           ├── rag.service.spec.ts
│           ├── sync.service.spec.ts
│           └── cv.service.spec.ts
│
├── ai-service/                       # Python AI Microservice
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── requirements.txt
│   ├── setup.py
│   │
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                   # FastAPI entry point
│   │   ├── config.py                 # Configuration
│   │   ├── watchers/
│   │   │   ├── __init__.py
│   │   │   ├── file_watcher.py      # Python Watchdog ✅
│   │   │   ├── event_handler.py     # Process file events
│   │   │   └── sync_client.py       # Notify backend via webhook 
│   │   │
│   │   ├── api/                      # API Routes
│   │   │   ├── __init__.py
│   │   │   ├── parsing.py            # CV/Certificate parsing endpoints
│   │   │   ├── ocr.py                # OCR endpoints
│   │   │   ├── generation.py         # CV generation endpoints
│   │   │   ├── nlp.py                # NLP understanding endpoints
│   │   │   └── metadata.py           # Metadata extraction endpoint
│   │   │
│   │   ├── services/                 # Business Logic
│   │   │   ├── __init__.py
│   │   │   ├── cv_parser.py          # CV parsing logic
│   │   │   ├── cert_parser.py        # Certificate parsing
│   │   │   ├── ocr_service.py        # OCR processing
│   │   │   ├── cv_generator.py       # CV generation
│   │   │   ├── nlp_service.py        # NLU for queries/updates
│   │   │   ├── ollama_service.py     # Ollama integration
│   │   │   └── metadata_extractor.py # Structured data extraction
│   │   │
│   │   ├── parsers/                  # Document Parsers
│   │   │   ├── __init__.py
│   │   │   ├── pdf_parser.py         # PyMuPDF implementation
│   │   │   ├── docx_parser.py        # python-docx implementation
│   │   │   ├── tika_parser.py        # Apache Tika wrapper
│   │   │   └── base_parser.py        # Abstract base class
│   │   │
│   │   ├── ocr/                      # OCR Engines
│   │   │   ├── __init__.py
│   │   │   ├── tesseract_ocr.py      # Tesseract implementation
│   │   │   ├── easyocr_engine.py     # EasyOCR implementation
│   │   │   └── preprocessor.py       # Image preprocessing
│   │   │
│   │   ├── generators/               # CV Generation
│   │   │   ├── __init__.py
│   │   │   ├── docx_generator.py     # DOCX generation (docxtpl)
│   │   │   ├── pdf_generator.py      # PDF generation (pdfkit/LibreOffice)
│   │   │   └── template_manager.py   # Template handling
│   │   │
│   │   ├── nlp/                      # Natural Language Processing
│   │   │   ├── __init__.py
│   │   │   ├── intent_classifier.py  # Query vs Update detection
│   │   │   ├── entity_extractor.py   # Name, skill, cert extraction
│   │   │   └── ollama_client.py      # Ollama API client
│   │   │
│   │   ├── models/                   # Data Models (Pydantic)
│   │   │   ├── __init__.py
│   │   │   ├── cv_data.py
│   │   │   ├── certification.py
│   │   │   ├── metadata.py
│   │   │   └── nlp_request.py
│   │   │
│   │   └── utils/                    # Utilities
│   │       ├── __init__.py
│   │       ├── file_utils.py
│   │       ├── date_utils.py
│   │       └── logger.py
│   │
│   ├── templates/                    # CV Templates
│   │   ├── standard.docx             # Fixed template 1
│   │   ├── canadian.docx             # Fixed template 2
│   │   ├── eu.docx                   # Fixed template 3
│   │   └── custom/                   # Client-provided templates
│   │       └── .gitkeep
│   │
│   └── tests/                        # Python Tests
│       ├── __init__.py
│       ├── test_cv_parser.py
│       ├── test_ocr.py
│       ├── test_nlp.py
│       └── test_cv_generator.py
│
├── frontend/                         # React Frontend (Already Built)
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   │
│   ├── public/
│   │   ├── index.html
│   │   └── assets/
│   │
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── index.css
│   │   │
│   │   ├── components/               # Reusable Components
│   │   │   ├── common/
│   │   │   │   ├── Button.tsx
│   │   │   │   ├── Input.tsx
│   │   │   │   ├── Card.tsx
│   │   │   │   └── Modal.tsx
│   │   │   ├── layout/
│   │   │   │   ├── Header.tsx
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   └── Footer.tsx
│   │   │   └── features/
│   │   │       ├── CVUpload.tsx
│   │   │       ├── CertificationCard.tsx
│   │   │       ├── SkillBadge.tsx
│   │   │       └── RAGChatbot.tsx
│   │   │
│   │   ├── pages/                    # Page Components
│   │   │   ├── auth/
│   │   │   │   ├── Login.tsx
│   │   │   │   └── Register.tsx
│   │   │   ├── employee/
│   │   │   │   ├── Dashboard.tsx
│   │   │   │   ├── Profile.tsx
│   │   │   │   ├── Certifications.tsx
│   │   │   │   └── Projects.tsx
│   │   │   ├── team-manager/
│   │   │   │   ├── TeamDashboard.tsx
│   │   │   │   └── TeamCertifications.tsx
│   │   │   └── bid-manager/
│   │   │       ├── BidDashboard.tsx
│   │   │       ├── EmployeeSearch.tsx
│   │   │       └── CVGeneration.tsx
│   │   │
│   │   ├── services/                 # API Services
│   │   │   ├── api.ts                # Axios config
│   │   │   ├── auth.service.ts
│   │   │   ├── employee.service.ts
│   │   │   ├── certification.service.ts
│   │   │   ├── rag.service.ts
│   │   │   └── cv.service.ts
│   │   │
│   │   ├── hooks/                    # Custom Hooks
│   │   │   ├── useAuth.ts
│   │   │   ├── useEmployee.ts
│   │   │   └── useRAGSearch.ts
│   │   │
│   │   ├── store/                    # State Management
│   │   │   ├── index.ts
│   │   │   ├── authSlice.ts
│   │   │   └── employeeSlice.ts
│   │   │
│   │   ├── types/                    # TypeScript Types
│   │   │   ├── user.types.ts
│   │   │   ├── employee.types.ts
│   │   │   └── certification.types.ts
│   │   │
│   │   └── utils/                    # Utilities
│   │       ├── formatters.ts
│   │       ├── validators.ts
│   │       └── constants.ts
│   │
│   └── nginx/                        # Nginx Config
│       └── default.conf
│
├── n8n/                              # n8n Workflow Automation
│   ├── Dockerfile
│   ├── workflows/
│   │   ├── certification-expiry-notification.json
│   │   ├── folder-sync-trigger.json
│   │   └── cv-update-workflow.json
│   └── credentials/
│       └── credentials.json.example
│
├── nginx/                            # Reverse Proxy
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── ssl/
│   │   ├── cert.pem
│   │   └── key.pem
│   └── conf.d/
│       └── default.conf
│
├── database/                         # Database Initialization
│   ├── init-scripts/
│   │   ├── 01-create-extensions.sql  # pgvector, etc.
│   │   ├── 02-create-schema.sql
│   │   └── 03-seed-data.sql
│   └── backups/
│       └── .gitkeep
│
├── file-storage/                     # Persistent File Storage (WATCHED by Python Watchdog)
│   ├── cv-database/                  # Main CV folder structure
│   │   ├── Imen_BenAli/
│   │   │   ├── Imen_BenAli_CV.pdf
│   │   │   ├── metadata.json         # Auto-generated/updated
│   │   │   └── certificates/
│   │   │       ├── Python_Certificate.pdf
│   │   │       └── AWS_Certificate.pdf
│   │   ├── Khalil_Trabelsi/
│   │   │   ├── Khalil_Trabelsi_CV.pdf
│   │   │   ├── metadata.json
│   │   │   └── certificates/
│   │   │       └── Azure_Certificate.pdf
│   │   └── .gitkeep
│   │
│   ├── templates/                    # CV Templates
│   │   ├── standard.docx
│   │   ├── canadian.docx
│   │   ├── eu.docx
│   │   └── custom/
│   │       └── .gitkeep
│   │
│   └── generated-cvs/                # Temporarily generated CVs
│       └── .gitkeep
│
├── logs/                             # Application Logs
│   ├── backend/
│   │   └── .gitkeep
│   ├── ai-service/
│   │   └── .gitkeep
│   └── nginx/
│       └── .gitkeep
│
├── scripts/                          # Utility Scripts
│   ├── setup.sh                      # Initial setup
│   ├── backup.sh                     # Database backup
│   ├── restore.sh                    # Database restore
│   ├── generate-embeddings.sh        # Batch embedding generation
│   └── deploy.sh                     # Deployment script
│
├── docs/                             # Documentation
│   ├── api/
│   │   ├── backend-api.md
│   │   └── ai-service-api.md
│   ├── architecture/
│   │   ├── system-architecture.md
│   │   ├── database-schema.md
│   │   ├── auto-sync-flow.md
│   │   └── nextora-integration.md
│   ├── deployment/
│   │   ├── docker-deployment.md
│   │   └── production-setup.md
│   └── user-guides/
│       ├── employee-guide.md
│       ├── manager-guide.md
│       └── admin-guide.md
│
└── .github/                          # CI/CD
    └── workflows/
        ├── ci.yml                    # Continuous Integration
        ├── cd.yml                    # Continuous Deployment
        └── test.yml                  # Automated Testing

```

---

## 🐳 Docker Configuration Files

### **docker-compose.yml** (Root)

```yaml
version: '3.8'

services:
  # PostgreSQL Database
  postgres:
    image: pgvector/pgvector:pg14
    container_name: cv-postgres
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./database/init-scripts:/docker-entrypoint-initdb.d
      - ./database/backups:/backups
    ports:
      - "5432:5432"
    networks:
      - cv-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis (Job Queue & Caching)
  redis:
    image: redis:7-alpine
    container_name: cv-redis
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    networks:
      - cv-network
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # NestJS Backend
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: cv-backend
    environment:
      NODE_ENV: ${NODE_ENV}
      DATABASE_URL: postgresql://${DB_USER}:${DB_PASSWORD}@postgres:5432/${DB_NAME}
      REDIS_HOST: redis
      REDIS_PORT: 6379
      JWT_SECRET: ${JWT_SECRET}
      AI_SERVICE_URL: http://ai-service:8000
      OPENAI_API_KEY: ${OPENAI_API_KEY}
    volumes:
      - ./file-storage:/app/file-storage      # Shared with AI service
      - ./backend/src:/app/src                 # Hot reload
      - ./logs/backend:/app/logs
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      ai-service:
        condition: service_started
    networks:
      - cv-network
    command: npm run start:dev

  # Python AI Service
  ai-service:
    build:
      context: ./ai-service
      dockerfile: Dockerfile
    container_name: cv-ai-service
    environment:
      PYTHONUNBUFFERED: 1
      OLLAMA_HOST: ${OLLAMA_HOST}
      TESSERACT_LANG: eng+fra+ara+spa
    volumes:
      - ./file-storage:/app/file-storage      # Shared with Backend
      - ./ai-service/templates:/app/templates
      - ./logs/ai-service:/app/logs
    ports:
      - "8000:8000"
    networks:
      - cv-network
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

  # React Frontend
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
      target: development
    container_name: cv-frontend
    environment:
      VITE_API_URL: http://localhost:3000
    volumes:
      - ./frontend/src:/app/src
      - ./frontend/public:/app/public
    ports:
      - "5173:5173"
    networks:
      - cv-network
    command: npm run dev

  # n8n Workflow Automation
  n8n:
    image: n8nio/n8n:latest
    container_name: cv-n8n
    environment:
      N8N_BASIC_AUTH_ACTIVE: true
      N8N_BASIC_AUTH_USER: ${N8N_USER}
      N8N_BASIC_AUTH_PASSWORD: ${N8N_PASSWORD}
      WEBHOOK_URL: http://localhost:5678
    volumes:
      - n8n-data:/home/node/.n8n
      - ./n8n/workflows:/workflows
    ports:
      - "5678:5678"
    networks:
      - cv-network

  # Ollama (Local LLM)
  ollama:
    image: ollama/ollama:latest
    container_name: cv-ollama
    volumes:
      - ollama-data:/root/.ollama
    ports:
      - "11434:11434"
    networks:
      - cv-network
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

  # Nginx Reverse Proxy
  nginx:
    build:
      context: ./nginx
      dockerfile: Dockerfile
    container_name: cv-nginx
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf
      - ./nginx/ssl:/etc/nginx/ssl
      - ./logs/nginx:/var/log/nginx
    depends_on:
      - backend
      - frontend
    networks:
      - cv-network

networks:
  cv-network:
    driver: bridge

volumes:
  postgres-data:
  redis-data:
  n8n-data:
  ollama-data:
```

---

## 📦 Key Dockerfiles

### **backend/Dockerfile**

```dockerfile
FROM node:18-alpine AS development

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Build
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:dev"]

# Production stage
FROM node:18-alpine AS production

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY --from=development /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main"]
```

### **ai-service/Dockerfile**

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-fra \
    tesseract-ocr-ara \
    tesseract-ocr-spa \
    libreoffice \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### **frontend/Dockerfile**

```dockerfile
FROM node:18-alpine AS development

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]

# Production build
FROM node:18-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Nginx serve
FROM nginx:alpine AS production

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

---

## 🔧 Environment Variables (.env.example)

```bash
# Environment
NODE_ENV=development

# Database
DB_HOST=postgres
DB_PORT=5432
DB_NAME=cv_management
DB_USER=postgres
DB_PASSWORD=yourpassword

# Redis (Job Queue)
REDIS_HOST=redis
REDIS_PORT=6379

# JWT
JWT_SECRET=your-super-secret-jwt-key
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=7d

# OpenAI
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxx
EMBEDDING_MODEL=text-embedding-3-small
LLM_MODEL=gpt-4o-mini

# Ollama (Alternative)
OLLAMA_HOST=http://ollama:11434
OLLAMA_MODEL=llama3.1

# File Storage
STORAGE_PATH=/app/file-storage
MAX_FILE_SIZE=10485760

# n8n
N8N_USER=admin
N8N_PASSWORD=yourpassword

# NextOra Integration
NEXTORA_API_URL=https://nextora.example.com
NEXTORA_API_KEY=your-nextora-api-key
NEXTORA_WEBHOOK_SECRET=your-webhook-secret

# Email (for notifications)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password

# Frontend
VITE_API_URL=http://localhost:3000
```

---

## 📦 Additional Dependencies

### **backend/package.json** (Additional)

```json
{
  "dependencies": {
    "@nestjs/bull": "^10.0.0",
    "bull": "^4.11.0",
    "chokidar": "^3.5.3",
    "@nestjs/axios": "^3.0.0",
    "axios": "^1.6.0"
  }
}
```

### **ai-service/requirements.txt**

```txt
fastapi==0.109.0
uvicorn[standard]==0.27.0
PyMuPDF==1.23.0
python-docx==1.1.0
pytesseract==0.3.10
Pillow==10.2.0
docxtpl==0.16.7
python-multipart==0.0.6
pydantic==2.5.0
```

---

## 🚀 Quick Start Commands

```bash
# 1. Clone and setup
git clone <repository>
cd cv-management-system
cp .env.example .env
# Edit .env with your credentials

# 2. Build and start all services
docker-compose up -d --build

# 3. Check status
docker-compose ps

# 4. View logs
docker-compose logs -f backend
docker-compose logs -f ai-service

# 5. Access services
# Frontend: http://localhost:5173
# Backend API: http://localhost:3000
# AI Service: http://localhost:8000
# n8n: http://localhost:5678
# Database: localhost:5432

# 6. Run migrations
docker-compose exec backend npm run migration:run

# 7. Seed database
docker-compose exec backend npm run seed

# 8. Generate embeddings for existing employees
docker-compose exec backend npm run embeddings:generate

# 9. Pull Ollama model (if using local LLM)
docker-compose exec ollama ollama pull llama3.1

# 10. Test auto-sync (add a CV manually)
docker-compose exec backend mkdir -p /app/file-storage/cv-database/Test_User
docker-compose exec backend cp /path/to/test.pdf /app/file-storage/cv-database/Test_User/Test_User_CV.pdf
# Watch logs: docker-compose logs -f backend

# 11. Stop all services
docker-compose down

# 12. Stop and remove volumes (CAUTION: deletes data)
docker-compose down -v
```

---

## 🔄 Auto-Sync Flow

```
1. User uploads CV → file-storage/cv-database/Imen_BenAli/CV.pdf
                ↓
2. Chokidar detects new file → FolderWatcherService
                ↓
3. SyncService creates job → Bull Queue (Redis)
                ↓
4. CVParseProcessor picks up job
                ↓
5. Calls Python AI service → POST /api/parse/cv
                ↓
6. Python parses PDF → Returns structured data
                ↓
7. Backend receives parsed data
                ↓
8. Updates database → employees, skills, education tables
                ↓
9. Updates metadata.json → file-storage/cv-database/Imen_BenAli/metadata.json
                ↓
10. DONE: DB ↔ Files ↔ metadata.json all synced ✅
```

---

## 📝 Key Features of This Structure

### ✅ **Microservices Architecture**
- **Backend (NestJS)**: Business logic, API, database
- **AI Service (Python)**: Parsing, OCR, CV generation, NLP
- **Frontend (React)**: User interface
- **n8n**: Workflow automation
- **Ollama**: Local LLM (alternative to OpenAI)

### ✅ **Auto-Sync System**
- **Chokidar**: Watches file-storage for changes
- **Bull + Redis**: Background job queue for async processing
- **Metadata Service**: Manages metadata.json files
- **Bi-directional Sync**: File ↔ DB ↔ metadata.json

### ✅ **Docker Benefits**
- Consistent development environment
- Easy deployment
- Service isolation
- Scalability
- Easy rollback

### ✅ **Data Persistence**
- `file-storage/`: Persistent CV and certificate storage
- `postgres-data`: Database volume
- `redis-data`: Queue data persistence
- `n8n-data`: Workflow configurations
- `ollama-data`: Model storage

### ✅ **NextOra Integration**
- Dedicated module in backend (`src/nextora/`)
- Webhook endpoints for bidirectional communication
- Natural language query/update support

### ✅ **GDPR Compliance**
- Local file storage (no cloud)
- pgvector for embeddings (local)
- Ollama option for LLM (local, no API)

### ✅ **3 Fixed CV Templates + Custom**
- Standard, Canadian, EU templates included
- BID managers can upload client-specific templates
- Stored in `templates/custom/` directory

---

This structure is production-ready, scalable, includes auto-sync functionality, and follows best practices for microservices architecture with Docker! 🚀