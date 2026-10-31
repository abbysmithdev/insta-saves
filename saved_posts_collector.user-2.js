// ==UserScript==
// @name         Saved Posts Collector
// @namespace    saved-posts-board
// @version      0.1.1
// @description  Collects your Instagram saved posts and hands them to your Saved Posts Board web app.
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
// @connect      cdninstagram.com
// @connect      fbcdn.net
// @connect      *
// @inject-into  content
// @run-at       document-end
// @noframes
// ==/UserScript==

/*
  HOW IT WORKS
  1. On instagram.com, on your Saved page, it adds a "Collect saves" button.
     Collecting scrolls the saved grid, records each post link + thumbnail URL
     in the order Instagram shows them (newest saved first), and stores that
     list in the userscript's own storage.
  2. On your Saved Posts Board page (any page with
     <meta name="saved-posts-board">), it passes stored lists to the page,
     fetches thumbnails, and remembers which posts the board already has so
     the next collect can stop early.

  If you host the board somewhere other than *.github.io, add a @match line
  for that address above.
*/
(function () {
  "use strict";

  /* ---------- storage + network helpers (work across userscript managers) ---------- */
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
  function fetchAsDataURL(url) {
    return new Promise((resolve, reject) => {
      const toData = (blob) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      };
      const req = xhr({
        method: "GET",
        url,
        responseType: "blob",
        timeout: 20000,
        onload: (r) => {
          if (r.status && r.status >= 400) return reject(new Error("HTTP " + r.status));
          let body = r.response;
          if (body instanceof ArrayBuffer) body = new Blob([body]);
          if (body && typeof body.size === "number" && body.size > 0) return toData(body);
          reject(new Error("Empty response"));
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Timeout")),
      });
      if (req === null) {
        // No cross-site request support: try a normal fetch (often blocked by CORS)
        fetch(url).then((r) => r.blob()).then(toData).catch(reject);
      }
    });
  }

  const isApp = !!document.querySelector('meta[name="saved-posts-board"]');
  const isInstagram = /(^|\.)instagram\.com$/.test(location.hostname);

  /* =========================================================================
     PART 1: on the Saved Posts Board page
     ========================================================================= */
  if (isApp) {
    const delivered = new Set();
    const thumbQueue = [];
    const queued = new Set();
    let active = 0;

    const toPage = (type, data) =>
      window.postMessage(JSON.stringify(Object.assign({ spb: true, dir: "toPage", type }, data || {})), location.origin);

    function queueThumbs(list) {
      (list || []).forEach((t) => {
        if (t && t.c && t.iu && !queued.has(t.c)) {
          queued.add(t.c);
          thumbQueue.push(t);
        }
      });
      pump();
    }
    function pump() {
      while (active < 3 && thumbQueue.length) {
        const t = thumbQueue.shift();
        active++;
        fetchAsDataURL(t.iu)
          .then((data) => toPage("thumb", { c: t.c, data }))
          .catch(() => {})
          .finally(() => { active--; pump(); });
      }
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
        const batches = await getVal("batches", []);
        await setVal("batches", batches.filter((b) => b.id !== m.id));
        queueThumbs(m.thumbs);
      }
      if (m.type === "fetchThumbs") queueThumbs(m.thumbs);
    });

    toPage("ready");
    return;
  }

  if (!isInstagram) return;

  /* =========================================================================
     PART 2: on instagram.com
     ========================================================================= */
  const SAVED_RE = /^\/([^/]+)\/saved(?:\/(.*))?$/;
  const POST_RE = /\/(p|reels?|tv)\/([A-Za-z0-9_-]{5,})/;

  // ---- floating UI in a shadow root so Instagram's CSS can't touch it ----
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:14px;bottom:84px;z-index:2147483647;display:none";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .wrap{font:500 14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
      .pill{background:#c2410c;color:#fff;border:0;border-radius:999px;padding:11px 18px;font:inherit;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}
      .panel{background:#fffdfa;color:#2a2420;border-radius:14px;padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.25);max-width:260px;display:none}
      .panel b{display:block;margin-bottom:2px}
      .row{display:flex;gap:8px;margin-top:8px}
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    // Instagram's alt text often starts "Photo by Name on Month D, YYYY..." (not guaranteed)
    let au = "";
    const am = /^(?:Photo|Video|Image|Reel|Post)(?: shared)? by (.+?)(?: on [A-Z][a-z]+ \d| tagging |\. |$)/.exec(cap);
    if (am) au = am[1].trim();
    return { c: m[2], k: m[1].startsWith("reel") ? "reel" : m[1], iu, cap, au };
  }

  async function collect(forceFull) {
    if (running) return;
    const sm = SAVED_RE.exec(location.pathname);
    if (!sm) return;
    const user = sm[1];
    const rest = (sm[2] || "").replace(/\/$/, "");

    // On the collections overview, hop into "All posts" first
    if (!rest && !postAnchors().length) {
      sessionStorage.setItem("spb-auto", forceFull ? "full" : "1");
      const link = document.querySelector('a[href*="/saved/all-posts"]');
      if (link) link.click();
      else location.assign(`/${user}/saved/all-posts/`);
      return;
    }

    const isAll = !rest || rest.startsWith("all-posts");
    let collection = null;
    if (!isAll) {
      const slug = decodeURIComponent(rest.split("/")[0] || "");
      collection = slug.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()) || "Instagram collection";
    }

    running = true;
    stopRequested = false;
    $("pill").style.display = "none";

    const known = new Set(await getVal("known", []));
    const full = forceFull || !!collection || known.size === 0;
    const items = [];
    const byCode = new Map();
    let knownStreak = 0;
    let idle = 0;
    let newCount = 0;
    let rounds = 0;

    const scan = () => {
      let found = 0;
      postAnchors().forEach((a) => {
        const it = readAnchor(a);
        if (!it) return;
        const prev = byCode.get(it.c);
        if (prev) {
          if (!prev.iu && it.iu) prev.iu = it.iu;
          return;
        }
        byCode.set(it.c, it);
        items.push(it);
        found++;
        if (known.has(it.c)) knownStreak++;
        else { knownStreak = 0; newCount++; }
      });
      return found;
    };

    window.scrollTo(0, 0);
    await sleep(800);
    while (!stopRequested) {
      rounds++;
      const found = scan();
      panel(
        collection ? `Collecting "${collection}"` : full ? "Collecting all saves" : "Checking for new saves",
        `${newCount} new so far${items.length !== newCount ? `, ${items.length} looked at` : ""}. Keep this tab open.`,
        [["Stop", () => (stopRequested = true)]]
      );
      if (!full && knownStreak >= 3) break;
      if (found === 0) idle++;
      else idle = 0;
      if (idle >= 6) break;
      if (rounds === 3 && items.length === 0) break;
      window.scrollBy(0, Math.max(600, window.innerHeight * 1.6));
      await sleep(1100 + Math.random() * 500);
    }
    scan();

    running = false;
    $("pill").style.display = "";

    if (!items.length) {
      panel("No posts found here", "Open your Saved posts (Profile > Saved > All posts) and try again. If you're on it, Instagram's page layout may have changed.", [["OK", () => panel()]]);
      return;
    }

    const batch = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), user, collection, full, items };
    const batches = await getVal("batches", []);
    batches.push(batch);
    await setVal("batches", batches);

    const app = await getVal("app", "");
    const summary = newCount ? `${newCount} new ${newCount === 1 ? "post" : "posts"}` : "No new posts";
    if (app) {
      panel("Done", `${summary}. Taking you back to your board...`, [["Stay here", () => { clearTimeout(go); panel(); }]]);
      var go = setTimeout(() => location.assign(app), 1400);
    } else {
      panel("Done", `${summary}. Open your Saved Posts Board to bring them in.`, [["OK", () => panel()]]);
    }
  }

  $("pill").onclick = () => collect(false);
  $("pill").oncontextmenu = (e) => { e.preventDefault(); collect(true); };

  // Try to find the signed-in user's profile link (Instagram shows "<name>'s profile picture")
  function guessUsername() {
    for (const img of document.querySelectorAll('img[alt$="profile picture"]')) {
      const a = img.closest('a[href^="/"]');
      const m = a && /^\/([A-Za-z0-9._]+)\/?$/.exec(a.getAttribute("href"));
      if (m && !["explore", "reels", "direct", "accounts"].includes(m[1])) return m[1];
    }
    return null;
  }

  // Arrived from "Get new saves" but not on the Saved page (e.g. username unknown)
  if (location.hash === "#spb-collect" && !SAVED_RE.test(location.pathname)) {
    history.replaceState(null, "", location.pathname + location.search);
    sessionStorage.setItem("spb-want", "1");
  }

  // Instagram is a single-page app: watch for page changes
  let lastPath = "";
  let guessTries = 0;
  setInterval(() => {
    const onSaved = SAVED_RE.test(location.pathname);
    const want = sessionStorage.getItem("spb-want");
    host.style.display = onSaved || want ? "" : "none";
    $("pill").style.display = onSaved && !running ? "" : "none";
    if (!onSaved && want) {
      const u = guessTries++ < 15 ? guessUsername() : null;
      if (u) {
        sessionStorage.removeItem("spb-want");
        sessionStorage.setItem("spb-auto", "1");
        location.assign(`/${u}/saved/all-posts/`);
        return;
      }
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        panel("Almost there", "Go to your profile and tap Saved. Collecting will start on its own.", [
          ["Cancel", () => { sessionStorage.removeItem("spb-want"); panel(); host.style.display = "none"; }],
        ]);
      }
      return;
    }
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (!onSaved) { panel(); return; }
      if (want) { sessionStorage.removeItem("spb-want"); sessionStorage.setItem("spb-auto", "1"); }
      if (!running) panel("", "", []);
      const auto = sessionStorage.getItem("spb-auto");
      const hashAuto = location.hash === "#spb-collect";
      if (auto || hashAuto) {
        sessionStorage.removeItem("spb-auto");
        if (hashAuto) history.replaceState(null, "", location.pathname + location.search);
        setTimeout(() => collect(auto === "full"), 1500);
      } else if (!running) {
        panel("Saved Posts Collector", "Tap Collect to send new saves to your board. On a collection, it brings that collection in as a board.", [
          ["Full rescan", () => collect(true)],
          ["Hide", () => panel()],
        ]);
      }
    }
  }, 700);
})();
