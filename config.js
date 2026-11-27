// ------------------------------------------------------------------
// Your personal settings. These two values are NOT secret: the client
// ID is designed to be public, and the spreadsheet is still protected
// by your Google login. Fill them in during build-plan steps 1 and 3.
// ------------------------------------------------------------------
window.CONFIG = {
  // From Google Cloud Console > APIs & Services > Credentials (ends in .apps.googleusercontent.com)
  GOOGLE_CLIENT_ID: '1035479472449-ml75v1p95m670i2s4heb4jlf719ctd7s.apps.googleusercontent.com',

  // The long ID in your Health_Log sheet's URL: docs.google.com/spreadsheets/d/<THIS PART>/edit
  SPREADSHEET_ID: '1oCa6b99wSdQG2zpVwdWJh3Finl8eN3Na5Ax9_4R62Ys',

  // Only the Sheets permission is requested. The app can't see the rest of your Drive.
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets'
};
