# Preuve — ouverture publique du checkout Pro et Multi

Date : 2026-11-11  
PR : [#688 — Route Pro and Multi-restaurant plans into checkout](https://github.com/Sshindraa/Suppernote/pull/688)  
Commit qualifié : c9d949afb6b31910ff35786e0f5863437b38e7a0

## Décision

Hamza autorise l’ouverture des CTA publics Pro et Multi après qualification du
parcours staging. Cette décision remplace celle du 9 novembre qui gardait ces
formules sur Stripe test jusqu’à la qualification des pilotes.

La porte PILOTS reste OPEN : aucun restaurant pilote externe, engagement de
paiement ou résultat terrain n’est revendiqué ici. La décision porte sur
l’accès public à l’inscription et à l’essai gratuit de 14 jours, sans carte
bancaire. Sans moyen de paiement ajouté avant la fin de l’essai, Stripe annule
l’abonnement conformément au parcours existant.

## Périmètre

- Les CTA Pro et Multi de /pricing conservent la cadence choisie et conduisent
  à /register avec la formule sélectionnée. Le CTA Multi transmet aussi le
  nombre d’établissements.
- L’inscription staging affiche la formule, le nombre de sites, 14 jours
  gratuits sans carte et le montant correspondant.
- Le Checkout Stripe existant reçoit la sélection : Pro mensuel à 299 €/mois ;
  Multi pour deux établissements à 398 €/mois (299 € + 99 €).
- Aucun statut de porte, flag produit ou comportement de facturation n’est
  changé par cette ouverture.

## Qualification effectuée

- CI complète verte sur le commit qualifié ; le PR est basé sur main
  b37601b0efd1c957746258b472f046795e44e922.
- Déploiement staging et smoke tests verts : workflow 42924741212, tentative 2.
- Sur staging, le CTA Pro mensuel a conduit à l’inscription Pro mensuelle ;
  le CTA Multi mensuel a conduit à l’inscription Multi avec deux sites.
- Le Checkout Stripe TEST a affiché Pro à 299 €/mois puis Multi 2 sites à
  398 €/mois, avec 14 jours gratuits sans carte. Les deux sessions de test ont
  été expirées ; aucun paiement ni abonnement n’a été créé.
- Les huit prix Stripe test et les huit prix Stripe live ont été vérifiés en
  lecture seule : 8/8 conformes dans chaque catalogue.
- La clé Stripe test staging avait expiré. Elle a été remplacée dans le seul
  fichier d’environnement de l’API staging par une clé test valide du compte
  correspondant aux huit prix ; l’API staging a été redémarrée. Aucune clé de
  production n’a été modifiée.

## Limites et portes maintenues

Aucun compte Clerk n’a été créé, aucun formulaire d’inscription ou accord légal
n’a été soumis, et aucune session de Checkout n’a été finalisée. Le webhook de
création d’abonnement n’a donc pas été rejoué par cette qualification. Les
parcours et prix annuels sont couverts par le catalogue vérifié et les contrôles
automatisés, mais aucun Checkout annuel n’a été ouvert manuellement.

PILOTS et les autres portes différées restent inchangées dans le profil scoped.
La porte P0_USAGE reste la seule porte requise pour cette release.
