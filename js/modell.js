/**
 * Fachliche Logik des Ticketsystems – ohne DOM, ohne Netzwerk
 * ==========================================================
 * Ticketnummern, Routing (Absender-Domain → Queue), Betreff-Token, Normalisierung
 * der SharePoint-Daten, Berechtigungen (Soll-Zustand und Abgleich mit dem Ist),
 * Status/SLA und Kennzahlen. Dieselben Funktionen nutzen die App im Browser, der
 * Nachtlauf in GitHub Actions und die Tests – eine Regel steht genau einmal hier.
 *
 * Das Routing und das Betreff-Token spiegeln sich im Power-Automate-Flow
 * (scripts/flow-paket.mjs). Wer hier etwas ändert, prüft den Flow mit.
 */

import { STATUS, SLA_STUNDEN, PRIORITAETEN } from './config.js';

// ── Ticketnummern ───────────────────────────────────────────────────────────

/** Kennung einer Queue: Großbuchstabe, dann 1–9 Großbuchstaben/Ziffern (SCH, EWA, IT2). */
export const KENNUNG_MUSTER = /^[A-Z][A-Z0-9]{1,9}$/;

export function ticketNummer(kennung, id) {
  return `${kennung}-${id}`;
}

/** „SCH-12" → { kennung: 'SCH', id: 12 } – sonst null. */
export function parseTicketNummer(s) {
  const m = String(s ?? '').trim().toUpperCase().match(/^([A-Z][A-Z0-9]{1,9})-(\d{1,9})$/);
  return m ? { kennung: m[1], id: Number(m[2]) } : null;
}

/**
 * Die Ticketnummer aus einem Betreff lesen – so erkennt der Flow Antworten.
 *   „AW: [#SCH-12] Eingangsbestätigung: Drucker"     → SCH-12
 *   „AW: Neues Ticket: 1234 (Drucker)" (alte Mails)  → ALT-1234
 * Sonst ''.
 */
export function tokenAusBetreff(betreff, archivKennung = 'ALT', kennungen = null) {
  const s = String(betreff ?? '');
  // Genau wie der Flow (Aktion „Ticketnummer"): letztes „[#…]" gewinnt.
  if (s.includes('[#')) return s.split('[#').pop().split(']')[0].trim().toUpperCase();
  // Auch ohne Klammern: „Bezug SCH-12", „AW: SCH-12 Drucker" – nur bekannte Kennungen.
  if (kennungen) {
    const bekannt = new Set(kennungen.map(k => String(k).toUpperCase()));
    const treffer = betreffWoerter(s).find(w => {
      const teile = w.split('-');
      return teile.length === 2 && teile[0] && bekannt.has(teile[0]) && /^\d{1,9}$/.test(teile[1]);
    });
    if (treffer) return treffer;
  }
  if (s.includes('Neues Ticket: ')) return `${archivKennung}-${s.split('Neues Ticket: ').pop().trim().split(' ')[0]}`;
  return '';
}

/**
 * Zeichen, die im Betreff als Worttrenner gelten – im Flow genauso (Ausdruck „Woerter").
 * Bindestrich bewusst nicht: er gehört zur Nummer.
 */
export const TRENNZEICHEN = Object.freeze(['[', ']', '(', ')', ':', ',', ';', '#', '/', '"', "'", '.', '!', '?', '<', '>']);

/** Betreff → Wörter in Großbuchstaben (Spiegel des Flow-Ausdrucks). */
export function betreffWoerter(betreff) {
  let s = String(betreff ?? '').toUpperCase();
  for (const z of TRENNZEICHEN) s = s.split(z).join(' ');
  return s.split(' ').filter(Boolean);
}

/** Betreff mit genau einem Token vorn: „[#SCH-12] Drucker". */
export function betreffMitToken(nummer, betreff) {
  const rein = String(betreff ?? '').replace(/\[#[A-Za-z][A-Za-z0-9]{1,9}-\d{1,9}\]\s*/g, '').trim();
  return `[#${nummer}] ${rein}`.trim();
}

// ── Adressen & Routing ──────────────────────────────────────────────────────

/** Nur plausible Mailadressen (bewusst eng: der Wert landet in Texten und Claims). */
export function istMail(s) {
  return /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(s ?? '').trim());
}

/** Domain einer Adresse in Kleinbuchstaben, '' wenn keine. */
export function domainAus(adresse) {
  const s = String(adresse ?? '').trim().toLowerCase().replace(/[<>\s]/g, '');
  const i = s.lastIndexOf('@');
  return i > 0 ? s.slice(i + 1) : '';
}

/** „schmie-guss.de, @shb-guss.de\nx.de" → ['schmie-guss.de','shb-guss.de','x.de'] */
export function domainsAusText(text) {
  const liste = String(text ?? '').toLowerCase().split(/[\s,;]+/)
    .map(d => d.replace(/^@/, '').trim())
    .filter(d => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
  return [...new Set(liste)];
}

/** „a@x.de; B@y.de" → ['a@x.de','b@y.de'] (nur gültige, ohne Dubletten). */
export function mailsAusText(text) {
  const liste = String(text ?? '').split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(istMail);
  return [...new Set(liste)];
}

/** Claim eines Kontos für SharePoint (Personenfelder, ensureUser). */
export function claimFuerMail(mail) {
  return `i:0#.f|membership|${String(mail ?? '').trim().toLowerCase()}`;
}

/** Mail-Adresse aus einem Claim oder Login-Namen. */
export function mailAusLogin(login) {
  const s = String(login ?? '');
  const teil = s.includes('|') ? s.split('|').pop() : s;
  return istMail(teil) ? teil.toLowerCase() : '';
}

/**
 * Welche Queue ist für diesen Absender zuständig? Exakte Domain-Treffer vor der
 * Standard-Queue; Archiv-Queues nehmen nie neue Tickets an.
 * Spiegelung im Flow: Aktion „Queue_nach_Domain" / „Standard_Queue".
 */
export function queueFuerAbsender(queues, adresse, betreff = '') {
  const d = domainAus(adresse);
  const b = String(betreff ?? '').toLowerCase();
  // Reihenfolge wie im Flow („Elemente abrufen" sortiert nach Reihenfolge, dann ID).
  const kandidaten = (queues || []).filter(q => q.aktiv && q.modus !== 'Archiv')
    .sort((x, y) => (x.reihenfolge || 0) - (y.reihenfolge || 0) || (x.itemId || 0) - (y.itemId || 0));
  const stichwort = q => (q.stichwoerter || []).some(w => b.includes(w.toLowerCase()));
  const mitStichwort = q => (q.stichwoerter || []).length > 0;
  return kandidaten.find(q => mitStichwort(q) && q.domains.length && q.domains.includes(d) && stichwort(q))   // z. B. SAP nur für ein Werk
    || kandidaten.find(q => mitStichwort(q) && !q.domains.length && stichwort(q))                            // z. B. SAP für alle
    || (d && kandidaten.find(q => !mitStichwort(q) && q.domains.includes(d)))                                 // Werk nach Domain
    || kandidaten.find(q => q.standard)
    || null;
}

/** „SAP; S/4HANA\nFiori" → ['SAP','S/4HANA','Fiori'] (ohne leere/doppelte, Groß-/Kleinschreibung egal). */
export function stichwoerterAusText(text) {
  const out = [];
  for (const w of String(text ?? '').split(/[;\n,]+/).map(x => x.trim()).filter(Boolean)) {
    if (!out.some(o => o.toLowerCase() === w.toLowerCase())) out.push(w);
  }
  return out;
}

// ── Konfiguration (Liste „TicketQueues") ────────────────────────────────────

const _txt = v => String(v ?? '').trim();
const _bool = v => v === true || v === 1 || v === '1' || /^(true|ja|yes)$/i.test(String(v ?? ''));
const _guid = v => {
  const s = _txt(v).replace(/[{}]/g, '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : '';
};

export const MODI = Object.freeze(['Ticket', 'Hinweis', 'Archiv']);

/** Zeile der Konfigurationsliste (Graph `fields` oder SP-REST-Item) → Queue-Objekt. */
export function queueAusFeldern(item) {
  const f = item?.fields || item || {};
  return {
    itemId: Number(item?.id ?? item?.Id ?? f.id ?? f.Id ?? 0) || 0,
    name: _txt(f.Title),
    kennung: _txt(f.Kennung).toUpperCase(),
    liste: _txt(f.ListenName),
    listId: _guid(f.ListenId),
    listUrl: _txt(f.ListenUrl),
    domains: domainsAusText(f.Domains),
    stichwoerter: stichwoerterAusText(f.Stichwoerter),
    kategorie: _txt(f.Kategorie),
    farbe: /^#[0-9a-f]{6}$/i.test(_txt(f.Farbe)) ? _txt(f.Farbe) : '',
    werk: _txt(f.Werk),
    bearbeiter: mailsAusText(f.Bearbeiter),
    gruppe: _txt(f.Gruppe),
    modus: MODI.includes(f.Modus) ? f.Modus : 'Ticket',
    hinweis: String(f.Hinweistext ?? ''),
    standard: _bool(f.Standard),
    // Neue Zeilen ohne Wert gelten als aktiv – ein leeres Kästchen soll keine Queue abschalten.
    aktiv: f.Aktiv === undefined || f.Aktiv === null ? true : _bool(f.Aktiv),
    benachrichtigen: _bool(f.Benachrichtigen),
    reihenfolge: Number(f.Reihenfolge) || 0,
  };
}

/** Queue-Objekt → Felder für Graph (so, wie der Flow sie liest: Domains mit ';'). */
export function queueZuFeldern(q) {
  return {
    Title: _txt(q.name),
    Kennung: _txt(q.kennung).toUpperCase(),
    ListenName: _txt(q.liste),
    ListenId: _guid(q.listId),
    ListenUrl: _txt(q.listUrl),
    Domains: domainsAusText(Array.isArray(q.domains) ? q.domains.join(';') : q.domains).join(';'),
    Stichwoerter: stichwoerterAusText(Array.isArray(q.stichwoerter) ? q.stichwoerter.join(';') : q.stichwoerter).join(';'),
    Kategorie: _txt(q.kategorie),
    Farbe: /^#[0-9a-f]{6}$/i.test(_txt(q.farbe)) ? _txt(q.farbe) : '',
    Werk: _txt(q.werk),
    Bearbeiter: mailsAusText(Array.isArray(q.bearbeiter) ? q.bearbeiter.join(';') : q.bearbeiter).join(';'),
    Gruppe: _txt(q.gruppe),
    Modus: MODI.includes(q.modus) ? q.modus : 'Ticket',
    Hinweistext: String(q.hinweis ?? ''),
    Standard: !!q.standard,
    Aktiv: q.aktiv !== false,
    Benachrichtigen: !!q.benachrichtigen,
    Reihenfolge: Number(q.reihenfolge) || 0,
  };
}

/** Vorschläge für Listen- und Gruppennamen einer neuen Queue. */
export function standardNamen(kennung) {
  const k = _txt(kennung).toUpperCase();
  return { liste: `Tickets-${k}`, gruppe: `Tickets ${k} – Bearbeiter` };
}

/**
 * Konfiguration prüfen. Liefert Meldungen { kennung, schwere: 'fehler'|'hinweis', text }.
 * Fehler blockieren das Speichern, Hinweise nicht.
 */
export function pruefeQueues(queues) {
  const out = [];
  const add = (q, schwere, text) => out.push({ kennung: q?.kennung || '?', schwere, text });
  const aktiv = (queues || []).filter(q => q.aktiv);
  const kennungen = new Map();
  const domains = new Map();
  for (const q of queues || []) {
    if (!KENNUNG_MUSTER.test(q.kennung)) add(q, 'fehler', 'Kennung: 2–10 Zeichen, Großbuchstaben/Ziffern, beginnt mit einem Buchstaben.');
    if (kennungen.has(q.kennung)) add(q, 'fehler', `Kennung ${q.kennung} ist doppelt vergeben.`);
    kennungen.set(q.kennung, q);
    if (!q.name) add(q, 'fehler', 'Name fehlt.');
    if (q.modus !== 'Hinweis' && !q.liste) add(q, 'fehler', 'Listenname fehlt.');
    if (q.modus === 'Hinweis' && !q.hinweis.trim()) add(q, 'fehler', 'Hinweis-Queue ohne Hinweistext.');
    if (q.modus === 'Ticket' && !q.gruppe) add(q, 'hinweis', 'Keine Bearbeiter-Gruppe – nur Admins sehen die Tickets.');
    if (q.modus === 'Ticket' && !q.listId) add(q, 'hinweis', 'Liste noch nicht eingerichtet (Verwaltung → Einrichtung).');
    if (q.modus === 'Archiv' && (q.domains.length || q.standard)) add(q, 'hinweis', 'Archiv nimmt keine neuen Tickets an – Domains/Standard werden ignoriert.');
    if (q.modus === 'Archiv' && (q.stichwoerter || []).length) add(q, 'hinweis', 'Archiv nimmt keine neuen Tickets an – Stichwörter werden ignoriert.');
    if (!q.aktiv) continue;
    // Stichwort-Queues (z. B. SAP) dürfen Domains mit einer Werk-Queue teilen: Das Stichwort entscheidet.
    if ((q.stichwoerter || []).length) continue;
    for (const d of q.domains) {
      if (domains.has(d) && q.modus !== 'Archiv') add(q, 'fehler', `Domain ${d} ist schon ${domains.get(d)} zugeordnet.`);
      if (q.modus !== 'Archiv') domains.set(d, q.kennung);
    }
  }
  const standards = aktiv.filter(q => q.standard && q.modus !== 'Archiv');
  if (standards.length > 1) add(standards[1], 'fehler', 'Mehr als eine Standard-Queue aktiv.');
  if (aktiv.length && !standards.length) out.push({ kennung: '–', schwere: 'hinweis', text: 'Keine Standard-Queue: Mails unbekannter Domains werden abgewiesen (Fehler-Mail an Admin).' });
  if (aktiv.filter(q => q.modus === 'Archiv').length > 1) out.push({ kennung: '–', schwere: 'fehler', text: 'Mehr als ein Archiv aktiv.' });
  return out;
}

// ── Berechtigungen ──────────────────────────────────────────────────────────

/** SharePoint-Rechte (SP.PermissionKind), soweit hier gebraucht. */
export const RECHT = Object.freeze({
  ansehen: 1,            // ViewListItems
  hinzufuegen: 2,        // AddListItems
  bearbeiten: 3,         // EditListItems
  loeschen: 4,           // DeleteListItems
  versionenLoeschen: 8,  // DeleteVersions
  ueberschreiben: 9,     // CancelCheckout = „Listenverhalten außer Kraft setzen"
  listenVerwalten: 12,   // ManageLists
  rechteVerwalten: 26,   // ManagePermissions
});

/** Hat die Maske { High, Low } (Zahlen oder Strings aus SP-REST) dieses Recht? */
export function hatRecht(maske, recht) {
  if (!maske) return false;
  const bit = recht - 1;
  const wert = bit < 32 ? Number(maske.Low) || 0 : Number(maske.High) || 0;
  const pos = bit < 32 ? bit : bit - 32;
  return Math.floor(wert / 2 ** pos) % 2 === 1;
}

/**
 * Rolle einer Person in einer Liste aus ihren effektiven Rechten:
 * admin (Rechte verwalten) · bearbeiter (alle Elemente bearbeiten) · melder (lesen) · keine.
 */
export function rolleAusRechten(maske) {
  if (!maske) return 'keine';
  if (hatRecht(maske, RECHT.rechteVerwalten)) return 'admin';
  if (hatRecht(maske, RECHT.bearbeiten) && hatRecht(maske, RECHT.ueberschreiben)) return 'bearbeiter';
  if (hatRecht(maske, RECHT.ansehen)) return 'melder';
  return 'keine';
}

/**
 * Maske der Stufe „Ticket-Bearbeitung" aus der Maske von „Mitwirken":
 * + Listenverhalten außer Kraft setzen, − Elemente löschen, − Versionen löschen.
 */
export function bearbeitungsMaske(mitwirken) {
  const bit = n => 2 ** (n - 1);
  let low = Number(mitwirken?.Low) || 0;
  if (!hatRecht({ Low: low, High: 0 }, RECHT.ueberschreiben)) low += bit(RECHT.ueberschreiben);
  if (hatRecht({ Low: low, High: 0 }, RECHT.loeschen)) low -= bit(RECHT.loeschen);
  if (hatRecht({ Low: low, High: 0 }, RECHT.versionenLoeschen)) low -= bit(RECHT.versionenLoeschen);
  return { High: String(Number(mitwirken?.High) || 0), Low: String(low) };
}

/** Rollen im Soll: eingebaute über RoleTypeKind (sprachunabhängig), eigene über den Namen. */
export const ROLLE = Object.freeze({
  voll: Object.freeze({ typ: 5, anzeige: 'Vollzugriff' }),
  mitwirken: Object.freeze({ typ: 3, anzeige: 'Mitwirken' }),
  lesen: Object.freeze({ typ: 2, anzeige: 'Lesen' }),
});
export const rolleBearbeitung = name => ({ name, anzeige: name });

/**
 * Soll-Berechtigungen einer Liste.
 * @param {object} q          Queue
 * @param {object} ctx        { ownerGruppe, dienstkonto, melderClaim, melderAnzeige, stufeBearbeitung, queues, melderSehen }
 * @param {'tickets'|'notizen'} art
 * @returns {Array<{schluessel:string, art:'gruppe'|'login', wert:string, anzeige:string, rolle:object, grund:string}>}
 */
export function sollRechte(q, ctx, art = 'tickets') {
  if (!q || q.modus === 'Hinweis') return [];
  const soll = [];
  const add = (artP, wert, anzeige, rolle, grund) => {
    if (!wert) return;
    const schluessel = `${artP}:${String(wert).toLowerCase()}|${rolle.typ ?? String(rolle.name).toLowerCase()}`;
    if (!soll.some(s => s.schluessel === schluessel)) soll.push({ schluessel, art: artP, wert, anzeige, rolle, grund });
  };
  const bearbeitung = rolleBearbeitung(ctx.stufeBearbeitung);
  add('gruppe', ctx.ownerGruppe, ctx.ownerGruppe, ROLLE.voll, 'Websitebesitzer = Admins');
  if (ctx.dienstkonto) add('login', claimFuerMail(ctx.dienstkonto), ctx.dienstkonto, ROLLE.voll, 'Konto des Flows (legt Tickets an, setzt „Erstellt von")');

  if (q.modus === 'Archiv') {
    const gruppen = q.gruppe === '*'
      ? (ctx.queues || []).filter(x => x.modus === 'Ticket' && x.aktiv && x.gruppe).map(x => x.gruppe)
      : (q.gruppe ? [q.gruppe] : []);
    for (const g of gruppen) add('gruppe', g, g, bearbeitung, 'Bearbeiter dürfen Alt-Tickets weiter bearbeiten');
    return soll;
  }
  if (q.gruppe) add('gruppe', q.gruppe, q.gruppe, bearbeitung, `Bearbeiter der Queue ${q.kennung}`);
  // Übergabe: Bearbeiter anderer Queues dürfen hier Tickets anlegen (z. B. SAP-Fall an das SAP-Team),
  // sehen wegen „nur eigene Elemente" aber nichts außer dem, was sie selbst übergeben.
  if (art === 'tickets' && ctx.uebergabe !== false) {
    for (const x of (ctx.queues || []).filter(x => x.modus === 'Ticket' && x.aktiv && x.gruppe && x.gruppe !== q.gruppe)) {
      add('gruppe', x.gruppe, x.gruppe, ROLLE.mitwirken, `Übergabe aus Queue ${x.kennung} (sieht nur selbst übergebene Tickets)`);
    }
  }
  if (art === 'tickets' && ctx.melderSehen !== false && ctx.melderClaim) {
    add('login', ctx.melderClaim, ctx.melderAnzeige || ctx.melderClaim, ROLLE.lesen, 'Melder sehen nur ihre eigenen Tickets');
  }
  return soll;
}

/**
 * Soll-Berechtigungen der Konfigurationsliste „TicketQueues": alle lesen (die App braucht
 * die Queues, um die Listen zu finden – vertraulich ist darin nichts), ändern nur Admins.
 * So kann niemand außer den Websitebesitzern das Routing verbiegen.
 */
export function sollKonfigRechte(ctx) {
  const soll = [
    { art: 'gruppe', wert: ctx.ownerGruppe, anzeige: ctx.ownerGruppe, rolle: ROLLE.voll, grund: 'Websitebesitzer = Admins' },
    { art: 'login', wert: claimFuerMail(ctx.dienstkonto), anzeige: ctx.dienstkonto, rolle: ROLLE.lesen, grund: 'Flow liest die Queues' },
    { art: 'login', wert: ctx.melderClaim, anzeige: ctx.melderAnzeige || ctx.melderClaim, rolle: ROLLE.lesen, grund: 'App findet damit die Listen' },
  ].filter(s => s.wert && s.wert !== claimFuerMail(''));
  return soll.map(s => ({ ...s, schluessel: `${s.art}:${String(s.wert).toLowerCase()}|${s.rolle.typ}` }));
}

const _lc = s => String(s ?? '').toLowerCase();

/** Rolle aus SharePoint, die für den Abgleich zählt (nicht „Beschränkter Zugriff"/versteckt). */
function _zaehlt(r) {
  return !r.hidden && r.typ !== 1;
}

function _rolleGleich(soll, ist) {
  return soll.typ != null ? ist.typ === soll.typ : _lc(ist.name) === _lc(soll.name);
}

function _prinzipalGleich(soll, ist) {
  if (soll.art === 'gruppe') return ist.typ === 8 && (_lc(ist.titel) === _lc(soll.wert) || _lc(ist.login) === _lc(soll.wert));
  return _lc(ist.login) === _lc(soll.wert);
}

/**
 * Soll gegen Ist.
 * @param soll  Ergebnis von sollRechte()
 * @param ist   [{ principalId, login, titel, typ, rollen: [{ id, name, typ, hidden }] }]
 * @returns { fehlt: soll[], zuviel: [{ principalId, login, titel, rolle }], ok: soll[] }
 */
export function rechteAbgleich(soll, ist) {
  const fehlt = [], ok = [], zuviel = [];
  for (const s of soll) {
    const treffer = (ist || []).some(p => _prinzipalGleich(s, p) && (p.rollen || []).some(r => _zaehlt(r) && _rolleGleich(s.rolle, r)));
    (treffer ? ok : fehlt).push(s);
  }
  for (const p of ist || []) {
    for (const r of p.rollen || []) {
      if (!_zaehlt(r)) continue;
      const gewollt = soll.some(s => _prinzipalGleich(s, p) && _rolleGleich(s.rolle, r));
      if (!gewollt) zuviel.push({ principalId: p.principalId, login: p.login, titel: p.titel, typ: p.typ, rolle: r });
    }
  }
  return { fehlt, zuviel, ok };
}

/** Listeneinstellungen: Abweichungen [{ feld, ist, soll }]. */
export function einstellungsAbgleich(ist, soll) {
  return Object.entries(soll)
    .filter(([k, v]) => ist?.[k] !== v)
    .map(([feld, v]) => ({ feld, ist: ist?.[feld], soll: v }));
}

/** SP-REST-Rollenzuweisungen (nometadata, $expand=Member,RoleDefinitionBindings) → Ist-Format. */
export function istAusRollenzuweisungen(value) {
  return (value || []).map(ra => ({
    principalId: ra.PrincipalId ?? ra.Member?.Id,
    login: ra.Member?.LoginName || '',
    titel: ra.Member?.Title || '',
    typ: ra.Member?.PrincipalType,
    rollen: (ra.RoleDefinitionBindings?.results || ra.RoleDefinitionBindings || []).map(b => ({
      id: b.Id, name: b.Name, typ: b.RoleTypeKind, hidden: !!b.Hidden,
    })),
  }));
}

// ── Tickets ─────────────────────────────────────────────────────────────────

export const STATUS_WERTE = STATUS.map(s => s.wert);
export const statusInfo = wert => STATUS.find(s => s.wert === wert) || { wert, offen: true, farbe: 'grau' };
export const istOffen = wert => statusInfo(wert).offen;
export const istWartend = wert => !!statusInfo(wert).wartet;

/** Priorität vereinheitlichen: high/(1) Hoch/mittel/… → Kritisch|Hoch|Normal|Niedrig ('' bleibt ''). */
export function normPrio(v) {
  const s = _lc(v).trim();
  if (!s) return '';
  if (/krit|crit/.test(s)) return 'Kritisch';
  if (/hoch|high/.test(s)) return 'Hoch';
  if (/niedrig|low/.test(s)) return 'Niedrig';
  return 'Normal';
}

/** Wichtigkeit einer Mail (low/normal/high) → Priorität. */
export function prioAusWichtigkeit(w) {
  return { high: 'Hoch', low: 'Niedrig' }[_lc(w)] || 'Normal';
}

/**
 * Den passenden Auswahlwert einer Choice-Spalte finden (z. B. „Hoch" → „(1) Hoch",
 * wenn die Liste so benannt ist). Kein Treffer → Wert unverändert.
 */
export function passendeAuswahl(auswahl, wert, norm = x => _lc(x).trim()) {
  const ziel = norm(wert);
  return (auswahl || []).find(c => norm(c) === ziel) ?? wert;
}

function _person(v) {
  if (!v || typeof v !== 'object') return null;
  const mail = _lc(v.EMail || v.Email || v.email || mailAusLogin(v.Name || v.LoginName));
  const name = v.Title || v.LookupValue || v.displayName || mail;
  if (!name && !mail) return null;
  return { id: v.Id ?? v.LookupId ?? null, name: String(name || ''), mail };
}

function _personen(v) {
  const arr = Array.isArray(v) ? v : Array.isArray(v?.results) ? v.results : v ? [v] : [];
  return arr.map(_person).filter(Boolean);
}

/**
 * SP-REST-Element (nometadata, Personen expandiert) → Ticket.
 * @param it    Element
 * @param q     Queue
 * @param felder  { kategorie?: 'InternerName', art?: '…' } – optionale Spalten dieser Liste
 */
export function ticketAusSp(it, q, felder = {}) {
  const melder = _person(it.Issueloggedby);
  const autor = _person(it.Author);
  const melderMail = _lc(it.E_x002d_Mail_x002d_Adresse || melder?.mail || '').trim();
  return {
    nummer: ticketNummer(q.kennung, it.Id),
    kennung: q.kennung,
    id: Number(it.Id),
    titel: String(it.Title ?? ''),
    status: String(it.Status ?? ''),
    prio: normPrio(it.Priority),
    prioRoh: String(it.Priority ?? ''),
    werk: String(it.Werk ?? ''),
    kategorie: felder.kategorie ? String(it[felder.kategorie] ?? '') : '',
    art: felder.art ? String(it[felder.art] ?? '') : '',
    bearbeiter: _personen(it.Assignedto0),
    melder: melder || (melderMail ? { id: null, name: melderMail, mail: melderMail } : null),
    melderMail,
    autor,
    gemeldetAm: it.DateReported || it.Created || '',
    erstellt: it.Created || '',
    geaendert: it.Modified || '',
    anhaenge: !!it.Attachments,
    hauptticket: (() => { const n = parseTicketNummer(it.Hauptticket); return n ? ticketNummer(n.kennung, n.id) : ''; })(),
  };
}

/** Ist das Ticket „meins" als Melder? (Melder-Mail, Personenfeld oder Ersteller) */
export function istMeineAnfrage(t, mail) {
  const m = _lc(mail);
  if (!m) return false;
  return t.melderMail === m || _lc(t.melder?.mail) === m || _lc(t.autor?.mail) === m;
}

export const istMirZugewiesen = (t, mail) => t.bearbeiter.some(b => _lc(b.mail) === _lc(mail));

/** Fälligkeit nach Priorität (Kalenderstunden ab Meldung). */
export function faelligAm(t, sla = SLA_STUNDEN) {
  const basis = Date.parse(t.gemeldetAm || t.erstellt);
  if (isNaN(basis)) return null;
  const std = sla[t.prio] ?? sla.Normal;
  return new Date(basis + std * 3600e3);
}

export function istUeberfaellig(t, jetzt = new Date(), sla = SLA_STUNDEN) {
  if (!istOffen(t.status) || istWartend(t.status)) return false;
  const f = faelligAm(t, sla);
  return !!f && f < jetzt;
}

/**
 * Tickets filtern.
 * f: { suche, status: 'offen'|'alle'|'geschlossen'|<Status>, kennung, prio, zuweisung: 'alle'|'ich'|'keiner', ueberfaellig }
 */
export function filtereTickets(tickets, f = {}, ich = '', jetzt = new Date()) {
  const such = _lc(f.suche).trim();
  return (tickets || []).filter(t => {
    if (f.kennung && t.kennung !== f.kennung) return false;
    if (f.status === 'offen' && !istOffen(t.status)) return false;
    if (f.status === 'geschlossen' && istOffen(t.status)) return false;
    if (f.status && !['offen', 'alle', 'geschlossen'].includes(f.status) && t.status !== f.status) return false;
    if (f.prio && t.prio !== f.prio) return false;
    if (f.zuweisung === 'ich' && !istMirZugewiesen(t, ich)) return false;
    if (f.zuweisung === 'keiner' && t.bearbeiter.length) return false;
    if (f.ueberfaellig && !istUeberfaellig(t, jetzt)) return false;
    if (such) {
      const heu = [t.nummer, t.titel, t.melder?.name, t.melderMail, t.kategorie, t.werk, t.hauptticket, ...t.bearbeiter.map(b => b.name)]
        .map(_lc).join(' ');
      if (!such.split(/\s+/).every(w => heu.includes(w))) return false;
    }
    return true;
  });
}

const _prioRang = p => { const i = PRIORITAETEN.indexOf(p); return i < 0 ? PRIORITAETEN.length : i; };

/** Sortierung: 'neu' (Meldung absteigend), 'prio' (Priorität, dann älteste zuerst), 'geaendert'. */
export function sortiereTickets(tickets, art = 'neu') {
  const zeit = v => Date.parse(v) || 0;
  const liste = [...(tickets || [])];
  if (art === 'prio') return liste.sort((a, b) => _prioRang(a.prio) - _prioRang(b.prio) || zeit(a.gemeldetAm) - zeit(b.gemeldetAm));
  if (art === 'geaendert') return liste.sort((a, b) => zeit(b.geaendert) - zeit(a.geaendert));
  return liste.sort((a, b) => zeit(b.gemeldetAm) - zeit(a.gemeldetAm) || b.id - a.id);
}

// ── Haupt- und Untertickets ─────────────────────────────────────────────────
//
// Ein Unterticket trägt in „Hauptticket" die Nummer seines Haupttickets. Es gibt nur
// eine Ebene: Wird ein Hauptticket selbst Unterticket, wandern seine Untertickets mit.
// Die Pläne verändern nichts – sie sagen nur, welche Tickets welchen Wert bekommen.

/** Alle bekannten Ticketnummern in einem Text (auch „Neues Ticket: 123" → ALT-123). */
export function nummernImText(text, kennungen, archivKennung = 'ALT') {
  const s = String(text ?? '');
  const bekannt = new Set((kennungen || []).map(k => String(k).toUpperCase()));
  const out = [];
  const add = n => { if (!out.includes(n)) out.push(n); };
  for (const m of s.toUpperCase().matchAll(/(?:^|[^A-Z0-9])([A-Z][A-Z0-9]{1,9})-(\d{1,9})(?!\d)/g)) {
    if (bekannt.has(m[1])) add(`${m[1]}-${Number(m[2])}`);
  }
  for (const m of s.matchAll(/Neues Ticket:\s*(\d{1,9})\b/gi)) add(`${archivKennung}-${Number(m[1])}`);
  return out;
}

export const untertickets = (hauptNr, alle) => (alle || []).filter(x => x.hauptticket && x.hauptticket === hauptNr);

/** `unter` wird Unterticket von `haupt` (bzw. von dessen Hauptticket). */
export function planZusammenfuehren(unter, haupt, alle) {
  if (!unter || !haupt) throw new Error('Ticket nicht gefunden.');
  if (unter.nummer === haupt.nummer) throw new Error('Ein Ticket kann nicht mit sich selbst zusammengeführt werden.');
  const ziel = haupt.hauptticket || haupt.nummer;
  if (ziel === unter.nummer) throw new Error(`${haupt.nummer} ist bereits Unterticket von ${unter.nummer}.`);
  if (unter.hauptticket === ziel) throw new Error(`${unter.nummer} ist bereits Unterticket von ${ziel}.`);
  const aenderungen = [{ nummer: unter.nummer, hauptticket: ziel }];
  for (const x of untertickets(unter.nummer, alle)) aenderungen.push({ nummer: x.nummer, hauptticket: ziel });
  return { haupt: ziel, aenderungen };
}

/** Ein Unterticket wird zum Hauptticket; das bisherige Hauptticket und alle Geschwister hängen sich darunter. */
export function planHauptWechseln(neu, alle) {
  if (!neu?.hauptticket) throw new Error(`${neu?.nummer || 'Das Ticket'} ist bereits Hauptticket.`);
  const alt = neu.hauptticket;
  const aenderungen = [{ nummer: neu.nummer, hauptticket: '' }, { nummer: alt, hauptticket: neu.nummer }];
  for (const x of untertickets(alt, alle)) if (x.nummer !== neu.nummer) aenderungen.push({ nummer: x.nummer, hauptticket: neu.nummer });
  return { haupt: neu.nummer, aenderungen };
}

/** Unterticket lösen – oder bei einem Hauptticket die ganze Gruppe auflösen. */
export function planLoesen(t, alle) {
  if (t.hauptticket) return { aenderungen: [{ nummer: t.nummer, hauptticket: '' }] };
  const unter = untertickets(t.nummer, alle);
  if (!unter.length) throw new Error(`${t.nummer} ist mit keinem Ticket verknüpft.`);
  return { aenderungen: unter.map(x => ({ nummer: x.nummer, hauptticket: '' })) };
}

/** Eindeutige Melder-Adressen einer Ticketgruppe (für Benachrichtigungen). */
export function melderAdressen(tickets) {
  const out = [];
  for (const t of tickets) {
    const m = _lc(t.melderMail || t.melder?.mail).trim();
    if (m && istMail(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

const STOPPWOERTER = new Set(['aw', 're', 'wg', 'fw', 'fwd', 'tr', 'und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'ist', 'sind', 'ich', 'wir', 'kein', 'keine', 'nicht', 'geht', 'mehr', 'mit', 'von', 'für', 'bei', 'auf', 'aus', 'ein', 'eine', 'einen', 'bitte', 'hallo', 'problem', 'frage', 'ticket', 'eingangsbestätigung']);

/** Bedeutungstragende Wörter eines Titels (für die Ähnlichkeit). */
export function titelWoerter(titel) {
  return new Set(String(titel ?? '').toLowerCase()
    .replace(/\[#[^\]]*\]/g, ' ')
    .split(/[^a-z0-9äöüß]+/)
    .filter(w => w.length > 2 && !STOPPWOERTER.has(w)));
}

/** Jaccard-Ähnlichkeit zweier Titel (0…1). */
export function aehnlichkeit(a, b) {
  const x = titelWoerter(a), y = titelWoerter(b);
  if (!x.size || !y.size) return 0;
  let gemeinsam = 0;
  for (const w of x) if (y.has(w)) gemeinsam++;
  return gemeinsam / (x.size + y.size - gemeinsam);
}

/**
 * Mögliche Duplikate eines Tickets: (1) Nummer im Betreff/Text, (2) gleicher Melder mit
 * ähnlichem Betreff in 14 Tagen, (3) sehr ähnlicher Betreff anderer Melder in 3 Tagen
 * (Hinweis auf eine Störung). Bereits verknüpfte Tickets fallen weg.
 */
export function duplikatVorschlaege(t, alle, { kennungen = [], archivKennung = 'ALT', jetzt = new Date() } = {}) {
  const nachNr = new Map((alle || []).map(x => [x.nummer, x]));
  const familie = t.hauptticket || t.nummer;
  const verbunden = x => x.nummer === t.nummer || x.nummer === familie || x.hauptticket === familie;
  const out = [];
  const add = (x, grund) => { if (x && !verbunden(x) && !out.some(o => o.ticket.nummer === x.nummer)) out.push({ ticket: x, grund }); };
  const text = `${t.titel}\n${String(t.beschreibung ?? '').replace(/<[^>]+>/g, ' ')}`;
  for (const n of nummernImText(text, kennungen, archivKennung)) add(nachNr.get(n), 'Nummer im Betreff/Text');
  const zeit = x => Date.parse(x.gemeldetAm || x.erstellt) || 0;
  const tage = x => Math.abs(zeit(x) - zeit(t)) / 86400e3;
  const offen = (alle || []).filter(x => istOffen(x.status) && !verbunden(x));
  const mail = _lc(t.melderMail);
  offen.filter(x => mail && _lc(x.melderMail) === mail && tage(x) <= 14 && aehnlichkeit(x.titel, t.titel) >= 0.5)
    .forEach(x => add(x, 'gleicher Melder, ähnlicher Betreff'));
  offen.filter(x => _lc(x.melderMail) !== mail && tage(x) <= 3 && aehnlichkeit(x.titel, t.titel) >= 0.6)
    .forEach(x => add(x, 'ähnlicher Betreff von anderen – Störung?'));
  return out.slice(0, 6);
}

// ── Kennzahlen ──────────────────────────────────────────────────────────────

/** Montag 00:00 der Woche von d (lokale Zeit). */
export function wochenStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** ISO-Kalenderwoche. */
export function kalenderwoche(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const tag = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - tag);
  const jahresStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x - jahresStart) / 86400000 + 1) / 7);
}

export function kennzahlen(tickets, jetzt = new Date(), sla = SLA_STUNDEN) {
  const offen = tickets.filter(t => istOffen(t.status));
  const vor30 = jetzt - 30 * 86400e3;
  // „Erledigt am" gibt es nicht als Spalte – für geschlossene Tickets ist die letzte Änderung die beste Näherung.
  const erledigt30 = tickets.filter(t => !istOffen(t.status) && Date.parse(t.geaendert) >= vor30);
  const loesung = erledigt30
    .map(t => (Date.parse(t.geaendert) - Date.parse(t.gemeldetAm || t.erstellt)) / 3600e3)
    .filter(h => isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const median = loesung.length ? loesung[Math.floor(loesung.length / 2)] : null;
  return {
    gesamt: tickets.length,
    offen: offen.length,
    neu: tickets.filter(t => t.status === 'Neu').length,
    unzugewiesen: offen.filter(t => !t.bearbeiter.length).length,
    wartend: offen.filter(t => istWartend(t.status)).length,
    ueberfaellig: offen.filter(t => istUeberfaellig(t, jetzt, sla)).length,
    erledigt30: erledigt30.length,
    eingang30: tickets.filter(t => Date.parse(t.gemeldetAm || t.erstellt) >= vor30).length,
    medianLoesungStunden: median,
  };
}

/** Eingang/Erledigt je Kalenderwoche der letzten n Wochen (älteste zuerst). */
export function verlaufNachWoche(tickets, wochen = 12, jetzt = new Date()) {
  const start0 = wochenStart(jetzt);
  const zeilen = [];
  for (let i = wochen - 1; i >= 0; i--) {
    const von = new Date(start0); von.setDate(von.getDate() - 7 * i);
    const bis = new Date(von); bis.setDate(bis.getDate() + 7);
    const inWoche = v => { const t = Date.parse(v); return t >= von && t < bis; };
    zeilen.push({
      kw: kalenderwoche(von),
      von,
      eingang: tickets.filter(t => inWoche(t.gemeldetAm || t.erstellt)).length,
      erledigt: tickets.filter(t => !istOffen(t.status) && inWoche(t.geaendert)).length,
    });
  }
  return zeilen;
}

/** Zählen nach Schlüssel → [{ wert, anzahl }] absteigend. */
export function zaehleNach(tickets, fn) {
  const m = new Map();
  for (const t of tickets) {
    const k = fn(t) || '–';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].map(([wert, anzahl]) => ({ wert, anzahl })).sort((a, b) => b.anzahl - a.anzahl || String(a.wert).localeCompare(String(b.wert)));
}

// ── Navigation ──────────────────────────────────────────────────────────────

/** „#/t/SCH-12" → { seite: 'ticket', nummer: 'SCH-12' } usw. Unbekanntes → Startseite. */
export function parseRoute(hash) {
  const teile = String(hash ?? '').replace(/^#\/?/, '').split('/').filter(Boolean).map(s => decodeURIComponent(s));
  const [a, b] = teile;
  if (a === 't' && parseTicketNummer(b)) return { seite: 'ticket', nummer: parseTicketNummer(b) && b.toUpperCase() };
  if (a === 'verwaltung') return { seite: 'verwaltung', bereich: ['queues', 'rechte', 'migration', 'eingang'].includes(b) ? b : 'queues' };
  if (['posteingang', 'meine', 'neu', 'berichte'].includes(a)) return { seite: a };
  return { seite: '' };
}

export const ticketLink = (appUrl, nummer) => `${appUrl}#/t/${nummer}`;
