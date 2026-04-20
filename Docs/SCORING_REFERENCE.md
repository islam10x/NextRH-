# Référence Complète du Scoring NextRH

> Dernière mise à jour : 2026-04-20
> Document de référence pour le calcul, l'affichage, les permissions et l'interprétation du scoring.

## 1. Objectif du scoring

Le scoring mesure la performance annuelle d'un employé sur 4 axes :

| Axe | Ce qui est mesuré |
| --- | --- |
| Projets | Contribution sur les projets pris en compte pour l'année de scoring |
| Certifications | Progression par rapport à l'objectif annuel de certifications |
| Trainings | Formations suivies et complétées |
| Formations | Formations dispensées aux clients |

Le score final est une somme pondérée de ces 4 sous-scores. Il n'est pas plafonné.

## 2. Sources de données utilisées

### Projets

- Source principale : `project_participants` joint à `projects`
- Condition : seuls les projets assignés par un manager comptent (`assigned_by IS NOT NULL`)
- Les projets injectés uniquement par parsing CV ne comptent pas dans le scoring
- Les PV importés peuvent enrichir la complexité, le rôle et la date, et donnent un bonus si vérifiés

### Certifications

- Source : table des certifications
- Condition : statut `active`
- Filtre annuel : la date d'obtention doit appartenir à l'année scorée

### Trainings

- Source : sessions de training
- Condition : statut `completed`
- Filtre annuel : année extraite de `end_date`, sinon `start_date`, sinon `due_date`, sinon `updated_at`

### Formations dispensées

- Source : `training_records`
- Filtre annuel : année extraite de `start_date` ou `end_date`

## 3. Règles de calcul

### 3.1 Score projets

Pour chaque projet retenu :

$$
points\_projet = 10 \times C \times R \times PV
$$

Avec :

| Facteur | Valeurs |
| --- | --- |
| Complexité `C` | `low = 1.0`, `medium = 2.0`, `high = 3.5` |
| Rôle `R` | `contributor = 1.0`, `technical_lead = 1.3`, `project_lead = 1.5` |
| Bonus PV `PV` | `1.25` si PV vérifié, sinon `1.0` |

Score projets total :

$$
score\_projets = \sum (10 \times C_i \times R_i \times PV_i)
$$

### 3.2 Score certifications

$$
score\_certifications = \frac{N}{T} \times 100
$$

Où :

- `N` = nombre de certifications actives obtenues pendant l'année
- `T` = objectif annuel de certifications
- Si aucun objectif n'est défini, la valeur par défaut utilisée dans le calcul est `2`
- Une protection locale impose un dénominateur minimal de `1`

### 3.3 Score trainings

$$
score\_trainings = N \times 10
$$

Où `N` est le nombre de trainings complétés pour l'année.

### 3.4 Score formations

$$
score\_formations = N \times 10
$$

Où `N` est le nombre de formations dispensées pendant l'année.

### 3.5 Score final

$$
score\_final = W_p \times score\_projets + W_c \times score\_certifications + W_t \times score\_trainings + W_f \times score\_formations
$$

Avec :

- `W_p` = poids projets
- `W_c` = poids certifications
- `W_t` = poids trainings
- `W_f` = poids formations

Les poids doivent être compris entre `0` et `1` et leur somme doit rester proche de `1.0`.

## 4. Poids et portée des poids

Le système supporte 2 niveaux de poids :

1. Poids globaux
2. Poids spécifiques à une équipe

Règle de résolution :

1. Si un employé appartient à une équipe qui possède des poids spécifiques, ces poids sont utilisés.
2. Sinon, le système retombe sur les poids globaux.

Conséquences côté produit :

- Un `team_manager` modifie uniquement les poids de sa propre équipe.
- Un `bid_manager` peut modifier les poids globaux, ou cibler une équipe via `teamId`.
- Quand un employé ouvre son scoring, les poids affichés sont les poids effectivement appliqués à son calcul.

Valeurs par défaut utilisées par le système si aucun réglage n'existe encore :

| Poids | Valeur par défaut |
| --- | --- |
| Projets | 35% |
| Certifications | 25% |
| Trainings | 20% |
| Formations | 20% |

## 5. Objectif de certifications

L'objectif de certifications est défini par année et par employé.

- Il influence uniquement le sous-score certifications.
- Si aucun objectif explicite n'existe, le calcul prend `2` comme cible par défaut.
- Côté employé, l'interface affiche l'objectif défini par le manager s'il existe.

## 6. Classements

### Rang global

Le rang global est calculé sur tous les employés scorés de l'année, triés par score final décroissant.

- `1` = meilleur score global
- `2` = deuxième meilleur score global
- etc.

### Rang dans l'équipe

Le rang dans l'équipe est calculé après regroupement des employés par équipe.

- Il dépend uniquement des scores des membres de la même équipe.
- Il n'est pas utilisé partout dans l'UI actuelle, mais il est stocké côté backend.

## 7. Réinitialisation annuelle

Le scoring est annuel.

- seuls les éléments datés dans l'année de scoring sont pris en compte
- il n'y a plus de mécanisme de decay inter-annuel des projets
- au 1er janvier, le calcul repart naturellement sur les données de la nouvelle année

## 8. Ce que chaque rôle peut voir ou modifier

### Employé

Peut voir :

- son score final et ses sous-scores
- son rang global
- les poids appliqués à son scoring
- les formules utilisées
- l'objectif de certifications s'il existe
- le classement global

Ne voit pas :

- le détail pas à pas du calcul numérique
- le détail interne projet par projet utilisé pour dériver le score final

### Team Manager

Peut :

- calculer les scores de son équipe
- importer des PV
- définir les objectifs de certifications
- modifier les poids de sa propre équipe
- consulter le classement de son équipe

### BID Manager

Peut :

- accéder aux fonctionnalités globales
- modifier les poids globaux
- cibler une équipe spécifique si nécessaire

## 9. Affichage dans l'interface

### Page employé `Mon Scoring`

Affiche :

- score final
- sous-scores par axe
- rang global
- poids actifs
- formules
- objectif certifications
- classement global

### Dashboard employé

Le widget de score affiche :

- score final
- sous-scores
- rang global

### Page manager `Scoring Employés`

Affiche :

- le classement de l'équipe pour un `team_manager`
- la configuration des poids si le rôle l'autorise

## 10. Déclencheurs de recalcul

Le système recalcule ou peut recalculer les scores dans ces cas :

1. calcul manuel d'un score employé
2. calcul manuel des scores d'équipe
3. modification d'un enregistrement projet influençant le score
4. modification des poids, avec recalcul immédiat des scores de l'année en cours sur le périmètre concerné
5. certains imports métier, comme un PV, suivis d'un recalcul

Après chaque recomputation individuelle, les rankings sont remis à jour.

## 11. Points d'attention produit

1. Le score final dépend des poids actifs au moment du calcul. Si les poids changent, les scores doivent être recalculés pour rester cohérents.
2. Les classements visibles côté produit reposent sur le rang, pas sur le percentile.

## 12. Résumé rapide

| Élément | Portée | Remarque |
| --- | --- | --- |
| Score final | Employé, année | Somme pondérée des 4 axes |
| Rang global | Global | Basé sur tous les employés scorés de l'année |
| Rang d'équipe | Équipe | Basé sur les membres de la même équipe |
| Poids | Global ou équipe | Résolus automatiquement selon l'équipe |
| Objectif certifications | Employé, année | Défini par manager, défaut de calcul = 2 |

## 13. Références techniques utiles

- Backend principal : `backend/src/scoring/scoring.service.ts`
- Contrôleur scoring : `backend/src/scoring/scoring.controller.ts`
- Page employé : `frontend/src/pages/employee/EmployeeScoringPage.tsx`
- Dashboard employé : `frontend/src/pages/employee/EmployeeDashboard.tsx`
- Page manager : `frontend/src/pages/manager/ManagerScoringPage.tsx`
