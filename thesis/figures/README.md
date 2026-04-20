## Figures folder

Place exported PNG/PDF images here before compiling.

| Filename                | Source                                              |
|-------------------------|-----------------------------------------------------|
| arch_overview.png       | Draw manually or export from draw.io                |
| usecase_general.png     | Export Docs/diagrams/00_general_usecase.drawio      |
| uc_auth.png             | Export Docs/diagrams/01_auth_user_management.drawio |
| uc_cv.png               | Export Docs/diagrams/02_cv_management.drawio        |
| uc_cert.png             | Export Docs/diagrams/03_certification_management.drawio |
| uc_training.png         | Export Docs/diagrams/04_training_management.drawio  |
| uc_team.png             | Export Docs/diagrams/05_team_management.drawio      |
| uc_rag.png              | Export Docs/diagrams/06_rag_ai_assistant.drawio     |
| uc_notif.png            | Export Docs/diagrams/07_notifications.drawio        |
| uc_employee.png         | Export Docs/diagrams/08_employee_directory.drawio   |
| rag_arch.png            | Export Docs/diagrams/09_ai_service_internals.drawio |
| seq_invite.png          | Render Docs/diagrams/01_auth_user_management.puml   |
| seq_cv.png              | Draw sequence diagram for CV upload flow            |
| seq_cert.png            | Render Docs/diagrams/03_certification_management.puml|
| seq_training.png        | Render Docs/diagrams/04_training_management.puml    |
| seq_rag.png             | Render Docs/diagrams/06_rag_ai_assistant.puml       |
| seq_cvgen.png           | Render Docs/diagrams/09_ai_service_internals.puml   |
| db_schema.png           | Export DB ER diagram (pgAdmin or DBeaver)           |

### How to export draw.io diagrams to PNG
1. Open draw.io (diagrams.net) — File > Open from Device
2. File > Export As > PNG (set DPI to 150+)
3. Save as the filename listed above into this folder

### How to render PlantUML diagrams
Using the PlantUML VSCode extension or CLI:
```
java -jar plantuml.jar Docs/diagrams/06_rag_ai_assistant.puml -o thesis/figures/
```
