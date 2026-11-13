# Naturel voix — phase 1 : continuité de l'échange

## Périmètre

Conserver le fil quand l'appelant refuse une proposition secondaire ou acquiesce pendant
une explication. ElevenLabs v4 Turbo, Deepgram/Ink et leurs délais restent configurés comme
avant. Aucun changement d'API publique, de modèle de données ou de fournisseur.

Activation bornée par `VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS`, vide par défaut.
Les workflows staging et production ne listent que Chez Suppernote, restaurant de qualification.
Le groupe `scripts/ops/sync-env.sh voice-stt staging|prod` synchronise aussi cette liste.
Aucun restaurant client n'est ajouté. Ce déploiement permet la recette téléphonique ;
les tests et les rejeux du modèle ne démontrent pas encore un gain de naturel entendu.

## Réponses brèves à une proposition

`structured-turn/reply-scope.ts` borne les cas où les mots seuls ne donnent aucune portée :

- refus bref après proposition de gérant/message : reprendre la réservation ou clarifier ;
- refus du récapitulatif : demander ce qui ne convient pas, sans réserver ni raccrocher ;
- refus de la relecture du nom : demander la correction, sans redemander les autres faits ;
- oui après transfert **ou** message : demander le choix ; oui à une seule proposition de
  transfert : chemin habituel.

Les formules développées, corrections et abandons explicites restent compris par le modèle.
Après une réservation créée, cette protection ne rouvre pas l'échange. Ce n'est pas une règle
générale « non = continuer » : l'état de la proposition est nécessaire.

Sur un cas borné, le schéma n'autorise que `action=none`, le brouillon reste inchangé, et le
modèle formule la question. La courte réponse attend le contrôle de sa sortie entière avant
synthèse. Une sortie qui contourne le schéma (raccrochage, mutation, absence de question) est
retenue et corrigée par un second passage ; ce second passage est également contrôlé. Un
échec répété rejoint le secours existant, sans exécuter l'action refusée. Aucun texte fixe de
clarification n'est imposé au modèle.

Un récapitulatif déjà entendu reste repris par `confirmationResume` (#587), pas récité à nouveau.
Les disponibilités et le consentement final restent nécessaires à la création. Une invitation à reprendre
l’échange seul porte `awaiting=open` ; `confirmationResume` demande explicitement l’accord
pour réserver. Deux derniers tirages avec le champ de ton ElevenLabs et l’historique complet
formulent cette demande sans relire les faits.

## Acquiescement pendant l'explication

`caller-backchannel.ts` traite uniquement un petit ensemble d'acquiescements isolés, avec
preuve de voix brève (au plus 600 ms), pendant une explication déjà audible. L'estimation du
texte entendu doit contenir au moins quatre mots et rester à distance du début de la question.
Le contexte TTS fournit son alignement quand il existe ; sans preuve suffisante, le chemin
habituel de prise de parole s'applique.

Ne sont jamais absorbés : négation, correction, valeur ajoutée (y compris un chiffre), question,
accord plus précis, parole prolongée, accueil, confirmation de nom ou de réservation. L'attente
de la réplique actuellement synthétisée est connue avant la mise à jour finale de l'état : un
oui à cette confirmation reste protégé même pendant sa génération.

L'acquiescement conserve la génération et les trames TTS. Une pause rapide déjà déclenchée
reprend si l'appelant s'est tu depuis 200 ms ; sinon son minuteur habituel continue de surveiller
la voix. Une partielle « oui » qui devient « oui mais plutôt vingt heures » redevient immédiatement
une interruption. Le final tardif n'est absorbé qu'avec la même génération, le même début de
parole et le même dernier instant de voix, dans les deux secondes. Une nouvelle prise de parole,
même sans nouveau marqueur du fournisseur, ne réutilise pas cette décision.

Événement additif `caller_backchannel`, sans texte ni donnée personnelle ; aucun nouveau tour
de dialogue n'est créé pour cet acquiescement.

## Vérifications et limites

- Tests de bout en bout simulés : refus de transfert, brouillon conservé malgré une sortie
  erronée, reprise courte puis création unique après accord, refus du récapitulatif, abandon
  explicite, oui à deux alternatives sans action arbitraire.
- Tests du pont STT : partielle puis final tardif sans annulation ni nouveau tour ; suite
  corrective qui coupe normalement ; nouveau oui après la question qui reste un vrai tour.
- Tests de limites : chiffres, questions, accueil, confirmation en cours de génération,
  absence de preuve audio, voix longue, délai, génération et reprise de voix distincts.
- Groupe de synchronisation : UUID de qualification accepté, joker refusé ; autres clés intactes.
- Rejeux synthétiques avec le vrai modèle via le gestionnaire de streaming du staging,
  sans exécution d'action métier. Sur les deux tirages initiaux « transfert ou message ? / oui »,
  la référence choisissait le transfert ; le candidat demandait le choix. Les deux témoins
  « oui à un transfert seul » et « abandon explicite » gardent leurs actions respectives.
  Un second rejeu avec l'historique complet a révélé une relecture encore trop longue ;
  la consigne a été précisée et la reprise courte réévaluée. Ces petits essais ne constituent
  pas une mesure de généralisation ni une écoute téléphonique.

## Recette téléphonique sur Chez Suppernote

1. Réservation avec parenthèse terrasse, refus de transfert, reprise courte, accord final.
2. Non au récapitulatif puis correction ; abandon explicite dans un appel distinct.
3. Oui pendant une explication puis silence ; correction commençant par oui dans un autre essai.
4. Oui à une question et oui de confirmation ; nom épelé avec refus puis correction.

Comparer les pistes audio : coupures, mots perdus, reprise au bon endroit, absence de nouveau
récapitulatif et résultat métier. Une préférence d'écoute reste à établir avant extension.

## Retour arrière

Application : procédure habituelle avec snapshot, sans restauration DB. Désactivation ciblée :
retirer le restaurant de la liste, recharger l'API et modifier aussi la configuration du workflow
pour éviter sa réactivation au déploiement suivant. Le synchroniseur optionnel conserve une
valeur existante si la variable d'entrée est vide : une entrée vide ne constitue pas une purge.
