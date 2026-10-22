/**
 * Ticket-Detail
 * =============
 * Bearbeiter: Status, Priorität, Zuweisung, Antwort an den Melder (Kommentar + Mail),
 * interne Notizen, Anhänge, Übergabe an eine andere Queue, Verknüpfung:
 *   - Zusammenführen (Unterticket ↔ Hauptticket), Vorschläge für Duplikate
 *   - Hauptticket wechseln, Verknüpfung lösen
 *   - Antwort/Erledigt am Hauptticket erreicht auf Wunsch alle Melder der Untertickets
 *   - Verlauf des Haupttickets zeigt auch die Nachrichten der Untertickets
 * Melder: Verlauf lesen, antworten (per Mail an das Ticketpostfach – der Flow hängt
 * die Antwort an und benachrichtigt die Bearbeiter).
 */
import { KONFIG, FELDER, STATUS, PRIORITAETEN, siteUrl } from './config.js';
import {
  zustand, ladeTicket, ladeTicketKurz, ladeFelder, setzeWerte, setzeBearbeiter, setzeHauptticket, ladeUntertickets,
  ladeKommentare, kommentieren, ladeNotizen, notieren, ladeAnhaenge, anhangHochladen, anhangLoeschen,
  liste as listeVon, darfBearbeiten, uebergabeZiele, alleKennungen, ladeAlle,
} from './daten.js';
import { sendeMail, sp, lit } from './api.js';
import {
  istOffen, istUeberfaellig, faelligAm, passendeAuswahl, normPrio, istMirZugewiesen, ticketNummer, parseTicketNummer,
  planZusammenfuehren, planHauptWechseln, planLoesen, duplikatVorschlaege,
} from './modell.js';
import { mailAntwortAnMelder, mailStatusAnMelder, mailMelderAntwort, mailZuweisung, mailZusammengefuehrt } from './mails.js';
import { kopiereTicket } from './kopie.js';
import { meineMail, meinName } from './auth.js';
import { esc, datumZeit, relativ } from './text.js';
import { sicheresHtml, istHtml, textFragment } from './html.js';
import { $, aktion, dialog, meldung, beschaeftigt, bestaetigen, statusBadge, prioBadge, personen, avatar, ladeAnzeige, queuePill } from './ui.js';
import { personenwahl, leseAuswahl } from './personenwahl.js';

/** { ticket, liste, rolle, haupt: Ticket|null, unter: Ticket[], vorschlaege: [] } */
let akt = null;

const istBearbeiter = () => akt && (akt.rolle === 'bearbeiter' || akt.rolle === 'admin');
/** Untertickets, wenn dieses Ticket ein Hauptticket ist. */
const meineUnter = () => (akt && !akt.ticket.hauptticket ? akt.unter : []);

export async function zeige(main, route, aktuell) {
  main.innerHTML = ladeAnzeige('Lade Ticket …');
  const { ticket, liste } = await ladeTicket(route.nummer);
  if (!aktuell()) return;
  akt = { ticket, liste, rolle: liste.rolle, haupt: null, unter: [], vorschlaege: [] };
  if (istBearbeiter()) await ladeFamilie();
  if (!aktuell()) return;
  zeichne(main);
  ladeVerlauf();
  ladeAnhangListe();
  if (istBearbeiter()) { ladeNotizListe(); ladeVorschlaege(); }
}

/** Hauptticket und Untertickets der Gruppe dieses Tickets laden. */
async function ladeFamilie() {
  const t = akt.ticket;
  const hauptNr = t.hauptticket || t.nummer;
  const [haupt, unter] = await Promise.all([
    t.hauptticket ? ladeTicketKurz(t.hauptticket) : Promise.resolve(null),
    ladeUntertickets(hauptNr).catch(() => []),
  ]);
  akt.haupt = haupt;
  akt.unter = unter.filter(x => x.nummer !== t.nummer);
}

/** Duplikat-Vorschläge im Hintergrund (braucht die Tickets der eigenen Queues). */
async function ladeVorschlaege() {
  const nr = akt.ticket.nummer;
  const { tickets } = await ladeAlle({ mindestens: 'bearbeiter', mitArchiv: true }).catch(() => ({ tickets: [] }));
  if (akt?.ticket.nummer !== nr) return;
  akt.vorschlaege = duplikatVorschlaege(akt.ticket, tickets, { kennungen: alleKennungen(), archivKennung: KONFIG.archivKennung });
  zeichneVorschlaege();
}

function auswahlOptionen(feld, werte, aktuell, norm) {
  const liste = akt.liste.auswahl[feld]?.length ? akt.liste.auswahl[feld] : werte;
  const alle = liste.includes(aktuell) || !aktuell ? liste : [aktuell, ...liste];
  return alle.map(w => `<option value="${esc(w)}"${(norm ? norm(w) === norm(aktuell) : w === aktuell) ? ' selected' : ''}>${esc(w)}</option>`).join('');
}

function zeichne(main = $('#hauptinhalt')) {
  const t = akt.ticket;
  const q = akt.liste.queue;
  const b = istBearbeiter();
  const zurueck = b ? '#/posteingang' : '#/meine';
  const faellig = faelligAm(t);
  const ueber = istUeberfaellig(t);

  main.innerHTML = `
    <div class="ticket-kopf">
      <a href="${zurueck}" class="zurueck">← ${b ? 'Posteingang' : 'Meine Anfragen'}</a>
      <div class="nr-zeile"><span class="nr gross">${esc(t.nummer)}</span>${queuePill(q)}<span class="leise">${esc(q.name)}${q.modus === 'Archiv' ? ' (Archiv)' : ''}</span>${statusBadge(t.status)}${prioBadge(t.prio)}${ueber && b ? '<span class="badge st-rot">überfällig</span>' : ''}${meineUnter().length ? `<span class="badge st-blau">Hauptticket · ${meineUnter().length} Unterticket${meineUnter().length > 1 ? 's' : ''}</span>` : ''}${t.hauptticket ? `<span class="badge st-grau">Unterticket von ${esc(t.hauptticket)}</span>` : ''}</div>
      <h1>${esc(t.titel || '(ohne Betreff)')}</h1>
    </div>
    <div id="t-vorschlaege"></div>
    <div class="ticket-raster">
      <section class="ticket-haupt">
        <article class="karte">
          <h2>Beschreibung</h2>
          <div class="mail-inhalt" id="t-beschreibung"></div>
        </article>
        <article class="karte">
          <div class="karte-kopfzeile"><h2>Anhänge</h2>${b ? `<label class="knopf klein">Datei anhängen<input type="file" multiple hidden data-aendern="t-hochladen"/></label>` : ''}</div>
          <div id="t-anhaenge">${ladeAnzeige()}</div>
        </article>
        <article class="karte">
          <div class="reiter" role="tablist">
            <button class="reiter-knopf aktiv" role="tab" aria-selected="true" data-aktion="t-reiter" data-reiter="verlauf">Verlauf <span class="leise klein">(für Melder sichtbar)</span></button>
            ${b ? '<button class="reiter-knopf" role="tab" aria-selected="false" data-aktion="t-reiter" data-reiter="intern">🔒 Intern <span class="leise klein">(nur IT)</span></button>' : ''}
          </div>
          <div id="t-reiter-verlauf">
            <div id="t-verlauf">${ladeAnzeige()}</div>
            ${antwortFormular(b)}
          </div>
          ${b ? `<div id="t-reiter-intern" hidden>
            <div id="t-notizen">${ladeAnzeige()}</div>
            <form class="antwort intern" data-absenden="t-notiz">
              <label class="sr" for="t-notiz-text">Interne Notiz</label>
              <textarea id="t-notiz-text" name="text" rows="3" required placeholder="Interne Notiz – sieht nur das IT-Team dieser Queue …"></textarea>
              <div class="antwort-fuss"><span class="leise klein">🔒 Nicht für den Melder sichtbar.</span><button class="knopf">Notiz speichern</button></div>
            </form>
          </div>` : ''}
        </article>
      </section>
      <aside class="ticket-seite">
        <div class="karte eigenschaften">
          ${b ? `
          <label>Status<select data-aendern="t-status">${auswahlOptionen(FELDER.status, STATUS.map(s => s.wert), t.status)}</select></label>
          <label>Priorität<select data-aendern="t-prio">${auswahlOptionen(FELDER.prio, PRIORITAETEN, t.prioRoh || t.prio, normPrio)}</select></label>`
          : `<div class="feld"><span>Status</span>${statusBadge(t.status)}</div>`}
          <div class="feld"><span>Bearbeiter</span><div class="personen-block">${personen(t.bearbeiter)}</div>
            ${b ? `<div class="knopfzeile">${istMirZugewiesen(t, meineMail()) ? '' : '<button class="knopf klein" data-aktion="t-uebernehmen">Übernehmen</button>'}<button class="knopf klein" data-aktion="t-zuweisen">Zuweisen …</button></div>` : ''}
          </div>
          <div class="feld"><span>Melder</span><div>${t.melder ? `<span class="person">${avatar(t.melder.name, t.melder.mail)}<span>${esc(t.melder.name)}</span></span>` : '<span class="leise">unbekannt</span>'}${t.melderMail ? `<div class="klein"><a href="mailto:${esc(t.melderMail)}">${esc(t.melderMail)}</a></div>` : ''}</div></div>
          <div class="feld"><span>Queue</span><div>${esc(q.name)} <span class="leise">(${esc(q.kennung)})</span></div></div>
          ${t.werk ? `<div class="feld"><span>Werk</span><div>${esc(t.werk)}</div></div>` : ''}
          ${t.kategorie ? `<div class="feld"><span>Kategorie</span><div>${esc(t.kategorie)}</div></div>` : ''}
          <div class="feld"><span>Gemeldet</span><div title="${esc(datumZeit(t.gemeldetAm))}">${esc(datumZeit(t.gemeldetAm))}</div></div>
          <div class="feld"><span>Geändert</span><div title="${esc(datumZeit(t.geaendert))}">${esc(relativ(t.geaendert))}</div></div>
          ${b && istOffen(t.status) && faellig ? `<div class="feld"><span>Ziel</span><div class="${ueber ? 'rot' : ''}">${esc(datumZeit(faellig))}</div></div>` : ''}
          ${!b && t.hauptticket ? `<div class="feld"><span>Hinweis</span><div class="klein">Wird gemeinsam mit Ticket ${esc(t.hauptticket)} bearbeitet.</div></div>` : ''}
        </div>
        ${b ? verknuepfungKarte() : ''}
        ${b ? `<div class="karte aktionen">
          ${istOffen(t.status) ? '<button class="knopf gruen" data-aktion="t-erledigt">✓ Erledigt …</button>' : '<button class="knopf" data-aktion="t-wieder-oeffnen">Wieder öffnen</button>'}
          <button class="knopf" data-aktion="t-weiterleiten">An andere Queue übergeben …</button>
          <a class="knopf" target="_blank" rel="noopener" href="${esc(`${siteUrl()}/_layouts/15/listform.aspx?PageType=4&ListId=%7B${q.listId}%7D&ID=${t.id}`)}">In SharePoint ↗</a>
        </div>` : ''}
      </aside>
    </div>`;

  const ziel = $('#t-beschreibung');
  const text = t.beschreibung || '';
  if (!text.trim()) ziel.innerHTML = '<p class="leise">Keine Beschreibung.</p>';
  else ziel.appendChild(istHtml(text) ? sicheresHtml(text) : textFragment(text));
  zeichneVorschlaege();
}

function ticketZeile(x, knoepfe = '') {
  return `<li class="verknuepft"><div><a href="#/t/${esc(x.nummer)}"><strong>${esc(x.nummer)}</strong></a> ${statusBadge(x.status)}</div>
    <div class="klein">${esc(x.titel || '(ohne Betreff)')}</div>
    <div class="leise klein">${esc(x.melder?.name || x.melderMail || '')}</div>${knoepfe ? `<div class="knopfzeile">${knoepfe}</div>` : ''}</li>`;
}

function verknuepfungKarte() {
  const t = akt.ticket;
  const fehlt = akt.liste.fehlend.includes(FELDER.hauptticket);
  let inhalt;
  if (fehlt) {
    inhalt = '<p class="leise klein">In dieser Liste fehlt die Spalte „Hauptticket" – Verwaltung → Rechte & Einrichtung → „Abgleichen".</p>';
  } else if (t.hauptticket) {
    const h = akt.haupt;
    inhalt = `<p class="klein">Unterticket von:</p><ul class="verknuepft-liste">${h ? ticketZeile(h) : `<li class="verknuepft"><strong>${esc(t.hauptticket)}</strong> <span class="leise klein">(kein Zugriff)</span></li>`}</ul>
      ${akt.unter.length ? `<p class="klein leise">Weitere Untertickets: ${akt.unter.map(x => `<a href="#/t/${esc(x.nummer)}">${esc(x.nummer)}</a>`).join(', ')}</p>` : ''}
      <div class="knopfzeile"><button class="knopf klein" data-aktion="t-haupt-wechseln" data-nr="${esc(t.nummer)}" title="Dieses Ticket wird Hauptticket, die anderen hängen sich darunter">Zum Hauptticket machen</button>
      <button class="knopf klein" data-aktion="t-loesen" data-nr="${esc(t.nummer)}">Lösen</button></div>`;
  } else if (akt.unter.length) {
    inhalt = `<p class="klein">Hauptticket für ${akt.unter.length} Unterticket${akt.unter.length > 1 ? 's' : ''}. Antworten und „Erledigt" können deren Melder mit erreichen.</p>
      <ul class="verknuepft-liste">${akt.unter.map(x => ticketZeile(x,
        `<button class="knopf-link" data-aktion="t-haupt-wechseln" data-nr="${esc(x.nummer)}">Zum Hauptticket machen</button><button class="knopf-link rot" data-aktion="t-loesen" data-nr="${esc(x.nummer)}">Lösen</button>`)).join('')}</ul>
      <div class="knopfzeile"><button class="knopf-link rot" data-aktion="t-loesen" data-nr="${esc(t.nummer)}">Gruppe auflösen</button></div>`;
  } else {
    inhalt = '<p class="leise klein">Nicht mit anderen Tickets verknüpft.</p>';
  }
  return `<div class="karte verknuepfung"><h2>Verknüpfung</h2>${inhalt}
    ${fehlt ? '' : '<button class="knopf klein" data-aktion="t-zusammen">Zusammenführen …</button>'}</div>`;
}

function zeichneVorschlaege() {
  const box = $('#t-vorschlaege');
  if (!box || !akt?.vorschlaege.length || akt.liste.fehlend.includes(FELDER.hauptticket)) { if (box) box.innerHTML = ''; return; }
  box.innerHTML = `<div class="hinweis duplikate"><strong>Mögliche Duplikate:</strong>
    ${akt.vorschlaege.map(v => `<span class="duplikat"><a href="#/t/${esc(v.ticket.nummer)}">${esc(v.ticket.nummer)}</a> ${esc(v.ticket.titel)} <span class="leise klein">(${esc(v.grund)})</span>
      <button class="knopf klein" data-aktion="t-zusammen" data-nr="${esc(v.ticket.nummer)}">Zusammenführen</button></span>`).join('')}</div>`;
}

function antwortFormular(b) {
  if (b) {
    const hatMail = !!akt.ticket.melderMail;
    const n = meineUnter().length;
    return `<form class="antwort" data-absenden="t-antwort">
      <label class="sr" for="t-antwort-text">Antwort</label>
      <textarea id="t-antwort-text" name="text" rows="4" required placeholder="Antwort an den Melder / Kommentar …"></textarea>
      <div class="antwort-fuss">
        <div class="checks">
          <label class="check"><input type="checkbox" name="mail"${hatMail ? ' checked' : ' disabled'}/> Melder per Mail benachrichtigen${hatMail ? '' : ' (keine Adresse)'}</label>
          ${n ? `<label class="check"><input type="checkbox" name="unter" checked/> Auch die Melder der ${n} Unterticket${n > 1 ? 's' : ''} (Nachricht erscheint auch dort)</label>` : ''}
        </div>
        <button class="knopf primaer">Senden</button>
      </div>
    </form>`;
  }
  return `<form class="antwort" data-absenden="t-antwort">
    <label class="sr" for="t-antwort-text">Ihre Antwort</label>
    <textarea id="t-antwort-text" name="text" rows="4" required placeholder="Ihre Antwort oder Ergänzung an das IT-Team …"></textarea>
    <div class="antwort-fuss"><span class="leise klein">Wird per Mail an ${esc(KONFIG.ticketPostfach)} gesendet und erscheint in 1–2 Minuten im Verlauf.</span><button class="knopf primaer">Antworten</button></div>
  </form>`;
}

// ── Verlauf, Notizen, Anhänge ─────────────────────────────────────────────

function eintrag(e, intern = false) {
  const div = document.createElement('div');
  div.className = 'eintrag' + (intern ? ' intern' : '') + (e.mail === meineMail() ? ' eigen' : '') + (e.quelle ? ' fremd' : '');
  div.innerHTML = `<div class="eintrag-kopf">${avatar(e.name, e.mail)}<strong>${esc(e.name)}</strong>${e.quelle ? `<a class="badge st-grau" href="#/t/${esc(e.quelle)}">aus ${esc(e.quelle)}</a>` : ''}<span class="leise klein" title="${esc(datumZeit(e.datum))}">${esc(relativ(e.datum))}</span></div><div class="eintrag-text"></div>`;
  div.querySelector('.eintrag-text').appendChild(textFragment(e.text));
  return div;
}

async function ladeVerlauf() {
  const ziel = $('#t-verlauf');
  if (!ziel) return;
  const nr = akt.ticket.nummer;
  try {
    const eigene = await ladeKommentare(nr);
    // Am Hauptticket auch die Nachrichten der Untertickets – ohne die Spiegelungen vom Hauptticket selbst.
    const aus = await Promise.all(meineUnter().map(x => ladeKommentare(x.nummer)
      .then(ks => ks.filter(k => !k.text.startsWith(`✉ Über Hauptticket ${nr}`)).map(k => ({ ...k, quelle: x.nummer })))
      .catch(() => [])));
    if (akt?.ticket.nummer !== nr) return;
    const alle = [...eigene, ...aus.flat()].sort((a, b) => Date.parse(a.datum) - Date.parse(b.datum));
    ziel.innerHTML = alle.length ? '' : '<p class="leise">Noch keine Nachrichten.</p>';
    alle.forEach(k => ziel.appendChild(eintrag(k)));
  } catch (e) { ziel.innerHTML = `<p class="rot klein">Verlauf nicht verfügbar: ${esc(e.message)}</p>`; }
}

async function ladeNotizListe() {
  const ziel = $('#t-notizen');
  if (!ziel) return;
  const nr = akt.ticket.nummer;
  try {
    const notizen = await ladeNotizen(nr);
    if (akt?.ticket.nummer !== nr) return;
    if (notizen === null) { ziel.innerHTML = '<p class="leise">Für diese Queue ist noch keine Notizliste eingerichtet (Verwaltung → Rechte).</p>'; return; }
    ziel.innerHTML = notizen.length ? '' : '<p class="leise">Keine internen Notizen.</p>';
    notizen.forEach(n => ziel.appendChild(eintrag(n, true)));
  } catch (e) { ziel.innerHTML = `<p class="rot klein">Notizen nicht verfügbar: ${esc(e.message)}</p>`; }
}

async function ladeAnhangListe() {
  const ziel = $('#t-anhaenge');
  if (!ziel) return;
  const nr = akt.ticket.nummer;
  try {
    const liste = await ladeAnhaenge(nr);
    if (akt?.ticket.nummer !== nr) return;
    ziel.innerHTML = liste.length
      ? `<ul class="anhaenge">${liste.map(a => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">📎 ${esc(a.name)}</a>${istBearbeiter() ? `<button class="knopf-link rot" data-aktion="t-anhang-weg" data-name="${esc(a.name)}" aria-label="${esc(a.name)} löschen">entfernen</button>` : ''}</li>`).join('')}</ul>`
      : '<p class="leise">Keine Anhänge.</p>';
  } catch (e) { ziel.innerHTML = `<p class="rot klein">${esc(e.message)}</p>`; }
}

// ── Hilfen ────────────────────────────────────────────────────────────────

function neuZeichnen() {
  zeichne();
  ladeVerlauf();
  ladeAnhangListe();
  ladeNotizListe();
}

/** Ticket neu laden (inkl. Gruppe) und zeichnen – nach Änderungen an der Verknüpfung. */
async function neuLaden() {
  const { ticket, liste } = await ladeTicket(akt.ticket.nummer);
  akt = { ...akt, ticket, liste, vorschlaege: [] };
  await ladeFamilie();
  neuZeichnen();
  ladeVorschlaege();
}

/** Mail senden, Fehler sammeln statt abbrechen (eine fehlende Adresse soll den Rest nicht stoppen). */
async function mailSicher(an, m, warnungen) {
  try { await sendeMail({ an, betreff: m.betreff, html: m.html, antwortAn: KONFIG.ticketPostfach }); return true; }
  catch (e) { warnungen.push(`Mail an ${an}: ${e.message}`); return false; }
}

async function statusFuer(x, status, { text = '', mail = false, hinweis = '', gesendet = new Set(), warnungen = [] } = {}) {
  const l = await ladeFelder(x.kennung);
  const wert = passendeAuswahl(l.auswahl[FELDER.status], status);
  await setzeWerte(x.nummer, { [FELDER.status]: wert }, { status: wert });
  x.status = wert;
  if (text.trim()) await kommentieren(x.nummer, hinweis ? `✉ Über Hauptticket ${akt.ticket.nummer}: ${text.trim()}` : text.trim());
  const an = String(x.melderMail || '').toLowerCase();
  if (mail && an && !gesendet.has(an)) {
    gesendet.add(an);
    await mailSicher(an, mailStatusAnMelder({ nummer: x.nummer, titel: x.titel, status: wert, text, hinweis }), warnungen);
  }
}

const hinweisFuer = x => `Ihr Anliegen (${x.nummer}) wird gemeinsam mit Ticket ${akt.ticket.nummer} bearbeitet.`;

/** Änderungen an „Hauptticket" ausführen – vorher prüfen, ob ich alle betroffenen Tickets bearbeiten darf. */
async function fuehreAus(aenderungen) {
  const verboten = aenderungen.filter(a => !darfBearbeiten(parseTicketNummer(a.nummer)?.kennung));
  if (verboten.length) throw new Error(`Keine Bearbeitungsrechte für ${verboten.map(a => a.nummer).join(', ')} – bitte einen Admin oder das zuständige Team.`);
  for (const a of aenderungen) await setzeHauptticket(a.nummer, a.hauptticket);
}

// ── Aktionen ──────────────────────────────────────────────────────────────

aktion('t-reiter', el => {
  const r = el.dataset.reiter;
  document.querySelectorAll('.reiter-knopf').forEach(k => { const an = k.dataset.reiter === r; k.classList.toggle('aktiv', an); k.setAttribute('aria-selected', String(an)); });
  $('#t-reiter-verlauf').hidden = r !== 'verlauf';
  const intern = $('#t-reiter-intern');
  if (intern) intern.hidden = r !== 'intern';
});

async function abschliessen(status) {
  const t = akt.ticket;
  const unter = meineUnter().filter(x => istOffen(x.status));
  const r = await dialog({
    titel: `${t.nummer} – ${status}`,
    inhalt: `<label class="block">Lösung / Nachricht an den Melder (optional)<textarea name="text" rows="4"></textarea></label>
      <label class="check"><input type="checkbox" name="mail"${t.melderMail ? ' checked' : ' disabled'}/> Melder per Mail informieren</label>
      ${unter.length ? `<label class="check"><input type="checkbox" name="unter" checked/> Die ${unter.length} offenen Untertickets ebenfalls auf „${esc(status)}" setzen und deren Melder informieren</label>` : ''}`,
    knoepfe: [{ wert: 'abbrechen', text: 'Abbrechen' }, { wert: 'ok', text: status === 'Erledigt' ? 'Als erledigt markieren' : 'Speichern', primaer: true }],
  });
  if (r.wert !== 'ok') return false;
  const gesendet = new Set(), warnungen = [];
  const text = r.daten.text || '';
  await statusFuer(t, status, { text, mail: r.daten.mail === 'on', gesendet, warnungen });
  if (r.daten.unter === 'on') {
    for (const x of unter) await statusFuer(x, status, { text: text || `Erledigt über Hauptticket ${t.nummer}.`, mail: true, hinweis: hinweisFuer(x), gesendet, warnungen });
  }
  warnungen.forEach(w => meldung(w, 'fehler'));
  meldung(`${t.nummer}: ${status}${r.daten.unter === 'on' && unter.length ? ` (+ ${unter.length} Untertickets)` : ''}`, 'erfolg');
  return true;
}

aktion('t-status', async el => {
  const neu = el.value;
  if (!istOffen(neu) && istOffen(akt.ticket.status)) {
    if (!(await abschliessen(neu))) { el.value = akt.ticket.status; return; }
  } else {
    await statusFuer(akt.ticket, neu);
    meldung(`Status: ${neu}`, 'erfolg');
  }
  neuZeichnen();
});

aktion('t-prio', async el => {
  await setzeWerte(akt.ticket.nummer, { [FELDER.prio]: el.value }, { prio: normPrio(el.value), prioRoh: el.value });
  akt.ticket.prio = normPrio(el.value); akt.ticket.prioRoh = el.value;
  meldung('Priorität gespeichert', 'erfolg');
  neuZeichnen();
});

aktion('t-erledigt', async () => {
  if (await abschliessen('Erledigt')) neuZeichnen();
});

aktion('t-wieder-oeffnen', async () => {
  await statusFuer(akt.ticket, 'In Bearbeitung');
  neuZeichnen();
});

/** Bearbeiter setzen – am Hauptticket für die ganze Gruppe (bleibt so einheitlich zuständig). */
async function bearbeiterSetzen(neu, mitUnter = true) {
  await setzeBearbeiter(akt.ticket.nummer, neu);
  akt.ticket.bearbeiter = neu;
  if (mitUnter) {
    for (const x of meineUnter().filter(x => darfBearbeiten(x.kennung))) {
      await setzeBearbeiter(x.nummer, neu).catch(e => meldung(`${x.nummer}: ${e.message}`, 'fehler'));
      x.bearbeiter = neu;
    }
  }
}

aktion('t-uebernehmen', async el => beschaeftigt(el, 'Übernehme …', async () => {
  const t = akt.ticket;
  await bearbeiterSetzen([...t.bearbeiter.filter(p => p.mail), { mail: meineMail(), name: meinName() }]);
  if (['Neu', 'Offen'].includes(t.status)) await statusFuer(t, 'In Bearbeitung');
  meldung(`${t.nummer} übernommen`, 'erfolg');
  neuZeichnen();
}));

async function gruppenMitglieder(gruppe) {
  if (!gruppe) return [];
  try {
    const r = await sp(`_api/web/sitegroups/getbyname(${lit(gruppe)})/users?$select=Title,Email`);
    return (r?.value || []).filter(u => u.Email).map(u => ({ name: u.Title, mail: u.Email.toLowerCase() }));
  } catch { return []; }
}

aktion('t-zuweisen', async () => {
  const t = akt.ticket;
  const q = akt.liste.queue;
  const mitglieder = await gruppenMitglieder(q.gruppe);
  const vorschlaege = [...mitglieder, ...q.bearbeiter.map(m => ({ mail: m, name: m }))]
    .filter((p, i, a) => a.findIndex(x => x.mail === p.mail) === i && !t.bearbeiter.some(b => b.mail === p.mail));
  const n = meineUnter().length;
  const r = await dialog({
    titel: `${t.nummer} zuweisen`,
    inhalt: personenwahl('personen', { vorbelegt: t.bearbeiter.filter(p => p.mail).map(p => ({ mail: p.mail, name: p.name })), vorschlaege })
      + '<label class="check"><input type="checkbox" name="mail" checked/> Neu Zugewiesene per Mail informieren</label>'
      + (n ? `<label class="check"><input type="checkbox" name="unter" checked/> Auch für die ${n} Untertickets</label>` : ''),
    knoepfe: [{ wert: 'abbrechen', text: 'Abbrechen' }, { wert: 'ok', text: 'Speichern', primaer: true }],
  });
  if (r.wert !== 'ok') return;
  const neu = leseAuswahl(r.daten.personen);
  const hinzu = neu.filter(p => !t.bearbeiter.some(b => b.mail === p.mail) && p.mail !== meineMail());
  await bearbeiterSetzen(neu, r.daten.unter === 'on');
  if (r.daten.mail === 'on' && hinzu.length) {
    const m = mailZuweisung({ nummer: t.nummer, titel: t.titel, von: meinName() });
    await sendeMail({ an: hinzu.map(p => p.mail), betreff: m.betreff, html: m.html }).catch(e => meldung('Mail: ' + e.message, 'fehler'));
  }
  meldung('Zuweisung gespeichert', 'erfolg');
  neuZeichnen();
});

aktion('t-antwort', async form => {
  const t = akt.ticket;
  const daten = new FormData(form);
  const text = String(daten.get('text') || '').trim();
  if (!text) return;
  const knopf = form.querySelector('button');
  await beschaeftigt(knopf, 'Sende …', async () => {
    if (istBearbeiter()) {
      const mail = daten.get('mail') === 'on' && !!t.melderMail;
      const unter = daten.get('unter') === 'on' ? meineUnter() : [];
      const gesendet = new Set(), warnungen = [];
      await kommentieren(t.nummer, mail || unter.length ? `✉ ${text}` : text);
      if (mail) {
        gesendet.add(t.melderMail);
        await mailSicher(t.melderMail, mailAntwortAnMelder({ nummer: t.nummer, titel: t.titel, text, absender: meinName() }), warnungen);
      }
      // Untertickets: Nachricht im eigenen Verlauf + Mail mit der eigenen Nummer (Antworten landen dort).
      for (const x of unter) {
        await kommentieren(x.nummer, `✉ Über Hauptticket ${t.nummer}: ${text}`).catch(e => warnungen.push(`${x.nummer}: ${e.message}`));
        const an = String(x.melderMail || '').toLowerCase();
        if (an && !gesendet.has(an)) {
          gesendet.add(an);
          await mailSicher(an, mailAntwortAnMelder({ nummer: x.nummer, titel: x.titel, text, absender: meinName(), hinweis: hinweisFuer(x) }), warnungen);
        }
      }
      if (t.status === 'Neu') await statusFuer(t, 'In Bearbeitung');
      warnungen.forEach(w => meldung(w, 'fehler'));
      meldung(gesendet.size ? `Antwort an ${gesendet.size} Melder gesendet` : 'Kommentar gespeichert', 'erfolg');
      neuZeichnen();
    } else {
      const m = mailMelderAntwort({ nummer: t.nummer, titel: t.titel, text });
      await sendeMail({ an: KONFIG.ticketPostfach, betreff: m.betreff, html: m.html });
      form.reset();
      const vorschau = eintrag({ name: meinName(), mail: meineMail(), text: text + '\n\n(wird übermittelt …)', datum: new Date().toISOString() });
      vorschau.classList.add('vorlaeufig');
      $('#t-verlauf').appendChild(vorschau);
      meldung('Antwort gesendet – sie erscheint in 1–2 Minuten im Verlauf.', 'erfolg');
    }
  });
});

aktion('t-notiz', async form => {
  const text = String(new FormData(form).get('text') || '').trim();
  if (!text) return;
  await beschaeftigt(form.querySelector('button'), 'Speichere …', async () => {
    await notieren(akt.ticket.nummer, text);
    form.reset();
    await ladeNotizListe();
  });
});

aktion('t-hochladen', async el => {
  const dateien = [...(el.files || [])];
  for (const d of dateien) {
    if (d.size > 50 * 1024 * 1024) { meldung(`${d.name}: größer als 50 MB`, 'fehler'); continue; }
    await anhangHochladen(akt.ticket.nummer, d);
    meldung(`${d.name} angehängt`, 'erfolg');
  }
  el.value = '';
  ladeAnhangListe();
});

aktion('t-anhang-weg', async el => {
  const r = await dialog({ titel: 'Anhang entfernen?', inhalt: `<p>${esc(el.dataset.name)} wird aus dem Ticket entfernt.</p>`, knoepfe: [{ wert: 'nein', text: 'Abbrechen' }, { wert: 'ja', text: 'Entfernen', gefahr: true }] });
  if (r.wert !== 'ja') return;
  await anhangLoeschen(akt.ticket.nummer, el.dataset.name);
  ladeAnhangListe();
});

// ── Verknüpfung ───────────────────────────────────────────────────────────

aktion('t-zusammen', async el => {
  const t = akt.ticket;
  const vorgabe = el.dataset.nr || '';
  const r = await dialog({
    titel: `${t.nummer} zusammenführen`,
    inhalt: `<p class="leise">Tickets zum selben Thema werden verknüpft: Das <strong>Hauptticket</strong> wird bearbeitet, die <strong>Untertickets</strong> bleiben mit ihrem Melder bestehen. Antworten und „Erledigt" am Hauptticket erreichen auf Wunsch alle Melder.</p>
      <label class="block">Anderes Ticket (Nummer)<input name="nr" value="${esc(vorgabe)}" placeholder="z. B. SCH-12" required pattern="[A-Za-z][A-Za-z0-9]{1,9}-[0-9]{1,9}"/></label>
      ${akt.vorschlaege.length ? `<p class="klein leise">Vorschläge: ${akt.vorschlaege.map(v => esc(v.ticket.nummer)).join(', ')}</p>` : ''}
      <fieldset class="block"><legend>Welches wird Hauptticket?</legend>
        <label class="check"><input type="radio" name="richtung" value="anderes" checked/> Das andere Ticket – ${esc(t.nummer)} wird Unterticket</label>
        <label class="check"><input type="radio" name="richtung" value="dieses"/> ${esc(t.nummer)} – das andere wird Unterticket</label>
      </fieldset>
      <label class="check"><input type="checkbox" name="mail" checked/> Melder des Untertickets informieren</label>`,
    knoepfe: [{ wert: 'abbrechen', text: 'Abbrechen' }, { wert: 'ok', text: 'Zusammenführen', primaer: true }],
  });
  if (r.wert !== 'ok') return;
  const nr = String(r.daten.nr || '').trim().toUpperCase();
  if (!parseTicketNummer(nr)) throw new Error('Bitte eine Ticketnummer wie SCH-12 angeben.');
  const anderes = await ladeTicketKurz(nr);
  if (!anderes) throw new Error(`Ticket ${nr} gibt es nicht, oder du hast keinen Zugriff darauf.`);
  const [unter, haupt] = r.daten.richtung === 'dieses' ? [anderes, t] : [t, anderes];
  // Untertickets beider Seiten kennen, damit sie mitwandern
  const bekannt = [t, anderes, ...(await ladeUntertickets(unter.nummer)), ...(await ladeUntertickets(haupt.hauptticket || haupt.nummer))];
  const plan = planZusammenfuehren(unter, haupt, bekannt);
  if (!await bestaetigen('Zusammenführen?', `${plan.aenderungen.map(a => a.nummer).join(', ')} ${plan.aenderungen.length > 1 ? 'werden Untertickets' : 'wird Unterticket'} von ${plan.haupt}.`, { ja: 'Zusammenführen' })) return;
  await fuehreAus(plan.aenderungen);
  const hauptTicket = bekannt.find(x => x.nummer === plan.haupt) || await ladeTicketKurz(plan.haupt);
  const warnungen = [];
  for (const a of plan.aenderungen) {
    const x = bekannt.find(y => y.nummer === a.nummer);
    await kommentieren(a.nummer, `🔗 Zusammengeführt mit Hauptticket ${plan.haupt} (${meinName()}).`).catch(e => warnungen.push(e.message));
    // Zuständigkeit vom Hauptticket übernehmen
    if (hauptTicket?.bearbeiter.length && darfBearbeiten(parseTicketNummer(a.nummer).kennung)) await setzeBearbeiter(a.nummer, hauptTicket.bearbeiter).catch(e => warnungen.push(e.message));
    if (r.daten.mail === 'on' && x?.melderMail && x.melderMail !== hauptTicket?.melderMail) {
      await mailSicher(x.melderMail, mailZusammengefuehrt({ nummer: x.nummer, titel: x.titel, haupt: plan.haupt }), warnungen);
    }
  }
  await kommentieren(plan.haupt, `🔗 Untertickets ergänzt: ${plan.aenderungen.map(a => a.nummer).join(', ')} (${meinName()}).`).catch(e => warnungen.push(e.message));
  warnungen.forEach(w => meldung(w, 'fehler'));
  meldung(`Zusammengeführt – Hauptticket ${plan.haupt}`, 'erfolg');
  if (plan.haupt !== t.nummer) location.hash = '#/t/' + plan.haupt; else await neuLaden();
});

aktion('t-haupt-wechseln', async el => {
  const nr = el.dataset.nr;
  const neu = nr === akt.ticket.nummer ? akt.ticket : akt.unter.find(x => x.nummer === nr);
  if (!neu) return;
  const hauptNr = neu.hauptticket;
  const familie = [akt.ticket, ...akt.unter, ...(akt.haupt ? [akt.haupt] : [])];
  const plan = planHauptWechseln(neu, familie);
  if (!await bestaetigen('Hauptticket wechseln?', `${nr} wird Hauptticket; ${hauptNr} und die übrigen Untertickets hängen sich darunter.`, { ja: 'Wechseln' })) return;
  await fuehreAus(plan.aenderungen);
  await kommentieren(nr, `🔗 Ist jetzt Hauptticket (vorher ${hauptNr}) – ${meinName()}.`).catch(() => {});
  await kommentieren(hauptNr, `🔗 Hauptticket gewechselt zu ${nr} – ${meinName()}.`).catch(() => {});
  meldung(`${nr} ist jetzt Hauptticket`, 'erfolg');
  if (nr !== akt.ticket.nummer) location.hash = '#/t/' + nr; else await neuLaden();
});

aktion('t-loesen', async el => {
  const nr = el.dataset.nr;
  const x = nr === akt.ticket.nummer ? akt.ticket : akt.unter.find(y => y.nummer === nr);
  if (!x) return;
  const plan = planLoesen(x, [akt.ticket, ...akt.unter]);
  const gruppe = !x.hauptticket;
  if (!await bestaetigen(gruppe ? 'Gruppe auflösen?' : 'Verknüpfung lösen?',
    gruppe ? `Alle ${plan.aenderungen.length} Untertickets werden wieder eigenständig.` : `${nr} wird wieder ein eigenständiges Ticket.`, { ja: 'Lösen' })) return;
  await fuehreAus(plan.aenderungen);
  for (const a of plan.aenderungen) await kommentieren(a.nummer, `🔗 Verknüpfung gelöst (${meinName()}).`).catch(() => {});
  meldung('Verknüpfung gelöst', 'erfolg');
  await neuLaden();
});

// ── Übergabe an eine andere Queue ─────────────────────────────────────────

aktion('t-weiterleiten', async () => {
  const t = akt.ticket;
  const quelle = akt.liste.queue;
  const ziele = uebergabeZiele(quelle.kennung);
  if (!ziele.length) {
    await dialog({ titel: 'Andere Queue', inhalt: '<p>Es gibt keine Queue, an die du übergeben darfst. Ein Admin kann die Übergabe-Rechte unter Verwaltung → Rechte & Einrichtung („Abgleichen") vergeben.</p>' });
    return;
  }
  const r = await dialog({
    titel: `${t.nummer} an andere Queue übergeben`,
    inhalt: `<p>Das Ticket wird mit Verlauf und Anhängen in die Ziel-Queue kopiert und bekommt dort eine neue Nummer. Hier bleibt es als „Weitergeleitet" mit Verweis stehen.</p>
      <label class="block">Ziel-Queue<select name="ziel">${ziele.map(l => `<option value="${esc(l.queue.kennung)}">${esc(l.queue.name)} (${esc(l.queue.kennung)})${['bearbeiter', 'admin'].includes(l.rolle) ? '' : ' – Übergabe'}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="mail"${t.melderMail ? ' checked' : ' disabled'}/> Melder über die neue Nummer informieren</label>`,
    knoepfe: [{ wert: 'abbrechen', text: 'Abbrechen' }, { wert: 'ok', text: 'Übergeben', primaer: true }],
  });
  if (r.wert !== 'ok') return;
  const ziel = listeVon(r.daten.ziel);
  await ladeFelder(ziel.queue.kennung);
  meldung('Kopiere Ticket …', 'info');
  const extra = {};
  if (ziel.queue.kategorie && ziel.felder?.kategorie) extra[ziel.felder.kategorie] = ziel.queue.kategorie;
  const { id, warnungen } = await kopiereTicket(
    { listId: quelle.listId, id: t.id, listenName: quelle.liste },
    { listId: ziel.queue.listId, listenName: ziel.queue.liste, kennung: ziel.queue.kennung },
    { werk: ziel.queue.werk || t.werk, status: passendeAuswahl(ziel.auswahl[FELDER.status], 'Neu'), hinweis: `Übergeben aus ${t.nummer} (${quelle.name}) von ${meinName()}.`, extra },
  );
  const neueNr = ticketNummer(ziel.queue.kennung, id);
  const weiter = (akt.liste.auswahl[FELDER.status] || []).includes('Weitergeleitet') ? 'Weitergeleitet' : passendeAuswahl(akt.liste.auswahl[FELDER.status], 'Abgebrochen');
  await setzeWerte(t.nummer, { [FELDER.status]: weiter }, { status: weiter });
  await kommentieren(t.nummer, `→ Übergeben an ${neueNr} (${ziel.queue.name}) von ${meinName()}.`);
  // Verknüpfung geht mit: Das alte Ticket verlässt die Gruppe, das neue übernimmt seinen Platz.
  if (t.hauptticket) await setzeHauptticket(t.nummer, '').catch(e => warnungen.push(e.message));
  if (meineUnter().length) {
    await fuehreAus(meineUnter().map(x => ({ nummer: x.nummer, hauptticket: neueNr })))
      .catch(e => warnungen.push(`Untertickets bleiben bei ${t.nummer}: ${e.message}`));
  }
  if (r.daten.mail === 'on' && t.melderMail) {
    const m = mailStatusAnMelder({ nummer: neueNr, titel: t.titel, status: 'Neu', text: `Ihr Ticket ${t.nummer} wird jetzt von ${ziel.queue.name} bearbeitet. Neue Ticketnummer: ${neueNr}.` });
    await sendeMail({ an: t.melderMail, betreff: m.betreff, html: m.html, antwortAn: KONFIG.ticketPostfach }).catch(e => meldung('Mail: ' + e.message, 'fehler'));
  }
  zustand.tickets.delete(ziel.queue.kennung);
  zustand.tickets.delete(quelle.kennung);
  warnungen.forEach(w => meldung(w, 'fehler'));
  meldung(`Übergeben: ${neueNr}`, 'erfolg');
  // In einer fremden Queue sehe ich das neue Ticket nicht (nur eigene Elemente) – dann hier bleiben.
  if (darfBearbeiten(ziel.queue.kennung)) location.hash = '#/t/' + neueNr; else await neuLaden();
});
