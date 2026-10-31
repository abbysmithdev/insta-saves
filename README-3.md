# Saved Posts Board

A web app for browsing and sorting Instagram saved posts and collections, plus a small userscript that collects them from Instagram's website.

## Files

| File | What it is |
|---|---|
| `index.html` | The web app. Hosted on GitHub Pages. |
| `saved_posts_collector.user.js` | The helper script. Runs on instagram.com and on the app page. |

## Hosting

1. Put both files in a repo and turn on GitHub Pages.
2. The app lives at `https://<you>.github.io/<repo>/`.
3. The script install link is `https://<you>.github.io/<repo>/saved_posts_collector.user.js`. The address has to end in `.user.js`, so the script managers can recognize it.

If you use a custom domain instead of `github.io`, add a `@match` line for it at the top of the script.

## Installing the script

**iPhone / iPad:** install the free **Userscripts** app. Then go to Settings > Apps > Safari > Extensions > Userscripts, turn it on, and allow it on all websites. Open the `.user.js` link in Safari, tap the extensions button in the address bar, pick Userscripts, and install.

**Android:** install Firefox and add the **Violentmonkey** add-on. Open the `.user.js` link and confirm the install.

**Mac:** use Safari with the Userscripts app (same as iPhone), or Chrome / Firefox with Violentmonkey or Tampermonkey.

After installing, open the app and reload it. The dot at the bottom of the menu turns green ("Collector connected").

## Using it

- **Get new saves:** opens Instagram's Saved > All posts page. The collector scrolls through, then sends you back to the app.
  - The first run reads everything.
  - Later runs stop once they reach posts the app already has.
- **Sync** (next to Collections in the sidebar, also in Settings): visits each of your Instagram collections and mirrors them in the app. Posts removed from a collection on Instagram come off it here too, and deleted collections disappear.
- **Accounts:** the saved grid doesn't say who posted what, so while the app is open, the collector looks up each post's @handle and name in the background, one every couple of seconds. If Instagram asks it to slow down, it pauses until the next visit.
- **Viewing posts:** tapping a post opens Instagram's official embed, so photos, carousels and reels can be viewed and played in the app. This only works for public accounts; private posts need **Open on Instagram**.
- **Full rescan:** a button on the collector's panel on Instagram. Use it after a collector update, or if a run was interrupted.
- **Import Instagram export** (Settings, optional): the "Download your information" export (JSON format, with Saved included) has exact save dates and handles.

## Where data lives

- Posts, collections and notes are stored in the browser's localStorage, on that one device.
- Thumbnails are stored in IndexedDB.
- Use **Backup & restore** in the app now and then.

## When something breaks

The script finds posts by reading the links on Instagram's Saved page (`/p/`, `/reel/`, `/tv/`). If Instagram changes that page, the script may find nothing and will say so. The parts to look at are `postAnchors()` and `readAnchor()`.
