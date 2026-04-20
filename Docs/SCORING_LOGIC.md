# Système de Scoring des Employés — Documentation Complète

> Référence fonctionnelle et technique actuelle : voir aussi [SCORING_REFERENCE.md](SCORING_REFERENCE.md).

> **Version** : 2.1 — Production Ready  
> **Dernière mise à jour** : Avril 2026

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Architecture technique](#2-architecture-technique)
3. [Définitions — Que représente chaque métrique ?](#3-définitions)
4. [Toutes les formules](#4-toutes-les-formules)
5. [Tables de référence](#5-tables-de-référence)
6. [Pondérations (Weights)](#6-pondérations-weights)
7. [Classement, Rang et Percentile](#7-classement-rang-et-percentile)
8. [Rôles et permissions](#8-rôles-et-permissions)
9. [Parcours utilisateur](#9-parcours-utilisateur)
10. [Exemples chiffrés complets](#10-exemples-chiffrés-complets)
11. [Schéma base de données](#11-schéma-base-de-données)

---

## 1. Vue d'ensemble

Le système de scoring évalue chaque employé sur **4 axes** :

| Axe | Ce que ça mesure |
|-----|-----------------|
| **Projets** | L'impact de l'employé dans les projets de l'entreprise |
| **Certifications** | La progression vers l'objectif de certifications fixé par le manager |
| **Trainings (formations reçues)** | L'investissement de l'employé dans son développement personnel |
| **Formations dispensées** | La contribution de l'employé en tant que formateur pour les clients |

Le **score final** est la somme pondérée des 4 sous-scores. **Aucun plafond** : un employé très performant peut dépasser 100.

---

## 2. Architecture technique

```
┌─────────────┐         HTTP POST          ┌─────────────────┐
│   Frontend   │ ◄─────────────────────────► │  NestJS Backend  │
│   (React)    │                            │  (Orchestration)  │
└─────────────┘                            └────────┬──────────┘
                                                     │
                                           Collecte données DB
                                           (projets, certs, trainings)
                                                     │
                                                     ▼
                                           ┌─────────────────┐
                                           │  AI Service      │
                                           │  (Python/FastAPI) │
                                           │  scoring_engine   │
                                           └─────────────────┘
```

**Flux** :
1. Le **Backend NestJS** collecte toutes les données depuis PostgreSQL
2. Il envoie un payload JSON au **AI Service Python**
3. Le **ScoringEngine** calcule les 4 sous-scores
4. Le score final = somme pondérée
5. Le Backend sauvegarde le résultat + met à jour les classements (rang, percentile)

---

## 3. Définitions — Que représente chaque métrique ?

### Score Projets (`project_score`)
**Représente** l'impact cumulé de l'employé sur les projets de l'entreprise pendant **l'année de scoring uniquement**. **Seuls les projets assignés par un team manager comptent** — les projets provenant du CV parsing ne sont pas pris en compte dans le scoring. Plus un projet est complexe, plus le rôle est élevé, et plus le PV est présent, plus les points sont élevés. Un reset annuel est appliqué : au 1er janvier, on repart sur les projets de la nouvelle année.

### Score Certifications (`certification_score`)
**Représente** le taux de réalisation de l'objectif annuel de certifications fixé par le manager. Un score de 100 signifie que l'objectif est atteint. Au-delà de 100, l'employé a dépassé l'objectif.

### Score Trainings (`training_score`)
**Représente** le nombre de formations assignées par le manager que l'employé a complétées. Chaque formation terminée = 10 points. Cela mesure l'investissement de l'employé dans son propre développement.

### Score Formations (`formation_score`)
**Représente** le nombre de formations que l'employé a **dispensées aux clients** (prouvé par une feuille de présence/attestation uploadée). Chaque formation donnée = 10 points. Cela mesure la contribution de l'employé en tant que formateur.

### Score Final (`final_score`)
**Représente** la performance globale de l'employé, calculée comme la somme pondérée des 4 sous-scores. Les poids déterminent l'importance relative de chaque axe.

### Rang Global (`rank_global`)
**Représente** la position de l'employé par rapport à tous les autres employés scorés cette année. Rang #1 = meilleur score.

### Rang Équipe (`rank_in_team`)
**Représente** la position de l'employé au sein de sa propre équipe uniquement.

### Percentile (`percentile`)
**Représente** le pourcentage d'employés qui ont un score **inférieur** à celui de cet employé. 

- **67%** signifie que 67% des employés ont un score plus bas → l'employé est dans le top 33%
- **100%** signifie que l'employé a le meilleur score (ou est seul)
- **0%** signifie que l'employé a le score le plus bas — aucun employé n'est en dessous
- Un percentile élevé = bonne performance relative

---

## 4. Toutes les formules

### 4.1 Score Projets

Pour **chaque projet** de l'employé :

```
points_projet = 10 × C × R × PV
```

Où :
- **`10`** = points de base par projet
- **`C`** = poids de complexité du projet :
  - `low` = 1.0, `medium` = 2.0, `high` = 3.5
- **`R`** = multiplicateur du rôle de l'employé :
  - `contributor` = 1.0, `technical_lead` = 1.3, `project_lead` = 1.5
- **`PV`** = bonus procès-verbal :
  - Avec PV vérifié = 1.25, Sans PV = 1.0

Seuls les projets dont la date de référence tombe dans l'année scorée sont pris en compte.

Le **score projets total** est la somme de tous les projets :

```
score_projets = Σ (10 × Cᵢ × Rᵢ × PVᵢ)
```

> **Pas de plafond** — plus l'employé a de projets, plus le score monte.

---

### 4.2 Score Certifications

```
score_certifications = (N / T) × 100
```

Où :
- **`N`** = nombre de certifications obtenues cette année (status = `active`)
- **`T`** = objectif annuel fixé par le manager (défaut = 2). Si T = 0, on utilise T = 1.

> **Pas de plafond** — si N > T, le score dépasse 100.

---

### 4.3 Score Trainings (Formations reçues)

```
score_trainings = N × 10
```

Où :
- **`N`** = nombre de formations assignées par le manager et complétées par l'employé (status = `completed`) cette année
- **`10`** = points par formation

> **Pas de plafond.**

---

### 4.4 Score Formations (Formations dispensées)

```
score_formations = N × 10
```

Où :
- **`N`** = nombre de formations dispensées aux clients cette année (vérifiées par feuille de présence uploadée)
- **`10`** = points par formation

> **Pas de plafond.**

---

### 4.5 Score Final

```
score_final = Wp × score_projets + Wc × score_certifications + Wt × score_trainings + Wf × score_formations
```

Où :
- **`Wp`** = poids projets (défaut **0.35** = 35%)
- **`Wc`** = poids certifications (défaut **0.25** = 25%)
- **`Wt`** = poids trainings (défaut **0.20** = 20%)
- **`Wf`** = poids formations (défaut **0.20** = 20%)

> Les poids sont configurables par le BID Manager. Ils doivent être des fractions entre 0 et 1.
> **Le score final n'est pas plafonné.**

---

### 4.6 Percentile

```
percentile = ((N_total - rang) / N_total) × 100
```

Où :
- **`N_total`** = nombre total d'employés scorés cette année
- **`rang`** = rang global de l'employé (1 = meilleur score)
- Si `N_total` = 1 (un seul employé), le percentile est **100** par convention

**Interprétation** :
| Rang | N_total | Calcul | Percentile | Signification |
|------|---------|--------|------------|---------------|
| 1 | 3 | (3-1)/3 × 100 | **66.7%** | 67% des employés sont en dessous |
| 2 | 3 | (3-2)/3 × 100 | **33.3%** | 33% des employés sont en dessous |
| 3 | 3 | (3-3)/3 × 100 | **0.0%** | Personne n'est en dessous |
| 1 | 5 | (5-1)/5 × 100 | **80.0%** | 80% des employés sont en dessous |
| 1 | 1 | convention | **100%** | Seul employé → percentile max |

---

### 4.7 Reset annuel des projets

Le scoring projets fonctionne désormais par **année civile** :

- seuls les projets datés dans `score_year` sont comptés ;
- les projets des années précédentes ne sont pas dégradés, ils sont simplement **ignorés** ;
- au **1er janvier**, le calcul repart sur les projets de la nouvelle année.

---

### Résumé de toutes les formules

| Métrique | Formule | Plafond |
|----------|---------|---------|
| Score projet (par projet) | `10 × C × R × PV` | Aucun |
| Score projets (total) | `Σ (10 × Cᵢ × Rᵢ × PVᵢ)` | Aucun |
| Score certifications | `(N / T) × 100` | Aucun |
| Score trainings | `N × 10` | Aucun |
| Score formations | `N × 10` | Aucun |
| **Score final** | `Wp×Projets + Wc×Certifs + Wt×Trainings + Wf×Formations` | **Aucun** |
| Percentile | `((N_total - rang) / N_total) × 100` | 100% |

---

## 5. Tables de référence

### Complexité du projet

| Niveau | Valeur DB | Poids (C) |
|--------|-----------|-----------|
| Faible | `low` | 1.0 |
| Moyenne | `medium` | 2.0 |
| Élevée | `high` | 3.5 |

### Rôle de l'employé (enum PostgreSQL strict)

| Rôle | Valeur DB | Multiplicateur (R) |
|------|-----------|-------------------|
| Contributeur | `contributor` | ×1.0 |
| Lead technique | `technical_lead` | ×1.3 |
| Chef de projet | `project_lead` | ×1.5 |

### Bonus PV

| Situation | Multiplicateur (PV) |
|-----------|-------------------|
| Pas de PV | ×1.0 |
| PV vérifié | ×1.25 |

### Exemples de points par projet (année en cours, D=1)

| Complexité | Rôle | PV | Points |
|-----------|------|----|--------|
| low | contributor | ❌ | 10 × 1.0 × 1.0 × 1.0 = **10.0** |
| medium | contributor | ❌ | 10 × 2.0 × 1.0 × 1.0 = **20.0** |
| high | project_lead | ❌ | 10 × 3.5 × 1.5 × 1.0 = **52.5** |
| high | project_lead | ✅ | 10 × 3.5 × 1.5 × 1.25 = **65.6** |

---

## 6. Pondérations (Weights)

### Poids globaux vs poids par équipe

Le système supporte des poids personnalisés par équipe. Lors du calcul :
1. On cherche les poids spécifiques à l'équipe de l'employé
2. Si non trouvés, on utilise les poids globaux (team_id = NULL)
3. Si aucun poids global n'existe, on crée les défauts (0.35, 0.25, 0.20, 0.20)

### Modifier les poids

```
PATCH /scoring/weights
{
  "projectWeight": 0.30,
  "certificationWeight": 0.30,
  "trainingWeight": 0.20,
  "formationWeight": 0.20,
  "teamId": "uuid-equipe"    // optionnel
}
```

> Validation : chaque poids doit être entre 0 et 1. Seul le `BID_MANAGER` peut modifier les poids.

---

## 7. Classement, Rang et Percentile

### Comment le classement est calculé

Après `POST /scoring/compute-team`, le système :
1. Récupère **tous** les scores de l'année
2. Les trie par `final_score` décroissant
3. Attribue le `rank_global` (position 1, 2, 3…)
4. Calcule le `percentile` : `((N - rang) / N) × 100`
5. Regroupe par équipe et attribue le `rank_in_team`

### Percentile — Explication détaillée

Le percentile indique **quel pourcentage d'employés ont un score inférieur** à celui de l'employé.

```
percentile = ((N_total - rang) / N_total) × 100
```

- **N_total** = nombre total d'employés scorés cette année
- **rang** = position de l'employé (1 = meilleur)

**Exemple concret avec 3 employés** :

| Rang | Employé | Score | Calcul | Percentile | Signification |
|------|---------|-------|--------|------------|---------------|
| 1 | Jazil | 100.0 | (3−1)/3 × 100 | **67%** | 67% des employés sont en dessous |
| 2 | Aya | 62.5 | (3−2)/3 × 100 | **33%** | 33% des employés sont en dessous |
| 3 | Anouar | 43.3 | (3−3)/3 × 100 | **0%** | Personne n'est en dessous |

**Cas spéciaux** :
- Si un seul employé est scoré → percentile = **100%** par convention
- Le percentile est arrondi au centième (ex: 66.67%)

### Qui peut voir le classement ?

| Rôle | Accès leaderboard |
|------|-------------------|
| `EMPLOYEE` | ✅ Peut voir le classement |
| `TEAM_MANAGER` | ✅ Peut voir + filtrer par équipe |
| `BID_MANAGER` | ✅ Accès complet |

```
GET /scoring/leaderboard?year=2026&teamId=xxx&limit=10
```

---

## 8. Rôles et permissions

### Rôle dans les projets (enum strict)

Le rôle d'un participant dans un projet est un **enum PostgreSQL** avec exactement 3 valeurs :

```
'contributor'      → Contributeur
'technical_lead'   → Responsable technique
'project_lead'     → Chef de projet
```

Aucun texte libre n'est accepté. La migration `21-scoring-production-fixes.sql` convertit les anciennes valeurs libres vers l'enum.

### Rôles utilisateur (permissions système)

| Action | EMPLOYEE | TEAM_MANAGER | BID_MANAGER |
|--------|----------|--------------|-------------|
| Voir son score | ✅ | ✅ | ✅ |
| Voir le leaderboard | ✅ | ✅ | ✅ |
| Uploader un PV | ❌ | ✅ | ✅ |
| Uploader fiche formation | ✅ | ✅ | ✅ |
| Définir les objectifs | ❌ | ✅ | ✅ |
| Calculer les scores | ❌ | ✅ | ✅ |
| Modifier les poids | ❌ | ❌ | ✅ |

---

## 9. Parcours utilisateur

### Manager : Scorer son équipe

1. **Définir les objectifs** → `POST /scoring/targets` (objectif certifications par employé)
2. **Uploader les PV** → `POST /scoring/upload-pv` (avec fichier PDF + profileId + projectId)
3. **Calculer les scores** → `POST /scoring/compute-team` (calcule pour toute l'équipe)
4. **Voir le classement** → `GET /scoring/leaderboard?year=2026`

### Employé : Suivre son score

1. **Uploader ses attestations de formation** → `POST /scoring/upload-training-sheet`
2. **Voir son score** → `GET /scoring/score/:profileId/:year`
3. **Voir son historique** → `GET /scoring/history/:profileId`
4. **Voir le classement** → `GET /scoring/leaderboard?year=2026`

### Recalcul automatique

Le score est automatiquement recalculé quand :
- Un **objectif de certification** est modifié (`setTargets`)
- Un **enregistrement projet** est mis à jour (`updateProjectRecord` — complexité ou rôle modifié)
- Un **training est marqué complété** — le backend recalcule automatiquement le score de l'employé
- Un **PV est importé** — le frontend déclenche le recalcul et rafraîchit le classement

---

## 10. Exemples chiffrés complets

### Exemple 1 : Ahmed — Ingénieur senior, année 2025

**Projets** (3 projets) :
| Projet | Complexité | Rôle | PV | Points |
|--------|-----------|------|-----|--------|
| Data Center Tunisair | high (3.5) | project_lead (×1.5) | ✅ (×1.25) | 10 × 3.5 × 1.5 × 1.25 = **65.625** |
| LAN SNDP | medium (2.0) | technical_lead (×1.3) | ❌ (×1.0) | 10 × 2.0 × 1.3 × 1.0 = **26.0** |
| WiFi Campus | low (1.0) | contributor (×1.0) | ❌ (×1.0) | 10 × 1.0 × 1.0 × 1.0 = **10.0** |

- Score projets = 65.625 + 26.0 + 10.0 = **101.63**

**Certifications** : 2 obtenues, objectif = 2
- Score cert = (2/2) × 100 = **100.0**

**Formations reçues** : 3 complétées
- Score training = 3 × 10 = **30.0**

**Formations dispensées pour clients** : 1
- Score formation = 1 × 10 = **10.0**

**Score final** (poids par défaut) :
```
0.35 × 101.63 + 0.25 × 100.0 + 0.20 × 30.0 + 0.20 × 10.0
= 35.57 + 25.00 + 6.00 + 2.00 = 68.57
```

---

### Exemple 2 : Sana — Junior, année 2025

**Projets** : 1 projet
| Projet | Complexité | Rôle | PV | Points |
|--------|-----------|------|-----|--------|
| Audit Réseau BNA | medium (2.0) | contributor (×1.0) | ❌ | 10 × 2.0 × 1.0 × 1.0 = **20.0** |

- Score projets = **20.0**

**Certifications** : 1 obtenue, objectif = 2
- Score cert = (1/2) × 100 = **50.0**

**Formations reçues** : 5 complétées
- Score training = 5 × 10 = **50.0**

**Formations dispensées** : 0
- Score formation = **0.0**

**Score final** :
```
0.35 × 20.0 + 0.25 × 50.0 + 0.20 × 50.0 + 0.20 × 0.0
= 7.00 + 12.50 + 10.00 + 0.00 = 29.50
```

---

### Exemple 3 : Classement après calcul

| Rang Global | Employé | Score | Rang Équipe | Percentile |
|-------------|---------|-------|-------------|------------|
| 1 | Ahmed | 66.04 | 1 (Equipe Réseau) | 100% |
| 2 | Karim | 42.30 | 1 (Equipe Dev) | 50% |
| 3 | Sana | 29.50 | 2 (Equipe Réseau) | 0% |

---

## 11. Schéma base de données

### Tables principales

```sql
-- Scores calculés par employé/année
employee_scores (
    score_id UUID PK,
    profile_id UUID FK → employee_profiles,
    score_year INTEGER,
    project_score DECIMAL,
    certification_score DECIMAL,
    training_score DECIMAL,
    formation_score DECIMAL,
    final_score DECIMAL,
    rank_global INTEGER,
    rank_in_team INTEGER,
    percentile DECIMAL,
    score_details JSONB
)

-- Poids de scoring (global ou par équipe)
scoring_weights (
    weight_id UUID PK,
    team_id UUID NULLABLE UNIQUE,
    project_weight DECIMAL DEFAULT 0.35,
    certification_weight DECIMAL DEFAULT 0.25,
    training_weight DECIMAL DEFAULT 0.20,
    formation_weight DECIMAL DEFAULT 0.20
)

-- Objectifs annuels par employé
scoring_targets (
    target_id UUID PK,
    profile_id UUID FK,
    target_year INTEGER,
    certification_target INTEGER DEFAULT 2
)

-- Enregistrements projets (PV uploadés)
project_records (
    record_id UUID PK,
    profile_id UUID FK,
    project_name TEXT,
    client_name TEXT,
    complexity VARCHAR,
    employee_role VARCHAR,
    pv_verified BOOLEAN DEFAULT FALSE,
    document_hash VARCHAR
)

-- Participants projets (rôle = ENUM strict)
project_participants (
    participant_id UUID PK,
    project_id UUID FK,
    profile_id UUID FK,
    role participant_role DEFAULT 'contributor'
    -- participant_role ENUM: 'contributor', 'technical_lead', 'project_lead'
)

-- Formations dispensées pour clients (training_records)
training_records (
    record_id UUID PK,
    profile_id UUID FK,
    training_name TEXT,
    client_name TEXT,
    trainer_name TEXT,
    start_date DATE,
    end_date DATE,
    participant_count INTEGER
)

-- Dédoublonnage par hash de fichier
document_hashes (
    hash_id UUID PK,
    file_hash VARCHAR UNIQUE,
    document_type VARCHAR,
    original_filename TEXT
)
```

---

## Résumé des corrections apportées (v2.0)

| # | Problème | Correction |
|---|----------|------------|
| C1 | Ancienne logique de decay entre années | → Supprimée : seuls les projets de l'année scorée comptent |
| C2 | `certification_target` stocké mais pas utilisé dans le calcul | → Score cert = `count / target × 100` |
| C3 | Poids d'équipe jamais utilisés dans `computeScore` | → Recherche automatique du `teamId` de l'employé |
| C4 | `rankInTeam` jamais rempli | → Calculé dans `updateRankings()` |
| 3. Architecture | Flux en 5 étapes (ancien) | → Scores non plafonnés, formule projets simpliée |
| M1 | Pas de recalcul après `updateProjectRecord` | → Auto-recompute ajouté |
| M2 | Scores bruts (raw counts) sans normalisation | → Tous les sous-scores normalisés 0–100 |
| M3 | Score final non borné | → Aucun plafond — les employés performants peuvent dépasser 100 |
| M4 | Rôle = texte libre avec parsing string | → Enum PostgreSQL strict (3 valeurs) |
| M5 | Leaderboard inaccessible aux employés | → `EMPLOYEE` ajouté aux rôles autorisés |
| M6 | Formations décrites comme "pour collègues" | → Corrigé : "pour clients" |
| M7 | Poids = multiplicateurs (5, 8, 4, 6) au lieu de fractions | → Fractions sommant à 1.0 (0.35, 0.25, 0.20, 0.20) |
| M8 | DTO weights validé 0–100 | → Validé 0–1 |
