# CrossPoint clippings (KOReader plugin)

Two-way sync of highlights and notes between KOReader and a CrossPoint Sync server.

## Install
Copy the `crosspointclippings.koplugin` folder into `koreader/plugins/` (Kindle: `/mnt/us/koreader/plugins/`) and restart KOReader.

## Setup
1. Tools → Progress sync → Custom sync server → your server URL. Log in.
2. Progress sync → Document matching method → **Binary** (same on every device, CrossPoint too).
3. Open a book → Tools → CrossPoint clippings → Sync clippings now. Optionally enable sync on open/close.

## How it works
- Uploads KOReader highlights with spine + text, plus exact xpointers (needs the forked server; detected via /healthz).
- Places clippings from other devices by xpointer, or by searching their text in the right chapter, then writes the xpointers back.
- Unplaceable clippings (e.g. a different edition) are kept and retried on later syncs.
- Works with the stock server too, without xpointer storage: every KOReader device then places clippings by text search.

Only reflowable documents (EPUB, FB2, …). Debug output goes to `crash.log` with the `CrossPointClippings:` prefix.
