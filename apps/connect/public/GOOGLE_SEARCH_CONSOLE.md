# Google Search Console — Vérification de propriété

## Méthode 1 : Meta tag (recommandée)

1. Va sur https://search.google.com/search-console
2. Ajoute la propriété `https://suppernote.com` (URL prefix)
3. Choisis la méthode "HTML tag"
4. Copie le token (format : `google-site-verification: google<hash>.html` → le token est `google<hash>.html` sans le prefix)
5. Set l'env var dans `apps/connect/.env` :
   ```
   NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION=google<hash>.html
   ```
6. Rebuild : `pnpm --filter @suppernote/connect build`
7. Redémarre : `pm2 restart suppernote-connect`
8. Clique "Verify" dans GSC

## Méthode 2 : Fichier HTML

1. Va sur https://search.google.com/search-console
2. Ajoute la propriété `https://suppernote.com` (URL prefix)
3. Choisis la méthode "HTML file"
4. Télécharge le fichier `google<hash>.html`
5. Place-le dans ce dossier : `apps/connect/public/google<hash>.html`
6. Rebuild : `pnpm --filter @suppernote/connect build`
7. Redémarre : `pm2 restart suppernote-connect`
8. Vérifie : `curl https://suppernote.com/google<hash>.html` → doit retourner le contenu
9. Clique "Verify" dans GSC

## Après vérification

1. Soumet le sitemap : `https://suppernote.com/sitemap.xml`
2. Surveille l'indexation dans GSC (quelques jours à semaines)
3. Vérifie "Coverage" → 0 erreur
4. Vérifie "Enhancements" → Rich Results (Restaurant schema)
