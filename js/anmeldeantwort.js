"use strict";
// Rückkehr von der Microsoft-Anmeldung
// ====================================
// Neue und alte App (/alt/) nutzen die Redirect-URI, die in Entra schon eingetragen ist:
// https://dfedorov12.github.io/tickets/ – also diese Seite. Steht eine Anmeldeantwort in
// der Adresse (state + code/error), entscheidet dieses Skript vor dem App-Start, wem sie
// gehört:
//   redirect      Anmeldung der App im selben Fenster – wertet MSAL in js/auth.js aus.
//   silent        unsichtbares iframe der App (Token erneuern) – per MSAL-Bridge an die
//                 App weiterreichen.
//   alte App      Popup oder iframe von MSAL 2 – Adresse stehen lassen; MSAL 2 liest sie
//                 selbst aus und schließt das Fenster.
//   pa_consent_…  Einwilligungs-Popup der alten App (Power Automate) – Hauptfenster
//                 benachrichtigen, Fenster schließen.
// Soll die App hier nicht starten, steht in window.__anmeldeantwort der Text für die
// Startanzeige (js/app.js).
(function () {
  const hash = new URLSearchParams(location.hash.slice(1));
  const suche = new URLSearchParams(location.search);
  const antwort = hash.has("state") ? hash : suche.has("state") ? suche : null;
  if (!antwort || !(antwort.has("code") || antwort.has("error"))) return;
  const state = antwort.get("state") || "";

  if (state.startsWith("pa_consent_")) {
    // Die alte App wartet nur auf das Signal; der Code bleibt in diesem Fenster.
    try { new BroadcastChannel("pa-oauth-callback").postMessage({ fertig: true }); } catch (e) { /* ohne BroadcastChannel: Popup bleibt offen */ }
    history.replaceState(null, "", location.pathname);
    window.__anmeldeantwort = "Einwilligung erteilt – dieses Fenster schließt sich.";
    setTimeout(() => window.close(), 1500);
    return;
  }

  // MSAL-State: base64url(JSON {id, meta: {interactionType}}) | eigener Teil
  let art = "";
  try {
    const b64 = state.split("|")[0].replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), z => z.charCodeAt(0)));
    art = JSON.parse(json).meta.interactionType;
  } catch (e) { return; } // unbekanntes Format: MSAL in der App entscheidet
  if (art === "redirect") return;

  // Wer hat die Anmeldung angestoßen? (gleiche Herkunft, sonst nicht lesbar)
  let ausloeser = null;
  try {
    if (window.parent !== window) ausloeser = window.parent.location.pathname;
    else if (window.opener) ausloeser = window.opener.location.pathname;
  } catch (e) { ausloeser = null; }

  window.__anmeldeantwort = "Anmeldung wird abgeschlossen …";
  if (ausloeser !== null && !/\/alt\//.test(ausloeser) && typeof msalRedirectBridge !== "undefined") {
    msalRedirectBridge.broadcastResponseToMainFrame().catch(fehler => {
      console.warn("Anmeldung: Antwort konnte nicht weitergereicht werden", fehler);
    });
  }
})();
