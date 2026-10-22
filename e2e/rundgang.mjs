#!/usr/bin/env node
/**
 * Browser-Rundgang gegen eine SharePoint/Graph-Attrappe (ohne Tenant, ohne Anmeldung)
 * ==================================================================================
 *   node e2e/rundgang.mjs            (Screenshots nach e2e/bilder/)
 * Braucht Playwright (global oder im Projekt) mit Chromium.
 * Prüft je Rolle (Bearbeiterin, Melder, Admin), dass die Oberfläche lädt, ohne
 * Skriptfehler arbeitet und die Kernabläufe tun, was sie sollen.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { neuerTenant, beantworte, LISTEN } from './attrappe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BILDER = path.join(ROOT, 'e2e', 'bilder');
fs.mkdirSync(BILDER, { recursive: true });

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire(import.meta.url)('/opt/node22/lib/node_modules/playwright')); }

// ── statischer Server ──
const TYPEN = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.zip': 'application/zip' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/tickets/, '')));
  const datei = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!datei.startsWith(ROOT) || !fs.existsSync(datei)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPEN[path.extname(datei)] || 'application/octet-stream' });
  fs.createReadStream(datei).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASIS = `http://localhost:${server.address().port}/tickets/`;

const MSAL = mail => `window.msal = {
  PublicClientApplication: class {
    constructor() {}
    async initialize() {}
    async handleRedirectPromise() { return null; }
    getActiveAccount() { return { username: ${JSON.stringify(mail)}, name: ${JSON.stringify(mail.split('@')[0])} }; }
    getAllAccounts() { return [this.getActiveAccount()]; }
    setActiveAccount() {}
    async acquireTokenSilent() { return { accessToken: 'attrappe' }; }
    loginRedirect() {} logoutRedirect() {} acquireTokenRedirect() {}
  },
  InteractionRequiredAuthError: class extends Error {},
};`;

let gruen = 0, rot = 0;
const ok = (c, text) => { if (c) { gruen++; console.log('  ✓', text); } else { rot++; console.log('  ✗', text); } };

const browser = await chromium.launch();

async function sitzung(mail, tenant) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'de-DE' });
  const page = await ctx.newPage();
  const fehler = [];
  page.on('pageerror', e => fehler.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fehler.push(m.text()); });
  await page.route('**/vendor/msal-browser/5.23.0/msal-browser.min.js', r => r.fulfill({ contentType: 'text/javascript', body: MSAL(mail) }));
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  const api = async r => {
    const req = r.request();
    let body;
    try { body = req.postData() ? JSON.parse(req.postData()) : undefined; } catch { body = undefined; }
    if (body && typeof body === 'object') body.__accept = req.headers().accept;
    await r.fulfill(beantworte(tenant, mail, req.method() === 'POST' && req.headers()['x-http-method'] ? req.headers()['x-http-method'] : req.method(), req.url(), body));
  };
  await page.route('https://graph.microsoft.com/**', api);
  await page.route('https://dihag.sharepoint.com/**', api);
  return { page, ctx, fehler };
}

const warte = ms => new Promise(r => setTimeout(r, ms));

// ── 1) Bearbeiterin ──
{
  console.log('\nBearbeiterin (anna.agent@dihag.com)');
  const t = neuerTenant();
  const { page, ctx, fehler } = await sitzung('anna.agent@dihag.com', t);
  await page.goto(BASIS);
  await page.waitForSelector('table.tickets');
  ok(/#\/posteingang$/.test(page.url()), 'Start = Posteingang');
  const zeilen = await page.$$eval('table.tickets tbody tr', trs => trs.map(tr => tr.querySelector('.nr a').textContent.trim()));
  ok(zeilen.includes('SCH-1') && zeilen.includes('SCH-4') && !zeilen.includes('SCH-3'), `offene SCH-Tickets, kein erledigtes (${zeilen.join(', ')})`);
  ok(!zeilen.some(z => z.startsWith('SHB')), 'keine SHB-Tickets (nicht Bearbeiterin dort)');
  ok(await page.$('a.nav-punkt[href="#/verwaltung"]') === null, 'keine Verwaltung ohne Besitzerrechte');
  await page.screenshot({ path: path.join(BILDER, '1-posteingang.png') });

  await page.click('button[data-sicht="ohne"]');
  const ohne = await page.$$eval('table.tickets tbody tr .nr a', x => x.map(e => e.textContent.trim()));
  ok(ohne.length === 3 && !ohne.includes('SCH-2'), `Sicht „Ohne Bearbeiter" (${ohne.join(', ')})`);
  await page.fill('input.suche', 'sap');
  await warte(400);
  const such = await page.$$eval('table.tickets tbody tr .nr a', x => x.map(e => e.textContent.trim()));
  ok(such.join() === 'SCH-4', 'Suche „sap" findet SCH-4');
  await page.fill('input.suche', '');
  await page.click('button[data-sicht="offen"]');

  await page.goto(BASIS + '#/t/SCH-1');
  await page.waitForSelector('#t-beschreibung p');
  await warte(300);
  ok(await page.evaluate(() => window.__xss === undefined), 'Mail-HTML: kein Skript/onerror ausgeführt');
  const links = await page.$$eval('#t-beschreibung a', as => as.map(a => a.getAttribute('href')));
  ok(links.length === 1 && links[0] === 'https://example.com/hilfe', `Mail-HTML: javascript:-Link wird Text, normaler Link bleibt (${links.join(' | ')})`);
  ok(await page.$('#t-beschreibung img, #t-beschreibung script') === null, 'Mail-HTML: keine Bilder/Skripte');
  ok((await page.textContent('#t-verlauf')).includes('Wir schauen uns das an.'), 'Verlauf zeigt Kommentar');
  ok((await page.textContent('#t-anhaenge')).includes('foto.jpg'), 'Anhang gelistet');

  await page.click('button[data-reiter="intern"]');
  await page.waitForSelector('#t-notizen .eintrag');
  ok((await page.textContent('#t-notizen')).includes('Toner ist bestellt.'), 'Interne Notiz sichtbar');
  await page.click('button[data-reiter="verlauf"]');

  await page.fill('#t-antwort-text', 'Bitte einmal neu starten.');
  await page.click('form[data-absenden="t-antwort"] button.primaer');
  await page.waitForFunction(() => document.querySelector('#t-verlauf')?.textContent.includes('Bitte einmal neu starten.'));
  const mail = t.mails.at(-1);
  ok(mail && mail.toRecipients[0].emailAddress.address === 'max@schmie-guss.de' && /^\[#SCH-1\]/.test(mail.subject) && mail.replyTo?.[0].emailAddress.address === 'ticket@dihag.com', `Antwort: Mail an Melder mit [#SCH-1] und Reply-To Ticketpostfach (${mail?.subject})`);
  ok(t.listen[Object.keys(t.listen)[1]].items[0].Status === 'In Bearbeitung', 'Status „Neu" → „In Bearbeitung" nach Antwort');

  await page.click('button[data-aktion="t-uebernehmen"]');
  await page.waitForFunction(() => !document.querySelector('button[data-aktion="t-uebernehmen"]'));
  ok(t.listen[Object.keys(t.listen)[1]].items[0].Assignedto0.some(p => p.EMail === 'anna.agent@dihag.com'), 'Übernehmen weist mir zu');

  await page.click('button[data-aktion="t-erledigt"]');
  await page.waitForSelector('dialog[open] textarea');
  await page.fill('dialog[open] textarea', 'Treiber neu installiert.');
  await page.click('dialog[open] button[value="ok"]');
  await page.waitForFunction(() => document.querySelector('.nr-zeile')?.textContent.includes('Erledigt'));
  ok(t.listen[Object.keys(t.listen)[1]].items[0].Status === 'Erledigt', 'Erledigt gespeichert');
  ok(/erledigt/i.test(t.mails.at(-1)?.body.content || ''), 'Erledigt-Mail an Melder');
  await page.screenshot({ path: path.join(BILDER, '2-ticket-bearbeiterin.png'), fullPage: true });

  await page.goto(BASIS + '#/berichte');
  await page.waitForSelector('.kacheln');
  ok(await page.$('svg.svg-diagramm') !== null, 'Berichte: Diagramm gezeichnet');
  await page.screenshot({ path: path.join(BILDER, '3-berichte.png'), fullPage: true });

  await page.goto(BASIS + '#/neu');
  await page.waitForSelector('#neu-mail');
  ok(await page.$('button[data-reiter="direkt"]') !== null, 'Neues Ticket: Reiter „Direkt anlegen" für Bearbeiter');
  ok(fehler.length === 0, 'keine Skriptfehler' + (fehler.length ? ': ' + fehler.join(' | ') : ''));
  await ctx.close();
}

// ── 2) Melder ──
{
  console.log('\nMelder (max@schmie-guss.de)');
  const t = neuerTenant();
  const { page, ctx, fehler } = await sitzung('max@schmie-guss.de', t);
  await page.goto(BASIS);
  await page.waitForSelector('#meine-inhalt .ticket-karte');
  ok(/#\/meine$/.test(page.url()), 'Start = Meine Anfragen');
  ok(await page.$('a.nav-punkt[href="#/posteingang"]') === null, 'kein Posteingang für Melder');
  const karten = await page.$$eval('.ticket-karte .nr', x => x.map(e => e.textContent.trim()));
  ok(karten.includes('SCH-1') && karten.includes('SHB-1') && !karten.includes('SCH-3'), `nur eigene Tickets (${karten.join(', ')})`);
  await page.screenshot({ path: path.join(BILDER, '4-meine-anfragen.png'), fullPage: true });

  await page.goto(BASIS + '#/t/SCH-1');
  await page.waitForSelector('#t-beschreibung');
  ok(await page.$('select[data-aendern="t-status"]') === null, 'Melder kann Status nicht ändern');
  ok(await page.$('button[data-reiter="intern"]') === null, 'Melder sieht keinen Intern-Reiter');
  await page.fill('#t-antwort-text', 'Geht immer noch nicht.');
  await page.click('form[data-absenden="t-antwort"] button.primaer');
  await page.waitForSelector('.eintrag.vorlaeufig');
  const m = t.mails.at(-1);
  ok(m?.toRecipients[0].emailAddress.address === 'ticket@dihag.com' && /\[#SCH-1\]/.test(m.subject), `Melder-Antwort geht als Mail mit Token an das Ticketpostfach (${m?.subject})`);
  await page.screenshot({ path: path.join(BILDER, '5-ticket-melder.png'), fullPage: true });

  await page.goto(BASIS + '#/neu');
  await page.waitForSelector('#neu-mail');
  ok(await page.$('button[data-reiter="direkt"]') === null, 'kein Direkt-Anlegen für Melder');
  await page.fill('#neu-mail input[name=titel]', 'Maus defekt');
  await page.fill('#neu-mail textarea[name=text]', 'Die Maus klickt doppelt.');
  await page.click('#neu-mail button.primaer');
  await page.waitForSelector('.erfolg-box');
  ok(t.mails.at(-1)?.subject === 'Maus defekt' && t.mails.at(-1).toRecipients[0].emailAddress.address === 'ticket@dihag.com', 'Neues Ticket = Mail an Ticketpostfach');
  await page.goto(BASIS + '#/t/SCH-3');
  await page.waitForSelector('.fehlerbox');
  ok((await page.textContent('.fehlerbox')).length > 0, 'fremdes Ticket SCH-3 nicht abrufbar');
  ok(fehler.filter(f => !/SharePoint 404|gibt es nicht/.test(f)).length === 0, 'keine Skriptfehler' + (fehler.length ? ': ' + fehler.join(' | ') : ''));
  await ctx.close();
}

// ── 2b) Zusammenführen, Hauptticket wechseln, SAP-Übergabe ──
{
  console.log('\nZusammenführen / Hauptticket / SAP-Übergabe (anna.agent@dihag.com)');
  const t = neuerTenant();
  const sch = t.listen[LISTEN.sch];
  const it = id => sch.items.find(i => i.Id === id);
  const bisMails = async n => { for (let i = 0; i < 80 && t.mails.length < n; i++) await warte(100); };
  const { page, ctx, fehler } = await sitzung('anna.agent@dihag.com', t);

  await page.goto(BASIS + '#/t/SCH-5');
  await page.waitForSelector('.duplikate');
  ok((await page.textContent('.duplikate')).includes('SCH-1'), 'Duplikat erkannt: SCH-5 ähnelt SCH-1 (anderer Melder, gleiches Thema)');
  await page.screenshot({ path: path.join(BILDER, '9-duplikat.png') });
  await page.click('.duplikate button[data-nr="SCH-1"]');
  await page.waitForSelector('dialog[open] input[name=nr]');
  ok(await page.inputValue('dialog[open] input[name=nr]') === 'SCH-1', 'Zusammenführen: Nummer vorbelegt');
  await page.click('dialog[open] button[value="ok"]');
  await page.waitForSelector('dialog[open] button[value="ja"]');
  await page.click('dialog[open] button[value="ja"]');
  await page.waitForFunction(() => location.hash === '#/t/SCH-1');
  await page.waitForSelector('.verknuepft-liste');
  ok(it(5).Hauptticket === 'SCH-1', 'SCH-5 ist jetzt Unterticket von SCH-1');
  ok(t.mails.some(m => m.toRecipients[0].emailAddress.address === 'eva@schmie-guss.de' && /^\[#SCH-5\]/.test(m.subject)), 'Melderin von SCH-5 erfährt es – mit ihrer eigenen Nummer');
  ok((await page.textContent('.nr-zeile')).includes('Hauptticket · 1 Unterticket'), 'SCH-1 als Hauptticket gekennzeichnet');

  const vorher = t.mails.length;
  await page.fill('#t-antwort-text', 'Der Techniker ist unterwegs.');
  ok(await page.isChecked('form[data-absenden="t-antwort"] input[name=unter]'), 'Antwort: „Auch die Melder der Untertickets" ist vorausgewählt');
  await page.click('form[data-absenden="t-antwort"] button.primaer');
  await bisMails(vorher + 2);
  const neu = t.mails.slice(vorher);
  ok(neu.length === 2
    && neu.some(m => m.toRecipients[0].emailAddress.address === 'max@schmie-guss.de' && /^\[#SCH-1\]/.test(m.subject))
    && neu.some(m => m.toRecipients[0].emailAddress.address === 'eva@schmie-guss.de' && /^\[#SCH-5\]/.test(m.subject) && /gemeinsam mit Ticket SCH-1/.test(m.body.content)),
  `Antwort am Hauptticket erreicht beide Melder, jeden mit eigener Nummer (${neu.map(m => m.subject).join(' | ')})`);
  ok((sch.kommentare[5] || []).some(k => k.text.startsWith('✉ Über Hauptticket SCH-1: Der Techniker')), 'Nachricht steht auch im Verlauf des Untertickets');
  await page.waitForFunction(() => [...document.querySelectorAll('#t-verlauf .eintrag .badge')].some(b => b.textContent.includes('SCH-5')));
  ok(true, 'Verlauf des Haupttickets zeigt Einträge aus SCH-5');
  await page.screenshot({ path: path.join(BILDER, '10-hauptticket.png'), fullPage: true });

  await page.goto(BASIS + '#/posteingang');
  await page.waitForSelector('table.tickets');
  const reihen = await page.$$eval('table.tickets tbody tr', trs => trs.map(tr => tr.textContent.replace(/\s+/g, ' ')));
  ok(!reihen.some(r => r.includes('SCH-5')) && reihen.some(r => r.includes('SCH-1') && r.includes('+1')), 'Posteingang: Unterticket eingeklappt, Hauptticket mit „+1"');

  await page.goto(BASIS + '#/t/SCH-5');
  await page.waitForSelector('.verknuepfung button[data-aktion="t-haupt-wechseln"]');
  await page.click('.verknuepfung button[data-aktion="t-haupt-wechseln"]');
  await page.waitForSelector('dialog[open] button[value="ja"]');
  await page.click('dialog[open] button[value="ja"]');
  await page.waitForFunction(() => document.querySelector('.nr-zeile')?.textContent.includes('Hauptticket · 1'));
  ok(it(5).Hauptticket === '' && it(1).Hauptticket === 'SCH-5', 'Hauptticket gewechselt: SCH-5 führt, SCH-1 hängt darunter');

  const vorErledigt = t.mails.length;
  await page.click('button[data-aktion="t-erledigt"]');
  await page.waitForSelector('dialog[open] input[name=unter]');
  await page.fill('dialog[open] textarea', 'Drucker getauscht.');
  await page.click('dialog[open] button[value="ok"]');
  await page.waitForFunction(() => document.querySelector('.nr-zeile')?.textContent.includes('Erledigt'));
  await bisMails(vorErledigt + 2);
  ok(it(5).Status === 'Erledigt' && it(1).Status === 'Erledigt', 'Erledigt am Hauptticket schließt das Unterticket mit');
  ok(t.mails.slice(vorErledigt).some(m => m.toRecipients[0].emailAddress.address === 'max@schmie-guss.de' && /^\[#SCH-1\]/.test(m.subject) && /erledigt/i.test(m.body.content)), 'Melder des Untertickets bekommt die Erledigt-Mail');

  await page.goto(BASIS + '#/t/SCH-4');
  await page.waitForSelector('button[data-aktion="t-weiterleiten"]');
  await page.click('button[data-aktion="t-weiterleiten"]');
  await page.waitForSelector('dialog[open] select[name=ziel]');
  const ziele = await page.$$eval('dialog[open] select[name=ziel] option', o => o.map(x => x.value));
  ok(ziele.join() === 'SAP', `Übergabe-Ziele: nur SAP (dort darf die SCH-Gruppe anlegen) – ${ziele.join()}`);
  await page.click('dialog[open] button[value="ok"]');
  await page.waitForFunction(() => document.querySelector('#meldungen')?.textContent.includes('Übergeben: SAP-1'));
  const sap = t.listen[LISTEN.sap].items[0];
  ok(sap && sap.Kategorie === 'SAP' && sap.Title === 'SAP-Berechtigung Einkauf', 'SAP-Ticket SAP-1 angelegt (Kategorie SAP)');
  ok(it(4).Status === 'Abgebrochen' && (sch.kommentare[4] || []).some(k => k.text.includes('SAP-1')), 'SCH-4 verweist auf SAP-1 und ist geschlossen');
  ok(/#\/t\/SCH-4$/.test(page.url()), 'nach Übergabe in fremde Queue bleibt die Ansicht beim alten Ticket');
  ok(fehler.length === 0, 'keine Skriptfehler' + (fehler.length ? ': ' + fehler.join(' | ') : ''));
  await ctx.close();
}

// ── 3) Admin ──
{
  console.log('\nAdmin (admin@dihag.com)');
  const t = neuerTenant();
  const { page, ctx, fehler } = await sitzung('admin@dihag.com', t);
  await page.goto(BASIS + '#/verwaltung/queues');
  await page.waitForSelector('.unternav');
  await page.waitForSelector('table.daten');
  ok((await page.textContent('table.daten')).includes('schmie-guss.de'), 'Queues-Tabelle');
  await page.fill('input[data-eingabe="v-routing"]', 'x@schmie-guss.de');
  await page.waitForFunction(() => document.querySelector('#v-routing-ergebnis')?.textContent.includes('SCH'));
  ok(true, 'Routing-Test: schmie-guss.de → SCH');
  await page.fill('input[data-eingabe="v-routing"]', 'x@irgendwo.de');
  await page.waitForFunction(() => document.querySelector('#v-routing-ergebnis')?.textContent.includes('SHB'));
  ok(true, 'Routing-Test: unbekannt → Standard SHB');
  await page.fill('#v-routing-mail', 'x@schmie-guss.de');
  await page.fill('#v-routing-betreff', 'AW: SAP Berechtigung');
  await page.waitForFunction(() => document.querySelector('#v-routing-ergebnis')?.textContent.includes('SAP'));
  ok(true, 'Routing-Test: Stichwort SAP im Betreff → SAP, auch von schmie-guss.de');
  await page.screenshot({ path: path.join(BILDER, '6-verwaltung-queues.png'), fullPage: true });

  await page.click('button[data-aktion="v-queue-bearbeiten"][data-kennung="SCH"]');
  await page.waitForSelector('dialog[open] input[name=kennung][readonly]');
  ok(true, 'Kennung einer eingerichteten Queue ist gesperrt');
  await page.screenshot({ path: path.join(BILDER, '7-queue-dialog.png') });
  await page.click('dialog[open] button[value="abbrechen"]');

  await page.goto(BASIS + '#/verwaltung/rechte');
  await page.waitForSelector('button[data-aktion="v-alle-pruefen"]');
  await page.click('button[data-aktion="v-alle-pruefen"]');
  await page.waitForSelector('#v-q-ALT .pruefliste', { timeout: 15000 });
  const sch = await page.textContent('#v-q-SCH');
  const shb = await page.textContent('#v-q-SHB');
  ok(/zu viel: .*Mitwirken/.test(sch) && /fehlt: .*Jeder außer externen Benutzern/.test(sch), 'SCH: überzählige Mitwirken-Rechte und fehlende Melder-Leserechte erkannt');
  ok(/erbt von der Site/.test(shb) && /ReadSecurity: 1 → 2/.test(shb), 'SHB: Vererbung und „alle Elemente lesbar" erkannt');
  await page.screenshot({ path: path.join(BILDER, '8-verwaltung-rechte.png'), fullPage: true });

  await page.goto(BASIS + '#/verwaltung/eingang');
  await page.waitForSelector('a[href="flow/Helpdesk-v2.zip"]');
  ok(true, 'Eingang-Seite mit Flow-Download');
  await page.goto(BASIS + '#/verwaltung/migration');
  await page.click('button[data-aktion="m-vorschau"]');
  await page.waitForSelector('#m-ergebnis p');
  ok((await page.textContent('#m-ergebnis')).includes('1 von 1'), 'Migration: Vorschau findet das Alt-Ticket des Werks SCH');
  ok(fehler.length === 0, 'keine Skriptfehler' + (fehler.length ? ': ' + fehler.join(' | ') : ''));
  await ctx.close();
}

// ── 5) Rückkehr von der Anmeldung auf …/tickets/ (bestehende Redirect-URI) ──
{
  console.log('\nAnmelderückkehr (Redirect-URI = App-Adresse)');
  const t = neuerTenant();
  const { page, ctx, fehler } = await sitzung('anna.agent@dihag.com', t);
  const state = art => Buffer.from(JSON.stringify({ id: 'kanal-' + art, meta: { interactionType: art } })).toString('base64url') + '|/tickets/';
  await page.route(BASIS + 'alt/rahmen.html', r => r.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><title>alt</title>' }));
  await page.route(BASIS + 'fremd.html', r => r.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><title>fremd</title>' }));
  const iframe = (src, kanal) => page.evaluate(([src, kanal]) => new Promise(fertig => {
    const bc = new BroadcastChannel(kanal);
    let nachricht = null;
    bc.onmessage = e => { nachricht = e.data; };
    const f = document.createElement('iframe');
    f.src = src;
    f.onload = () => setTimeout(() => {
      bc.close();
      const w = f.contentWindow;
      fertig({ nachricht, hash: w.location.hash, app: !w.document.getElementById('app')?.hidden, text: w.document.getElementById('boot-text')?.textContent });
    }, 600);
    document.body.appendChild(f);
  }), [src, kanal]);

  // a) neue App: Token-Erneuerung im unsichtbaren iframe → Bridge reicht die Antwort weiter
  await page.goto(BASIS);
  await page.waitForSelector('table.tickets');
  const neu = await iframe(BASIS + '#code=c1&state=' + encodeURIComponent(state('silent')), 'kanal-silent');
  ok(page.url().startsWith(BASIS) && !page.url().includes('code='), 'Anmelde-iframe löst die App nicht aus dem Rahmen');
  ok(neu.nachricht?.v === 1 && /code=c1/.test(neu.nachricht.payload), 'iframe-Antwort per Redirect-Bridge an die App');
  ok(!neu.hash.includes('code=') && !neu.app, `iframe: Code aus der Adresse entfernt, App startet dort nicht (${neu.text})`);

  // b) alte App (/alt/, MSAL 2): Antwort bleibt stehen, MSAL 2 liest sie selbst
  await page.goto(BASIS + 'alt/rahmen.html');
  const alt = await iframe(BASIS + '#code=c2&state=' + encodeURIComponent(state('silent')), 'kanal-silent');
  ok(page.url().endsWith('/alt/rahmen.html'), 'iframe der alten App bleibt im Rahmen');
  ok(alt.nachricht === null && alt.hash.includes('code=c2') && !alt.app, 'alte App: Antwort bleibt für MSAL 2 in der Adresse, keine Bridge');

  // c) Power-Automate-Einwilligung der alten App (Popup, Antwort im Query)
  const signal = page.evaluate(() => new Promise(fertig => {
    const bc = new BroadcastChannel('pa-oauth-callback');
    bc.onmessage = e => { bc.close(); fertig(e.data); };
  }));
  const popup = await ctx.newPage();
  await popup.goto(BASIS + '?code=c3&state=pa_consent_abc');
  await popup.waitForFunction(() => /Einwilligung erteilt/.test(document.getElementById('boot-text')?.textContent));
  const daten = await Promise.race([signal, warte(2000).then(() => null)]);
  ok(daten?.fertig === true && !JSON.stringify(daten).includes('c3'), 'Einwilligung: Signal an die alte App, ohne Code');
  ok(!popup.url().includes('code='), 'Einwilligung: Code aus der Adresse entfernt');
  if (!popup.isClosed()) await popup.close();

  // d) Anmeldung im selben Fenster: App startet normal (MSAL wertet die Antwort aus)
  await page.goto(BASIS + '#code=c4&state=' + encodeURIComponent(state('redirect')));
  await page.waitForSelector('table.tickets');
  ok(true, 'Redirect-Antwort: App startet');

  // e) Clickjacking-Schutz bleibt: ohne Anmeldeantwort wird die App aus jedem Rahmen gelöst
  await page.goto(BASIS + 'fremd.html');
  await page.evaluate(src => { const f = document.createElement('iframe'); f.src = src; document.body.appendChild(f); }, BASIS + '#/posteingang');
  await page.waitForURL(u => !String(u).endsWith('fremd.html'), { timeout: 5000 }).catch(() => {});
  ok(!page.url().endsWith('fremd.html'), 'App im fremden Rahmen löst sich heraus');
  ok(fehler.length === 0, 'keine Skriptfehler' + (fehler.length ? ': ' + fehler.join(' | ') : ''));
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${rot ? '✗' : '✓'} ${gruen} grün, ${rot} rot`);
process.exit(rot ? 1 : 0);
