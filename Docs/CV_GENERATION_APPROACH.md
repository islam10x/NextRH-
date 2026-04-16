# CV Generation — Approche Technique

## 1. Vue d'ensemble

Le module de génération de CV (`cv_generator.py`) produit un fichier DOCX personnalisé en injectant les données d'un employé dans un template Word existant. L'objectif est de **conserver fidèlement la mise en page du template** tout en remplaçant toutes les informations personnelles par celles du nouvel employé.

Le flux global est le suivant :

```
Frontend (React) → Backend (NestJS) → AI Service (FastAPI/Python) → DOCX généré (+ PDF optionnel)
```

**Endpoints concernés :**
- `POST /cv/generate` — génère à partir d'un template uploadé
- `POST /cv/generate-from-stored` — génère à partir d'un template stocké en base

---

## 2. Détection du mode de traitement

La première étape est la détection automatique du type de template via `_detect_template_mode()` :

| Mode | Critère | Moteur utilisé |
|------|---------|---------------|
| **PLACEHOLDER** | Le template contient des tokens Jinja2 (`{{ full_name }}`, `{{ email }}`, etc.) | **docxtpl** |
| **DIRECT** | Le template est un vrai CV avec de vraies données | Pipeline de remplacement par regex |

Le mode PLACEHOLDER est considéré comme optimal. Le mode DIRECT est le cœur de la complexité.

---

## 3. Services externes utilisés pendant la génération

### Groq (LLM)
- **Utilisé pendant la génération** : oui
- **Rôle** : reformulation du résumé professionnel + détection de paires de remplacement supplémentaires
- **Modèle** : `llama-3.3-70b-versatile` (configuré via `GROQ_CV_MODEL` dans `config.py`)
- **Fallback** : si le quota est épuisé ou la clé absente, la génération continue avec les données brutes de l'employé (aucun crash)
- **Statut clé** : ✅ Fonctionnelle (vérifiée)

### APILayer Resume Parser
- **Utilisé pendant le parsing** : oui (lors de l'upload d'un CV par l'employé, dans `cv_parser.py`)
- **Rôle dans le parsing** : enrichissement complémentaire des champs manqués par le parser déterministe (`TemplateCVParser`) — compétences, langues, expérience si vide. Le parser primaire garde la priorité, APILayer ne remplace que les champs vides.
- **Note** : `cv_generator.py` contient des helpers de nettoyage de données APILayer (ex. `_trim_apilayer_address`) car les données source peuvent venir d'un CSV/BDD initialement parsé via APILayer — mais l'API APILayer n'est **pas appelée** pendant la génération.
- **Statut clé** : ✅ Fonctionnelle (vérifiée)

---

## 3. Pipeline DIRECT (mode principal)

Le mode DIRECT fonctionne en **8 phases** dans la fonction `_generate_with_replacement` :

```
Phase 1  →  Extraction du texte du template
Phase 2  →  Détection des champs contact (email, téléphone, nom, adresse, LinkedIn)
Phase 2b →  Extraction des données structurelles (expérience, formation, certifications)
Phase 3  →  Pré-génération du résumé professionnel (Groq LLM + fallback déterministe)
Phase 4  →  Construction de la carte de remplacement complète
Phase 5  →  Suppléments de paires via Groq AI (optionnel)
Phase 6  →  Remplacement single-pass sur document.xml
Phase 7  →  Redimensionnement des textboxes
Phase 8  →  Contrôle qualité et complétude
```

### 3.1 Détection des champs contact (`_detect_personal_info`)

La détection est **déterministe et multi-stratégie** :

1. **Réassemblage de fragments** (Step 0) : les templates infographiques (ex : canadien 124) fractionnent email, téléphone, adresse en dizaines de `<w:txbxContent>` séparés. Le code les réunit avant toute détection.
2. **Clean-email scan** : détecte d'abord un email court et strict pour ancrer la zone de contact.
3. **Scan de nom large** : parcourt tous les paragraphes avec un score de proximité (distance à l'email + bonus ALL_CAPS) + heuristique de particule de nom.
4. **Patterns placeholder** : reconnaît `PRÉNOM NOM`, `Poste Occupé / Recherché`, etc. pour les templates vierges.
5. **Nom depuis l'email local-part** en dernier recours (`pauline.trottier` → `Pauline Trottier`).

### 3.2 Extraction structurelle (`_extract_template_structured_data`)

- **Expérience** : détecte les entreprises via le titre de poste en MAJUSCULES ou les plages de dates.
- **Formation** : mots-clés multilingues (LICENCE, BACCALAURÉAT, Université, Lycée, Bachelor…).
- **Résumé** : paragraphes BODY avant le premier titre de section, hors blocs contact.
- **Protection** : ignore les paragraphes de cellules de tableau (`_is_in_table_cell()`) pour éviter que les en-têtes de colonnes ("Certificat", "Diplôme") soient détectés comme des données.

### 3.3 Détection universelle des titres de section

Approche à 3 niveaux dans `_identify_section_lxml` / `_identify_section` :
1. Signaux de formatage (gras, style Heading/Titre, ALL_CAPS, police ≥ 13pt, soulignement).
2. **Correspondance pure par mot-clé** : paragraphes courts (≤ 4 mots) correspondant à `_SECTION_MAP` — même sans aucun formatage.
3. **Normalisation Unicode** : `U+2019` ('), `U+00A0` (NBSP) → ASCII, pour éviter les faux non-matchs.

`_SECTION_MAP` est multilingue (FR, EN, ES) et couvre : expérience, formation, compétences, certifications, projets, langues, centres d'intérêt, résumé.

### 3.4 Construction de la carte de remplacement (`_build_full_replacement_map`)

Produit une liste de paires `(texte_template, texte_employé)` couvrant :
- Champs contact (nom, email, téléphone, adresse, LinkedIn, titre)
- Expérience / formation / certifications (mappés positionnellement)
- Résumé professionnel
- Fragments d'email/téléphone/LinkedIn (pour les templates à textboxes fragmentées)
- Paires Jinja2 de secours (`{{ full_name }}` → valeur) qui fonctionnent dans les deux modes

### 3.5 Remplacement au niveau run-XML (`_apply_paragraph_replacements`)

- Utilise `_para_own_runs` (pas `iter()`) pour ne pas descendre dans les `<w:txbxContent>` imbriqués — évite les doublons de remplacement.
- **Fenêtre glissante cross-textboxes** : reconstruit la chaîne complète à travers plusieurs textboxes consécutives, remplace le premier, vide les suivants. Gère les 4 copies AlternateContent (WPS Choice + VML Fallback × pages 1+2).
- Appliqué séparément aux shapes WPS et aux formes VML (fallback LibreOffice).

### 3.6 Support des templates à tableaux (`_fill_table_section`)

Pour les sections dont le contenu est dans des `<w:tbl>` (ex : expérience, certifications en colonnes) :
- **Conserve la ligne d'en-tête** du tableau.
- **Remplace toutes les lignes de données** par les données de l'employé en préservant le `<w:rPr>` (formatage des cellules).
- `_build_section_table_rows` mappe chaque section au bon format de colonnes :
  - Expérience → `[dates, entreprise, titre]`
  - Certifications → `[nom, date]`
  - Formation → `[dates, établissement, diplôme]`
  - Projets → `[année, client, projet]`

### 3.7 Remplacement dans les formes VML (`_replace_in_vml_fallback`)

Les templates avec `<mc:AlternateContent>` ont deux représentations du même contenu :
- `<mc:Choice Requires="wpg">` : shapes WPS (utilisés par Word)
- `<mc:Fallback>` : formes VML `<v:textbox>` (rendues par LibreOffice)

Le code applique les mêmes remplacements aux deux pour garantir la cohérence du rendu PDF.

---

## 4. Mode PLACEHOLDER (docxtpl)

Quand le template contient des tokens `{{ champ }}`, le moteur **docxtpl** (surcouche Jinja2 pour DOCX) prend en charge l'injection directement. C'est le mode le plus fiable car :
- Aucune détection de données dans le template n'est nécessaire.
- La structure XML n'est jamais manipulée manuellement.
- Les listes (expériences, formations) sont gérées nativement par les boucles Jinja2.

Les tokens supportés : `{{ full_name }}`, `{{ current_position }}`, `{{ email }}`, `{{ phone }}`, `{{ address }}`, `{{ linkedin }}`, `{{ summary }}`, `{{ skills }}`, ainsi que des blocs `{% for %}` pour les sections répétables.

---

## 5. Types de templates supportés

| Type de template | Mécanisme principal | Statut |
|-----------------|---------------------|--------|
| À textboxes infographiques (WPS/wpg) | Fragment reassembly + sliding window + VML fallback | ✅ Supporté |
| À paragraphes standard (BODY) | Regex + positional mapping | ✅ Supporté |
| À tableaux (sections en `<w:tbl>`) | `_fill_table_section` | ✅ Supporté |
| Mixte (BODY + TXBX + tableaux) | Combinaison des 3 mécanismes | ✅ Supporté |
| Jinja2 / Placeholder | docxtpl | ✅ Supporté (mode idéal) |
| Templates en espagnol | `_SECTION_MAP` multilingue | ✅ Supporté |
| Templates sans formatage sur les titres | Keyword fallback + Unicode normalization | ✅ Supporté |

---

## 6. Points forts

### ✅ Préservation du formatage
Le remplacement s'effectue au niveau des `<w:r>` (runs XML) ce qui préserve la police, la couleur, la taille et le gras de chaque caractère. La mise en page du template est conservée à l'identique.

### ✅ Robustesse multi-structure
Le pipeline gère trois familles de templates structurellement très différentes (paragraphes, textboxes, tableaux) avec un même point d'entrée `process_cv`.

### ✅ Détection multilingue
`_SECTION_MAP` et les heuristiques de contact couvrent le français, l'anglais et l'espagnol. Les accents et la casse sont normalisés.

### ✅ Réassemblage de fragments
Les templates infographiques qui fractionnent email/téléphone/adresse en dizaines de textboxes sont gérés transparentement grâce au fragment reassembly et à la fenêtre glissante cross-textboxes.

### ✅ Double rendu DOCX/PDF cohérent
Les remplacements sont appliqués à la fois aux formes WPS (Word) et aux formes VML (LibreOffice), garantissant que le PDF exporté reflète exactement le DOCX.

### ✅ Résistance aux templates adversariaux
5 templates synthétiques testent des cas limites : contact en tableau, titres de section par taille de police uniquement, headings espagnols, contact après 6000 caractères de préambule, sections entières dans des textboxes. Tous passent.

### ✅ LLM optionnel, jamais bloquant
Groq est utilisé pour enrichir le résumé et détecter des paires supplémentaires, mais **tous les appels LLM ont un fallback déterministe**. Si le quota API est épuisé, la génération continue normalement.

### ✅ Protection contre les remplacements parasites
- Les en-têtes de colonnes de tableaux (`_is_in_table_cell()`) ne sont pas extraits comme données.
- Les fragments de nom trop courts (< 2 caractères) ne génèrent pas de paires de remplacement global.
- Le bloc contact est protégé lors de l'injection du résumé.

---

## 7. Points faibles

### ⚠️ Mode DIRECT fragile sur des templates très atypiques
Le mode DIRECT repose sur des heuristiques et des patterns regex. Un template avec une structure inhabituelle (ex : contact dans un footer XML, sections toutes en images, ou PDF converti en DOCX avec pertes) peut donner des résultats incomplets.

### ⚠️ Mapping positionnel des sections
L'expérience, la formation et les certifications sont mappés **positionnellement** (1er poste du template → 1er poste de l'employé). Si l'employé a plus d'entrées que le template ne l'anticipe, les entrées supplémentaires sont perdues dans les templates à paragraphes. Seuls les templates à tableaux gèrent un nombre variable de lignes.

### ⚠️ Dépendance à la qualité du template original
Si le template source contient des données dupliquées, des incohérences entre les formes WPS et VML, ou des fragments mal structurés, les remplacements peuvent être partiels ou produire des artefacts visuels.

### ⚠️ Pas de support des templates PDF
Les templates au format PDF ne peuvent pas être utilisés directement comme base de génération, uniquement en sortie. Cette restriction est volontaire pour la fiabilité.

### ⚠️ Groq comme seul LLM backend
Le résumé professionnel et les paires supplémentaires dépendent de l'API Groq (quota journalier de 100k tokens). En cas de quota épuisé, le résumé injecté est celui de l'employé tel quel, sans reformulation. Il n'y a pas d'intégration alternative (OpenAI, Ollama, etc.) en production.

### ⚠️ Résolution du nom par heuristique
La détection du nom complet dans le template est basée sur la proximité à l'email, la casse et les patterns d'apparence. Elle peut échouer sur des noms composés inhabituels, des templates avec plusieurs blocs de noms (ex : nom du consultant + nom du client), ou des structures très compactes.

### ⚠️ Redimensionnement des textboxes limité
Le redimensionnement des textboxes (`_set_shape_cx`) ajuste la largeur des formes qui contiennent des données plus longues, mais il est limité aux formes WPS simples. Les groupes `<wpg:wgp>` nécessitent une gestion particulière pour éviter de comprimer le groupe, et les cas limites peuvent encore provoquer un débordement visuel.

### ⚠️ Absence de test de rendu visuel
Les tests actuels valident le XML généré et la présence des données, mais **pas le rendu visuel final**. Un champ correctement injecté dans le XML peut quand même être tronqué, invisible ou mal positionné dans le rendu Word/LibreOffice sans qu'aucun test ne le détecte.

---

## 8. Architecture des fichiers

```
ai-service/app/services/cv_generator.py   ← Cœur du moteur (5900+ lignes)
ai-service/app/api/generation.py          ← Endpoint FastAPI POST /api/v1/generation/cv
backend/src/cv/cv.controller.ts           ← Endpoints NestJS /cv/generate, /cv/generate-from-stored
backend/src/cv/cv.service.ts              ← Orchestration et appel à l'AI Service
frontend/src/pages/bid/CVGenerationPage.tsx ← Interface utilisateur
```

---

## 9. Recommandations

1. **Préférer le mode PLACEHOLDER** pour les nouveaux templates — créer des templates avec tokens `{{ }}` dès le départ garantit un résultat parfait sans heuristique.
2. **Vérifier la cohérence WPS/VML** dans les templates à sidebar infographique avant déploiement.
3. **Tester tout nouveau template** avec `test_cv_robustness.py` et vérifier visuellement le DOCX généré.
4. **Pour les sections à nombre variable d'entrées**, utiliser des templates à tableaux (`<w:tbl>`) plutôt qu'à paragraphes fixes.
5. **Monitorer le quota Groq** en production — prévoir un LLM de secours ou des résumés pré-générés pour les cas critiques.
