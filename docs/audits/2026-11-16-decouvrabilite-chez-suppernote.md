# Découvrabilité de Chez Suppernote — 16 novembre 2026

Fiche contrôlée : https://suppernote.com/restaurant/chez-suppernote-demo. Il s'agit d'un restaurant fictif de démonstration, pas d'un établissement ouvert au public.

## État constaté

- La page publique répond HTTP 200 et déclare son URL comme canonique. Ses balises robots et Googlebot indiquent `noindex, follow`.
- Le sitemap public `https://suppernote.com/sitemap.xml` ne contient pas la fiche. Le code local exclut les slugs de démonstration tant de la source API des établissements découvrables que du sitemap Connect.
- Dans Search Console, inspection de l'URL sur la propriété `suppernote.com` : « Google ne reconnaît pas cette URL », sans dernière exploration ni sitemap référent détecté. La page n'est pas indexée.
- Le HTML public n'émet pas de JSON-LD. Le code local exclut explicitement les données structurées Restaurant et FAQ pour les slugs de démonstration. C'est cohérent avec le caractère fictif ; ne pas présenter une adresse, un numéro, des avis ou des horaires fictifs comme ceux d'un vrai établissement.
- La fiche enrichie et le correctif de disponibilité sont locaux et n'ont pas été publiés. La réservation et son annulation ont été vérifiées en staging, pas sur cette version locale complète.

## Après validation de la fiche et autorisation de publication

1. Décider si l'objectif est d'indexer une **page de démonstration** ou de réserver l'indexation aux véritables restaurants. Pour une démo indexable, rendre sa nature fictive évidente dans le titre, la description et le contenu ; ne pas émettre de schéma Restaurant trompeur.
2. Préparer et relire les changements nécessaires : supprimer `noindex` pour la seule fiche approuvée et l'inclure dans le sitemap, sans ouvrir les autres faux établissements ni les listes publiques par accident. Vérifier les conditions de publication, les tests et le comportement de l'API.
3. Après publication autorisée, contrôler HTTP 200, canonical, robots, présence exacte dans le sitemap et cohérence des données structurées avec le contenu visible. Une absence de données structurées n'empêche pas l'indexation.
4. Inspecter l'URL active dans Search Console et, si elle est indexable, demander son indexation. Puis revenir à l'inspection de l'index : une URL présente dans le sitemap ou acceptée en exploration n'est pas pour autant indexée. Relever la date d'exploration, le statut et la canonique choisie par Google.

Références : [inspection d'URL Google](https://support.google.com/webmasters/answer/9012289?hl=fr) ; [consignes de Google sur les données structurées](https://developers.google.com/search/docs/appearance/structured-data/sd-policies?hl=fr).

## Préparation locale — 17 novembre 2026

- La version locale autorise l'indexation de la fiche canonique de démonstration : titre et description identifient explicitement son caractère fictif. Les aperçus et les liens de réservation test conservent `noindex`.
- La source du sitemap inclut uniquement la démo officielle publiée et active ; les deux anciens slugs sont normalisés et dédupliqués. Les autres fiches fictives restent exclues des listes et du sitemap.
- Les données structurées `Restaurant` et `FAQPage` restent absentes de la démo. Cette absence est volontaire et ne garantit pas l'indexation.
- Le rendu HTML et le sitemap ont été contrôlés sur l'environnement local avec une API fictive. La production n'est pas modifiée ; l'inspection Search Console et la demande éventuelle d'indexation restent à effectuer après autorisation et publication.
