# Scoring Formulas and Examples

This document describes the exact scoring formulas currently used by the backend in `backend/src/scoring/scoring.service.ts`.

## 1. Final Score Formula

The final yearly score is the simple average of 4 pillars:

```text
finalScore = (projectScore + certificationScore + trainingScore + formationScore) / 4
```

The backend stores each pillar on a 0-100 scale, then averages them with equal weight.

## 2. Project Score Formula

For every project completed in the selected year:

### Case A: project has a manager evaluation

If the manager entered a score on a `/20` scale:

```text
projectContribution = (managerScore / 20) * 100
```

Examples:

- `20/20 -> 100`
- `16/20 -> 80`
- `12/20 -> 60`
- `8/20 -> 40`

Note:

- Legacy scores already stored on `/100` are kept as-is.

### Case B: pending external evaluation

If the project is waiting for the employee's home manager to score it, the project still contributes immediately using complexity:

```text
complexityBase(low) = 45
complexityBase(medium) = 65
complexityBase(high) = 85
pvBonus = 10 if PV is verified, else 0
projectContribution = min(100, complexityBase + pvBonus)
```

Examples:

- `low + PV -> 45 + 10 = 55`
- `medium + PV -> 65 + 10 = 75`
- `high + PV -> 85 + 10 = 95`
- `high without PV -> 85`

### Project pillar average

If an employee has multiple projects in the year:

```text
projectScore = average(all projectContribution values for the year)
```

Example:

- Project 1: `16/20 -> 80`
- Project 2: pending external, `high + PV -> 95`
- Project 3: `12/20 -> 60`

```text
projectScore = (80 + 95 + 60) / 3 = 78.33
```

## 3. Certification Score Formula

The certification score depends on the yearly target.

```text
effectiveTarget = max(certificationTarget, 1)
certificationScore = min(100, (activeCertificationsThisYear / effectiveTarget) * 100)
```

Examples:

### Example A

- target = `2`
- active certifications this year = `1`

```text
certificationScore = (1 / 2) * 100 = 50
```

### Example B

- target = `2`
- active certifications this year = `2`

```text
certificationScore = (2 / 2) * 100 = 100
```

### Example C

- target = `2`
- active certifications this year = `3`

```text
certificationScore = min(100, 150) = 100
```

## 4. Training Score Formula

Completed training sessions contribute `20` points each, capped at `100`.

```text
trainingScore = min(100, completedTrainingCount * 20)
```

Examples:

- `1 training -> 20`
- `3 trainings -> 60`
- `5 trainings -> 100`
- `7 trainings -> 100`

## 5. Formation Score Formula

Uploaded training sheets / trainer formations contribute `25` points each, capped at `100`.

```text
formationScore = min(100, formationCount * 25)
```

Examples:

- `1 formation -> 25`
- `2 formations -> 50`
- `4 formations -> 100`
- `6 formations -> 100`

## 6. Full Worked Example

Assume this employee has the following for 2026:

- Project A: `15/20`
- Project B: pending external evaluation, `high` complexity, PV uploaded
- Certifications: `1`
- Certification target: `2`
- Completed trainings: `3`
- Formations: `2`

### Step 1: project contributions

Project A:

```text
(15 / 20) * 100 = 75
```

Project B:

```text
high base = 85
PV bonus = 10
projectContribution = 95
```

### Step 2: project pillar

```text
projectScore = (75 + 95) / 2 = 85
```

### Step 3: certification pillar

```text
certificationScore = (1 / 2) * 100 = 50
```

### Step 4: training pillar

```text
trainingScore = 3 * 20 = 60
```

### Step 5: formation pillar

```text
formationScore = 2 * 25 = 50
```

### Step 6: final score

```text
finalScore = (85 + 50 + 60 + 50) / 4
finalScore = 245 / 4
finalScore = 61.25
```

## 7. Example After Home Manager External Review

Take the same employee, but now the home manager reviews Project B and gives `18/20`.

Project B changes from complexity-based `95` to manager-based:

```text
(18 / 20) * 100 = 90
```

Then:

```text
projectScore = (75 + 90) / 2 = 82.5
finalScore = (82.5 + 50 + 60 + 50) / 4 = 60.625
```

Rounded by the backend:

```text
finalScore = 60.63
```

## 8. Important UX/Behavior Notes

- A pending external project already impacts the employee score immediately after PV upload.
- Once the home manager submits the final `/20` score, that project switches from complexity-based scoring to manager-based scoring.
- If a PV upload is a duplicate, the backend now returns a clear message indicating the PV already exists.
- The final score is not weighted by custom coefficients: all 4 pillars currently have equal weight.
