# THEME & CONTENT SETTINGS v1 — preuve de rendu navigateur

Chromium (Playwright), CSS RÉEL (Tailwind + `app/globals.css`) appliqué au
balisage RÉEL de la vitrine (React + JSDOM, `MenuView` + `DeliveryConditionsButton`).
Établissement de démonstration « sombre » (fond `#14100D`, accent laiton).

* `default-*.png` — AUCUNE configuration : rendu historique (panneau adresse/horaires
  sombre, fenêtres et cartes sombres).
* `configured-*.png` — jetons `info_panel_*`, `popup_*`, `delivery_card_*` = blanc/noir,
  `surface_border` = `#C9A24B` : panneau adresse/horaires, fenêtre d'information produit,
  fenêtre « comment commander » et cartes de tarifs de livraison deviennent blancs ; la
  vitrine reste sombre, la fenêtre englobante « Modes et tarifs » et le bouton « Fermer »
  gardent le thème.
* `computed-styles.json` — styles CALCULÉS mesurés (couleur de fond / texte / bordure) par
  surface, pour `default` et `configured`.

Régénération (depuis la racine du dépôt, `npm ci` fait) :

```
node --experimental-strip-types --import ./tests/register.mjs \
     supabase/evidence/theme-content-settings-v1/render-markup.mjs <dossier>
node supabase/evidence/theme-content-settings-v1/browser-proof.mjs <dossier> <sortie>
```

`tests/fixtures/theme-content-settings-v1/baseline-noconfig.json` : empreinte du balisage
SANS configuration capturée sur main `412dbb5` (voir `provenance`), comparée par le test
`[BL-1]` de `tests/theme-content-settings-v1.dom.test.ts`.
