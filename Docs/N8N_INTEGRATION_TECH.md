# NextRH — Intégration n8n (Documentation technique)

Ce document explique en détail le fonctionnement de l’intégration **n8n** dans l’architecture actuelle de **NextRH** (backend Node.js/NestJS + PostgreSQL + n8n + système de notifications). Il est destiné à un développeur qui rejoint le projet et veut comprendre le flux de bout en bout.

---

## 1. Rôle global de n8n dans le projet

**Pourquoi nous utilisons n8n ?**
- n8n est notre moteur d’orchestration d’emails. Il évite d’implémenter et maintenir toute la logique d’envoi (SMTP, template, conditions, erreurs) directement dans le backend.

**Quel problème il résout dans notre architecture ?**
- Il découple la création d’une notification (backend) de l’envoi email (workflow). On gagne en souplesse, en observabilité et en possibilité d’évolution du workflow sans redéployer le backend.

**Responsabilité par rapport au backend**
- Le backend **crée** les notifications et **déclenche** n8n via un webhook.
- n8n **envoie** les emails et **confirme** au backend que l’email a bien été envoyé.

---

## 2. Fonctionnement des notifications

**Types de notifications pris en charge**
- Notifications métier (ex: certifications qui expirent, formations assignées, événements RH). Le type exact est stocké côté backend (ex: `certification_expiring`).

**Création côté backend**
- Une notification est créée dans la table `notifications` via le service `NotificationsService`.
- Elle possède notamment : `notification_id`, `user_id`, `title`, `message`, `email_sent`, `created_at`.

**Quand un email doit être envoyé ?**
- Si la notification n’est pas planifiée (ou si sa date est échue), le backend **pousse immédiatement** vers n8n.
- Sinon, un **fallback sweep** (cron) repère les notifications non envoyées et les envoie plus tard.

---

## 3. Déclenchement du workflow

**Quand le workflow n8n est déclenché ?**
- Dès qu’une notification est créée et doit être envoyée (création immédiate ou rattrapage par le sweep).

**Quelle action côté backend provoque l’exécution ?**
- L’appel HTTP vers l’URL `N8N_WEBHOOK_URL` déclenche le workflow n8n.

**Exécution instantanée vs fallback sweep**
- **Instantané** : push immédiatement après création (`n8nWebhookPusher`).
- **Fallback sweep** : job planifié qui récupère `email_sent = false` et déclenche n8n pour rattraper les envois manqués.

---

## 4. Rôle du Webhook

**Qu’est-ce qu’un webhook ici ?**
- Un endpoint HTTP exposé par n8n qui démarre un workflow à la réception d’un POST.

**Pourquoi le backend envoie une requête HTTP vers n8n ?**
- Pour déléguer l’envoi de l’email et l’orchestration à n8n.

**Structure des données envoyées**
Le backend envoie un JSON structuré (exemple) :

```json
{
  "notificationId": "...",
  "userEmail": "test@nextrh.com",
  "userName": "Prenom Nom",
  "type": "certification_expiring",
  "title": "...",
  "message": "...",
  "priority": 1,
  "createdAt": "2026-03-12T10:00:00.000Z"
}
```

**Pourquoi utiliser `x-webhook-secret` ?**
- C’est une clé partagée entre backend et n8n pour éviter les appels non autorisés.
- Elle est vérifiée par n8n (Header Auth) et par le backend lors du callback.

---

## 5. Déroulement complet du workflow (n8n)

1. **Webhook** : réception du POST venant du backend.
2. **IF (Has Email?)** : vérifie la présence de `userEmail`.
3. **Send Email** : envoie l’email via SMTP.
4. **HTTP Request (Mark Email Sent)** : callback vers le backend pour marquer `email_sent = true`.

---

## 6. Cycle de vie complet d’une notification

1. **Création** d’une notification côté backend.
2. **Push vers n8n** (immédiat ou via sweep).
3. **Envoi email** dans n8n.
4. **Callback** vers backend pour `email_sent = true`.
5. **État final** : notification enregistrée + email envoyé.

---

## 7. Mode test vs mode production

**Mode test**
- Quand on clique sur **Execute Workflow**, n8n écoute un **test URL** (`/webhook-test/...`).
- Utile uniquement pour tester manuellement un workflow.

**Mode production**
- Le backend appelle l’URL **production** (`/webhook/...`).
- Aucune exécution n’apparaît en test si vous utilisez la prod, et inversement.

---

## 8. Bouton “Publish” dans n8n

**À quoi sert “Publish” ?**
- Il rend la version du workflow **active** et exécutable en production.

**Différence entre Save, Execute, Publish**
- **Save** : sauvegarde vos modifications dans l’éditeur.
- **Execute** : lance le workflow en **mode test** uniquement.
- **Publish** : rend le workflow **actif** pour les requêtes réelles.

**Publish = production-ready ?**
- Pas automatiquement. Pour être prêt prod, il faut :
  - URL production correcte (`/webhook/...`)
  - `x-webhook-secret` robuste
  - SMTP validé
  - HTTPS en production (reverse proxy)
  - Sécurisation des accès n8n

---

## 9. Schéma textuel (flux complet)

```
[Backend NestJS]
   | 1) create notification
   | 2) POST webhook (N8N_WEBHOOK_URL)
   v
[n8n Webhook]
   | 3) IF has email?
   | 4) Send Email (SMTP)
   | 5) PATCH /webhooks/notifications/:id/email-sent
   v
[Backend NestJS]
   | 6) email_sent = true
   v
[PostgreSQL]
```

---

## Notes importantes de configuration

- **URL webhook (prod)** : `http://localhost:5678/webhook/nextrh-notification`
- **Callback backend (n8n dans Docker)** :
  `http://host.docker.internal:3000/webhooks/notifications/{{ $node["Webhook"].json.body.notificationId }}/email-sent`
- **IF node** : `{{ $json.body.userEmail }}` + Type = String + is not empty
- **Email HTML** : utiliser `{{ $json.body.* }}`

---

Ce document est la référence technique pour comprendre l’intégration n8n dans NextRH.
