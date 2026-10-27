/* Nevandar Luisteren — gsm-app (PWA). Praat rechtstreeks met je Dropbox via OAuth (PKCE); geen server, geen geheimen.
   Zelfde map en keuzebestanden als de regisseur op de pc (gsm_sync.py) en de Claude-pagina. */
"use strict";
const BASE = "/Nevandar luisteren";
const APP_KEY = (window.NEVANDAR_CONFIG || {}).dropboxAppKey || "";
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, "");
const SCOPES = "files.metadata.read files.content.read files.content.write";

const $ = (s, el = document) => el.querySelector(s);
const view = () => document.getElementById("view");
const audio = document.getElementById("audio");
const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const S = { index: null, decided: new Map(), chapter: null, items: [], pos: 0, noteOpen: false, last: null, busy: false,
  links: new Map(), auto: ls.get("auto", true), rate: ls.get("rate", 1), interacted: false };

// ------------------------------------------------------------------ Dropbox-aanmelding (PKCE)
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  ls.set("pkce", { verifier, state });
  const u = new URL("https://www.dropbox.com/oauth2/authorize");
  Object.entries({ client_id: APP_KEY, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
    redirect_uri: REDIRECT, token_access_type: "offline", scope: SCOPES, state }).forEach(([k, v]) => u.searchParams.set(k, v));
  location.href = u.toString();
}
async function tokenRequest(params) {
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { kind: "auth", message: j.error_description || j.error || ("HTTP " + r.status) };
  return j;
}
async function finishLogin() {
  const q = new URLSearchParams(location.search);
  if (!q.get("code") && !q.get("error")) return false;
  const p = ls.get("pkce", null); history.replaceState(null, "", REDIRECT);
  if (q.get("error")) throw { kind: "auth", message: q.get("error_description") || q.get("error") };
  if (!p || p.state !== q.get("state")) throw { kind: "auth", message: "Aanmelding verlopen. Probeer opnieuw." };
  const j = await tokenRequest({ code: q.get("code"), grant_type: "authorization_code", code_verifier: p.verifier, client_id: APP_KEY, redirect_uri: REDIRECT });
  ls.set("tok", { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 120) * 1000 }); ls.del("pkce");
  return true;
}
async function accessToken() {
  const t = ls.get("tok", null);
  if (!t) throw { kind: "login" };
  if (t.access && Date.now() < t.exp) return t.access;
  const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: APP_KEY });
  t.access = j.access_token; t.exp = Date.now() + (j.expires_in - 120) * 1000; ls.set("tok", t);
  return t.access;
}
const argHeader = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
async function dbx(kind, endpoint, args, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await accessToken();
    const host = kind === "rpc" ? "https://api.dropboxapi.com/2/" : "https://content.dropboxapi.com/2/";
    const headers = { Authorization: "Bearer " + tok };
    let payload;
    if (kind === "rpc") { headers["Content-Type"] = "application/json"; payload = JSON.stringify(args); }
    else { headers["Dropbox-API-Arg"] = argHeader(args); if (body != null) { headers["Content-Type"] = "application/octet-stream"; payload = body; } }
    let r;
    try { r = await fetch(host + endpoint, { method: "POST", headers, body: payload }); }
    catch (e) { throw { kind: "net" }; }
    if (r.status === 401 && attempt === 0) { const t = ls.get("tok", {}); t.exp = 0; ls.set("tok", t); continue; }
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw { kind: "api", status: r.status, summary: (txt.match(/"error_summary":\s*"([^"]+)"/) || [])[1] || txt.slice(0, 160) };
    }
    return kind === "rpc" ? r.json() : r.text();
  }
}
const readJson = async path => JSON.parse(await dbx("content", "files/download", { path: BASE + "/" + path }));
const notFound = e => e && e.kind === "api" && /not_found/.test(e.summary || "");
function errText(e) {
  if (!e) return "Er ging iets mis.";
  if (e.kind === "net") return "Geen internetverbinding met Dropbox. Probeer zo opnieuw.";
  if (e.kind === "auth" || e.kind === "login") return "Dropbox-aanmelding: " + (e.message || "meld je opnieuw aan.");
  if (e.kind === "api") return "Dropbox gaf een fout: " + e.summary;
  return "Er ging iets mis: " + (e.message || e);
}

// ------------------------------------------------------------------ data
async function loadDecided() {
  S.decided = new Map();
  const add = es => (es || []).forEach(e => {
    const m = /^(H\d+[a-z]?)_(\d+)__(.+?)__(goed|opnieuw|nakijken)__/.exec(e.name || "");
    if (m && e[".tag"] === "file") S.decided.set(m[1] + ":" + m[2], { versie: m[3], keuze: m[4], path: e.path_display });
  });
  try {
    let p = await dbx("rpc", "files/list_folder", { path: BASE + "/keuzes", recursive: false, limit: 2000 });
    add(p.entries);
    while (p.has_more) { p = await dbx("rpc", "files/list_folder/continue", { cursor: p.cursor }); add(p.entries); }
  } catch (e) { if (!notFound(e)) throw e; }
}
async function linkFor(it) {
  const hit = S.links.get(it.mp3);
  if (hit && Date.now() < hit.exp) return hit.url;
  const r = await dbx("rpc", "files/get_temporary_link", { path: BASE + "/" + it.mp3 });
  S.links.set(it.mp3, { url: r.link, exp: Date.now() + 3.5 * 3600 * 1000 });
  return r.link;
}
const isDone = it => { const d = S.decided.get(it.id); return d && d.versie === it.versie; };

// ------------------------------------------------------------------ schermen
function showError(e, retry) {
  view().innerHTML = `<div class="notice bad">${esc(errText(e))}</div><div class="row" style="margin-top:12px"><button id="retry">Opnieuw proberen</button></div>`;
  $("#retry").onclick = retry;
}
function loginScreen(msg) {
  view().innerHTML = `<div class="login">
    <div class="mark">N</div>
    <p>Verbind de app één keer met je persoonlijke Dropbox. Daarna blijft ze aangemeld.</p>
    ${msg ? `<div class="notice bad">${esc(msg)}</div>` : ""}
    ${APP_KEY ? `<button class="primary" id="go">Verbinden met Dropbox</button>` : `<div class="notice bad">De app-sleutel ontbreekt in config.js.</div>`}
  </div>`;
  if (APP_KEY) $("#go").onclick = login;
}
async function home() {
  stopAudio(); S.chapter = null;
  view().innerHTML = `<p class="empty">Hoofdstukken laden…</p>`;
  try { S.index = await readJson("lijst/index.json"); await loadDecided(); }
  catch (e) {
    if (e && e.kind === "login") return loginScreen();
    if (notFound(e)) { view().innerHTML = `<div class="notice">Er staat nog geen beoordelingslijst in Dropbox. Start de regisseur op je pc: die zet de lijst en de opnames klaar.</div>`; return; }
    return showError(e, home);
  }
  const chs = S.index.hoofdstukken || [];
  const left = c => { let n = c.aantal; S.decided.forEach((v, k) => { if (k.split(":")[0] === c.code) n--; }); return Math.max(0, n); };
  if (!chs.length) { view().innerHTML = `<p class="empty">Alles is beoordeeld. Nieuwe opnames verschijnen hier zodra de pc ze klaarzet.</p>`; return; }
  const total = chs.reduce((a, c) => a + left(c), 0), waiting = S.decided.size;
  view().innerHTML = `<div style="display:grid;gap:12px">
      <p class="sub">${total} alinea's wachten op je oordeel${waiting ? ` · ${waiting} keuzes wachten tot de pc ze inleest` : ""} · lijst van ${esc(S.index.bijgewerkt || "")}</p>
      <div class="chapters">${chs.map(c => `<button class="chap" data-c="${esc(c.code)}"><span class="code">${esc(c.code)}</span><span class="t">${esc(c.titel || "")}</span><span class="count">${left(c)}</span></button>`).join("")}</div>
      <button class="link" id="refresh">↻ Lijst vernieuwen</button></div>`;
  view().querySelectorAll(".chap").forEach(b => b.onclick = () => openChapter(b.dataset.c));
  $("#refresh").onclick = home;
}
async function openChapter(code) {
  view().innerHTML = `<p class="empty">${esc(code)} laden…</p>`;
  try { const d = await readJson("lijst/" + code + ".json"); S.chapter = { code, titel: d.titel }; S.items = d.items || []; }
  catch (e) { return showError(e, () => openChapter(code)); }
  const saved = ls.get("pos_" + code, null); S.pos = 0;
  if (saved) { const k = S.items.findIndex(x => x.id === saved); if (k >= 0) S.pos = k; }
  S.noteOpen = false; nextOpen(0); render(true);
}
function nextOpen(dir) {
  const n = S.items.length; if (!n) return;
  if (dir === 0) { for (let k = 0; k < n; k++) { const j = (S.pos + k) % n; if (!isDone(S.items[j])) { S.pos = j; return; } } return; }
  for (let k = 1; k <= n; k++) { const j = ((S.pos + dir * k) % n + n) % n; if (!isDone(S.items[j])) { S.pos = j; return; } }
}
const fmt = s => !isFinite(s) ? "0:00" : Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
const textHtml = t => esc(t).replace(/“([^”]*)”?/g, m => "<q>" + m + "</q>");

function render(autoplay) {
  const c = S.chapter, it = S.items[S.pos];
  const open = S.items.filter(x => !isDone(x)).length;
  if (!it || !open) {
    stopAudio();
    view().innerHTML = `<div class="bar"><button class="link" id="back">‹ Hoofdstukken</button></div><p class="empty">Alles in ${esc(c.code)} is beoordeeld.</p>`;
    $("#back").onclick = home; return;
  }
  ls.set("pos_" + c.code, it.id);
  const done = S.items.length - open;
  view().innerHTML = `
    <div class="card-in" style="display:grid;gap:14px">
      <div class="bar"><button class="link" id="back">‹ ${esc(c.code)} · ${esc(c.titel || "")}</button><span class="progress">${done + 1} / ${S.items.length}</span></div>
      <div class="meta">
        <span class="eyebrow">Alinea ${it.nr}</span>
        <span class="chip ${esc(it.status)}">${it.status === "nieuw" ? "nieuwe versie" : it.status === "gewijzigd" ? "uitspraak gewijzigd" : "eerste opname"}</span>
        ${it.sprekers ? `<span class="speakers">🗣 ${esc(it.sprekers)}</span>` : ""}
      </div>
      <div class="player">
        <div class="prow">
          <button class="pp" id="pp" aria-label="Afspelen">▶</button>
          <div class="seek"><input type="range" id="seek" min="0" max="1000" value="0" aria-label="Positie"><div class="times"><span id="cur">0:00</span><span id="dur">…</span></div></div>
          <div class="pctl"><button class="small" id="back10" aria-label="10 seconden terug">↺ 10</button><button class="small" id="rate">${S.rate}×</button></div>
        </div>
        <div class="prow2"><label class="toggle"><input type="checkbox" id="auto" ${S.auto ? "checked" : ""}> Volgende automatisch afspelen</label><span class="sub" id="pstat"></span></div>
      </div>
      <p class="text">${textHtml(it.tekst)}</p>
      <div class="notebox" id="notebox" ${S.noteOpen ? "" : "hidden"}>
        <span class="eyebrow">Wat moet je nakijken?</span>
        <div class="quick">${["Uitspraak fout", "Verkeerde spreker", "Verkeerde emotie/tag", "Stem klinkt anders", "Te snel", "Hapering of ruis"].map(q => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
        <textarea id="note" placeholder="Bv. ‘Pholer’ klinkt als ‘Fooler’"></textarea>
        <div class="row"><button id="cancelnote">Annuleren</button><button id="savenote" class="a-check">Bewaar notitie</button></div>
      </div>
      <div class="row"><button class="link" id="prev">‹ Vorige</button><button class="link" id="skip">Overslaan ›</button></div>
    </div>
    <div class="actions" ${S.noteOpen ? "hidden" : ""}>
      <button id="ok" class="a-ok"><span class="ic">✓</span>Goed</button>
      <button id="redo" class="a-redo"><span class="ic">↻</span>Opnieuw</button>
      <button id="chk" class="a-check"><span class="ic">✎</span>Nakijken</button>
    </div>`;
  $("#back").onclick = home;
  $("#prev").onclick = () => { nextOpen(-1); S.noteOpen = false; render(S.auto); };
  $("#skip").onclick = () => { nextOpen(1); S.noteOpen = false; render(S.auto); };
  $("#ok").onclick = () => decide("goed", "");
  $("#redo").onclick = () => decide("opnieuw", "");
  $("#chk").onclick = () => { S.noteOpen = true; audio.pause(); render(false); setTimeout(() => $("#note") && $("#note").focus(), 50); };
  $("#pp").onclick = () => { S.interacted = true; if (audio.paused) play(); else audio.pause(); };
  $("#back10").onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 10); };
  $("#rate").onclick = () => { const r = [1, 1.25, 1.5, 0.85]; S.rate = r[(r.indexOf(S.rate) + 1) % r.length]; ls.set("rate", S.rate); audio.playbackRate = S.rate; $("#rate").textContent = S.rate + "×"; };
  $("#auto").onchange = e => { S.auto = e.target.checked; ls.set("auto", S.auto); };
  $("#seek").oninput = e => { if (audio.duration) audio.currentTime = e.target.value / 1000 * audio.duration; };
  if (S.noteOpen) {
    view().querySelectorAll("[data-q]").forEach(b => b.onclick = () => { const t = $("#note"); t.value = (t.value ? t.value.trim() + "; " : "") + b.dataset.q; t.focus(); });
    $("#cancelnote").onclick = () => { S.noteOpen = false; render(false); };
    $("#savenote").onclick = () => decide("nakijken", $("#note").value.trim());
  }
  loadAudio(it, autoplay && S.interacted);
  prefetchNext();
}

// ------------------------------------------------------------------ speler
let loadedId = null;
async function loadAudio(it, autoplay) {
  setMedia(it);
  if (loadedId === it.id + it.versie && audio.src) { syncUi(); if (autoplay) play(); return; }
  audio.pause(); loadedId = it.id + it.versie; status("Opname laden…");
  try {
    const url = await linkFor(it);
    if (loadedId !== it.id + it.versie) return;
    audio.src = url; audio.playbackRate = S.rate; status("");
    if (autoplay) play();
  } catch (e) { status(errText(e)); }
}
function play() { audio.playbackRate = S.rate; audio.play().catch(() => status("Tik op ▶ om af te spelen.")); }
function stopAudio() { audio.pause(); audio.removeAttribute("src"); loadedId = null; }
function status(t) { const el = $("#pstat"); if (el) el.textContent = t; }
function syncUi() {
  const pp = $("#pp"); if (!pp) return;
  pp.textContent = audio.paused ? "▶" : "❚❚"; pp.setAttribute("aria-label", audio.paused ? "Afspelen" : "Pauzeren");
  $("#cur").textContent = fmt(audio.currentTime); $("#dur").textContent = fmt(audio.duration);
  if (audio.duration) $("#seek").value = Math.round(audio.currentTime / audio.duration * 1000);
}
["play", "pause", "timeupdate", "loadedmetadata", "ended"].forEach(ev => audio.addEventListener(ev, syncUi));
audio.addEventListener("error", () => status("Deze opname kon niet geladen worden. Vernieuw de lijst."));
async function prefetchNext() {
  const save = S.pos; nextOpen(1); const nx = S.items[S.pos]; S.pos = save;
  if (nx && nx !== S.items[save]) linkFor(nx).catch(() => {});
}
function setMedia(it) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: `${S.chapter.code} · alinea ${it.nr}`, artist: it.sprekers || "Verteller", album: "Nevandar",
    artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }] });
  navigator.mediaSession.setActionHandler("play", () => play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("seekbackward", () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  navigator.mediaSession.setActionHandler("nexttrack", () => { nextOpen(1); render(true); });
  navigator.mediaSession.setActionHandler("previoustrack", () => { nextOpen(-1); render(true); });
}

// ------------------------------------------------------------------ keuzes
async function decide(keuze, notitie) {
  if (S.busy) return; S.busy = true; S.interacted = true;
  const it = S.items[S.pos], t = new Date().toISOString();
  const path = `${BASE}/keuzes/${it.id.replace(":", "_")}__${it.versie}__${keuze}__${t.replace(/[:.]/g, "-")}.json`;
  const btns = document.querySelectorAll(".actions button, #savenote"); btns.forEach(b => b.disabled = true);
  try {
    await dbx("content", "files/upload", { path, mode: "add", autorename: true, mute: true },
      JSON.stringify({ id: it.id, versie: it.versie, keuze, notitie, tijd: t }));
    S.decided.set(it.id, { versie: it.versie, keuze, path });
    S.last = { id: it.id, path };
    S.noteOpen = false; nextOpen(1); render(S.auto);
    toast(keuze === "goed" ? "Goedgekeurd" : keuze === "opnieuw" ? "Gaat opnieuw" : "Notitie bewaard", true);
  } catch (e) { btns.forEach(b => b.disabled = false); toast(errText(e)); }
  finally { S.busy = false; }
}
let toastTimer;
function toast(msg, undoable) {
  document.querySelectorAll(".toast").forEach(x => x.remove()); clearTimeout(toastTimer);
  const el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(msg)}</span>` + (undoable && S.last ? `<button id="undo">Ongedaan maken</button>` : "");
  document.body.appendChild(el);
  const u = el.querySelector("#undo"); if (u) u.onclick = undo;
  toastTimer = setTimeout(() => el.remove(), undoable ? 5000 : 7000);
}
async function undo() {
  const l = S.last; if (!l || S.busy) return; S.busy = true;
  document.querySelectorAll(".toast").forEach(x => x.remove());
  try {
    await dbx("rpc", "files/delete_v2", { path: l.path });
    S.decided.delete(l.id); const k = S.items.findIndex(x => x.id === l.id); if (k >= 0) S.pos = k; S.last = null; render(false); toast("Keuze ongedaan gemaakt");
  } catch (e) { toast("Ongedaan maken lukte niet. Mogelijk heeft de pc de keuze al ingelezen."); }
  finally { S.busy = false; }
}

// ------------------------------------------------------------------ menu & start
document.getElementById("menuBtn").onclick = () => {
  const m = document.createElement("div"); m.className = "menu";
  m.innerHTML = `<div class="sheet"><span class="eyebrow">Nevandar Luisteren</span>
    <button id="mHome">Hoofdstukken</button><button id="mOut">Afmelden bij Dropbox</button><button id="mClose" class="link">Sluiten</button></div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };
  $("#mClose", m).onclick = () => m.remove();
  $("#mHome", m).onclick = () => { m.remove(); home(); };
  $("#mOut", m).onclick = () => { m.remove(); ls.del("tok"); stopAudio(); loginScreen(); };
};
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
(async () => {
  try { await finishLogin(); }
  catch (e) { return loginScreen(errText(e)); }
  if (!ls.get("tok", null)) return loginScreen();
  home();
})();
