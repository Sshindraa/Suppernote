# Site public : règles de design et de contenu

S'applique à toute page publique (accueil, page fonctionnalité, tarifs, démo, pages SEO), quel que soit l'agent qui la code. Référence visuelle unique : l'accueil.

## Ce que le code impose

`apps/dashboard/src/app/marketing-claims.test.ts` trouve seul toute page dont les metadata viennent de `marketing-metadata.ts`, et échoue si :

- la page n'est pas écrite dans `MarketingShell` (menu, logo, polices, palette, pied de page) ou recrée son propre menu, ses polices ou son pied de page ;
- elle utilise du noir pur (`bg-black`) ou une couleur en dur (`[#…]`) ;
- elle ou ses sections directes contiennent une affirmation sans preuve ou « assistant téléphonique ».

Une nouvelle page publique : `export const metadata` depuis `marketing-metadata.ts`, contenu dans `<MarketingShell>`.

## Ce qu'un test ne vérifie pas

- **Partir du moment de service, pas du mécanisme.** Le fil rouge est la journée de service (11 h → 23 h 30). Une page fonctionnalité développe un moment de cette journée (le téléphone = 12 h 40), puis explique comment ça marche.
- **Montrer le produit** avec les éléments de l'accueil : sections `day-paper` / `day-deep`, titres `font-brand`, cartes de réservation, scène d'appel de `HeroServiceDay`, mention « Illustration · données de démonstration ». Réutiliser, ne pas redessiner.
- CTA `day-cta` vers `/demo`.
- Marque : « le chef de rang digital » ; l'agent vocal : « Léa, l'assistante IA ». « Répondeur » ou « standard » seulement pour expliquer une différence. `vous` partout, phrases courtes, vocabulaire de salle.
- Ne rien promettre que le code ne fait pas ; ce qui n'existe pas encore est « Bientôt » ou « en préparation », sans partenaire cité.
- SEO : le H1 contient la recherche visée, l'accroche de marque va dessous. Une page par intention ; la FAQ de l'accueil renvoie vers la page.
- Vérifier le rendu desktop et iPad à côté de l'accueil avant de proposer la page.
