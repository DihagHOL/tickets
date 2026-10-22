/**
 * Flow „Helpdesk v2": Struktur, Verweise, Paket und – mit einem kleinen Auswerter für
 * die Workflow-Ausdrucksprache – dieselbe Logik wie js/modell.js (Ticketnummer, Routing).
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { ok, gleich, ende } from './_pruef.mjs';
import {
  bauDefinition, bauPaket, paketDateien, zip,
  AUSDRUCK_TICKETNUMMER, AUSDRUCK_DOMAIN_TREFFER, AUSDRUCK_STANDARD, AUSDRUCK_ANTWORTTEXT,
  AUSDRUCK_WOERTER, AUSDRUCK_KENNUNGSLISTE, AUSDRUCK_NUMMER_WORT, AUSDRUCK_STICHWORT_TREFFER,
  AUSDRUCK_STICHWORT_DOMAIN, AUSDRUCK_STICHWORT_OHNE_DOMAIN, AUSDRUCK_ZIEL, AUSDRUCK_WERK,
} from '../scripts/flow-paket.mjs';
import { tokenAusBetreff, queueFuerAbsender, queueAusFeldern, queueZuFeldern } from '../js/modell.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const def = bauDefinition();

// ── Struktur ────────────────────────────────────────────────────────────────
const alle = new Map(); // name → { aktion, geschwister }
const schleifen = new Set();
function lauf(actions, pfad) {
  for (const [name, a] of Object.entries(actions || {})) {
    ok(!alle.has(name), `Aktionsname eindeutig: ${name}`);
    alle.set(name, { aktion: a, geschwister: actions, pfad });
    if (a.type === 'Foreach') schleifen.add(name);
    lauf(a.actions, pfad + '/' + name);
    lauf(a.else?.actions, pfad + '/' + name + '(sonst)');
  }
}
lauf(def.actions, '');
ok(alle.size > 50, `vollständiger Ablauf (${alle.size} Aktionen)`);

for (const [name, { aktion, geschwister }] of alle) {
  for (const [vor, status] of Object.entries(aktion.runAfter || {})) {
    ok(vor in geschwister, `${name}: runAfter „${vor}" liegt in derselben Ebene`);
    ok(status.every(s => ['Succeeded', 'Failed', 'Skipped', 'TimedOut'].includes(s)), `${name}: gültige runAfter-Status`);
  }
  if (aktion.type === 'If') ok(aktion.expression && aktion.actions && aktion.else, `${name}: If vollständig`);
}
// Jede Ebene hat genau einen Einstieg ohne runAfter-Abhängigkeit
const ebenen = new Map();
for (const [name, { aktion, geschwister }] of alle) {
  if (!ebenen.has(geschwister)) ebenen.set(geschwister, []);
  if (!Object.keys(aktion.runAfter || {}).length) ebenen.get(geschwister).push(name);
}
for (const [, starts] of ebenen) ok(starts.length === 1, `genau ein Einstieg je Ebene (${starts.join(', ')})`);

// Verweise in Ausdrücken
const text = JSON.stringify(def);
for (const m of text.matchAll(/\b(outputs|body|actions)\('([^']+)'\)/g)) ok(alle.has(m[2]), `${m[1]}('${m[2]}') verweist auf vorhandene Aktion`);
for (const m of text.matchAll(/\bitems\('([^']+)'\)/g)) ok(schleifen.has(m[1]), `items('${m[1]}') verweist auf eine Schleife`);
const variablen = new Set([...alle.values()].filter(x => x.aktion.type === 'InitializeVariable').flatMap(x => x.aktion.inputs.variables.map(v => v.name)));
for (const m of text.matchAll(/variables\('([^']+)'\)/g)) ok(variablen.has(m[1]), `Variable ${m[1]} initialisiert`);
for (const x of alle.values()) if (x.aktion.type === 'InitializeVariable') ok(x.pfad === '', 'Variablen nur auf oberster Ebene');

// Ein ganzer Ausdruck („@…") darf kein @{…} enthalten – das würde NICHT ausgewertet.
function alleStrings(o, f) { if (typeof o === 'string') f(o); else if (o && typeof o === 'object') Object.values(o).forEach(v => alleStrings(v, f)); }
alleStrings(def.actions, s => { if (/^@(?!\{)/.test(s)) ok(!s.includes('@{'), `kein @{…} in Ausdruck: ${s.slice(0, 60)}`); });

// Verbindungen
const paket = bauPaket();
const flowDatei = Object.keys(paket).find(k => k.endsWith('definition.json'));
const refs = paket[flowDatei].properties.connectionReferences;
const benutzt = new Set([...text.matchAll(/"connectionName":"([^"]+)"/g)].map(m => m[1]));
for (const b of benutzt) ok(b in refs, `Verbindung ${b} deklariert`);
const apis = paket[Object.keys(paket).find(k => k.endsWith('apisMap.json'))];
const cons = paket[Object.keys(paket).find(k => k.endsWith('connectionsMap.json'))];
for (const b of benutzt) ok(apis[b] in paket['manifest.json'].resources && cons[b] in paket['manifest.json'].resources, `Paket-Ressourcen für ${b}`);
ok(!benutzt.has('shared_office365_1'), 'kein zweites Outlook-Konto nötig');

// Paket aktuell und lesbar
const zipDatei = path.join(ROOT, 'flow', 'Helpdesk-v2.zip');
ok(fs.existsSync(zipDatei), 'flow/Helpdesk-v2.zip vorhanden');
ok(fs.readFileSync(zipDatei).equals(zip(paketDateien())), 'Paket ist aktuell (sonst: node scripts/flow-paket.mjs)');
function entpacke(buf) {
  const out = {};
  const endeOff = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(endeOff + 16);
  for (let i = 0; i < buf.readUInt16LE(endeOff + 10); i++) {
    const nLen = buf.readUInt16LE(p + 28), lokal = buf.readUInt32LE(p + 42), gross = buf.readUInt32LE(p + 20);
    const name = buf.slice(p + 46, p + 46 + nLen).toString();
    const start = lokal + 30 + buf.readUInt16LE(lokal + 26) + buf.readUInt16LE(lokal + 28);
    out[name] = zlib.inflateRawSync(buf.slice(start, start + gross)).toString();
    p += 46 + nLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}
const entpackt = entpacke(fs.readFileSync(zipDatei));
gleich(Object.keys(entpackt).sort(), Object.keys(paketDateien()).sort(), 'ZIP enthält alle Paketdateien');
ok(JSON.parse(entpackt[flowDatei]).properties.displayName === 'Helpdesk v2', 'ZIP: Definition lesbar');

// ── Kleiner Auswerter für die Workflow-Ausdrucksprache ──────────────────────
function auswerten(ausdruck, ctx) {
  const s = ausdruck.replace(/^@/, '');
  let i = 0;
  const leer = () => { while (/\s/.test(s[i])) i++; };
  function wert() {
    leer();
    let v;
    if (s[i] === "'") {
      let out = ''; i++;
      for (;;) { if (s[i] === "'" && s[i + 1] === "'") { out += "'"; i += 2; } else if (s[i] === "'") { i++; break; } else out += s[i++]; }
      v = out;
    } else if (/[0-9-]/.test(s[i])) { const m = s.slice(i).match(/^-?\d+/)[0]; i += m.length; v = Number(m); }
    else {
      const name = s.slice(i).match(/^[A-Za-z_]\w*/)[0]; i += name.length; leer();
      if (name === 'true') v = true; else if (name === 'false') v = false; else if (name === 'null') v = null;
      else {
        if (s[i] !== '(') throw new Error('Erwartet ( nach ' + name);
        i++; const args = []; leer();
        while (s[i] !== ')') { args.push(wert()); leer(); if (s[i] === ',') i++; leer(); }
        i++;
        v = FN[name] ? FN[name](...args) : ctx[name](...args);
      }
    }
    for (;;) { leer(); if (s[i] === '?' && s[i + 1] === '[') i++; if (s[i] !== '[') break; i++; const k = wert(); leer(); i++; v = v == null ? null : v[k]; }
    return v;
  }
  const FN = {
    if: (c, a, b) => (c ? a : b), contains: (a, b) => String(a).includes(b), first: a => a[0] ?? null, last: a => a[a.length - 1] ?? null,
    split: (a, b) => String(a).split(b), toUpper: a => String(a).toUpperCase(), toLower: a => String(a).toLowerCase(), trim: a => String(a).trim(),
    concat: (...a) => a.join(''), equals: (a, b) => a === b, and: (...a) => a.every(Boolean), or: (...a) => a.some(Boolean), not: a => !a,
    empty: a => a == null || a === '' || (Array.isArray(a) && !a.length), coalesce: (...a) => a.find(x => x != null) ?? null,
    take: (a, n) => String(a).slice(0, n), decodeUriComponent: a => decodeURIComponent(a), join: (a, b) => a.join(b), length: a => a.length,
    greater: (a, b) => a > b, replace: (a, b, c) => String(a).split(b).join(c), int: a => { if (!/^\d+$/.test(String(a))) throw new Error('int'); return Number(a); },
    isInt: a => /^[+-]?\d+$/.test(String(a)), lessOrEquals: (a, b) => a <= b,
  };
  const r = wert();
  return r;
}

// Die Ausdrücke im Paket sind genau die getesteten
const ausdruck = name => { const a = alle.get(name).aktion; return a.inputs?.where || a.inputs; };
ok(ausdruck('Woerter') === AUSDRUCK_WOERTER && ausdruck('Nummern_im_Betreff') === AUSDRUCK_NUMMER_WORT && ausdruck('Ziel') === AUSDRUCK_ZIEL, 'Paket nutzt die getesteten Ausdrücke');
ok(alle.get('Stichwort_pruefen').aktion.runtimeConfiguration?.concurrency?.repetitions === 1, 'Stichwort-Schleife nacheinander (feste Reihenfolge)');

// Ticketnummer: Flow (Kennungen → Wörter → Nummern → Ticketnummer) = tokenAusBetreff()
const KENN = ['SCH', 'SHB', 'SAP', 'ALT'];
function flowTicketnummer(betreff) {
  const kennungsliste = auswerten(AUSDRUCK_KENNUNGSLISTE, { body: () => KENN });
  const woerter = auswerten(AUSDRUCK_WOERTER, { outputs: () => betreff });
  const nummern = woerter.filter(w => auswerten(AUSDRUCK_NUMMER_WORT, { item: () => w, outputs: () => kennungsliste }));
  return auswerten(AUSDRUCK_TICKETNUMMER, { outputs: n => (n === 'Betreff' ? betreff : null), body: () => nummern });
}
const betreffs = [
  'AW: [#SCH-12] Eingangsbestätigung: Drucker', 'WG: [#ewa-3] x', 'AW: Neues Ticket: 1234 (Drucker)', 'Neues Ticket: 99',
  'Drucker kaputt', '', 'RE: AW: [#DIHAG-7] Eingangsbestätigung: [Wichtig] Server', '[#SCH-12]',
  'Bezug SCH-12: Drucker', '(sap-7) noch offen?', 'COVID-19 Regeln', 'SCH-12-3 Teil', 'SCH-12a', 'SCH-1234567890',
  '[#SHB-2] Re: SCH-12', 'Drucker [#] kaputt', 'AW: SCH-5, SAP-2', 'Neues Ticket: 12) x',
];
for (const b of betreffs) {
  const flow = flowTicketnummer(b);
  ok(flow === tokenAusBetreff(b, 'ALT', KENN), `Ticketnummer „${b}" → Flow ${JSON.stringify(flow)} = App ${JSON.stringify(tokenAusBetreff(b, 'ALT', KENN))}`);
}

// Routing: Flow (Stichwort-Schleife, Filter, Ziel) = queueFuerAbsender() – mit Zeilen wie „Elemente abrufen"
const queues = [
  { Id: 1, Kennung: 'SCH', Domains: 'schmie-guss.de;sch-guss.de', Modus: 'Ticket', Werk: 'SCH', Reihenfolge: 10 },
  { Id: 2, Kennung: 'DIHAG', Domains: 'dihag.com', Modus: 'Ticket', Werk: 'DIHAG', Reihenfolge: 20 },
  { Id: 3, Kennung: 'ALLG', Domains: '', Modus: 'Ticket', Standard: true, Werk: 'Kein', Reihenfolge: 90 },
  { Id: 4, Kennung: 'GIE', Domains: 'gienanth.com', Modus: 'Hinweis', Reihenfolge: 30 },
  { Id: 5, Kennung: 'ALT', Domains: 'alt.de', Modus: 'Archiv', Stichwoerter: 'Altlast', Reihenfolge: 40 },
  { Id: 6, Kennung: 'SAP', Domains: '', Stichwoerter: 'SAP;S/4HANA', Modus: 'Ticket', Werk: '', Reihenfolge: 5 },
  { Id: 7, Kennung: 'SAPSCH', Domains: 'schmie-guss.de', Stichwoerter: 'SAP', Modus: 'Ticket', Werk: 'SCH', Reihenfolge: 6 },
].map(z => ({ ...queueZuFeldern(queueAusFeldern(z)), Id: z.Id })).map(f => ({ ...f, Modus: { Value: f.Modus } }))
  .sort((a, b) => a.Reihenfolge - b.Reihenfolge || a.Id - b.Id);  // $orderby=Reihenfolge
function flowZiel(absender, betreff) {
  const domain = absender.split('@').pop();
  const out = n => ({ Betreff: betreff, Domain: domain }[n]);
  const gemerkt = queues.filter(q => {
    const treffer = q.Stichwoerter.split(';').filter(w => auswerten(AUSDRUCK_STICHWORT_TREFFER, { item: () => w, outputs: out }));
    return treffer.length > 0 && q.Modus.Value !== 'Archiv';
  });
  const b = {
    Stichwort_mit_Domain: gemerkt.filter(q => auswerten(AUSDRUCK_STICHWORT_DOMAIN, { item: () => q, outputs: out })),
    Stichwort_ohne_Domain: gemerkt.filter(q => auswerten(AUSDRUCK_STICHWORT_OHNE_DOMAIN, { item: () => q })),
    Queue_nach_Domain: queues.filter(q => auswerten(AUSDRUCK_DOMAIN_TREFFER, { outputs: out, item: () => q })),
    Standard_Queue: queues.filter(q => auswerten(AUSDRUCK_STANDARD, { item: () => q })),
  };
  const ziel = auswerten(AUSDRUCK_ZIEL, { body: n => b[n] });
  const werk = ziel ? auswerten(AUSDRUCK_WERK, { outputs: () => ziel, body: n => b[n] }) : '';
  return { kennung: ziel?.Kennung, werk };
}
const appQueues = queues.map(f => queueAusFeldern({ ...f, Modus: f.Modus.Value }));
const faelle = [
  ['a@schmie-guss.de', 'Drucker'], ['b@sch-guss.de', ''], ['c@dihag.com', 'VPN'], ['d@gienanth.com', 'Hallo'], ['e@alt.de', 'Altlast'],
  ['f@unbekannt.de', 'Frage'], ['g@x.dihag.com', 'x'], ['h@dihag.com', 'SAP Berechtigung'], ['i@schmie-guss.de', 'AW: sap transaktion'],
  ['j@unbekannt.de', 'Problem mit S/4HANA'], ['k@gienanth.com', 'SAP-Frage'],
];
for (const [absender, betreff] of faelle) {
  const flow = flowZiel(absender, betreff);
  const app = queueFuerAbsender(appQueues, absender, betreff)?.kennung;
  ok(flow.kennung === app, `Routing ${absender} „${betreff}": Flow ${flow.kennung} = App ${app}`);
}
gleich(flowZiel('h@dihag.com', 'SAP Berechtigung').werk, 'DIHAG', 'SAP für alle Werke: Werk kommt aus der Absender-Domain');
gleich(flowZiel('i@schmie-guss.de', 'SAP').werk, 'SCH', 'Werk der Queue hat Vorrang');

// Antworttext: zitierter Verlauf fällt weg
const lf = '\n';
const mail = 'Geht wieder, danke!' + lf + lf + 'Von: IT <ticket@dihag.com>' + lf + 'Gesendet: …' + lf + 'Ihr Ticket …';
gleich(auswerten(AUSDRUCK_ANTWORTTEXT, { body: () => mail }), 'Geht wieder, danke!', 'Antworttext ohne Zitat (Von:)');
gleich(auswerten(AUSDRUCK_ANTWORTTEXT, { body: () => 'Hallo' + lf + '________________________________' + lf + 'From: x' }), 'Hallo', 'Antworttext ohne Zitat (Trennlinie)');
gleich(auswerten(AUSDRUCK_ANTWORTTEXT, { body: () => 'x'.repeat(5000) }).length, 1800, 'Antworttext gekürzt');

// Personenfeld-Wert (Zuständige)
const zust = alle.get('Bearbeiter_eintragen_Inhalt').aktion.inputs.formValues[0].FieldValue.slice(2, -1);
gleich(auswerten(zust, { outputs: () => ({ Bearbeiter: 'a@dihag.com;b@dihag.com' }) }), "[{'Key':'i:0#.f|membership|a@dihag.com'},{'Key':'i:0#.f|membership|b@dihag.com'}]", 'Personenwert für Zuständige');

// Eingangsbestätigung trägt das Token, das der Flow später wiedererkennt
const bestaetigung = alle.get('Eingangsbestaetigung').aktion.inputs.parameters['replyParameters/Subject'];
ok(bestaetigung.startsWith("[#@{outputs('Nummer')}]"), 'Eingangsbestätigung mit [#Nummer] im Betreff');
ok(tokenAusBetreff('AW: [#SCH-5] Eingangsbestätigung: Test') === 'SCH-5', 'Antwort darauf wird erkannt');
ok(!/Neues Ticket:/.test(bestaetigung), 'neues Betreff-Format kollidiert nicht mit dem alten');

ende();
