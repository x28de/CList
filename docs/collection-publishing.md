# CList Collection Publishing

Collections can be published to external services as shareable URLs, in standard formats readable by other CList users or any RSS/OPML-aware tool.

---

## Workflow

1. User opens a collection in the read pane
2. Clicks **Edit & Publish** (new button in collection detail header)
3. A **Collection Editor** panel opens:
   - Editable item list (reorder, remove, edit titles)
   - Format selector: JSON / OPML / HTML
   - Publish-to selector (configured publishing accounts)
   - **Publish** button → returns a URL
4. URL is shown with copy button and optional "Share to chat" shortcut
5. Published entry saved to kvstore for later retrieval

---

## Step 1 — `pastebin.mooc.ca` service

Tiny Flask app, deployed as a new container at `/srv/apps/pastebin/`.

| Endpoint | Auth | Description |
|---|---|---|
| `POST /` | Bearer token | Store content → `{id, url}` |
| `GET /{id}` | none | Serve content publicly |
| `PUT /{id}` | Bearer token | Update existing entry |
| `DELETE /{id}` | Bearer token | Remove entry |

Auth: kvstore JWT pattern (same as annotations, proxyp). SQLite backend.

---

## Step 2 — Publishing account types

New account types registered in the schema system (`window.CList.schemas`). All use permission flag **`b`** (bin/publish) so they appear in the publishing account selector.

| Type | kvKey | Credential field | Notes |
|---|---|---|---|
| `JSONBin` | Label (e.g. "My JSONBin") | API key (`X-Master-Key`) | `https://api.jsonbin.io/v3/b` |
| `Gist` | Label | GitHub personal access token | `https://api.github.com/gists` |
| `0x0` | Label | — (anonymous) | `https://0x0.st` |
| `CListBin` | Instance URL | Bearer token | Points to `pastebin.mooc.ca` or self-hosted |

Add `b` to the permissions flag table in `docs/accounts-structure.md`.

---

## Step 3 — Collection editor panel

New panel rendered in the feed container, accessed from the collection detail
header via a new **Edit & Publish** (`edit` icon) button.

### UI
- Editable item list: each item shows title (editable inline) + drag handle + remove button
- **Format** selector: JSON / OPML / HTML
- **Publish to** selector: dropdown of `b`-flagged accounts from `window.CList.accounts`
- **Publish** button
- After publishing: URL field (readonly, copy button) + Share to chat button (if chat active)

### State
The editor works on a mutable copy of `col.items` — original collection in kvstore is not modified unless the user explicitly saves.

---

## Step 4 — Publisher adapters (`collectionpub.js`)

One async function per service. Common signature:

```js
async function publishTo{Service}(title, items, format, accountData) → url
```

| Function | Service | Method |
|---|---|---|
| `publishToJsonBin` | JSONBin.io | `POST https://api.jsonbin.io/v3/b` with `X-Master-Key` header |
| `publishToGist` | GitHub Gist | `POST https://api.github.com/gists` with `Authorization: token` |
| `publishTo0x0` | 0x0.st | `POST https://0x0.st` as multipart/form-data |
| `publishToCListBin` | CListBin | `POST {instance}/` with `Authorization: Bearer` |

### Output formats

| Format | MIME | Description |
|---|---|---|
| JSON | `application/json` | `{title, items:[{title,url,author,date,...}]}` |
| OPML | `text/x-opml` | `<opml>` with `<outline>` per item — RSS-reader compatible |
| HTML | `text/html` | Styled page with title, linked item list, CList branding |

---

## Step 5 — Published pages registry

Each published page stored in kvstore as:

```
key:   published:{uuid}
value: { title, url, format, service, publishedAt, sourceCollection, serviceId }
```

`serviceId` is the service's own ID for the entry (needed for update/delete on JSONBin and Gist).

### My Pages view

New entry in `window.CList.loaders` (appears in the Load panel):

- Lists all `published:*` kvstore entries
- Each row: title, format badge, service badge, URL (clickable), action buttons:
  - **Re-open in editor** — loads the published data back into the collection editor
  - **Copy URL**
  - **Delete** (calls the service's delete endpoint + removes kvstore entry)

---

## Step 6 — Import flow

Accept a published collection URL and import it as a local collection.

Entry points:
- Paste URL into a new "Import from URL" input in the Collections view
- Receive URL via chat share card (kind: `collection`, with a `publishedUrl` field)

Flow:
1. Fetch URL → detect format from `Content-Type` or URL extension
2. Parse JSON / OPML / HTML
3. Show a preview (title + item count)
4. User clicks **Save as collection** → saves to kvstore under a chosen name

---

## Files to create / modify

| File | Change |
|---|---|
| `/srv/apps/pastebin/` | New app — Flask, SQLite, Docker |
| `/srv/proxy/Caddyfile` | Add `pastebin.mooc.ca` route |
| `js/collectionpub.js` | New — publisher adapters + format renderers |
| `js/collections.js` | Add Edit & Publish button, editor panel, import input, My Pages loader |
| `index.html` | Add `collectionpub.js` script tag |
| `docs/accounts-structure.md` | Add `b` flag, JSONBin/Gist/0x0/CListBin schema entries |
| `CLAUDE.md` | Add pastebin.mooc.ca to services table |
