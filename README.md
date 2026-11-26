# Health Log

Personal fitness and nutrition tracker. A static PWA (plain HTML/JS, no build step) that signs in with Google and stores everything in a Google Sheet named `Health_Log`.

- `index.html`, `app.js`, `sheets.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icons/`: the web app, served by GitHub Pages from the repo root.
- `config.js`: the only file to edit (Google OAuth Client ID and Spreadsheet ID). Neither value is a secret.
- `apps-script/Code.gs`: paste into the sheet's Extensions > Apps Script. `setup()` builds the tabs; `doPost()` receives the nightly Apple Shortcut sync.

Setup steps are in the design doc.
