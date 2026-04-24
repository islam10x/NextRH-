# Scoring Rules Reference

This document describes the scoring logic currently implemented in the application after the production-readiness corrections.

## Final Score Formula

The final annual score is:

`Final score = (Projects + Certifications + Trainings + Formations) / 4`

Each pillar is computed separately, then the four values are averaged with equal weight.

## Project Pillar

Project scoring is based on project assignment and project evidence, then refined by manager evaluation.

### Manager Score Rule

When a manager gives a project score out of 20:

`Project contribution = (manager score / 20) x 100`

Example:

`16 / 20 -> 80 / 100`

This manager score is the definitive project contribution.

### Provisional Fallback Rule

If no manager score is available yet, the project uses complexity only:

`low = 45`

`medium = 65`

`high = 85`

So the fallback formula is:

`Provisional project contribution = complexity base`

Important correction:

`PV evidence does not add bonus points by itself`

This was changed intentionally because a document can validate evidence, but it should not mathematically inflate performance before a manager evaluation.

### Unknown Complexity Rule

If no explicit complexity is available yet, the implemented default is:

`unknown complexity -> medium`

This is a neutral fallback and avoids under-crediting or over-crediting by default.

## Internal vs External Scoring Workflow

### Internal Project

Internal projects are scored in the PV submission flow.

The implemented workflow is:

1. The employee is assigned to an internal project.
2. The project can contribute provisionally through complexity if it falls in the scoring year.
3. When the manager submits the PV, the manager also enters the internal employee score on a `/20` scale.
4. That score becomes the definitive project contribution after conversion to `/100`.

If the internal score is still missing, the application surfaces that missing action next to the `Scoring` entry and reminds the manager from the Team Scoring page.

### External Project

The implemented workflow is:

1. A cross-team request is approved and one employee is selected.
2. The employee is assigned to the external project, but the score does not increase yet.
3. The project manager uploads the PV to document the external contribution.
4. At that moment the project can start contributing with the provisional complexity fallback.
5. The project manager writes the contribution summary.
6. The employee's home manager reviews that summary and gives the final score out of 20.
7. The home-manager score replaces the provisional fallback.

This keeps responsibility clear:

`project manager = describes external contribution`

`home manager = gives final employee score`

## Why Internal And External Are Handled Differently

The production-ready rule is now:

1. Internal employees are scored directly by their own manager because that manager owns the assignment and can evaluate performance directly.
2. For internal projects, that scoring input is captured during PV submission so the manager completes evidence and scoring in one place.
3. External employees are finalized by their home manager because the home manager owns the employee evaluation relationship and should remain accountable for the final score.
4. External employees do not receive project score immediately on approval; score begins only after PV submission.

So the asymmetry is now intentional and justified, not accidental.

## Which Projects Count In The Current Year

The scoring engine counts projects in the scoring year using the best available reference date.

Priority order:

1. Project record reference date
2. Project end date
3. Project start date

The project record reference date can come from:

`verified PV completion date`

`provisional assignment date saved during internal assignment or cross-team approval`

`record creation date when neither of the two dates above exists`

This means an internal assigned project can already contribute during the current year before the workflow is fully closed. An external assigned project starts contributing only once the PV creates the project record.

## Certification Pillar

The certification pillar depends on the annual certification target set by the team manager.

Formula:

`Certification score = min(100, (active certifications in year / effective target) x 100)`

If the configured target is `0`, the system still uses an effective minimum target of `1` to avoid division by zero.

## Training Pillar

Each completed assigned training adds 20 points.

Formula:

`Training score = completed training count x 20`

This pillar is not artificially capped.

## Formation Pillar

Each delivered formation adds 25 points.

Formula:

`Formation score = delivered formation count x 25`

This pillar is not artificially capped.

## Fairness Principles In The Current Logic

The implemented logic now follows these fairness rules:

1. Evidence and performance are separated: a PV can support a workflow, but it does not create bonus points on its own.
2. Unknown complexity defaults to medium, which is the neutral operational fallback.
3. Internal employees are scored by their own manager during PV submission, so evidence and scoring are completed in one operation.
4. External employees are not credited simply because an approval happened; score starts only when the project is evidenced by PV submission.
5. Final human evaluation always overrides the provisional fallback when a manager score exists.
6. The application visually flags missing scoring actions for managers next to `Scoring`.
7. The employee-facing and manager-facing score breakdowns explain the exact rule used for each counted project.

## Scenario Summary

### Case 1: Internal project not scored yet

Result:

`project contribution = complexity base only`

### Case 2: Internal project scored by the team manager

Result:

`project contribution = (manager score / 20) x 100`

### Case 3: External project approved but not yet finalized

Result:

`project contribution = 0 until PV submission`

### Case 4: External project after PV submission but before home-manager review

Result:

`project contribution = complexity base only`

### Case 5: External project finalized by the home manager

Result:

`project contribution = (home manager score / 20) x 100`

### Case 6: No known complexity yet

Result:

`project contribution = medium = 65`