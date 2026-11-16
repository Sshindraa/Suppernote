import {
  ANNUAL_DISCOUNT_PERCENT,
  PRICING_CATALOG,
  TRIAL_DAYS,
  VAT_MENTION,
} from '@suppernote/shared';

const groups = [
  {
    title: 'Accueil téléphonique',
    rows: [
      ['Assistant pour les réservations par téléphone', 'Inclus', 'Inclus', 'Par adresse'],
      ['Numéro dédié et consignes du restaurant', 'Inclus', 'Inclus', 'Par adresse'],
    ],
  },
  {
    title: 'Réservations et salle',
    rows: [
      ['Planning téléphone, web et saisie en salle', 'Inclus', 'Inclus', 'Par adresse'],
      ['Page Connect, widget, plan de salle et liste d’attente', 'Inclus', 'Inclus', 'Par adresse'],
      [
        'Confirmations et rappels',
        'Selon configuration',
        'Selon configuration',
        'Selon configuration',
      ],
      ['Suivi des réservations non honorées', 'Inclus', 'Inclus', 'Par adresse'],
    ],
  },
  {
    title: 'Décisions pendant le service',
    rows: [
      [
        'Placement manuel, disponibilités et protections contre les conflits',
        'Inclus',
        'Inclus',
        'Par adresse',
      ],
      [
        'Pouls du service : arrivées, retards et liste d’attente',
        'Inclus',
        'Inclus',
        'Par adresse',
      ],
      [
        'Suggestions de retard et estimation des tables bientôt disponibles',
        'Non inclus*',
        'Copilote, à découvrir en démonstration',
        'Copilote par adresse',
      ],
      [
        'Rapprochements avec l’attente et analyse de réorganisation',
        'Non inclus*',
        'Copilote',
        'Copilote par adresse',
      ],
      [
        'Application après validation, historique et retour arrière sous conditions',
        'Non inclus*',
        'Copilote',
        'Copilote par adresse',
      ],
    ],
  },
  {
    title: 'Clients et fidélisation',
    rows: [
      ['Fichier client opérationnel', 'Inclus', 'Inclus', 'Par adresse'],
      [
        'Préparation de segments, règles et brouillons de campagnes',
        'Non inclus',
        'Inclus, sans envoi',
        'Inclus, sans envoi',
      ],
      [
        'Envoi de campagnes, profils avancés et cartes cadeaux',
        'Non disponible',
        'Non disponible',
        'Non disponible',
      ],
    ],
  },
  {
    title: 'Pilotage des établissements',
    rows: [
      [
        'Consultation des réservations et statistiques du restaurant',
        'Inclus',
        'Inclus',
        'Par adresse',
      ],
      ['Changement d’établissement depuis le même espace', 'Non inclus', 'Non inclus', 'Inclus'],
      ['Facturation réunie pour plusieurs adresses', 'Non inclus', 'Non inclus', 'Inclus'],
      [
        'Profils clients partagés et comparaison consolidée',
        'Non disponible',
        'Non disponible',
        'Non disponible',
      ],
    ],
  },
  {
    title: 'Mise en service et accompagnement',
    rows: [
      ['Configuration des horaires, règles et numéro dédié', 'Inclus', 'Inclus', 'Par adresse'],
      ['Validation des canaux et réservation test', 'Inclus', 'Inclus', 'Par adresse'],
    ],
  },
];

const questions = [
  [
    'Puis-je conserver mon numéro actuel ?',
    'Un numéro Suppernote dédié est attribué à votre restaurant. Vous pouvez conserver votre numéro habituel et configurer un renvoi d’appel vers Suppernote avec votre opérateur. Le renvoi et un appel test sont vérifiés avant l’activation. Les éventuels frais de renvoi dépendent de votre opérateur.',
  ],
  [
    'Comment se déroule la mise en service ?',
    'Vous renseignez votre salle, vos horaires et vos règles de réservation, puis configurez vos canaux téléphone et en ligne. L’attribution du numéro et les tests précèdent l’ouverture de votre espace. Aucun délai automatique de mise en service n’est annoncé.',
  ],
  [
    'Quel planning mon équipe utilise-t-elle ?',
    'Le planning Suppernote réunit les réservations prises par téléphone, sur votre page Connect, dans le widget et celles que votre équipe saisit en salle. Votre équipe conserve la main pour ajouter, modifier et suivre les réservations.',
  ],
  [
    'Que fait Suppernote pendant le service ?',
    'L’assistant traite les demandes de réservation par téléphone à partir de vos disponibilités et consignes. Votre équipe prépare la salle, accueille les clients et suit les demandes qui nécessitent son intervention. Les confirmations et rappels dépendent des canaux configurés.',
  ],
  [
    'Qu’apporte Pro aujourd’hui ?',
    'Essential permet à votre équipe de gérer les appels, les réservations et la salle. Pro ajoute le copilote : suggestions pour les retards, estimations de libération des tables, rapprochements avec les clients en attente et plans de réorganisation. Votre équipe valide le plan ; Suppernote vérifie encore les disponibilités avant de l’appliquer. Une démonstration vous permet de découvrir ce parcours. La préparation marketing reste un complément, sans envoi de campagnes.',
  ],
  [
    'Le copilote déplace-t-il seul mes réservations ?',
    'Non. L’analyse propose un plan sans déplacer les réservations. L’équipe le valide et confirme l’acceptation du client en attente. Les disponibilités sont vérifiées au moment de l’application. Un retour arrière n’est proposé que si les réservations et tables n’ont pas évolué ; sinon l’équipe corrige la situation manuellement. Les estimations affichent leur fiabilité ou utilisent votre durée de repas lorsque l’historique est insuffisant. Elles ne rendent jamais une table disponible.',
  ],
  [
    'Comment sont facturés les appels et les SMS ?',
    'Les offres n’appliquent actuellement aucun quota client de minutes vocales ou de SMS, ni facturation automatique de dépassement. Les budgets de suivi internes ne limitent pas votre usage. Les SMS de confirmation et de rappel nécessitent la configuration du canal. Les frais de renvoi de votre opérateur restent distincts de l’abonnement Suppernote.',
  ],
  [
    'Quand suis-je débité et puis-je résilier ?',
    `Les ${TRIAL_DAYS} premiers jours sont offerts, sans carte bancaire. Pour continuer ensuite, ajoutez une carte avant la fin de l’essai : sans carte, Léa cesse de répondre au téléphone. Le paiement est effectué par carte via Stripe. En mensuel, vous payez chaque mois et une résiliation prend effet à la fin de la période payée. En annuel, vous payez douze mois à l’avance avec ${ANNUAL_DISCOUNT_PERCENT} % de réduction. La résiliation conserve l’accès jusqu’à l’échéance ; aucun remboursement automatique en cours de période n’est prévu. ${VAT_MENTION} : les prix affichés sont les montants payés.`,
  ],
  [
    'Combien coûte un groupe de restaurants ?',
    `La base Multi-restaurant à ${PRICING_CATALOG['multi-site'].monthlyCents / 100} €/mois inclut le premier établissement. Chaque adresse supplémentaire ajoute ${PRICING_CATALOG['multi-site-addon'].monthlyCents / 100} €/mois. La réduction annuelle de ${ANNUAL_DISCOUNT_PERCENT} % s’applique à la base et aux établissements supplémentaires. Le montant annuel exact est indiqué avant paiement. Le sélecteur affiche le total pour votre nombre d’établissements et transmet ce choix à l’inscription. Chaque adresse conserve ses propres horaires, règles et fichier client. Les accès des équipes sont vérifiés lors de la mise en service.`,
  ],
];

export default function PricingDetails() {
  return (
    <div className="relative z-10 mx-auto max-w-[1180px] px-5 pb-20 md:px-8">
      <h2 className="mb-3 text-3xl font-semibold text-foreground">
        Comparez selon votre quotidien.
      </h2>
      <p className="mb-8 text-muted-foreground">
        Essential vous permet d’organiser le service. Pro ajoute des recommandations et des plans
        d’action que votre équipe valide.
      </p>
      <div className="overflow-x-auto rounded-3xl border border-border">
        <table className="w-full min-w-[660px] text-left text-sm">
          <caption className="sr-only">Fonctions actuellement accessibles par formule</caption>
          <thead>
            <tr className="bg-muted/40">
              <th scope="col" className="p-5">
                Votre usage
              </th>
              {['Essential', 'Pro', 'Multi-restaurant'].map((plan) => (
                <th key={plan} scope="col" className="p-5">
                  {plan}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.title}>
              <tr>
                <th colSpan={4} className="border-t border-border bg-muted/20 px-5 py-4 text-base">
                  {group.title}
                </th>
              </tr>
              {group.rows.map(([label, ...values]) => (
                <tr key={label} className="border-t border-border/50">
                  <th scope="row" className="p-5 font-normal">
                    {label}
                  </th>
                  {values.map((value, index) => (
                    <td key={index} className="p-5 text-muted-foreground">
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        * Les restaurants qui disposaient déjà du copilote conservent leur accès historique avec
        Essential. Pour une nouvelle offre, le copilote accompagne Pro. Les fonctions marquées « Non
        disponible » ne sont pas proposées comme inclusions actuelles. Aucun délai d’ouverture n’est
        annoncé. Les modalités de support sont précisées lors de la mise en service ; aucun délai de
        réponse ni disponibilité 7j/7 n’est promis.
      </p>
      <section className="mt-16" aria-labelledby="pricing-faq">
        <h2 id="pricing-faq" className="mb-6 text-3xl font-semibold">
          Avant de choisir.
        </h2>
        {questions.map(([question, answer]) => (
          <details key={question} className="border-b border-border py-5">
            <summary className="cursor-pointer text-lg font-medium transition-all duration-200 hover:text-pricing-accent">
              {question}
            </summary>
            <p className="mt-4 max-w-3xl leading-relaxed text-muted-foreground">{answer}</p>
          </details>
        ))}
      </section>
    </div>
  );
}
