// ==UserScript==
// @name         Saved Posts Collector
// @namespace    saved-posts-board
// @version      0.2.1
// @description  Collects your Instagram saved posts and collections and hands them to your Saved Posts Board web app.
// @match        https://www.instagram.com/*
// @match        https://*.github.io/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      instagram.com
// @connect      cdninstagram.com
// @connect      fbcdn.net
// @connect      *
// @inject-into  content
// @run-at       document-end
// @noframes
// ==/UserScript==

/*
  WHAT THIS DOES
  On instagram.com (your Saved pages):
    - "Collect saves": scrolls All posts and records each post (newest saved first).
    - "Sync collections": visits each of your collections and records what's in it.
    Results are stored in this script's own storage.
  On your Saved Posts Board page (<meta name="saved-posts-board">):
    - Hands the stored results to the page.
    - Downloads thumbnails.
    - Looks up each post's account handle and name, one post at a time, slowly.

  If you host the board somewhere other than *.github.io, add a @match line for it.
*/
(function () {
  "use strict";

  /* ---------------- helpers that work across userscript managers ---------------- */
  const hasGM = typeof GM !== "undefined" && GM;
  async function getVal(key, def) {
    try {
      if (hasGM && GM.getValue) return await GM.getValue(key, def);
      if (typeof GM_getValue === "function") return GM_getValue(key, def);
    } catch (e) {}
    return def;
  }
  async function setVal(key, val) {
    if (hasGM && GM.setValue) return GM.setValue(key, val);
    if (typeof GM_setValue === "function") return GM_setValue(key, val);
    throw new Error("No userscript storage available");
  }
  function xhr(details) {
    if (hasGM && GM.xmlHttpRequest) return GM.xmlHttpRequest(details);
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest(details);
    return null;
  }
  function request(url, type, anonymous) {
    return new Promise((resolve, reject) => {
      const req = xhr({
        method: "GET",
        url,
        anonymous: !!anonymous,
        responseType: type === "blob" ? "blob" : "text",
        timeout: 20000,
        onload: (r) => resolve({ status: r.status, body: type === "blob" ? r.response : r.responseText }),
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Timeout")),
      });
      if (req === null) {
        fetch(url, { credentials: anonymous ? "omit" : "include" })
          .then(async (r) => resolve({ status: r.status, body: type === "blob" ? await r.blob() : await r.text() }))
          .catch(reject);
      }
    });
  }
  function blobToDataURL(body) {
    return new Promise((resolve, reject) => {
      if (body instanceof ArrayBuffer) body = new Blob([body]);
      if (!body || !body.size) return reject(new Error("Empty"));
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(body);
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Run storage read-modify-write steps one at a time so they can't overwrite each other
  let lock = Promise.resolve();
  const serial = (fn) => (lock = lock.then(fn, fn));
  const decodeHTML = (s) => {
    const t = document.createElement("textarea");
    t.innerHTML = s;
    return t.value;
  };

  const isApp = !!document.querySelector('meta[name="saved-posts-board"]');
  const isInstagram = /(^|\.)instagram\.com$/.test(location.hostname);

  /* =========================================================================
     PART 1: on the Saved Posts Board page
     ========================================================================= */
  if (isApp) {
    const delivered = new Set();
    const toPage = (type, data) =>
      window.postMessage(JSON.stringify(Object.assign({ spb: true, dir: "toPage", type }, data || {})), location.origin);

    /* ---- thumbnails: up to 3 at a time ---- */
    const thumbQueue = [];
    const thumbSeen = new Set();
    let thumbActive = 0;
    function queueThumbs(list) {
      (list || []).forEach((t) => {
        if (t && t.c && t.iu && !thumbSeen.has(t.c)) {
          thumbSeen.add(t.c);
          thumbQueue.push(t);
        }
      });
      pumpThumbs();
    }
    function pumpThumbs() {
      while (thumbActive < 3 && thumbQueue.length) {
        const t = thumbQueue.shift();
        thumbActive++;
        request(t.iu, "blob")
          .then((r) => {
            if (r.status >= 400) throw new Error("HTTP " + r.status);
            return blobToDataURL(r.body);
          })
          .then((data) => toPage("thumb", { c: t.c, data }))
          .catch(() => {})
          .finally(() => { thumbActive--; pumpThumbs(); });
      }
    }

    /* ---- account lookups: one at a time, slowly ---- */
    const lookQueue = [];
    const lookSeen = new Set();
    let looking = false;
    let lookPaused = false;
    let viewer = "";
    let logged = 0;
    function meta(html, key) {
      const a = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, "i").exec(html);
      const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, "i").exec(html);
      const v = (a && a[1]) || (b && b[1]);
      return v ? decodeHTML(v) : "";
    }
    // Pull the post owner's details out of an embedded JSON block like "owner":{...,"username":"x","full_name":"y"}
    function ownerBlock(html) {
      const i = html.indexOf('"owner":{');
      if (i < 0) return { u: "", nm: "" };
      const chunk = html.slice(i, i + 2500);
      const u = /"username":"([A-Za-z0-9._]+)"/.exec(chunk);
      const n = /"full_name":"((?:[^"\\]|\\.)*)"/.exec(chunk);
      let nm = "";
      if (n) { try { nm = JSON.parse('"' + n[1] + '"'); } catch (e) {} }
      return { u: u ? u[1] : "", nm };
    }
    function parsePost(html) {
      let u = "", nm = "", how = "";
      const ogUrl = meta(html, "og:url");
      let m = /instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reels?|tv)\//.exec(ogUrl);
      if (m) { u = m[1]; how = "og:url"; }
      if (!u) {
        const d = meta(html, "og:description") || meta(html, "description");
        m = / - ([A-Za-z0-9._]+) on [A-Z][a-z]+ \d/.exec(d);
        if (m) { u = m[1]; how = "description"; }
      }
      const title = meta(html, "og:title");
      m = /^(.*?) (?:on Instagram|\(@)/.exec(title);
      if (m) nm = m[1].trim();
      if (!u || !nm) {
        const o = ownerBlock(html);
        if (!u && o.u) { u = o.u; how = "owner"; }
        if (!nm && o.nm) nm = o.nm;
      }
      return { u, nm, how };
    }
    function parseEmbed(html) {
      const m = /class="[^"]*UsernameText[^"]*"[^>]*>([A-Za-z0-9._]+)</.exec(html);
      if (m) return { u: m[1], nm: "", how: "embed" };
      const o = ownerBlock(html);
      return { u: o.u, nm: o.nm, how: o.u ? "embed-owner" : "" };
    }
    function queueLookups(list) {
      (list || []).forEach((t) => {
        if (t && t.c && !lookSeen.has(t.c)) {
          t.viewer = (t.viewer || viewer || "").toLowerCase();
          lookSeen.add(t.c);
          lookQueue.push(t);
        }
      });
      if (!looking && !lookPaused) runLookups();
    }
    async function runLookups() {
      looking = true;
      let errorsInARow = 0;
      while (lookQueue.length && !lookPaused) {
        const t = lookQueue.shift();
        const path = (t.k === "reel" ? "reel" : "p") + "/" + t.c + "/";
        let res = { u: "", nm: "", how: "" };
        const ok = (r) => r.u && r.u.toLowerCase() !== t.viewer;   // never accept the signed-in viewer's own handle
        try {
          // Ask as a logged-out visitor: those pages carry the post's share-preview info
          const r = await request("https://www.instagram.com/" + path, "text", true);
          if (r.status === 429 || /Please wait a few minutes/i.test(r.body || "")) {
            lookPaused = true;
            toPage("lookupPaused", {});
            break;
          }
          if (r.status < 400) {
            const a = parsePost(r.body || "");
            if (ok(a)) res = a;
            else if (a.nm) res.nm = a.nm;
          }
          if (!ok(res)) {
            await sleep(700);
            const e = await request("https://www.instagram.com/" + path + "embed/captioned/", "text", true);
            if (e.status < 400) {
              const em = parseEmbed(e.body || "");
              if (ok(em)) { res.u = em.u; res.how = em.how; if (!res.nm) res.nm = em.nm; }
            }
          }
          if (!ok(res)) res.u = "";
          errorsInARow = 0;
        } catch (e) {
          errorsInARow++;
        }
        if (logged < 8) { logged++; console.log("[Saved Posts Collector] lookup", t.c, res.u ? "@" + res.u + " via " + res.how : "no handle found", res.nm ? "(" + res.nm + ")" : ""); }
        toPage("meta", res.u || res.nm ? { c: t.c, u: res.u, nm: res.nm } : { c: t.c, fail: true });
        if (errorsInARow >= 5) { lookPaused = true; toPage("lookupPaused", {}); break; }
        await sleep(1400 + Math.random() * 900);
      }
      looking = false;
    }

    async function deliver() {
      const batches = await getVal("batches", []);
      batches.forEach((b) => {
        if (!delivered.has(b.id)) {
          delivered.add(b.id);
          toPage("import", { batch: b });
        }
      });
    }

    window.addEventListener("message", async (e) => {
      if (e.origin !== location.origin || typeof e.data !== "string") return;
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (!m || !m.spb || m.dir !== "toScript") return;
      if (m.type === "hello") {
        await setVal("known", m.known || []);
        if (m.app) await setVal("app", m.app);
        await deliver();
      }
      if (m.type === "ack") {
        await serial(async () => {
          const batches = await getVal("batches", []);
          await setVal("batches", batches.filter((b) => b.id !== m.id));
        });
        queueThumbs(m.thumbs);
      }
      if (m.type === "fetchThumbs") queueThumbs(m.thumbs);
      if (m.type === "lookup") { if (m.viewer) viewer = m.viewer; queueLookups(m.items); }
    });

    toPage("ready", { version: "0.2.1" });
    return;
  }

  if (!isInstagram) return;

  /* =========================================================================
     PART 2: on instagram.com
     ========================================================================= */
  const SAVED_RE = /^\/([^/]+)\/saved(?:\/(.*))?$/;
  const POST_RE = /\/(p|reels?|tv)\/([A-Za-z0-9_-]{5,})/;
  const JOB_KEY = "spb-job";

  /* ---- floating UI in a shadow root so Instagram's CSS can't touch it ---- */
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:14px;bottom:84px;z-index:2147483647;display:none";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .wrap{font:500 14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
      .pill{background:#c2410c;color:#fff;border:0;border-radius:999px;padding:11px 18px;font:inherit;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}
      .panel{background:#fffdfa;color:#2a2420;border-radius:14px;padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.25);max-width:270px;display:none}
      .panel b{display:block;margin-bottom:2px}
      .row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
      .sm{background:#f1ebe4;border:0;border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;cursor:pointer;color:#2a2420}
      .muted{color:#7b7068;font-size:12px}
    </style>
    <div class="wrap">
      <div class="panel" id="panel"><b id="ptitle"></b><div id="ptext" class="muted"></div><div class="row" id="prow"></div></div>
      <button class="pill" id="pill">Collect saves</button>
    </div>`;
  document.documentElement.appendChild(host);
  const $ = (id) => root.getElementById(id);
  function panel(title, text, buttons) {
    $("panel").style.display = title ? "block" : "none";
    $("ptitle").textContent = title || "";
    $("ptext").textContent = text || "";
    const row = $("prow");
    row.innerHTML = "";
    (buttons || []).forEach(([label, fn]) => {
      const b = document.createElement("button");
      b.className = "sm";
      b.textContent = label;
      b.onclick = fn;
      row.appendChild(b);
    });
  }

  let running = false;
  let stopRequested = false;
  const getJob = () => { try { return JSON.parse(sessionStorage.getItem(JOB_KEY) || "null"); } catch (e) { return null; } };
  const setJob = (j) => (j ? sessionStorage.setItem(JOB_KEY, JSON.stringify(j)) : sessionStorage.removeItem(JOB_KEY));

  function postAnchors() {
    const scope = document.querySelector("main") || document;
    return [...scope.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/tv/"]')];
  }
  function readAnchor(a) {
    const m = POST_RE.exec(a.getAttribute("href") || "");
    if (!m) return null;
    const img = a.querySelector("img");
    let iu = img ? img.currentSrc || img.src || "" : "";
    if (iu.startsWith("data:")) iu = "";
    const cap = img ? (img.getAttribute("alt") || "").trim() : "";
    let au = "";
    const am = /^(?:Photo|Video|Image|Reel|Post)(?: shared)? by (.+?)(?: on [A-Z][a-z]+ \d| tagging |\. |$)/.exec(cap);
    if (am) au = am[1].trim();
    // Saved-grid links usually all look like /p/..., so read the tile's icon label instead
    const labels = [...a.querySelectorAll("[aria-label], svg title")]
      .map((el) => el.getAttribute("aria-label") || el.textContent || "")
      .join(" ");
    let k = m[1].startsWith("reel") ? "reel" : m[1];
    if (k === "p") {
      if (/clip|reel/i.test(labels)) k = "reel";
      else if (/video/i.test(labels)) k = "tv";
      else if (/carousel|album|multiple/i.test(labels)) k = "car";
    }
    return { c: m[2], k, iu, cap, au, lbl: labels.slice(0, 60) };
  }
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(300);
    }
    return fn();
  }

  /* Scroll the current grid and gather posts. Returns {items, newCount, stopped}. */
  async function gather({ full, label }) {
    const known = new Set(await getVal("known", []));
    if (known.size === 0) full = true;
    const items = [];
    const byCode = new Map();
    let knownStreak = 0, idle = 0, newCount = 0;
    stopRequested = false;
    const scan = () => {
      let found = 0;
      postAnchors().forEach((a) => {
        const it = readAnchor(a);
        if (!it) return;
        const prev = byCode.get(it.c);
        if (prev) { if (!prev.iu && it.iu) prev.iu = it.iu; return; }
        byCode.set(it.c, it);
        items.push(it);
        found++;
        if (known.has(it.c)) knownStreak++;
        else { knownStreak = 0; newCount++; }
      });
      return found;
    };
    window.scrollTo(0, 0);
    await waitFor(() => postAnchors().length, 8000);
    while (!stopRequested) {
      const found = scan();
      panel(label, `${newCount} new, ${items.length} looked at. Keep this tab open.`, [["Stop", () => (stopRequested = true)]]);
      if (!full && knownStreak >= 3) break;
      idle = found === 0 ? idle + 1 : 0;
      if (idle >= 6) break;
      if (items.length === 0 && idle >= 2) break;
      window.scrollBy(0, Math.max(600, window.innerHeight * 1.6));
      await sleep(1100 + Math.random() * 500);
    }
    scan();
    try {
      const tally = {};
      items.forEach((it) => (tally[it.k] = (tally[it.k] || 0) + 1));
      console.log("[Saved Posts Collector]", label, "types:", JSON.stringify(tally), "sample icon labels:", items.filter((i) => i.lbl).slice(0, 5).map((i) => i.lbl));
    } catch (e) {}
    return { items, newCount, stopped: stopRequested };
  }
  async function storeBatch(b) {
    b.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    b.at = Date.now();
    await serial(async () => {
      const batches = await getVal("batches", []);
      batches.push(b);
      await setVal("batches", batches);
    });
  }
  async function goToApp(title, text) {
    const app = await getVal("app", "");
    if (app) {
      let go = null;
      panel(title, text + " Taking you back to your board...", [["Stay here", () => { clearTimeout(go); panel(); }]]);
      go = setTimeout(() => location.assign(app), 1400);
    } else {
      panel(title, text + " Open your Saved Posts Board to bring them in.", [["OK", () => panel()]]);
    }
  }
  function savedParts() {
    const sm = SAVED_RE.exec(location.pathname);
    if (!sm) return null;
    const rest = (sm[2] || "").replace(/\/$/, "");
    return { user: sm[1], rest, isOverview: !rest, isAll: rest.startsWith("all-posts") };
  }
  function collectionName(rest) {
    const slug = decodeURIComponent(rest.split("/")[0] || "");
    return slug.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()) || "Instagram collection";
  }

  /* ---- Collect saves (All posts, or the one collection you're looking at) ---- */
  async function collect(full) {
    if (running) return;
    const sp = savedParts();
    if (!sp) return;
    if (sp.isOverview && !postAnchors().length) {
      setJob({ mode: "collect", full: !!full });
      const link = document.querySelector('a[href*="/saved/all-posts"]');
      if (link) link.click();
      else location.assign(`/${sp.user}/saved/all-posts/`);
      return;
    }
    running = true;
    $("pill").style.display = "none";
    const collection = sp.isOverview || sp.isAll ? null : collectionName(sp.rest);
    const r = await gather({ full: full || !!collection, label: collection ? `Collecting "${collection}"` : full ? "Collecting all saves" : "Checking for new saves" });
    running = false;
    if (!r.items.length && !collection) {
      panel("No posts found here", "Open your Saved posts (Profile > Saved > All posts) and try again. If you're on it, Instagram's page layout may have changed.", [["OK", () => panel()]]);
      return;
    }
    await storeBatch({ user: sp.user, collection, complete: !r.stopped, full: !!full, items: r.items });
    await goToApp("Done", r.newCount ? `${r.newCount} new ${r.newCount === 1 ? "post" : "posts"}.` : "No new posts.");
  }

  /* ---- Sync collections: visit each collection and record what's in it ---- */
  function findCollections(user) {
    const out = [];
    const seen = new Set();
    const re = new RegExp(`^/${user.replace(/\./g, "\\.")}/saved/([^/]+)/(\\d+)/?$`);
    document.querySelectorAll('a[href*="/saved/"]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = re.exec(href);
      if (!m || m[1] === "all-posts" || seen.has(href)) return;
      seen.add(href);
      const text = (a.innerText || a.getAttribute("aria-label") || "").split("\n").map((s) => s.trim()).filter(Boolean)[0];
      out.push({ path: href.endsWith("/") ? href : href + "/", name: text || collectionName(m[1]) });
    });
    return out;
  }
  async function syncStep() {
    const job = getJob();
    const sp = savedParts();
    if (!job || job.mode !== "sync" || !sp) return;
    running = true;
    $("pill").style.display = "none";
    if (!job.targets) {
      if (!sp.isOverview) { location.assign(`/${sp.user}/saved/`); return; }
      panel("Syncing collections", "Finding your collections...", []);
      await waitFor(() => findCollections(sp.user).length, 8000);
      const targets = findCollections(sp.user);
      if (!targets.length) {
        setJob(null);
        running = false;
        panel("No collections found", "If you do have collections, Instagram's page layout may have changed.", [["OK", () => panel()]]);
        return;
      }
      job.targets = targets;
      job.idx = 0;
      job.user = sp.user;
      setJob(job);
      location.assign(targets[0].path);
      return;
    }
    const t = job.targets[job.idx];
    if (!t) return;
    if (location.pathname.replace(/\/?$/, "/") !== t.path) { location.assign(t.path); return; }
    const r = await gather({ full: true, label: `Collection ${job.idx + 1} of ${job.targets.length}: "${t.name}"` });
    if (r.stopped) {
      setJob(null);
      running = false;
      panel("Sync stopped", "Collections finished so far were saved.", [["OK", () => panel()]]);
      await storeBatch({ user: job.user, collection: t.name, complete: false, items: r.items });
      return;
    }
    await storeBatch({ user: job.user, collection: t.name, complete: true, items: r.items });
    job.idx++;
    if (job.idx < job.targets.length) {
      setJob(job);
      location.assign(job.targets[job.idx].path);
      return;
    }
    await storeBatch({ user: job.user, kind: "collections", names: job.targets.map((x) => x.name) });
    setJob(null);
    running = false;
    await goToApp("Collections synced", `${job.targets.length} ${job.targets.length === 1 ? "collection" : "collections"} updated.`);
  }
  function startSync() {
    const sp = savedParts();
    setJob({ mode: "sync" });
    if (sp && sp.isOverview) syncStep();
    else location.assign(`/${sp ? sp.user : ""}/saved/`);
  }

  /* ---- find the signed-in username from the page ("<name>'s profile picture") ---- */
  function guessUsername() {
    for (const img of document.querySelectorAll('img[alt$="profile picture"]')) {
      const a = img.closest('a[href^="/"]');
      const m = a && /^\/([A-Za-z0-9._]+)\/?$/.exec(a.getAttribute("href"));
      if (m && !["explore", "reels", "direct", "accounts"].includes(m[1])) return m[1];
    }
    return null;
  }

  $("pill").onclick = () => collect(false);

  /* ---- arriving from the app: #spb-collect or #spb-sync ---- */
  const hashMode = location.hash === "#spb-collect" ? "collect" : location.hash === "#spb-sync" ? "sync" : null;
  if (hashMode) {
    history.replaceState(null, "", location.pathname + location.search);
    if (SAVED_RE.test(location.pathname)) {
      if (hashMode === "sync") setJob({ mode: "sync" });
      else setJob({ mode: "collect", full: false });
    } else sessionStorage.setItem("spb-want", hashMode);
  }

  /* ---- Instagram is a single-page app: watch for page changes ---- */
  let lastPath = "";
  let guessTries = 0;
  setInterval(() => {
    const sp = savedParts();
    const want = sessionStorage.getItem("spb-want");
    host.style.display = sp || want ? "" : "none";
    $("pill").style.display = sp && !running ? "" : "none";

    if (!sp && want) {
      const u = guessTries++ < 15 ? guessUsername() : null;
      if (u) {
        sessionStorage.removeItem("spb-want");
        setJob(want === "sync" ? { mode: "sync" } : { mode: "collect", full: false });
        location.assign(want === "sync" ? `/${u}/saved/` : `/${u}/saved/all-posts/`);
        return;
      }
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        panel("Almost there", "Go to your profile and tap Saved. It will start on its own.", [
          ["Cancel", () => { sessionStorage.removeItem("spb-want"); panel(); host.style.display = "none"; }],
        ]);
      }
      return;
    }
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (!sp) { panel(); return; }
    if (want) {
      sessionStorage.removeItem("spb-want");
      setJob(want === "sync" ? { mode: "sync" } : { mode: "collect", full: false });
    }
    if (running) return;
    const job = getJob();
    if (job && job.mode === "sync") { setTimeout(syncStep, 1200); return; }
    if (job && job.mode === "collect") {
      setJob(null);
      setTimeout(() => collect(job.full), 1200);
      return;
    }
    panel("Saved Posts Collector", sp.isOverview || sp.isAll
      ? "Collect sends new saves to your board."
      : "Collect brings this collection in.", [
      ["Full rescan", () => collect(true)],
      ["Sync collections", startSync],
      ["Hide", () => panel()],
    ]);
  }, 700);
})();
