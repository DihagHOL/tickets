import { ok, gleich, ende } from './_pruef.mjs';
import * as M from '../js/modell.js';
import { KONFIG } from '../js/config.js';

// ── Nummern & Betreff ──
gleich(M.parseTicketNummer('sch-12'), { kennung: 'SCH', id: 12 }, 'Nummer: Kleinschreibung wird akzeptiert');
gleich(M.parseTicketNummer('SCH-'), null, 'Nummer: ohne ID → null');
gleich(M.parseTicketNummer('1AB-3'), null, 'Nummer: Kennung muss mit Buchstaben beginnen');
gleich(M.parseTicketNummer("SCH-1' or 1=1"), null, 'Nummer: Anhängsel → null');
gleich(M.tokenAusBetreff('AW: [#SCH-12] Eingangsbestätigung: Drucker'), 'SCH-12', 'Token aus Antwort');
gleich(M.tokenAusBetreff('WG: AW: [#ewa-3] x'), 'EWA-3', 'Token: Kleinschreibung → groß');
gleich(M.tokenAusBetreff('AW: Neues Ticket: 1234 (Drucker)'), 'ALT-1234', 'Token: alte Eingangsbestätigung → Archiv');
gleich(M.tokenAusBetreff('Neues Ticket: 99 (x)', 'ARCH'), 'ARCH-99', 'Token: Archiv-Kennung einstellbar');
gleich(M.tokenAusBetreff('Drucker [#] kaputt'), '', 'Token: nichts erkennbar → leer');
gleich(M.tokenAusBetreff(null), '', 'Token: null → leer');
gleich(M.betreffMitToken('SCH-12', 'AW: [#SCH-12] Drucker'), '[#SCH-12] AW: Drucker', 'Betreff: Token nicht doppelt');
gleich(M.betreffMitToken('SCH-12', ''), '[#SCH-12]', 'Betreff: leer');

// ── Adressen & Routing ──
gleich(M.domainAus('Max <MAX@Schmie-Guss.de>'), 'schmie-guss.de', 'Domain aus Adresse mit Namen');
gleich(M.domainAus('keinemail'), '', 'Domain: ohne @ leer');
gleich(M.domainsAusText('schmie-guss.de, @SHB-guss.de\n\nfoo;bar.de'), ['schmie-guss.de', 'shb-guss.de', 'bar.de'], 'Domains: Trenner, @, ungültige raus');
gleich(M.mailsAusText('a@x.de; B@x.de, a@x.de kaputt@'), ['a@x.de', 'b@x.de'], 'Mails: normalisiert, ohne Dubletten');
gleich(M.claimFuerMail(' Max@DIHAG.com '), 'i:0#.f|membership|max@dihag.com', 'Claim für Mail');
gleich(M.mailAusLogin('i:0#.f|membership|max@dihag.com'), 'max@dihag.com', 'Mail aus Claim');
gleich(M.mailAusLogin('Tickets SCH – Bearbeiter'), '', 'Mail aus Gruppenname: leer');

const q = (kennung, extra = {}) => ({ ...M.queueAusFeldern({ Title: kennung, Kennung: kennung, ListenName: 'Tickets-' + kennung }), ...extra });
const queues = [
  q('SCH', { domains: ['schmie-guss.de'] }),
  q('DIHAG', { domains: ['dihag.com'], standard: true }),
  q('GIE', { domains: ['gienanth.com'], modus: 'Hinweis', hinweis: 'x' }),
  q('ALT', { modus: 'Archiv', domains: ['alt.de'] }),
  q('AUS', { domains: ['aus.de'], aktiv: false }),
];
gleich(M.queueFuerAbsender(queues, 'x@schmie-guss.de')?.kennung, 'SCH', 'Routing: exakte Domain');
gleich(M.queueFuerAbsender(queues, 'x@unbekannt.de')?.kennung, 'DIHAG', 'Routing: unbekannt → Standard');
gleich(M.queueFuerAbsender(queues, 'x@gienanth.com')?.kennung, 'GIE', 'Routing: Hinweis-Queue wird gefunden');
gleich(M.queueFuerAbsender(queues, 'x@alt.de')?.kennung, 'DIHAG', 'Routing: Archiv nimmt nie neue Tickets');
gleich(M.queueFuerAbsender(queues, 'x@aus.de')?.kennung, 'DIHAG', 'Routing: inaktive Queue wird übergangen');
gleich(M.queueFuerAbsender(queues, 'x@sub.schmie-guss.de')?.kennung, 'DIHAG', 'Routing: Subdomain ist kein Treffer (bewusst exakt)');
gleich(M.queueFuerAbsender([], 'x@y.de'), null, 'Routing: ohne Queues null');

// ── Konfiguration ──
const zeile = { id: '7', fields: { Title: 'Schmiedeguss', Kennung: 'sch', ListenName: 'Tickets-SCH', ListenId: '{ABCDEF01-2345-6789-ABCD-EF0123456789}', Domains: 'schmie-guss.de;x.de', Bearbeiter: 'a@dihag.com;b@dihag.com', Modus: 'Ticket', Standard: false } };
const qa = M.queueAusFeldern(zeile);
gleich([qa.itemId, qa.kennung, qa.listId, qa.domains, qa.bearbeiter, qa.aktiv], [7, 'SCH', 'abcdef01-2345-6789-abcd-ef0123456789', ['schmie-guss.de', 'x.de'], ['a@dihag.com', 'b@dihag.com'], true], 'Konfig-Zeile → Queue (aktiv ohne Wert = an)');
gleich(M.queueAusFeldern({ fields: { Modus: 'Quatsch', Aktiv: false } }).modus, 'Ticket', 'Unbekannter Modus → Ticket');
gleich(M.queueAusFeldern({ fields: { ListenId: 'kein-guid' } }).listId, '', 'Ungültige Listen-ID → leer');
const felder = M.queueZuFeldern({ ...qa, domains: ['A.de', 'b.de'], bearbeiter: 'x@y.de, kaputt' });
gleich([felder.Domains, felder.Bearbeiter, felder.Aktiv], ['a.de;b.de', 'x@y.de', true], 'Queue → Felder (so liest der Flow)');
gleich(M.standardNamen('ewa'), { liste: 'Tickets-EWA', gruppe: 'Tickets EWA – Bearbeiter' }, 'Standardnamen');

const pr = M.pruefeQueues([
  { ...q('SCH'), domains: ['a.de'], gruppe: 'G', listId: 'x' },
  { ...q('SCH'), domains: ['a.de'], gruppe: 'G', listId: 'x' },
  { ...q('x'), gruppe: '' },
]);
ok(pr.some(m => m.schwere === 'fehler' && /doppelt/.test(m.text)), 'Prüfung: doppelte Kennung');
ok(pr.some(m => m.schwere === 'fehler' && /a\.de/.test(m.text)), 'Prüfung: doppelte Domain');
ok(pr.some(m => m.schwere === 'fehler' && /Kennung:/.test(m.text)), 'Prüfung: ungültige Kennung');
ok(pr.some(m => /Standard-Queue/.test(m.text)), 'Prüfung: fehlende Standard-Queue als Hinweis');
const pr2 = M.pruefeQueues([{ ...q('A1'), standard: true, gruppe: 'G', listId: 'x' }, { ...q('B1'), standard: true, gruppe: 'G', listId: 'x' }]);
ok(pr2.some(m => /Mehr als eine Standard/.test(m.text)), 'Prüfung: zwei Standard-Queues');
ok(M.pruefeQueues([{ ...q('HIN'), modus: 'Hinweis', hinweis: '' }]).some(m => /Hinweistext/.test(m.text)), 'Prüfung: Hinweis ohne Text');

// ── Rechte ──
const lesen = { High: '176', Low: '138612833' };
ok(M.hatRecht(lesen, M.RECHT.ansehen) && !M.hatRecht(lesen, M.RECHT.bearbeiten), 'Maske Lesen: ansehen ja, bearbeiten nein');
ok(M.hatRecht({ High: '0', Low: String(2 ** 31) }, 32), 'Bit 32 ohne Vorzeichenfehler');
ok(M.hatRecht({ High: String(2 ** 4), Low: '0' }, 37), 'High-Teil (Recht 37)');
gleich(M.rolleAusRechten(lesen), 'melder', 'Rolle: Lesen → Melder');
gleich(M.rolleAusRechten({ High: '2147483647', Low: '4294967295' }), 'admin', 'Rolle: Vollzugriff → Admin');
gleich(M.rolleAusRechten(null), 'keine', 'Rolle: keine Maske');
const mitwirken = { High: '432', Low: String(1 + 2 + 4 + 8 + 32 + 64 + 128 + 512 + 4096) };
const bearb = M.bearbeitungsMaske(mitwirken);
ok(M.hatRecht(bearb, M.RECHT.ueberschreiben), 'Stufe Bearbeitung: überschreibt Listenverhalten');
ok(!M.hatRecht(bearb, M.RECHT.loeschen) && !M.hatRecht(bearb, M.RECHT.versionenLoeschen), 'Stufe Bearbeitung: kein Löschen');
ok(M.hatRecht(bearb, M.RECHT.bearbeiten) && M.hatRecht(bearb, M.RECHT.hinzufuegen), 'Stufe Bearbeitung: bearbeiten + hinzufügen bleibt');
gleich(M.rolleAusRechten(bearb), 'bearbeiter', 'Rolle aus Stufe Bearbeitung → Bearbeiter');
gleich(M.bearbeitungsMaske(bearb), bearb, 'Stufe Bearbeitung: idempotent');

const ctx = {
  ownerGruppe: 'Ticket – Besitzer', dienstkonto: 'ticket@dihag.com',
  melderClaim: KONFIG.melderClaim, melderAnzeige: 'Jeder', stufeBearbeitung: 'Ticket-Bearbeitung',
  queues: [{ ...q('SCH'), gruppe: 'Tickets SCH – Bearbeiter' }, { ...q('SHB'), gruppe: 'Tickets SHB – Bearbeiter' }, { ...q('X'), gruppe: 'G-X', aktiv: false }],
};
const sollSch = M.sollRechte({ ...q('SCH'), gruppe: 'Tickets SCH – Bearbeiter' }, ctx);
gleich(sollSch.map(s => `${s.wert}=${s.rolle.anzeige}`), [
  'Ticket – Besitzer=Vollzugriff', 'i:0#.f|membership|ticket@dihag.com=Vollzugriff',
  'Tickets SCH – Bearbeiter=Ticket-Bearbeitung', 'Tickets SHB – Bearbeiter=Mitwirken', `${KONFIG.melderClaim}=Lesen`,
], 'Soll-Rechte Queue-Liste (inkl. Übergabe aus aktiven anderen Queues, nicht aus inaktiven)');
gleich(M.sollRechte({ ...q('SCH'), gruppe: 'Tickets SCH – Bearbeiter' }, { ...ctx, uebergabe: false }).length, 4, 'Übergabe abschaltbar');
gleich(M.sollRechte({ ...q('SCH'), gruppe: 'G' }, ctx, 'notizen').some(s => s.rolle.typ === 3), false, 'Notizliste: keine Übergabe-Rechte');
gleich(M.sollRechte({ ...q('SCH'), gruppe: 'G' }, ctx, 'notizen').some(s => s.rolle.typ === 2), false, 'Notizliste: keine Melder');
gleich(M.sollRechte({ ...q('SCH'), gruppe: 'G' }, { ...ctx, melderSehen: false, uebergabe: false }).length, 3, 'Melder abschaltbar');
gleich(M.sollRechte({ ...q('ALT'), modus: 'Archiv', gruppe: '*' }, ctx).map(s => s.wert).slice(2), ['Tickets SCH – Bearbeiter', 'Tickets SHB – Bearbeiter'], 'Archiv „*": alle aktiven Bearbeiter-Gruppen, keine Melder');
gleich(M.sollRechte({ ...q('ALT'), modus: 'Archiv', gruppe: '' }, ctx).length, 2, 'Archiv leer: nur Admins + Flow-Konto');
gleich(M.sollRechte({ ...q('GIE'), modus: 'Hinweis' }, ctx), [], 'Hinweis-Queue: keine Liste, kein Soll');

const ist = M.istAusRollenzuweisungen([
  { PrincipalId: 3, Member: { Id: 3, LoginName: 'Ticket – Besitzer', Title: 'Ticket – Besitzer', PrincipalType: 8 }, RoleDefinitionBindings: [{ Id: 1073741829, Name: 'Vollzugriff', RoleTypeKind: 5 }] },
  { PrincipalId: 9, Member: { Id: 9, LoginName: 'Tickets SCH – Bearbeiter', Title: 'Tickets SCH – Bearbeiter', PrincipalType: 8 }, RoleDefinitionBindings: [{ Id: 1100, Name: 'ticket-bearbeitung', RoleTypeKind: 0 }, { Id: 1073741827, Name: 'Mitwirken', RoleTypeKind: 3 }] },
  { PrincipalId: 4, Member: { Id: 4, LoginName: 'Ticket – Mitglieder', Title: 'Ticket – Mitglieder', PrincipalType: 8 }, RoleDefinitionBindings: { results: [{ Id: 1073741827, Name: 'Bearbeiten', RoleTypeKind: 6 }] } },
  { PrincipalId: 12, Member: { Id: 12, LoginName: 'i:0#.f|membership|x@dihag.com', Title: 'X', PrincipalType: 1 }, RoleDefinitionBindings: [{ Id: 1073741825, Name: 'Beschränkter Zugriff', RoleTypeKind: 1 }] },
]);
const ab = M.rechteAbgleich(sollSch, ist);
gleich(ab.ok.map(s => s.wert), ['Ticket – Besitzer', 'Tickets SCH – Bearbeiter'], 'Abgleich: vorhandene Soll-Rechte (Name ohne Groß/klein)');
gleich(ab.fehlt.map(s => s.wert), ['i:0#.f|membership|ticket@dihag.com', 'Tickets SHB – Bearbeiter', KONFIG.melderClaim], 'Abgleich: fehlende Rechte');
gleich(ab.zuviel.map(z => `${z.titel}/${z.rolle.name}`), ['Tickets SCH – Bearbeiter/Mitwirken', 'Ticket – Mitglieder/Bearbeiten'], 'Abgleich: zu viel (beschränkter Zugriff zählt nicht)');
const konfSoll = M.sollKonfigRechte(ctx);
gleich(konfSoll.map(s => `${s.anzeige}=${s.rolle.anzeige}`), ['Ticket – Besitzer=Vollzugriff', 'ticket@dihag.com=Lesen', 'Jeder=Lesen'], 'Konfigurationsliste: alle lesen, nur Admins ändern');
ok(!konfSoll.some(s => s.rolle.typ === 5 && s.art === 'login'), 'Konfigurationsliste: niemand außer Admins mit Vollzugriff');
gleich(M.einstellungsAbgleich({ ReadSecurity: 1, NoCrawl: true }, { ReadSecurity: 2, NoCrawl: true }), [{ feld: 'ReadSecurity', ist: 1, soll: 2 }], 'Einstellungs-Abgleich');

// ── Tickets ──
gleich(['high', '(1) Hoch', 'Mittel', 'low', 'Critical', ''].map(M.normPrio), ['Hoch', 'Hoch', 'Normal', 'Niedrig', 'Kritisch', ''], 'Priorität vereinheitlichen');
gleich(['high', 'LOW', 'normal', undefined].map(M.prioAusWichtigkeit), ['Hoch', 'Niedrig', 'Normal', 'Normal'], 'Priorität aus Mail-Wichtigkeit');
gleich(M.passendeAuswahl(['(1) Hoch', '(2) Normal'], 'Hoch', M.normPrio), '(1) Hoch', 'Passender Auswahlwert');
gleich(M.passendeAuswahl(['A'], 'B'), 'B', 'Kein Auswahltreffer → Wert bleibt');

const qSch = { ...q('SCH') };
const t = M.ticketAusSp({
  Id: 12, Title: 'Drucker', Status: 'Neu', Priority: 'high', Werk: 'SCH',
  Assignedto0: [{ Id: 5, Title: 'Henry Quinque', EMail: 'Henry.Quinque@dihag.com' }],
  Issueloggedby: { Id: 8, Title: 'Max M', EMail: 'max@schmie-guss.de' },
  E_x002d_Mail_x002d_Adresse: 'Max@Schmie-Guss.de', Author: { Title: 'Ticket', EMail: 'ticket@dihag.com' },
  Created: '2026-09-20T08:00:00Z', Modified: '2026-09-21T08:00:00Z', DateReported: '2026-09-20T07:59:00Z', Attachments: true, Kategorie: 'Hardware',
}, qSch, { kategorie: 'Kategorie' });
gleich([t.nummer, t.prio, t.bearbeiter[0].mail, t.melderMail, t.kategorie, t.anhaenge], ['SCH-12', 'Hoch', 'henry.quinque@dihag.com', 'max@schmie-guss.de', 'Hardware', true], 'Ticket aus SharePoint');
const leer = M.ticketAusSp({ Id: 1, Assignedto0: { results: [] }, Issueloggedby: null }, qSch);
gleich([leer.bearbeiter, leer.melder, leer.titel], [[], null, ''], 'Ticket ohne Personen');
ok(M.istMeineAnfrage(t, 'MAX@schmie-guss.de'), 'Meine Anfrage über Melder-Mail');
ok(M.istMirZugewiesen(t, 'henry.quinque@dihag.com'), 'Mir zugewiesen');

const jetzt = new Date('2026-09-25T12:00:00Z');
const mk = (id, extra) => ({ ...leer, id, nummer: 'SCH-' + id, prio: 'Normal', status: 'Neu', gemeldetAm: '2026-09-25T10:00:00Z', geaendert: '2026-09-25T10:00:00Z', bearbeiter: [], ...extra });
ok(!M.istUeberfaellig(mk(1), jetzt), 'SLA: frisches Ticket nicht überfällig');
ok(M.istUeberfaellig(mk(2, { prio: 'Kritisch', gemeldetAm: '2026-09-25T07:00:00Z' }), jetzt), 'SLA: Kritisch nach 5 Std. überfällig');
ok(!M.istUeberfaellig(mk(3, { prio: 'Kritisch', gemeldetAm: '2026-09-01T00:00:00Z', status: 'Warten auf Rückmeldung' }), jetzt), 'SLA: Wartend zählt nicht');
ok(!M.istUeberfaellig(mk(4, { gemeldetAm: '2026-01-01T00:00:00Z', status: 'Erledigt' }), jetzt), 'SLA: Erledigt zählt nicht');
ok(M.istOffen('Unbekannter Status'), 'Unbekannter Status gilt als offen');

const liste = [
  mk(1, { titel: 'Drucker kaputt', bearbeiter: [{ name: 'A', mail: 'a@x.de' }] }),
  mk(2, { titel: 'VPN', status: 'Erledigt', prio: 'Hoch' }),
  mk(3, { titel: 'Drucker Toner', prio: 'Kritisch', gemeldetAm: '2026-09-24T00:00:00Z' }),
];
gleich(M.filtereTickets(liste, { status: 'offen' }).map(x => x.id), [1, 3], 'Filter: offen');
gleich(M.filtereTickets(liste, { suche: 'drucker toner' }).map(x => x.id), [3], 'Filter: Suche mit mehreren Wörtern');
gleich(M.filtereTickets(liste, { suche: 'sch-2' }).map(x => x.id), [2], 'Filter: Suche nach Nummer');
gleich(M.filtereTickets(liste, { zuweisung: 'ich' }, 'A@x.de').map(x => x.id), [1], 'Filter: mir zugewiesen');
gleich(M.filtereTickets(liste, { zuweisung: 'keiner' }).map(x => x.id), [2, 3], 'Filter: nicht zugewiesen');
gleich(M.filtereTickets(liste, { ueberfaellig: true }, '', jetzt).map(x => x.id), [3], 'Filter: überfällig');
gleich(M.sortiereTickets(liste, 'prio').map(x => x.id), [3, 2, 1], 'Sortierung nach Priorität');
gleich(M.sortiereTickets(liste).map(x => x.id), [2, 1, 3], 'Sortierung: neueste Meldung zuerst (gleiche Zeit → höhere ID)');

const kz = M.kennzahlen(liste, jetzt);
gleich([kz.offen, kz.unzugewiesen, kz.ueberfaellig, kz.erledigt30], [2, 1, 1, 1], 'Kennzahlen');
const verlauf = M.verlaufNachWoche(liste, 2, jetzt);
gleich(verlauf.length, 2, 'Verlauf: Anzahl Wochen');
gleich(verlauf[1].eingang, 3, 'Verlauf: Eingang aktuelle Woche');
gleich(M.kalenderwoche(new Date('2026-09-25T12:00:00')), 39, 'Kalenderwoche');
gleich(M.zaehleNach(liste, x => x.prio), [{ wert: 'Hoch', anzahl: 1 }, { wert: 'Kritisch', anzahl: 1 }, { wert: 'Normal', anzahl: 1 }], 'Zählen nach Priorität');

// ── Stichwort-Routing (SAP) ──
const mitSap = [
  ...queues,
  { ...q('SAP'), stichwoerter: ['SAP', 'S/4HANA'], reihenfolge: 5 },
  { ...q('SAPSCH'), stichwoerter: ['SAP'], domains: ['schmie-guss.de'], reihenfolge: 6 },
];
gleich(M.queueFuerAbsender(mitSap, 'x@dihag.com', 'SAP: Berechtigung Einkauf')?.kennung, 'SAP', 'SAP-Stichwort schlägt Domain');
gleich(M.queueFuerAbsender(mitSap, 'x@schmie-guss.de', 'AW: sap Transaktion')?.kennung, 'SAPSCH', 'Stichwort + Domain vor Stichwort allein (Groß/klein egal)');
gleich(M.queueFuerAbsender(mitSap, 'x@unbekannt.de', 'Problem mit S/4HANA')?.kennung, 'SAP', 'zweites Stichwort');
gleich(M.queueFuerAbsender(mitSap, 'x@schmie-guss.de', 'Drucker')?.kennung, 'SCH', 'ohne Stichwort: Werk nach Domain');
gleich(M.queueFuerAbsender(mitSap, 'x@schmie-guss.de')?.kennung, 'SCH', 'ohne Betreff wie bisher');
gleich(M.stichwoerterAusText('SAP; S/4HANA\nsap, Fiori'), ['SAP', 'S/4HANA', 'Fiori'], 'Stichwörter: Trenner, ohne Dubletten');
gleich(M.queueZuFeldern({ ...q('SAP'), stichwoerter: ['SAP', 'Fiori'], farbe: '#0070F2', kategorie: 'SAP' }).Stichwoerter, 'SAP;Fiori', 'Stichwörter → Feld');
gleich(M.queueAusFeldern({ fields: { Farbe: 'red;background:url(x)' } }).farbe, '', 'Farbe nur als #RRGGBB (landet in style-Attributen)');
ok(!M.pruefeQueues([{ ...q('SCH'), domains: ['a.de'], gruppe: 'G', listId: 'x' }, { ...q('SAP'), stichwoerter: ['SAP'], domains: ['a.de'], gruppe: 'G', listId: 'x' }]).some(b => b.schwere === 'fehler'), 'Stichwort-Queue darf Domain mit Werk-Queue teilen');

// ── Ticketnummer im Betreff ohne Klammern ──
const kenn = ['SCH', 'SHB', 'SAP', 'ALT'];
gleich(M.tokenAusBetreff('Bezug SCH-12: Drucker', 'ALT', kenn), 'SCH-12', 'Nummer ohne Klammern erkannt');
gleich(M.tokenAusBetreff('(sap-7) noch offen?', 'ALT', kenn), 'SAP-7', 'in Klammern, Kleinschreibung');
gleich(M.tokenAusBetreff('COVID-19 Regeln', 'ALT', kenn), '', 'unbekannte Kennung ignoriert');
gleich(M.tokenAusBetreff('SCH-12-3 Teil', 'ALT', kenn), '', 'kein Treffer bei zwei Bindestrichen');
gleich(M.tokenAusBetreff('SCH-12a', 'ALT', kenn), '', 'kein Treffer bei Buchstaben in der Nummer');
gleich(M.tokenAusBetreff('[#SHB-2] Re: SCH-12', 'ALT', kenn), 'SHB-2', 'Klammer-Token hat Vorrang');
gleich(M.tokenAusBetreff('Bezug SCH-12'), '', 'ohne Kennungsliste nur Klammer-Token (wie bisher)');
gleich(M.betreffWoerter('AW: [#SCH-1] (Test), ok!'), ['AW', 'SCH-1', 'TEST', 'OK'], 'Betreff → Wörter');
gleich(M.nummernImText('Siehe SCH-012 und sap-7, nicht XYZ-1. Neues Ticket: 99', kenn), ['SCH-12', 'SAP-7', 'ALT-99'], 'Nummern im Text');
gleich(M.nummernImText('ASCH-12 SCH-123456789012'), [], 'keine Teiltreffer, keine überlangen Nummern');

// ── Haupt-/Untertickets ──
const fam = [
  mk(10, { nummer: 'SCH-10', melderMail: 'a@x.de' }),
  mk(11, { nummer: 'SCH-11', hauptticket: 'SCH-10', melderMail: 'b@x.de' }),
  mk(12, { nummer: 'SCH-12', hauptticket: 'SCH-10', melderMail: 'a@x.de' }),
  mk(13, { nummer: 'SCH-13', melderMail: 'c@x.de' }),
  mk(14, { nummer: 'SCH-14', hauptticket: 'SCH-13', melderMail: 'd@x.de' }),
];
const nr = n => fam.find(x => x.nummer === n);
gleich(M.untertickets('SCH-10', fam).map(x => x.nummer), ['SCH-11', 'SCH-12'], 'Untertickets');
gleich(M.planZusammenfuehren(nr('SCH-13'), nr('SCH-10'), fam), { haupt: 'SCH-10', aenderungen: [{ nummer: 'SCH-13', hauptticket: 'SCH-10' }, { nummer: 'SCH-14', hauptticket: 'SCH-10' }] }, 'Zusammenführen: Untertickets wandern mit (eine Ebene)');
gleich(M.planZusammenfuehren(nr('SCH-13'), nr('SCH-11'), fam).haupt, 'SCH-10', 'Ziel ist ein Unterticket → dessen Hauptticket');
let fehlerText = '';
try { M.planZusammenfuehren(nr('SCH-10'), nr('SCH-11'), fam); } catch (e) { fehlerText = e.message; }
ok(/bereits Unterticket/.test(fehlerText), 'kein Kreis: Hauptticket nicht unter eigenes Unterticket');
try { M.planZusammenfuehren(nr('SCH-11'), nr('SCH-10'), fam); fehlerText = ''; } catch (e) { fehlerText = e.message; }
ok(/bereits Unterticket/.test(fehlerText), 'schon verknüpft → Fehler');
gleich(M.planHauptWechseln(nr('SCH-12'), fam), { haupt: 'SCH-12', aenderungen: [{ nummer: 'SCH-12', hauptticket: '' }, { nummer: 'SCH-10', hauptticket: 'SCH-12' }, { nummer: 'SCH-11', hauptticket: 'SCH-12' }] }, 'Hauptticket wechseln');
gleich(M.planLoesen(nr('SCH-11'), fam).aenderungen, [{ nummer: 'SCH-11', hauptticket: '' }], 'Unterticket lösen');
gleich(M.planLoesen(nr('SCH-10'), fam).aenderungen.map(a => a.nummer), ['SCH-11', 'SCH-12'], 'Gruppe auflösen');
gleich(M.melderAdressen([nr('SCH-10'), nr('SCH-11'), nr('SCH-12')]), ['a@x.de', 'b@x.de'], 'Melder der Gruppe ohne Dubletten');
const t2 = M.ticketAusSp({ Id: 5, Hauptticket: 'sch-010' }, qSch);
gleich(t2.hauptticket, 'SCH-10', 'Hauptticket normalisiert');
gleich(M.ticketAusSp({ Id: 5, Hauptticket: 'Quatsch' }, qSch).hauptticket, '', 'ungültiges Hauptticket → leer');

// ── Duplikate ──
gleich(M.aehnlichkeit('Drucker Halle 2 druckt nicht', 'AW: Drucker in Halle 2 druckt nicht mehr'), 1, 'Ähnlichkeit ignoriert AW/Stoppwörter');
gleich(M.aehnlichkeit('Drucker Halle 2', 'VPN Zugang'), 0, 'keine Ähnlichkeit');
const dup = [
  mk(20, { nummer: 'SCH-20', titel: 'Drucker Halle 2 druckt nicht', melderMail: 'a@x.de' }),
  mk(21, { nummer: 'SCH-21', titel: 'Bezug SCH-20', melderMail: 'b@x.de', beschreibung: '<p>siehe auch SHB-3</p>' }),
  mk(22, { nummer: 'SCH-22', titel: 'AW: Drucker in Halle 2 druckt nicht mehr', melderMail: 'a@x.de' }),
  mk(23, { nummer: 'SCH-23', titel: 'Drucker Halle 2 druckt nicht', melderMail: 'z@x.de' }),
  mk(24, { nummer: 'SHB-3', titel: 'Monitor', melderMail: 'q@x.de' }),
  mk(25, { nummer: 'SCH-25', titel: 'Drucker Halle 2 druckt nicht', melderMail: 'a@x.de', status: 'Erledigt' }),
];
const vor = M.duplikatVorschlaege(dup[1], dup, { kennungen: kenn, jetzt });
gleich(vor.map(v => v.ticket.nummer), ['SCH-20', 'SHB-3'], 'Duplikat über Nummer in Betreff und Text');
const vor2 = M.duplikatVorschlaege(dup[0], dup, { kennungen: kenn, jetzt });
gleich(vor2.map(v => `${v.ticket.nummer}:${v.grund}`), ['SCH-22:gleicher Melder, ähnlicher Betreff', 'SCH-23:ähnlicher Betreff von anderen – Störung?'], 'Duplikate über Melder/Ähnlichkeit, erledigte nicht');
const verknuepft = dup.map(x => x.nummer === 'SCH-22' ? { ...x, hauptticket: 'SCH-20' } : x);
ok(!M.duplikatVorschlaege(verknuepft[0], verknuepft, { kennungen: kenn }).some(v => v.ticket.nummer === 'SCH-22'), 'bereits verknüpfte nicht vorschlagen');

// ── Navigation ──
gleich(M.parseRoute('#/t/sch-12'), { seite: 'ticket', nummer: 'SCH-12' }, 'Route: Ticket');
gleich(M.parseRoute('#/t/<script>'), { seite: '' }, 'Route: kaputte Nummer → Start');
gleich(M.parseRoute('#/verwaltung/rechte'), { seite: 'verwaltung', bereich: 'rechte' }, 'Route: Verwaltung');
gleich(M.parseRoute('#/verwaltung/xyz'), { seite: 'verwaltung', bereich: 'queues' }, 'Route: Verwaltung unbekannt → Queues');
gleich(M.parseRoute('#/meine'), { seite: 'meine' }, 'Route: Meine');
gleich(M.parseRoute(''), { seite: '' }, 'Route: leer');
gleich(M.ticketLink('https://a/b/', 'SCH-1'), 'https://a/b/#/t/SCH-1', 'Ticket-Link');

ende();
