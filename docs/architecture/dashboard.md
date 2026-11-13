# Dashboard Architecture

## Stack

- Next.js 15 App Router.
- React 19, Tailwind 3, Shadcn UI, Lucide.

## UI rules

- French-first copy.
- Tailwind colors must use design tokens / Shadcn CSS vars (`bg-background`, `text-muted-foreground`, `border-border`). No arbitrary hex classes.
- Shadcn UI from `@/components/ui/*`; icons from `lucide-react`; class composition via `cn()`.
- Components must handle loading, empty, error, and data states.
- Interactive elements should include `transition-all duration-200`.
- Layouts should be spacious (`p-6`/`p-8`) and responsive at iPad width.
- Marketing pages should stay static when possible (`○`, not `ƒ`).

## Style des écrans

Référence : les écrans refaits (Réservations, Appels, Marketing, Pilotage, Briefing, Réputation, Fidélité, Réactivation, Canaux).

- Pas de sous-titre explicatif sous un titre. Une limite ou une précision utile va dans une infobulle (`Tooltip` avec `Info` en `h-3.5 w-3.5`).
- Pas d'icône décorative. Gardez les icônes fonctionnelles : copier, lien externe, retour, `+`, chevrons, statut.
- Pas de majuscules, de micro-titres en capitales, de `tracking-wide`, `tracking-wider` ou `tracking-widest`, ni de texte sous 12 px (`text-xs` est le minimum). Garde-fou : `no-restricted-syntax` dans `apps/dashboard/eslint.config.mjs`. Les exceptions sont datées et listées dans `ignores` : retirez-les à la refonte de chaque écran.
- Hiérarchie : l'état de l'élément et l'action utile d'abord. La configuration se replie (`<details>` avec chevron, sans marqueur natif, ou bouton « Modifier »). Une action principale par bloc ; le reste dans un `DropdownMenu` (…).
- Toute suppression ou déconnexion passe par `ConfirmDialog`.
- Statut : toujours `StatusBadge` (`components/StatusBadge.tsx`), cinq niveaux à remplissage fixe. `action` : à traiter. `progress` : en cours ou actif. `done` : terminé ou succès. `neutral` : neutre ou archivé. `error` : erreur ou annulé. Le niveau se choisit par sens, une seule correspondance explicite par écran.
- Montants, pourcentages, durées et dates relatives : `lib/format.ts` (`formatEUR`, `formatPercent`, `formatDuration`, `formatRelativeDateTime`).
- États vides sur une ligne. Une phrase d'accompagnement n'est permise que pour un compte neuf, si elle guide vraiment.
- Erreur d'action : toast (`sonner`). `DataFetchError` seulement au chargement.
- Onglets : de section en liens texte (`SectionTabs`) ; onglets de page soulignés (`components/ui/tabs`).
- Tokens Tailwind uniquement, `vous`, `transition-all duration-200` sur les éléments interactifs.
- À arbitrer : `StatusBadge` met l'action requise en `bg-warning` plein, alors que `globals.css` décrit `--warning` comme une teinte neutre « jamais en aplat ».

## CSS guardrails (stylelint)

`pnpm lint:css` locks the following rules in `apps/*/src/**/*.css` (config `.stylelintrc.json` at root):

- No raw structural element selectors (`header`, `main`, `section`, `nav`, `footer`, `aside`, `article`, `button`, `div`) — they cause global bugs when styled in `globals.css` (see `header { position: fixed }` incident of July 2026).
- No hex colors (`#fff`).
- No `!important` (except a commented `stylelint-disable-next-line` for accessibility).
- No arbitrary z-index (use 0-50 or `var(--z-*)`).
- `font-size` in `rem`/`em` only.

## Copy tone

- Use `vous` everywhere, never `tu`. Suppernote is a B2B SaaS billed monthly to restaurant managers (40-60, non-dev). `tu` feels consumer/developer-tool.
- Includes: onboarding (steps, modal, guard, dashboard), tooltips, error messages, banners, marketing copy.
- Indefinite pronoun `on` → `nous` in user-facing copy (OK in code comments).
- A Vitest test (`onboarding-tone.test.ts`) enforces the convention.
