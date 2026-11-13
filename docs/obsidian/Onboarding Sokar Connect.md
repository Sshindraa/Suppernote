# Onboarding Suppernote Connect

Note technique décrivant la mise en œuvre du sous-parcours d'onboarding **Suppernote Connect**.

## Concept & Objectif

L'objectif de Suppernote Connect est de collecter les données d'identité publique, de localisation, de cuisine/ambiance et de capacité d'un établissement pour générer sa fiche publique indexable par Google, ChatGPT et Perplexity.

Ce parcours est composé de **5 étapes indépendantes de la Voice** :

1. **Identité publique** : Saisie du slug unique (`https://suppernote.com/r/[slug]`), description courte (200 char max) et image de couverture.
2. **Localisation** : Adresse complète, auto-complétion de la ville (via API Geo FR), géocodage des coordonnées lat/lng (via Nominatim OpenStreetMap) et affichage sur une carte interactive OSM.
3. **Cuisine & ambiance** : Cuisines proposées, fourchette de prix (€ à €€€€), régimes alimentaires et points forts (ambiance/chips).
4. **Capacité & règles** : Capacité maximale, taille de groupe autorisée, durée moyenne d'un service et politique d'annulation / empreinte bancaire.
5. **Activation & preview** : Double interrupteur pour activer la publication (`connectPublished`) et le référencement IA (`connectAgentic`), avec un iframe de rendu en direct.

## Choix Techniques

- **Parallélisme & Gating** : L'onboarding est divisé en deux sections dans l'UI. La Voice reste bloquante pour l'accès au Dashboard général. Le Suppernote Connect est optionnel (bouton "Plus tard") et n'empêche pas l'usage de la plateforme.
- **Pas de modification de schéma** : Pour stocker les données d'acompte, de capacité et de politique d'annulation de l'étape 4, nous utilisons la colonne JSON existante `RestaurantExposureSettings.capacitySpecials`.
- **Upload Cover** : Sans infrastructure S3 locale, le drag-and-drop en front lit le fichier en base64, le compresse/redimensionne à 1000px max, puis l'envoie via `POST /restaurants/:id/images` vers la table `RestaurantImage`.
- **Mode Preview** : L'endpoint public `GET /public/r/:slug` accepte le paramètre `?preview=1` pour contourner les contrôles de publication et désactiver le cache Redis. Le site public `apps/connect` propage ce paramètre.

## Endpoints Ajoutés

- `PATCH /restaurants/:id/connect` : Met à jour en bloc toutes les propriétés de Suppernote Connect (Restaurant + ExposureSettings).
- `POST /restaurants/:id/images` : Ajoute une image et met éventuellement à jour la cover du restaurant.
- `GET /restaurants/check-slug?slug=...` : Valide la regex et la disponibilité d'un slug.
