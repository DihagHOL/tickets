"use strict";
// Schutz gegen Clickjacking: Die App darf nicht in einem fremden Rahmen stecken, sonst
// ließe sich eine unsichtbare Kopie über eine harmlose Seite legen, und ein Klick dort
// träfe „Erledigt" oder „Weiterleiten". GitHub Pages erlaubt keine Header
// (frame-ancestors, X-Frame-Options), und im <meta>-CSP wirkt frame-ancestors nicht –
// daher blendet index.html die Seite per CSS aus, und nur dieses Skript blendet sie
// wieder ein, wenn sie ganz oben steht.
(function () {
  let oben = false;
  try { oben = window.self === window.top; } catch (e) { oben = false; }
  if (oben) {
    const sperre = document.getElementById("rahmenschutz");
    if (sperre) sperre.remove();
    return;
  }
  // Unsichtbares Anmelde-iframe (Token erneuern): Die Antwort von Microsoft steht in der
  // Adresse. Seite bleibt verborgen und im Rahmen – js/anmeldeantwort.js reicht sie weiter.
  if (/[#?&]state=/.test(location.href) && /[#?&](code|error)=/.test(location.href)) return;
  try { window.top.location = window.self.location.href; } catch (e) { /* Rahmen verbietet das – Seite bleibt leer */ }
})();
