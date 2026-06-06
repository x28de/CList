console.log('[collections] collections.js loading');
// collections.js — kvstore-backed collections for CList
// Depends on: utilities.js (escapeHtml, getSiteSpecificCookie, showStatusMessage),
//             kvstore.js (getEncKey), crypto_utils.js (encryptWithKey, decryptWithKey),
//             editors.js (currentEditor), tinymce.js (displayReferences)
// window.CList.config.flaskSiteUrl is a global set in index.html

// ── Collections ──────────────────────────────────────────────────────────────
// Items are saved directly to kvstore under keys collection:<name>.
// Collection names are restricted to letters, digits, #, -, _, and spaces.

const _COLLECTION_NAME_RE = /^[a-zA-Z0-9#\-_ ]+$/;

let _collectionsPopstateHandler = null;
let _activeCollection = null; // set by load button; read by showCollectionEditorPanel
let _draftItems = null;       // live reference to the editor's item array; set by _renderCollectionEditor
let _refreshEditor = null;    // callback to re-render the entry list; set by _renderCollectionEditor

// Format registry — add an entry here to expose a new output format in the collection editor.
// Each entry: { label, ext, mimeType, serialize(name, items) → string }
const collectionFormats = {
    rss: {
        label: 'RSS', ext: 'xml', mimeType: 'application/rss+xml',
        serialize(name, items) {
            const safe = items.filter(i => i.url);
            const itemsXml = safe.map(item => {
                const t = escapeHtml(_collectionItemDisplayTitle(item) || item.url);
                const l = escapeHtml(item.url);
                const d = item.summary    ? `\n    <description>${escapeHtml(item.summary)}</description>`       : '';
                const a = item.author_name ? `\n    <author>${escapeHtml(item.author_name)}</author>`            : '';
                return `  <item>\n    <title>${t}</title>\n    <link>${l}</link>${d}${a}\n  </item>`;
            }).join('\n');
            return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>${escapeHtml(name)}</title>\n    <link></link>\n    <description>${escapeHtml(name)}</description>\n${itemsXml}\n  </channel>\n</rss>`;
        },
    },
    opml: {
        label: 'OPML', ext: 'opml', mimeType: 'text/x-opml',
        serialize(name, items) {
            const safe = items.filter(i => i.url);
            const outlines = safe.map(item => {
                const t = escapeHtml(_collectionItemDisplayTitle(item) || item.url);
                const u = escapeHtml(item.url);
                return `    <outline text="${t}" type="rss" xmlUrl="${u}" htmlUrl="${u}"/>`;
            }).join('\n');
            return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${escapeHtml(name)}</title>\n    <dateCreated>${new Date().toUTCString()}</dateCreated>\n  </head>\n  <body>\n${outlines}\n  </body>\n</opml>`;
        },
    },
    json: {
        label: 'JSON', ext: 'json', mimeType: 'application/json',
        serialize(name, items) {
            return JSON.stringify({
                title: name,
                publishedAt: new Date().toISOString(),
                items: items.filter(i => i.url).map(item => ({
                    title:      _collectionItemDisplayTitle(item) || '',
                    url:        item.url,
                    author:     item.author_name || '',
                    summary:    item.summary     || '',
                    created_at: item.created_at  || '',
                })),
            }, null, 2);
        },
    },
    html: {
        label: 'HTML', ext: 'html', mimeType: 'text/html',
        serialize(name, items) {
            const rows = items.filter(i => i.url).map(item => {
                const t = escapeHtml(_collectionItemDisplayTitle(item) || item.url);
                const u = escapeHtml(item.url);
                const a = item.author_name ? ` — ${escapeHtml(item.author_name)}` : '';
                return `  <li><a href="${u}">${t}</a>${a}</li>`;
            }).join('\n');
            return `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>${escapeHtml(name)}</title>\n</head>\n<body>\n<h1>${escapeHtml(name)}</h1>\n<ul>\n${rows}\n</ul>\n</body>\n</html>`;
        },
    },
    md: {
        label: 'Markdown', ext: 'md', mimeType: 'text/markdown',
        serialize(name, items) {
            const lines = items.filter(i => i.url).map(item => {
                const t = _collectionItemDisplayTitle(item) || item.url;
                const a = item.author_name ? ` — ${item.author_name}` : '';
                return `- [${t}](${item.url})${a}`;
            });
            return `# ${name}\n\n${lines.join('\n')}\n`;
        },
    },
    text: {
        label: 'Text', ext: 'txt', mimeType: 'text/plain',
        serialize(name, items) {
            const lines = items.filter(i => i.url).map(item => {
                const t = _collectionItemDisplayTitle(item) || item.url;
                const a = item.author_name ? ` (${item.author_name})` : '';
                return `${t}${a}\n${item.url}`;
            });
            return `${name}\n${'='.repeat(name.length || 10)}\n\n${lines.join('\n\n')}\n`;
        },
    },
};

// Returns a human-readable display title for a collection item.
// Social platform items (Mastodon, Bluesky) show "Platform (@handle)" instead
// of the bare service name stored in item.title.
function _collectionItemDisplayTitle(item) {
    const isSocial = item.service === 'Mastodon' || item.service === 'Bluesky'
                  || item.title   === 'Mastodon' || item.title   === 'Bluesky';
    if (!isSocial) return item.title || item.url || '';
    const platform = item.title || item.service || 'Social';
    if (item.author_id)   return `${platform} (@${item.author_id})`;
    if (item.author_name) return `${platform} (${item.author_name})`;
    return platform;
}

// Called from collect buttons on all feed item types.
window.collectItem = function(itemId, opts) {
    _showCollectionPicker(itemId, opts);
};

async function _showCollectionPicker(itemId, opts = {}) {
    const PICKER_CLASS = 'collection-picker';
    const pickerId     = `collection-picker-${itemId}`;

    // Toggle: if this picker is already open, close it
    const existing = document.getElementById(pickerId);
    document.querySelectorAll('.' + PICKER_CLASS).forEach(el => el.remove());
    if (existing) return;

    const token = getSiteSpecificCookie(window.CList.config.flaskSiteUrl, window.CList.keys.ACCESS_TOKEN);
    if (!token) { showStatusMessage('Please log in to save to a collection.'); return; }

    const specificEl = document.getElementById(itemId);
    if (!specificEl) return;
    const statusBox = specificEl.closest('.status-box');
    if (!statusBox?.parentElement) return;

    const picker = document.createElement('div');
    picker.id        = pickerId;
    picker.className = PICKER_CLASS + (opts.glow ? ' collection-picker-glow' : '');
    picker.innerHTML = '<p class="feed-status-message">Loading collections…</p>';
    statusBox.parentElement.insertBefore(picker, statusBox.nextSibling);

    try {
        const encKey = await getEncKey(window.CList.config.flaskSiteUrl);
        if (!encKey) throw new Error('Encryption key not available — please log in again.');

        const resp = await fetch(`${window.CList.config.flaskSiteUrl}/get_kvs/`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`kvstore error ${resp.status}`);
        const kvs = await resp.json();

        const collections = (kvs || [])
            .filter(kv => kv.key.startsWith('collection:'))
            .map(kv => ({ name: kv.key.replace(/^collection:/, ''), key: kv.key, encValue: kv.value }));

        picker.innerHTML = '';
        _buildCollectionPickerContents(picker, collections, async (name, encValue) => {
            try {
                let colData = { items: [], publishedUrls: [] };
                if (encValue) {
                    try { colData = _parseCollectionData(JSON.parse(await decryptWithKey(encKey, encValue))); } catch {}
                }
                const specificEl = document.getElementById(itemId);
                const ref   = specificEl?.reference || {};
                const url   = ref.url   || '';
                const title = ref.title || url || itemId;
                if (url && colData.items.some(i => i.url === url)) {
                    showStatusMessage(`Already in "${name}".`);
                    picker.remove();
                    return;
                }
                colData.items.push({ id: itemId, title, url, ...ref });
                await _kvSaveItems(name, colData.items, token, encKey, colData.publishedUrls);
                document.getElementById(`collect-btn-${itemId}`)?.classList.add('action-active');
                picker.remove();
                showStatusMessage(`Added to "${name}".`);
            } catch (e) {
                console.error('[collection] add failed', e);
                showStatusMessage('Could not add to collection: ' + e.message);
            }
        }, document.getElementById(`collect-btn-${itemId}`));

    } catch (e) {
        console.error('[collection] picker error', e);
        picker.innerHTML = `<p class="feed-status-message">Could not load collections: ${e.message}</p>`;
    }
}

// Normalize a decrypted collection value — handles both old (bare array) and new ({ items, publishedUrls }) formats.
function _parseCollectionData(raw) {
    if (Array.isArray(raw)) return { items: raw, publishedUrls: [] };
    return { items: raw.items || [], publishedUrls: raw.publishedUrls || [] };
}

// Encrypt items and upsert to kvstore (add_kv, fallback update_kv on 409).
// publishedUrls is preserved and carried through all item-only saves.
async function _kvSaveItems(name, items, token, encKey, publishedUrls = []) {
    const encrypted = await encryptWithKey(encKey, JSON.stringify({ items, publishedUrls }));
    const kvPayload = { key: `collection:${name}`, value: encrypted };
    const kvHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    let resp = await fetch(`${window.CList.config.flaskSiteUrl}/add_kv/`, {
        method: 'POST', headers: kvHeaders, body: JSON.stringify(kvPayload),
    });
    if (resp.status === 409) {
        resp = await fetch(`${window.CList.config.flaskSiteUrl}/update_kv/`, {
            method: 'POST', headers: kvHeaders, body: JSON.stringify(kvPayload),
        });
    }
    if (!resp.ok) throw new Error(`kvstore error ${resp.status}`);
}

// Populate a .collection-picker div with existing collection buttons + new-name row.
// onSelect(name, encValue) is called when the user picks or creates a collection.
// anchorEl is excluded from the outside-click handler (pass null if not needed).
function _buildCollectionPickerContents(picker, collections, onSelect, anchorEl) {
    const outsideHandler = (e) => {
        if (!picker.contains(e.target) && e.target !== anchorEl) {
            picker.remove();
            document.removeEventListener('click', outsideHandler, true);
        }
    };
    setTimeout(() => document.addEventListener('click', outsideHandler, true), 0);

    if (!collections.length) {
        const msg = document.createElement('p');
        msg.className   = 'feed-status-message';
        msg.textContent = 'No collections yet — create one below.';
        picker.appendChild(msg);
    } else {
        const list = document.createElement('ul');
        list.className = 'collection-picker-list';
        for (const col of collections) {
            const li  = document.createElement('li');
            const btn = document.createElement('button');
            btn.className   = 'collection-pick-btn';
            btn.textContent = col.name;
            btn.addEventListener('click', () => onSelect(col.name, col.encValue));
            li.appendChild(btn);
            list.appendChild(li);
        }
        picker.appendChild(list);
    }

    const newRow    = document.createElement('div');
    newRow.className = 'collection-picker-new';
    const nameInput = document.createElement('input');
    nameInput.type        = 'text';
    nameInput.className   = 'input-field';
    nameInput.placeholder = 'New collection name…';
    nameInput.maxLength   = 50;
    const createBtn = document.createElement('button');
    createBtn.className   = 'btn-small';
    createBtn.textContent = 'Create & add';
    createBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (!name) { showStatusMessage('Please enter a collection name.'); return; }
        if (!_COLLECTION_NAME_RE.test(name)) {
            showStatusMessage('Name may only contain letters, digits, spaces, #, -, and _.');
            return;
        }
        onSelect(name, null);
    });
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });
    newRow.appendChild(nameInput);
    newRow.appendChild(createBtn);
    picker.appendChild(newRow);
}

// Open a collection's items as editor references and open the write pane.
async function _loadCollectionIntoEditor(col, token, encKey) {
    const items = col?.items || col; // accept col object or bare items array
    if (!items?.length) { showStatusMessage('This collection is empty.'); return; }

    // ── Collection editor: load directly into the collection editor panel ────
    if (typeof currentEditor !== 'undefined' && currentEditor === 'collection') {
        _activeCollection = { col, token, encKey };
        const titleEl = document.getElementById('write-title');
        if (titleEl) titleEl.textContent = col.name || '';
        const container = document.getElementById('collectionEditorDiv');
        if (container) _renderCollectionEditor(container, col, token, encKey);
        return;
    }

    // ── If the current editor is empty, switch to collection editor ──────────
    const handler = typeof editorHandlers !== 'undefined' && editorHandlers[currentEditor];
    const currentContent = handler && typeof handler.getContent === 'function' ? handler.getContent() : null;
    const editorIsEmpty  = !currentContent || (typeof currentContent === 'string' && !currentContent.trim());

    if (editorIsEmpty && typeof initializeEditor === 'function') {
        _activeCollection = { col, token, encKey };
        const titleEl = document.getElementById('write-title');
        if (titleEl) titleEl.textContent = col.name || '';
        await initializeEditor('collection');
        return;
    }

    // ── 1. Build editor body content ────────────────────────────────────────
    const isHtmlEditor = (typeof currentEditor !== 'undefined' && currentEditor === 'tinymce');
    const filteredItems = items.filter(item => item.url);

    const paragraphs = filteredItems.map(item => {
        const author = (item.author_name && !item.author_name.startsWith('('))
            ? item.author_name
            : ((item.feed && item.feed !== '(no feed specified)') ? item.feed : (item.service || 'Unknown'));
        const body = item.summary || item.title || '';
        return isHtmlEditor
            ? `<p><strong>${escapeHtml(author)}</strong> wrote: ${escapeHtml(body)}</p>`
            : `${escapeHtml(author)} wrote: ${escapeHtml(body)}`;
    });

    if (paragraphs.length) {
        if (isHtmlEditor) {
            loadContent({ type: 'text/html', value: paragraphs.join('<p><br></p>') });
        } else {
            loadContent({ type: 'text/plain', value: paragraphs.join('\n\n') });
        }
    }

    // ── 2. Load all items into the reference list ────────────────────────────
    let added = 0;
    for (const item of items) {
        if (pushReference({ ...item, statusID: item.id })) added++;
    }

    if (added > 0) showStatusMessage('References loaded — click Refs to view');
    else showStatusMessage('All references already loaded.');
}

// Remove one item from a collection in kvstore and update the UI in place.
async function _removeItemFromCollection(col, itemUrl, token, encKey, countSpan, itemsDiv) {
    try {
        col.items = col.items.filter(i => i.url !== itemUrl);
        const encrypted = await encryptWithKey(encKey, JSON.stringify({ items: col.items, publishedUrls: col.publishedUrls || [] }));
        const resp = await fetch(`${window.CList.config.flaskSiteUrl}/update_kv/`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body:    JSON.stringify({ key: col.key, value: encrypted }),
        });
        if (!resp.ok) throw new Error(`kvstore error ${resp.status}`);
        countSpan.textContent = `${col.items.length} item${col.items.length !== 1 ? 's' : ''}`;
        _renderCollectionItems(col, token, encKey, countSpan, itemsDiv);
        showStatusMessage('Item removed.');
    } catch (e) {
        console.error('[collection] remove item failed', e);
        showStatusMessage('Could not remove item: ' + e.message);
    }
}

// Render the item list for a collection using makeListing for consistent feed entry display.
function _renderCollectionItems(col, token, encKey, countSpan, itemsDiv) {
    itemsDiv.innerHTML = '';
    if (!col.items.length) {
        const empty = document.createElement('p');
        empty.className   = 'feed-status-message';
        empty.textContent = 'This collection is empty.';
        itemsDiv.appendChild(empty);
        return;
    }

    for (const item of col.items) {
        if (!item.url) continue;

        const displayTitle = _collectionItemDisplayTitle(item);

        // For social items, build "Platform (@handle)" as the feed byline
        const isSocial   = item.service === 'Mastodon' || item.service === 'Bluesky'
                        || item.title   === 'Mastodon' || item.title   === 'Bluesky';
        const platform   = isSocial ? (item.title || item.service) : null;
        const handle     = isSocial && item.author_id ? `@${item.author_id}` : null;
        const feedDisplay = isSocial
            ? (handle ? `${platform} (${handle})` : platform)
            : (item.feed || null);

        try {
            const el = makeListing({
                service:   item.service || 'RSS',
                url:       item.url,
                title:     displayTitle,
                titleHtml: `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(displayTitle)}</a>`,
                desc:      item.summary || '',
                feed:      feedDisplay,
                feedUrl:   item.feedUrl || null,
                author:    (item.author_name && !item.author_name.startsWith('(')) ? item.author_name : null,
                date:      item.created_at || null,
                guid:      item.guid   || item.url,
                entryId:   item.id     || null,
                link:      item.url,
            });

            // Add a "Remove from collection" button into the entry's clist-actions bar
            const clistActions = el.querySelector('.clist-actions');
            if (clistActions) {
                const removeBtn = document.createElement('button');
                removeBtn.className = 'clist-action-btn';
                removeBtn.title     = 'Remove from collection';
                removeBtn.innerHTML = '<span class="material-icons md-18 md-light">remove_circle_outline</span>';
                removeBtn.onclick   = () => _removeItemFromCollection(col, item.url, token, encKey, countSpan, itemsDiv);
                clistActions.appendChild(removeBtn);
            }

            itemsDiv.appendChild(el);
        } catch (err) {
            console.error('Collection: could not render item', item.url, err);
        }
    }

    window.checkAnnotationsBatch?.();
}

// Open a single collection in a detail view, replacing the collection list.
// Browser back button and the in-view back icon both return to the list.
function _showCollectionDetail(col, token, encKey) {
    const feedContainer = window.CList.ui.view.feedContainer;
    if (!feedContainer) return;

    // Push state so the browser back button can return to the list
    history.pushState({ collectionDetail: col.name }, '');

    // One-shot popstate handler: any back navigation from here returns to list
    if (_collectionsPopstateHandler) window.removeEventListener('popstate', _collectionsPopstateHandler);
    _collectionsPopstateHandler = () => {
        window.removeEventListener('popstate', _collectionsPopstateHandler);
        _collectionsPopstateHandler = null;
        window.showSavedCollections();
    };
    window.addEventListener('popstate', _collectionsPopstateHandler);

    feedContainer.innerHTML = '';

    // ── Header: [back + count] [title centred] [load all] ──
    const header = document.createElement('div');
    header.className = 'collection-detail-header';

    const leftZone = document.createElement('div');
    leftZone.className = 'collection-detail-left';

    const backBtn = document.createElement('button');
    backBtn.className = 'clist-action-btn';
    backBtn.title     = 'Back to collections';
    backBtn.innerHTML = '<span class="material-icons md-18 md-light">arrow_back</span>';
    backBtn.onclick   = () => history.back();

    const countSpan = document.createElement('span');
    countSpan.className   = 'saved-collection-count';
    countSpan.textContent = `${col.items.length} item${col.items.length !== 1 ? 's' : ''}`;

    leftZone.appendChild(backBtn);
    leftZone.appendChild(countSpan);

    const titleEl = document.createElement('h3');
    titleEl.className   = 'collection-detail-title';
    titleEl.textContent = col.name;

    const rightZone = document.createElement('div');
    rightZone.className = 'collection-detail-right';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'clist-action-btn';
    loadBtn.title     = 'Load all to editor';
    loadBtn.innerHTML = '<span class="material-icons md-18 md-light">arrow_forward</span>';
    loadBtn.onclick   = () => _loadCollectionIntoEditor(col, token, encKey);

    const collabBtn = document.createElement('button');
    collabBtn.className = 'clist-action-btn';
    collabBtn.title     = 'Open in Collab';
    collabBtn.innerHTML = '<span class="material-icons md-18 md-light">edit_note</span>';
    collabBtn.onclick   = () => {
        if (typeof window.openCollabWithCollection === 'function') {
            window.openCollabWithCollection(col.name, col.items);
        } else {
            showStatusMessage('Collab editor not available.');
        }
    };

    const shareBtn = document.createElement('button');
    shareBtn.className = 'clist-action-btn chat-only-btn';
    shareBtn.title     = 'Share to chat';
    shareBtn.innerHTML = '<span class="material-icons md-18 md-light">chat</span>';
    shareBtn.onclick   = () => {
        const items = col.items.map(i => ({ title: _collectionItemDisplayTitle(i), url: i.url }));
        sendShareMessage('collection', null, col.name, null, { items });
    };

    rightZone.appendChild(collabBtn);
    rightZone.appendChild(shareBtn);
    rightZone.appendChild(loadBtn);

    header.appendChild(leftZone);
    header.appendChild(titleEl);
    header.appendChild(rightZone);
    feedContainer.appendChild(header);

    const itemsDiv = document.createElement('div');
    itemsDiv.className = 'collection-items-expanded';
    feedContainer.appendChild(itemsDiv);

    _renderCollectionItems(col, token, encKey, countSpan, itemsDiv);
}


// ── Collection import ────────────────────────────────────────────────────────

function _parseCollectionJSON(text) {
    const data  = JSON.parse(text);
    const items = (data.items || [])
        .map(i => ({ title: i.title || i.url || '', url: i.url || '', author_name: i.author || '', summary: i.summary || '' }))
        .filter(i => i.url);
    return { title: data.title || 'Imported collection', items };
}

function _parseCollectionOPML(text) {
    const doc      = new DOMParser().parseFromString(text, 'text/xml');
    const titleEl  = doc.querySelector('head > title');
    const title    = titleEl?.textContent?.trim() || 'Imported collection';
    const items    = [...doc.querySelectorAll('body > outline')]
        .map(o => ({
            title: o.getAttribute('text') || o.getAttribute('title') || '',
            url:   o.getAttribute('xmlUrl') || o.getAttribute('htmlUrl') || '',
        }))
        .filter(i => i.url);
    return { title, items };
}

function _parseCollectionHTML(text) {
    const doc   = new DOMParser().parseFromString(text, 'text/html');
    const title = doc.querySelector('h1')?.textContent?.trim()
               || doc.querySelector('title')?.textContent?.trim()
               || 'Imported collection';
    const items = [...doc.querySelectorAll('ul li a')]
        .map(a => ({ title: a.textContent.trim(), url: a.href }))
        .filter(i => i.url && !i.url.startsWith('javascript'));
    return { title, items };
}

function _parseCollectionRSS(text) {
    const doc   = new DOMParser().parseFromString(text, 'text/xml');
    const titleEl = doc.querySelector('channel > title, feed > title');
    const title   = titleEl?.textContent?.trim() || 'Imported feed';
    const rssItems  = [...doc.querySelectorAll('item')].map(item => ({
        title:       item.querySelector('title')?.textContent?.trim() || '',
        url:         item.querySelector('link')?.textContent?.trim() || '',
        author_name: item.querySelector('author')?.textContent?.trim()
                  || item.querySelector('dc\\:creator')?.textContent?.trim() || '',
        summary:     item.querySelector('description')?.textContent?.trim() || '',
    }));
    const atomItems = [...doc.querySelectorAll('entry')].map(entry => ({
        title:       entry.querySelector('title')?.textContent?.trim() || '',
        url:         entry.querySelector('link')?.getAttribute('href') || '',
        author_name: entry.querySelector('author > name')?.textContent?.trim() || '',
        summary:     entry.querySelector('summary, content')?.textContent?.trim() || '',
    }));
    const items = (rssItems.length ? rssItems : atomItems).filter(i => i.url);
    return { title, items };
}

function _detectFormat(contentType, url) {
    if (contentType?.includes('json'))                         return 'json';
    if (contentType?.includes('opml'))                         return 'opml';
    if (contentType?.includes('html'))                         return 'html';
    if (contentType?.includes('rss') || contentType?.includes('atom') || contentType?.includes('xml'))
                                                               return 'rss';
    const lower = (url || '').toLowerCase().split('?')[0];
    if (lower.endsWith('.json'))                               return 'json';
    if (lower.endsWith('.opml'))                               return 'opml';
    if (lower.endsWith('.rss') || lower.endsWith('.atom') || lower.endsWith('.xml')) return 'rss';
    if (lower.endsWith('.html') || lower.endsWith('.htm'))     return 'html';
    if (lower.endsWith('.md') || lower.endsWith('.txt'))       return 'text';
    return 'json'; // default guess
}

// Show a preview panel for a parsed {title, items} so the user can name and save it.
function _showCollectionImportPreview(parsed, token, encKey) {
    const feedContainer = window.CList.ui.view.feedContainer;
    if (!feedContainer) return;

    feedContainer.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'collection-detail-header';
    const leftZone = document.createElement('div');
    leftZone.className = 'collection-detail-left';
    const backBtn = document.createElement('button');
    backBtn.className = 'clist-action-btn';
    backBtn.title     = 'Back to collections';
    backBtn.innerHTML = '<span class="material-icons md-18 md-light">arrow_back</span>';
    backBtn.onclick   = () => window.showSavedCollections();
    leftZone.appendChild(backBtn);
    const titleEl = document.createElement('h3');
    titleEl.className   = 'collection-detail-title';
    titleEl.textContent = 'Import preview';
    header.appendChild(leftZone);
    header.appendChild(titleEl);
    header.appendChild(document.createElement('div'));
    feedContainer.appendChild(header);

    const preview = document.createElement('div');
    preview.style.padding = '0 8px 16px';
    feedContainer.appendChild(preview);

    const itemCount = document.createElement('p');
    itemCount.className   = 'feed-status-message';
    itemCount.textContent = `${parsed.items.length} item${parsed.items.length !== 1 ? 's' : ''} found`;
    preview.appendChild(itemCount);

    if (parsed.items.length) {
        const sampleList = document.createElement('ul');
        sampleList.className = 'collection-publish-items';
        parsed.items.slice(0, 5).forEach(item => {
            const li = document.createElement('li');
            li.className     = 'collection-publish-item';
            li.style.padding = '4px 0';
            li.innerHTML     = `<span style="flex:1;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.title || item.url)}</span>`;
            sampleList.appendChild(li);
        });
        if (parsed.items.length > 5) {
            const more = document.createElement('li');
            more.className    = 'collection-publish-item';
            more.style.color  = '#888';
            more.style.fontSize = '0.8rem';
            more.textContent  = `…and ${parsed.items.length - 5} more`;
            sampleList.appendChild(more);
        }
        preview.appendChild(sampleList);
    }

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap';
    preview.appendChild(nameRow);

    const nameLabel = document.createElement('label');
    nameLabel.textContent   = 'Save as: ';
    nameLabel.style.fontSize = '0.85rem';
    const nameInput = document.createElement('input');
    nameInput.type        = 'text';
    nameInput.className   = 'input-field';
    nameInput.value       = parsed.title;
    nameInput.maxLength   = 50;
    nameInput.style.cssText = 'flex:1;min-width:120px';
    nameLabel.appendChild(nameInput);
    nameRow.appendChild(nameLabel);

    const saveBtn = document.createElement('button');
    saveBtn.className   = 'btn';
    saveBtn.textContent = 'Save as collection';
    nameRow.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className   = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick     = () => window.showSavedCollections();
    nameRow.appendChild(cancelBtn);

    saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { showStatusMessage('Please enter a collection name.'); return; }
        if (!_COLLECTION_NAME_RE.test(name)) {
            showStatusMessage('Name may only contain letters, digits, spaces, #, -, and _.');
            return;
        }
        saveBtn.disabled    = true;
        saveBtn.textContent = 'Saving…';
        try {
            await _kvSaveItems(name, parsed.items, token, encKey);
            showStatusMessage(`Saved as "${name}".`);
            window.showSavedCollections();
        } catch (e) {
            console.error('[collection] import save failed', e);
            showStatusMessage('Could not save: ' + e.message);
            saveBtn.disabled    = false;
            saveBtn.textContent = 'Save as collection';
        }
    });
}

async function _importCollectionFromUrl(url, token, encKey) {
    const feedContainer = window.CList.ui.view.feedContainer;
    if (!feedContainer) return;
    feedContainer.innerHTML = '<p class="feed-status-message">Fetching…</p>';
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const contentType = resp.headers.get('Content-Type') || '';
        const text        = await resp.text();
        const format      = _detectFormat(contentType, url);
        let parsed;
        if (format === 'rss')       parsed = _parseCollectionRSS(text);
        else if (format === 'opml') parsed = _parseCollectionOPML(text);
        else if (format === 'html') parsed = _parseCollectionHTML(text);
        else                        parsed = _parseCollectionJSON(text);
        _showCollectionImportPreview(parsed, token, encKey);
    } catch (e) {
        console.error('[collection] import fetch failed', e);
        feedContainer.innerHTML = `<p class="feed-status-message">Could not fetch URL: ${escapeHtml(e.message)}</p>
            <button class="btn" style="margin:8px 4px 0">Back</button>`;
        feedContainer.querySelector('button').onclick = () => window.showSavedCollections();
    }
}

async function _importCollectionFromFile(file, token, encKey) {
    const feedContainer = window.CList.ui.view.feedContainer;
    if (!feedContainer) return;
    feedContainer.innerHTML = '<p class="feed-status-message">Reading file…</p>';
    try {
        const text   = await file.text();
        const format = _detectFormat(file.type, file.name);
        let parsed;
        if (format === 'rss')       parsed = _parseCollectionRSS(text);
        else if (format === 'opml') parsed = _parseCollectionOPML(text);
        else if (format === 'html') parsed = _parseCollectionHTML(text);
        else                        parsed = _parseCollectionJSON(text);
        _showCollectionImportPreview(parsed, token, encKey);
    } catch (e) {
        console.error('[collection] file import failed', e);
        feedContainer.innerHTML = `<p class="feed-status-message">Could not read file: ${escapeHtml(e.message)}</p>
            <button class="btn" style="margin:8px 4px 0">Back</button>`;
        feedContainer.querySelector('button').onclick = () => window.showSavedCollections();
    }
}

// List all saved collections from kvstore.
window.showSavedCollections = async function() {
    // Clean up any detail-view popstate handler if navigating here directly
    if (_collectionsPopstateHandler) {
        window.removeEventListener('popstate', _collectionsPopstateHandler);
        _collectionsPopstateHandler = null;
    }

    const feedSection   = document.getElementById('feed-section');
    const feedMenu      = window.CList.ui.view.feedMenu;
    const feedContainer = window.CList.ui.view.feedContainer;
    if (!feedContainer) return;

    if (feedSection) feedSection.style.display = '';   // restore CSS flex layout
    if (feedMenu)  { feedMenu.style.display = '';  feedMenu.innerHTML = ''; }
    feedContainer.innerHTML = '<p class="feed-status-message">Loading collections…</p>';

    const token = getSiteSpecificCookie(window.CList.config.flaskSiteUrl, window.CList.keys.ACCESS_TOKEN);
    if (!token) {
        feedContainer.innerHTML = '<p class="feed-status-message">Please log in to view your collections.</p>';
        return;
    }

    try {
        const resp = await fetch(`${window.CList.config.flaskSiteUrl}/get_kvs/`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`kvstore error ${resp.status}`);
        const kvs = await resp.json();

        const encKey = await getEncKey(window.CList.config.flaskSiteUrl);
        if (!encKey) throw new Error('Encryption key not available — please log in again.');

        const collections = [];
        for (const kv of (kvs || [])) {
            if (!kv.key.startsWith('collection:')) continue;
            try {
                const raw = JSON.parse(await decryptWithKey(encKey, kv.value));
                const colData = _parseCollectionData(raw);
                collections.push({ key: kv.key, name: kv.key.replace(/^collection:/, ''), items: colData.items, publishedUrls: colData.publishedUrls });
            } catch { /* skip corrupt entries */ }
        }

        feedContainer.innerHTML = '';
        const header = document.createElement('div');
        header.className = 'feed-panel-header';
        header.innerHTML = '<h3>My Collections</h3>';
        feedContainer.appendChild(header);

        if (!collections.length) {
            const msg = document.createElement('p');
            msg.className   = 'feed-status-message';
            msg.textContent = 'No collections yet. Use the library_add button on any item to start collecting.';
            feedContainer.appendChild(msg);
            return;
        }

        for (const col of collections) {
            const wrapper = document.createElement('div');
            wrapper.className = 'saved-collection-wrapper';

            // ── Summary row ──
            const row = document.createElement('div');
            row.className = 'saved-collection-row';

            const nameSpan = document.createElement('span');
            nameSpan.className   = 'saved-collection-name';
            nameSpan.textContent = col.name;
            nameSpan.title       = 'View / edit items';
            nameSpan.onclick     = () => _showCollectionDetail(col, token, encKey);

            const countSpan = document.createElement('span');
            countSpan.className   = 'saved-collection-count';
            countSpan.textContent = `${col.items.length} item${col.items.length !== 1 ? 's' : ''}`;

            const editBtn = document.createElement('button');
            editBtn.className = 'clist-action-btn';
            editBtn.title     = 'View / edit items';
            editBtn.innerHTML = '<span class="material-icons md-18 md-light">edit</span>';
            editBtn.onclick   = () => _showCollectionDetail(col, token, encKey);

            // Delete button — two-step confirmation
            const delBtn = document.createElement('button');
            delBtn.className = 'clist-action-btn';
            delBtn.title     = 'Delete this collection';
            delBtn.innerHTML = '<span class="material-icons md-18 md-light">delete_outline</span>';

            const confirmRow = document.createElement('div');
            confirmRow.className    = 'collection-delete-confirm';
            confirmRow.style.display = 'none';

            const confirmLabel = document.createElement('span');
            confirmLabel.textContent = `Delete "${col.name}"? `;

            const yesBtn = document.createElement('button');
            yesBtn.className   = 'btn collection-confirm-btn';
            yesBtn.textContent = 'Delete';
            yesBtn.onclick     = async () => {
                try {
                    const delResp = await fetch(`${window.CList.config.flaskSiteUrl}/delete_kv/`, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body:    JSON.stringify({ key: col.key }),
                    });
                    if (!delResp.ok) throw new Error(`kvstore error ${delResp.status}`);
                    showStatusMessage(`Collection "${col.name}" deleted.`);
                    window.showSavedCollections();
                } catch (e) {
                    console.error('[collection] delete failed', e);
                    showStatusMessage('Could not delete: ' + e.message);
                }
            };

            const cancelBtn = document.createElement('button');
            cancelBtn.className   = 'btn btn-secondary collection-confirm-btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick     = () => {
                confirmRow.style.display = 'none';
                delBtn.style.display     = '';
            };

            delBtn.onclick = () => {
                delBtn.style.display      = 'none';
                confirmRow.style.display  = 'flex';
            };

            confirmRow.appendChild(confirmLabel);
            confirmRow.appendChild(yesBtn);
            confirmRow.appendChild(cancelBtn);

            row.appendChild(nameSpan);
            row.appendChild(countSpan);
            row.appendChild(editBtn);
            row.appendChild(delBtn);
            row.appendChild(confirmRow);

            wrapper.appendChild(row);
            feedContainer.appendChild(wrapper);
        }

        // ── Import from URL section ──
        const importSection = document.createElement('div');
        importSection.style.cssText = 'margin-top:16px;padding:10px 4px 4px;border-top:1px solid #eee;text-align:center';

        const importToggle = document.createElement('button');
        importToggle.textContent = 'Import';

        const importPanel = document.createElement('div');
        importPanel.style.cssText = 'display:none;width:80%;margin:6px auto 0;text-align:left';

        // URL / File option buttons
        const optionRow = document.createElement('div');
        optionRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
        const urlOptBtn  = document.createElement('button');
        urlOptBtn.textContent = 'URL';
        const fileOptBtn = document.createElement('button');
        fileOptBtn.textContent = 'File';
        optionRow.appendChild(urlOptBtn);
        optionRow.appendChild(fileOptBtn);
        importPanel.appendChild(optionRow);

        // URL sub-panel
        const urlPanel = document.createElement('div');
        urlPanel.style.display = 'none';
        const urlInput = document.createElement('input');
        urlInput.type          = 'text';
        urlInput.className     = 'input-field';
        urlInput.placeholder   = 'Paste a URL (RSS, OPML, JSON, HTML)…';
        urlInput.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:6px';
        const urlGoBtn = document.createElement('button');
        urlGoBtn.textContent = 'Import';
        urlGoBtn.addEventListener('click', () => {
            const url = urlInput.value.trim();
            if (!url) { showStatusMessage('Please paste a URL to import.'); return; }
            _importCollectionFromUrl(url, token, encKey);
        });
        urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') urlGoBtn.click(); });
        urlPanel.appendChild(urlInput);
        urlPanel.appendChild(urlGoBtn);
        importPanel.appendChild(urlPanel);

        // File sub-panel
        const filePanel = document.createElement('div');
        filePanel.style.display = 'none';
        const fileInput = document.createElement('input');
        fileInput.type          = 'file';
        fileInput.accept        = '.rss,.xml,.opml,.json,.html,.htm,.md,.txt';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (file) _importCollectionFromFile(file, token, encKey);
        });
        const fileBrowseBtn = document.createElement('button');
        fileBrowseBtn.textContent = 'Browse file…';
        fileBrowseBtn.addEventListener('click', () => fileInput.click());
        filePanel.appendChild(fileInput);
        filePanel.appendChild(fileBrowseBtn);
        importPanel.appendChild(filePanel);

        urlOptBtn.addEventListener('click', () => {
            const open = urlPanel.style.display !== 'none';
            urlPanel.style.display  = open ? 'none' : 'block';
            filePanel.style.display = 'none';
            if (!open) setTimeout(() => urlInput.focus(), 0);
        });

        fileOptBtn.addEventListener('click', () => {
            const open = filePanel.style.display !== 'none';
            filePanel.style.display = open ? 'none' : 'block';
            urlPanel.style.display  = 'none';
        });

        importToggle.addEventListener('click', () => {
            const open = importPanel.style.display !== 'none';
            importPanel.style.display = open ? 'none' : 'block';
            if (open) {
                urlPanel.style.display  = 'none';
                filePanel.style.display = 'none';
            }
        });

        importSection.appendChild(importToggle);
        importSection.appendChild(importPanel);
        feedContainer.appendChild(importSection);

    } catch (e) {
        console.error('[collection] load failed', e);
        feedContainer.innerHTML = `<p class="feed-status-message">Could not load collections: ${e.message}</p>`;
    }
};

// ── My Pages loader ───────────────────────────────────────────────────────────
(function () {
    window.CList.loaders = window.CList.loaders || [];
    window.CList.loaders.push({
        label:   'My Pages',
        icon:    'cloud_done',
        visible: () => !!getSiteSpecificCookie(window.CList.config.flaskSiteUrl, window.CList.keys.ACCESS_TOKEN),
        load:    async () => {
            const optionsDiv = window.CList.ui.view.loadOptions;
            optionsDiv.innerHTML = '<p class="list-tip">Loading published pages…</p>';

            const token = getSiteSpecificCookie(window.CList.config.flaskSiteUrl, window.CList.keys.ACCESS_TOKEN);
            if (!token) {
                optionsDiv.innerHTML = '<p class="list-tip">Please log in to view your published pages.</p>';
                return null;
            }

            try {
                const encKey = await getEncKey(window.CList.config.flaskSiteUrl);
                if (!encKey) throw new Error('Encryption key not available');

                const resp = await fetch(`${window.CList.config.flaskSiteUrl}/get_kvs/`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                });
                if (!resp.ok) throw new Error(`kvstore error ${resp.status}`);
                const kvs = await resp.json();

                const pages = [];
                for (const kv of (kvs || [])) {
                    if (!kv.key.startsWith('collection:')) continue;
                    try {
                        const raw = JSON.parse(await decryptWithKey(encKey, kv.value));
                        const col = _parseCollectionData(raw);
                        if (!col.publishedUrls?.length) continue;
                        const colName = kv.key.replace(/^collection:/, '');
                        for (const pub of col.publishedUrls) {
                            pages.push({ collectionKey: kv.key, title: colName, ...pub });
                        }
                    } catch { /* skip corrupt entries */ }
                }

                optionsDiv.innerHTML = '';

                const heading = document.createElement('div');
                heading.className   = 'list-tip';
                heading.textContent = pages.length ? 'Your published pages' : 'No published pages yet — publish a collection to get started.';
                optionsDiv.appendChild(heading);

                if (!pages.length) return null;

                // Sort newest first
                pages.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

                pages.forEach(page => {
                    const row = document.createElement('div');
                    row.className = 'published-page-row';

                    const titleEl = document.createElement('span');
                    titleEl.className = 'published-page-title';
                    titleEl.innerHTML = `<a href="${escapeHtml(page.url)}" target="_blank" rel="noopener">${escapeHtml(page.title || page.url)}</a>`;
                    row.appendChild(titleEl);

                    if (page.format) {
                        const fmt = document.createElement('span');
                        fmt.className   = 'published-page-badge';
                        fmt.textContent = page.format.toUpperCase();
                        row.appendChild(fmt);
                    }

                    if (page.service) {
                        const svc = document.createElement('span');
                        svc.className   = 'published-page-badge badge-service';
                        svc.textContent = page.service;
                        row.appendChild(svc);
                    }

                    if (page.publishedAt) {
                        const dateEl = document.createElement('span');
                        dateEl.className   = 'published-page-date';
                        dateEl.textContent = page.publishedAt.slice(0, 10);
                        row.appendChild(dateEl);
                    }

                    // Action buttons
                    const actions = document.createElement('div');
                    actions.className = 'published-page-actions';

                    const openBtn = document.createElement('button');
                    openBtn.className = 'clist-action-btn';
                    openBtn.title     = 'Open in new tab';
                    openBtn.innerHTML = '<span class="material-icons md-18 md-light">open_in_new</span>';
                    openBtn.onclick   = () => window.open(page.url, '_blank', 'noopener');
                    actions.appendChild(openBtn);

                    const copyBtn = document.createElement('button');
                    copyBtn.className = 'clist-action-btn';
                    copyBtn.title     = 'Copy URL';
                    copyBtn.innerHTML = '<span class="material-icons md-18 md-light">content_copy</span>';
                    copyBtn.onclick   = () => {
                        navigator.clipboard.writeText(page.url).then(
                            () => showStatusMessage('URL copied.'),
                            () => showStatusMessage('Could not copy URL.')
                        );
                    };
                    actions.appendChild(copyBtn);

                    const delBtn = document.createElement('button');
                    delBtn.className = 'clist-action-btn';
                    delBtn.title     = 'Delete';
                    delBtn.innerHTML = '<span class="material-icons md-18 md-light">delete_outline</span>';
                    row.appendChild(actions);

                    // Delete: two-step confirm rendered inline
                    const confirmRow = document.createElement('div');
                    confirmRow.className    = 'published-page-confirm';
                    confirmRow.style.display = 'none';

                    const yesBtn = document.createElement('button');
                    yesBtn.className   = 'btn collection-confirm-btn';
                    yesBtn.textContent = 'Delete';
                    yesBtn.onclick     = async () => {
                        // Optionally remove from remote bin service
                        if (page.serviceId && page.service) {
                            const adapter = window.CList.binPublishers?.[page.service];
                            if (adapter?.delete) {
                                const acct = (window.CList.accounts || [])
                                    .map(a => parseAccountValue(a)).filter(Boolean)
                                    .find(pv => pv.type === page.service && pv.instance === page.accountInstance);
                                if (acct) {
                                    try { await adapter.delete(page.serviceId, acct); }
                                    catch (e) { console.error('[mypages] remote delete failed', e); }
                                }
                            }
                        }
                        // Remove this URL from the collection's publishedUrls array
                        try {
                            const getResp = await fetch(`${window.CList.config.flaskSiteUrl}/get_kvs/`, {
                                headers: { 'Authorization': `Bearer ${token}` },
                            });
                            if (!getResp.ok) throw new Error(`kvstore ${getResp.status}`);
                            const allKvs = await getResp.json();
                            const colKv  = (allKvs || []).find(k => k.key === page.collectionKey);
                            if (colKv) {
                                const raw = JSON.parse(await decryptWithKey(encKey, colKv.value));
                                const col = _parseCollectionData(raw);
                                col.publishedUrls = (col.publishedUrls || []).filter(p => p.url !== page.url);
                                const encrypted = await encryptWithKey(encKey, JSON.stringify({ items: col.items, publishedUrls: col.publishedUrls }));
                                await fetch(`${window.CList.config.flaskSiteUrl}/update_kv/`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                    body: JSON.stringify({ key: colKv.key, value: encrypted }),
                                });
                            }
                            row.remove();
                            showStatusMessage('Page removed.');
                        } catch (e) {
                            console.error('[mypages] kvstore update failed', e);
                            showStatusMessage('Could not remove: ' + e.message);
                        }
                    };

                    const cancelBtn = document.createElement('button');
                    cancelBtn.className   = 'btn btn-secondary collection-confirm-btn';
                    cancelBtn.textContent = 'Cancel';
                    cancelBtn.onclick     = () => {
                        confirmRow.style.display = 'none';
                        delBtn.style.display     = '';
                    };

                    delBtn.onclick = () => {
                        delBtn.style.display      = 'none';
                        confirmRow.style.display  = 'flex';
                    };

                    confirmRow.appendChild(document.createTextNode('Delete this page? '));
                    confirmRow.appendChild(yesBtn);
                    confirmRow.appendChild(cancelBtn);

                    actions.appendChild(delBtn);
                    row.appendChild(confirmRow);
                    optionsDiv.appendChild(row);
                });

            } catch (e) {
                console.error('[mypages] load failed', e);
                optionsDiv.innerHTML = `<p class="list-tip">Could not load pages: ${escapeHtml(e.message)}</p>`;
            }

            return null;
        },
    });
})();

// ── From URL loader ──────────────────────────────────────────────────────────
(function () {
    window.CList.loaders = window.CList.loaders || [];
    window.CList.loaders.push({
        label: 'From URL',
        icon:  'link',
        load:  () => new Promise(resolve => {
            const optionsDiv = window.CList.ui.view.loadOptions;
            optionsDiv.innerHTML = '';

            const form = document.createElement('div');
            form.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:8px 0';

            const urlInput = document.createElement('input');
            urlInput.type        = 'text';
            urlInput.placeholder = 'https://example.com/feed.rss';
            urlInput.className   = 'collection-editor-input';
            urlInput.style.width = '100%';
            form.appendChild(urlInput);

            const status = document.createElement('p');
            status.className = 'feed-status-message';
            status.style.display = 'none';
            form.appendChild(status);

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:6px';

            const loadBtn = document.createElement('button');
            loadBtn.className   = 'btn';
            loadBtn.textContent = 'Load';

            const cancelBtn = document.createElement('button');
            cancelBtn.className   = 'btn btn-secondary';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick     = () => { resolve(null); if (typeof closeRightPane === 'function') closeRightPane(); };

            btnRow.appendChild(loadBtn);
            btnRow.appendChild(cancelBtn);
            form.appendChild(btnRow);
            optionsDiv.appendChild(form);
            requestAnimationFrame(() => urlInput.focus());

            async function doLoad() {
                const url = urlInput.value.trim();
                if (!url) return;

                loadBtn.disabled    = true;
                loadBtn.textContent = 'Loading…';
                status.style.display = 'block';
                status.textContent   = 'Fetching…';

                try {
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const contentType = resp.headers.get('Content-Type') || '';
                    const text        = await resp.text();
                    const format      = _detectFormat(contentType, url);

                    if (format === 'rss' || format === 'opml' || format === 'json') {
                        let parsed;
                        if (format === 'rss')       parsed = _parseCollectionRSS(text);
                        else if (format === 'opml') parsed = _parseCollectionOPML(text);
                        else                        parsed = _parseCollectionJSON(text);

                        _activeCollection = { col: { name: parsed.title, items: parsed.items }, token: null, encKey: null };
                        if (typeof initializeEditor === 'function') await initializeEditor('collection');
                        if (typeof closeRightPane   === 'function') closeRightPane();
                        resolve(null);
                    } else if (format === 'html') {
                        if (typeof switchToEditor === 'function') {
                            await switchToEditor('tinymce', { type: 'text/html', value: text });
                        }
                        resolve(null);
                    } else {
                        if (typeof switchToEditor === 'function') {
                            await switchToEditor('texteditor', { type: 'text/plain', value: text });
                        }
                        resolve(null);
                    }
                } catch (e) {
                    console.error('[load from URL]', e);
                    status.textContent   = 'Failed: ' + e.message;
                    loadBtn.disabled     = false;
                    loadBtn.textContent  = 'Load';
                }
            }

            loadBtn.addEventListener('click', doLoad);
            urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLoad(); });
        }),
    });
})();

// ── Add item from feed to collection editor ───────────────────────────────────

window.addItemToCollectionEditor = function addItemToCollectionEditor(reference) {
    if (!Array.isArray(_draftItems)) {
        showStatusMessage('No collection is open in the editor.');
        return;
    }
    const url = reference?.url || '';
    if (!url) { showStatusMessage('This item has no URL and cannot be added to a collection.'); return; }
    const item = {
        title:       reference.title       || '',
        url,
        author_name: reference.author_name || '',
        feed:        reference.feed        || '',
        summary:     reference.summary     || '',
    };
    _draftItems.push(item);
    if (typeof _refreshEditor === 'function') _refreshEditor();
    showStatusMessage(`Added "${item.title || url}" to collection.`);
};

// ── Import a chat-shared collection into a local kvstore collection ───────────

window.importCollectionFromChat = async function(items, anchorEl) {
    const existing = anchorEl.nextElementSibling;
    if (existing && existing.classList.contains('collection-picker')) {
        existing.remove();
        return;
    }
    const token = getSiteSpecificCookie(window.CList.config.flaskSiteUrl, window.CList.keys.ACCESS_TOKEN);
    if (!token) { showStatusMessage('Please log in to save to a collection.'); return; }

    const picker = document.createElement('div');
    picker.className = 'collection-picker';
    picker.innerHTML = '<p class="feed-status-message">Loading…</p>';
    anchorEl.insertAdjacentElement('afterend', picker);

    try {
        const encKey = await getEncKey(window.CList.config.flaskSiteUrl);
        if (!encKey) throw new Error('Encryption key not available — please log in again.');
        const resp = await fetch(`${window.CList.config.flaskSiteUrl}/get_kvs/`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`kvstore error ${resp.status}`);
        const kvs = await resp.json();
        const collections = (kvs || [])
            .filter(kv => kv.key.startsWith('collection:'))
            .map(kv => ({ name: kv.key.replace(/^collection:/, ''), encValue: kv.value }));

        picker.innerHTML = '';

        async function onPickerSelect(name, encValue) {
            if (encValue) {
                // Existing collection — show conflict dialog
                let existing = { items: [], publishedUrls: [] };
                try { existing = _parseCollectionData(JSON.parse(await decryptWithKey(encKey, encValue))); } catch {}
                const existingUrls = new Set(existing.items.map(i => i.url).filter(Boolean));
                const toAdd = items.filter(i => i.url && !existingUrls.has(i.url));
                _buildCollectionConflictUI(picker, name,
                    async () => {
                        try {
                            await _kvSaveItems(name, items, token, encKey, existing.publishedUrls);
                            picker.remove();
                            showStatusMessage(`Saved as "${name}".`);
                        } catch (e) {
                            console.error('[collection] overwrite failed', e);
                            showStatusMessage('Could not save: ' + e.message);
                        }
                    },
                    async () => {
                        try {
                            await _kvSaveItems(name, [...existing.items, ...toAdd], token, encKey, existing.publishedUrls);
                            picker.remove();
                            showStatusMessage(`Added ${toAdd.length} item${toAdd.length !== 1 ? 's' : ''} to "${name}".`);
                        } catch (e) {
                            console.error('[collection] merge failed', e);
                            showStatusMessage('Could not merge: ' + e.message);
                        }
                    },
                    () => {
                        picker.innerHTML = '';
                        _buildCollectionPickerContents(picker, collections, onPickerSelect, anchorEl);
                    }
                );
            } else {
                // New collection — save directly
                try {
                    await _kvSaveItems(name, items, token, encKey);
                    picker.remove();
                    showStatusMessage(`Saved as "${name}".`);
                } catch (e) {
                    console.error('[collection] chat import failed', e);
                    showStatusMessage('Could not save: ' + e.message);
                }
            }
        }

        _buildCollectionPickerContents(picker, collections, onPickerSelect, anchorEl);

    } catch (e) {
        console.error('[collection] chat import picker error', e);
        picker.innerHTML = `<p class="feed-status-message">Could not load collections: ${e.message}</p>`;
    }
};

// ── Shared conflict dialog: Overwrite / Merge / Cancel ───────────────────────

function _buildCollectionConflictUI(container, collectionName, onOverwrite, onMerge, onCancel) {
    container.innerHTML = '';
    const msg = document.createElement('span');
    msg.style.cssText   = 'font-size:0.85rem';
    msg.textContent     = `"${collectionName}" already exists.`;
    const btns = document.createElement('div');
    btns.style.cssText  = 'display:flex;gap:6px;margin-top:6px';
    const overwriteBtn  = document.createElement('button');
    overwriteBtn.className = 'btn-small'; overwriteBtn.textContent = 'Overwrite';
    const mergeBtn      = document.createElement('button');
    mergeBtn.className  = 'btn-small'; mergeBtn.textContent = 'Merge';
    const cancelBtn     = document.createElement('button');
    cancelBtn.className = 'btn-small btn-secondary'; cancelBtn.textContent = 'Cancel';
    btns.appendChild(overwriteBtn);
    btns.appendChild(mergeBtn);
    btns.appendChild(cancelBtn);
    container.appendChild(msg);
    container.appendChild(btns);
    overwriteBtn.addEventListener('click', () => { overwriteBtn.disabled = mergeBtn.disabled = true; onOverwrite(); });
    mergeBtn.addEventListener('click',     () => { overwriteBtn.disabled = mergeBtn.disabled = true; onMerge(); });
    cancelBtn.addEventListener('click',    onCancel);
}

// ── Collection save ──────────────────────────────────────────────────────────

window.playCollectionSave = async function playCollectionSave() {
    const name  = (document.getElementById('write-title')?.textContent || '').trim();
    const items = _draftItems || [];
    const formatId = document.getElementById('write-format')?.value || 'rss';

    if (!name) { showStatusMessage('Please enter a collection name in the Title field before saving.'); return; }

    const saveOptionsDiv = document.getElementById('save-options');
    saveOptionsDiv.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'account-list';

    const tip = document.createElement('div');
    tip.className   = 'list-tip';
    tip.textContent = 'Select a destination';
    list.appendChild(tip);

    // ── Save to file ──
    const fileBtn = document.createElement('button');
    fileBtn.className = 'account-button';
    fileBtn.innerHTML = '<span class="material-icons">download</span><span>Save to file</span>';
    fileBtn.addEventListener('click', () => {
        const fmt = collectionFormats[formatId];
        if (!fmt) { showStatusMessage('Unknown format.'); return; }
        const content = fmt.serialize(name, items);
        const blob    = new Blob([content], { type: fmt.mimeType });
        const url     = URL.createObjectURL(blob);
        const a       = document.createElement('a');
        a.href        = url;
        a.download    = `${name}.${fmt.ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showStatusMessage(`Downloaded as ${name}.${fmt.ext}`);
    });
    list.appendChild(fileBtn);

    // ── Save to kvstore ──
    const token = getSiteSpecificCookie(window.CList.config.flaskSiteUrl, window.CList.keys.ACCESS_TOKEN);
    if (token) {
        const kvBtn = document.createElement('button');
        kvBtn.className = 'account-button';
        kvBtn.innerHTML = '<span class="material-icons">storage</span><span>Save to kvstore</span>';

        const confirmRow = document.createElement('div');
        confirmRow.style.cssText = 'display:none;padding:4px 12px';

        function _resetKvUi() {
            confirmRow.style.display = 'none';
            confirmRow.innerHTML     = '';
            kvBtn.style.display      = '';
            kvBtn.disabled           = false;
        }

        async function doKvSave(overwrite) {
            kvBtn.disabled = true;
            try {
                const encKey = await getEncKey(window.CList.config.flaskSiteUrl);
                // On overwrite, preserve existing publishedUrls so they survive a re-save
                let publishedUrls = [];
                if (overwrite) {
                    try {
                        const getResp = await fetch(`${window.CList.config.flaskSiteUrl}/get_kvs/`, {
                            headers: { 'Authorization': `Bearer ${token}` },
                        });
                        if (getResp.ok) {
                            const allKvs = await getResp.json();
                            const existing = (allKvs || []).find(kv => kv.key === `collection:${name}`);
                            if (existing) {
                                const raw = JSON.parse(await decryptWithKey(encKey, existing.value));
                                publishedUrls = _parseCollectionData(raw).publishedUrls;
                            }
                        }
                    } catch {}
                }
                const encrypted = await encryptWithKey(encKey, JSON.stringify({ items, publishedUrls }));
                const kvPayload = { key: `collection:${name}`, value: encrypted };
                const kvHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
                const endpoint  = overwrite
                    ? `${window.CList.config.flaskSiteUrl}/update_kv/`
                    : `${window.CList.config.flaskSiteUrl}/add_kv/`;
                const resp = await fetch(endpoint, { method: 'POST', headers: kvHeaders, body: JSON.stringify(kvPayload) });
                if (!overwrite && resp.status === 409) {
                    kvBtn.disabled           = false;
                    kvBtn.style.display      = 'none';
                    confirmRow.style.display = 'block';
                    _buildCollectionConflictUI(confirmRow, name, () => doKvSave(true), doKvMerge, _resetKvUi);
                    return;
                }
                if (!resp.ok) throw new Error(`kvstore ${resp.status}`);
                showStatusMessage(`Collection "${name}" saved to kvstore.`);
                if (typeof closeRightPane === 'function') closeRightPane();
            } catch (e) {
                console.error('[collection save] kvstore failed', e);
                showStatusMessage('Save failed: ' + e.message);
                kvBtn.disabled = false;
            }
        }

        async function doKvMerge() {
            try {
                const encKey    = await getEncKey(window.CList.config.flaskSiteUrl);
                const kvHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

                // Fetch existing collection
                const getResp = await fetch(`${window.CList.config.flaskSiteUrl}/get_kvs/`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                });
                if (!getResp.ok) throw new Error(`kvstore ${getResp.status}`);
                const kvs = await getResp.json();
                const existing = kvs.find(kv => kv.key === `collection:${name}`);
                if (!existing) throw new Error('Could not find existing collection to merge with.');

                const existingText = await decryptWithKey(encKey, existing.value);
                const existingCol  = _parseCollectionData(JSON.parse(existingText));

                // Union: existing items kept, draft items added only if URL not already present
                const existingUrls = new Set(existingCol.items.map(i => i.url).filter(Boolean));
                const newItems     = items.filter(i => i.url && !existingUrls.has(i.url));
                const merged       = [...existingCol.items, ...newItems];

                const encrypted = await encryptWithKey(encKey, JSON.stringify({ items: merged, publishedUrls: existingCol.publishedUrls }));
                const resp = await fetch(`${window.CList.config.flaskSiteUrl}/update_kv/`, {
                    method: 'POST', headers: kvHeaders,
                    body: JSON.stringify({ key: `collection:${name}`, value: encrypted }),
                });
                if (!resp.ok) throw new Error(`kvstore ${resp.status}`);
                const added = newItems.length;
                showStatusMessage(`Merged: ${added} new item${added !== 1 ? 's' : ''} added to "${name}".`);
                if (typeof closeRightPane === 'function') closeRightPane();
            } catch (e) {
                console.error('[collection save] merge failed', e);
                showStatusMessage('Merge failed: ' + e.message);
                _resetKvUi();
            }
        }

        kvBtn.addEventListener('click', () => doKvSave(false));

        list.appendChild(kvBtn);
        list.appendChild(confirmRow);
    }

    saveOptionsDiv.appendChild(list);
    if (typeof openRightInterface === 'function') openRightInterface('save-instructions');
};

// ── Pages catalog ────────────────────────────────────────────────────────────

// Append newUrls to the collection's publishedUrls array in kvstore.
async function _recordPublishedUrls(collectionName, newUrls, token, encKey) {
    const kvHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    const resp = await fetch(`${window.CList.config.flaskSiteUrl}/get_kvs/`, {
        headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`kvstore ${resp.status}`);
    const kvs = await resp.json();
    const kv = (kvs || []).find(k => k.key === `collection:${collectionName}`);
    if (!kv) return;

    const raw = JSON.parse(await decryptWithKey(encKey, kv.value));
    const col = _parseCollectionData(raw);
    col.publishedUrls = [...(col.publishedUrls || []), ...newUrls];

    const encrypted = await encryptWithKey(encKey, JSON.stringify({ items: col.items, publishedUrls: col.publishedUrls }));
    const saveResp = await fetch(`${window.CList.config.flaskSiteUrl}/update_kv/`, {
        method: 'POST', headers: kvHeaders,
        body: JSON.stringify({ key: kv.key, value: encrypted }),
    });
    if (!saveResp.ok) throw new Error(`kvstore ${saveResp.status}`);
}

// Regenerate the OPML and ActivityPub outbox catalog files on CListBin.
// Silent on failure — catalog update must not interrupt the publish flow.
async function _updatePagesCatalog(token, encKey, binAccount) {
    try {
        const kvHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
        const resp = await fetch(`${window.CList.config.flaskSiteUrl}/get_kvs/`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!resp.ok) return;
        const kvs = await resp.json();

        // Load existing catalog serviceIds (so we can update in place)
        let catalogMeta = {};
        const catalogKv = (kvs || []).find(kv => kv.key === 'clist:pages-catalog');
        if (catalogKv) {
            try { catalogMeta = JSON.parse(await decryptWithKey(encKey, catalogKv.value)); } catch {}
        }

        // Collect all published URLs across all collections
        const pages = [];
        for (const kv of (kvs || [])) {
            if (!kv.key.startsWith('collection:')) continue;
            try {
                const raw = JSON.parse(await decryptWithKey(encKey, kv.value));
                const col = _parseCollectionData(raw);
                if (!col.publishedUrls?.length) continue;
                const colName = kv.key.replace(/^collection:/, '');
                for (const pub of col.publishedUrls) {
                    pages.push({ name: colName, ...pub });
                }
            } catch {}
        }
        if (!pages.length) return;
        pages.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

        const binPublisher = window.CList.binPublishers?.['CListBin'];
        if (!binPublisher) return;

        const opmlContent = _generateCatalogOPML(pages);
        const apContent   = _generateCatalogAP(pages);

        if (catalogMeta.opmlServiceId) {
            const r = await binPublisher.update(catalogMeta.opmlServiceId, opmlContent, 'application/xml', binAccount);
            catalogMeta.opmlUrl = r.url;
        } else {
            const r = await binPublisher.publish(opmlContent, 'application/xml', 'pages.opml', binAccount);
            catalogMeta.opmlServiceId = r.serviceId;
            catalogMeta.opmlUrl = r.url;
        }

        if (catalogMeta.apServiceId) {
            const r = await binPublisher.update(catalogMeta.apServiceId, apContent, 'application/json', binAccount);
            catalogMeta.apUrl = r.url;
        } else {
            const r = await binPublisher.publish(apContent, 'application/json', 'pages.json', binAccount);
            catalogMeta.apServiceId = r.serviceId;
            catalogMeta.apUrl = r.url;
        }

        // Save catalog meta so the next publish can update in place and DID update can read the URLs
        const encrypted = await encryptWithKey(encKey, JSON.stringify(catalogMeta));
        let saveResp = await fetch(`${window.CList.config.flaskSiteUrl}/add_kv/`, {
            method: 'POST', headers: kvHeaders,
            body: JSON.stringify({ key: 'clist:pages-catalog', value: encrypted }),
        });
        if (saveResp.status === 409) {
            saveResp = await fetch(`${window.CList.config.flaskSiteUrl}/update_kv/`, {
                method: 'POST', headers: kvHeaders,
                body: JSON.stringify({ key: 'clist:pages-catalog', value: encrypted }),
            });
        }
    } catch (e) {
        console.error('[pages catalog] update failed:', e);
    }
}

function _generateCatalogOPML(pages) {
    const mimeTypes = { rss: 'rss', opml: 'link', json: 'link', html: 'link', md: 'link', text: 'link' };
    const username = window.CList.state?.username || '';
    const outlines = pages.map(p => {
        const t = escapeHtml(p.name);
        const u = escapeHtml(p.url);
        const type = mimeTypes[p.format] || 'link';
        return `    <outline text="${t}" type="${type}" xmlUrl="${u}" htmlUrl="${u}" datePublished="${escapeHtml(p.publishedAt || '')}"/>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeHtml(username ? username + "'s Published Pages" : 'Published Pages')}</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${outlines}
  </body>
</opml>`;
}

function _generateCatalogAP(pages) {
    const mimeTypeMap = {
        rss:  'application/rss+xml',
        opml: 'text/x-opml',
        json: 'application/json',
        html: 'text/html',
        md:   'text/markdown',
        text: 'text/plain',
    };
    const items = pages.map(p => ({
        type: 'Create',
        published: p.publishedAt || new Date().toISOString(),
        object: {
            type: 'Article',
            name: p.name,
            url:  p.url,
            mediaType: mimeTypeMap[p.format] || 'text/html',
        },
    }));
    return JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'OrderedCollection',
        totalItems: items.length,
        orderedItems: items,
    }, null, 2);
}

// ── Collection publish ───────────────────────────────────────────────────────

// Resolve which format to use for a given publisher handler and selected format.
// Returns a format id: the selected format if the handler accepts it, otherwise
// the first format the handler does accept, otherwise the selected format.
function _resolvePublishFormat(acceptedFormats, selectedFormatId) {
    if (!acceptedFormats || acceptedFormats.length === 0) return selectedFormatId;
    if (acceptedFormats.includes(selectedFormatId)) return selectedFormatId;
    return acceptedFormats[0];
}

window.playCollectionPublish = async function playCollectionPublish() {
    const name  = (document.getElementById('write-title')?.textContent || '').trim();
    const items = _draftItems || [];

    if (!name) { showStatusMessage('Please enter a collection name before publishing.'); return; }

    // Ensure accounts are loaded
    if (!Array.isArray(window.CList.accounts) || !window.CList.accounts.length) {
        try { window.CList.accounts = await getAccounts(window.CList.config.flaskSiteUrl); }
        catch (e) { showStatusMessage('Could not load accounts: ' + e.message); return; }
    }

    const postOptionsDiv = document.getElementById('post-options');
    const postResultDiv  = document.getElementById('post-result');
    postOptionsDiv.innerHTML = '';
    if (postResultDiv) postResultDiv.innerHTML = '';

    function _addPublishResult(text, isError = false) {
        if (!postResultDiv) { showStatusMessage(text); return; }
        const p = document.createElement('p');
        p.className   = isError ? 'error-message' : 'feed-status-message';
        p.style.margin = '4px 0';
        p.textContent  = text;
        postResultDiv.appendChild(p);
    }

    // Build the account list — 'w' publishers and 'b' bin-publishers
    postOptionsDiv.appendChild(makeAccountList(
        'Select destinations to publish to',
        window.CList.accounts,
        v => {
            const perms = v.permissions || '';
            if (perms.includes('w')) return !!window.CList.publishers?.[v.type];
            if (perms.includes('b')) return !!window.CList.binPublishers?.[v.type];
            return false;
        },
        (key, parsedValue, btn) => {
            const isSelected = btn.getAttribute('data-selected') === 'true';
            btn.setAttribute('data-selected', isSelected ? 'false' : 'true');
            btn.classList.toggle('selected', !isSelected);
        }
    ));

    const publishBtn = document.createElement('button');
    publishBtn.textContent = 'Publish';
    publishBtn.id          = 'final-post-button';
    publishBtn.className   = 'final-save-button';
    postOptionsDiv.appendChild(publishBtn);

    publishBtn.addEventListener('click', async () => {
        publishBtn.disabled    = true;
        publishBtn.textContent = 'Publishing…';

        const formatId = document.getElementById('write-format')?.value || 'rss';

        const selected = Array.from(
            document.querySelectorAll('#post-options .account-button[data-selected="true"]')
        ).map(btn => {
            const key     = btn.getAttribute('data-key');
            const account = window.CList.accounts.find(a => a.key === key);
            return account ? parseAccountValue(account) : null;
        }).filter(Boolean);

        if (!selected.length) {
            _addPublishResult('No destinations selected.', false);
            publishBtn.disabled = false; publishBtn.textContent = 'Publish';
            return;
        }

        // Separate into full-content ('b' bin publishers + unlimited 'w') and link-only (has maxlength)
        const fullContent = [];
        const linkOnly    = [];
        selected.forEach(accountData => {
            const perms    = accountData.permissions || '';
            const maxLen   = parseInt(accountData.maxlength, 10);
            const hasLimit = !isNaN(maxLen) && maxLen > 0;
            if (perms.includes('b') || !hasLimit) fullContent.push(accountData);
            else linkOnly.push(accountData);
        });

        let primaryUrl = null;
        const newPublishedUrls = [];
        let primaryBinAccount  = null;
        const token  = getSiteSpecificCookie(window.CList.config.flaskSiteUrl, window.CList.keys.ACCESS_TOKEN);
        const encKey = fullContent.length ? await getEncKey(window.CList.config.flaskSiteUrl).catch(() => null) : null;

        // ── Full-content destinations first ──
        for (const accountData of fullContent) {
            const perms = accountData.permissions || '';
            try {
                if (perms.includes('b')) {
                    // bin publisher — serialize in resolved format
                    const adapter = window.CList.binPublishers?.[accountData.type];
                    if (!adapter) continue;
                    const fmtId  = _resolvePublishFormat(adapter.acceptedFormats, formatId);
                    const fmt    = collectionFormats[fmtId];
                    if (!fmt) continue;
                    const filename = `${name}.${fmt.ext}`;
                    const result = await adapter.publish(fmt.serialize(name, items), fmt.mimeType, filename, accountData);
                    if (!primaryUrl) primaryUrl = result.url;
                    if (!primaryBinAccount && accountData.type === 'CListBin') primaryBinAccount = accountData;
                    newPublishedUrls.push({ url: result.url, serviceId: result.serviceId, format: fmtId, service: accountData.type, accountInstance: accountData.instance, publishedAt: new Date().toISOString() });
                    _addPublishResult(`Published to ${accountData.title || accountData.type}: ${result.url}`);
                } else {
                    // 'w' publisher with no char limit
                    const handler = window.CList.publishers?.[accountData.type];
                    if (!handler) continue;
                    const fmtId   = _resolvePublishFormat(handler.acceptedFormats, formatId);
                    const fmt     = collectionFormats[fmtId];
                    if (!fmt) continue;
                    const content = fmt.serialize(name, items);
                    const url     = await handler.publish(accountData, name, content, []);
                    if (!primaryUrl && url) primaryUrl = url;
                    if (url) newPublishedUrls.push({ url, format: fmtId, service: accountData.type, accountInstance: accountData.instance, publishedAt: new Date().toISOString() });
                }
            } catch (e) {
                console.error('[collection publish] full-content publish failed', e);
                _addPublishResult(`Failed: ${accountData.title || accountData.type} — ${e.message}`, true);
            }
        }

        // ── Link-only destinations ──
        for (const accountData of linkOnly) {
            try {
                const handler = window.CList.publishers?.[accountData.type];
                if (!handler) continue;
                const maxLen  = parseInt(accountData.maxlength, 10);
                let content;
                if (primaryUrl) {
                    content = `${name}: ${primaryUrl}`;
                } else {
                    // No primary yet — post text summary truncated to limit
                    const fmtId = _resolvePublishFormat(handler.acceptedFormats, formatId);
                    const fmt   = collectionFormats[fmtId] || collectionFormats.text;
                    content     = fmt.serialize(name, items).slice(0, maxLen);
                }
                await handler.publish(accountData, name, content, []);
            } catch (e) {
                console.error('[collection publish] link-only publish failed', e);
                _addPublishResult(`Failed: ${accountData.title || accountData.type} — ${e.message}`, true);
            }
        }

        publishBtn.disabled    = false;
        publishBtn.textContent = 'Publish';

        // Record published URLs in the collection entry and update the pages catalog
        if (newPublishedUrls.length && token && encKey) {
            _recordPublishedUrls(name, newPublishedUrls, token, encKey).then(() => {
                const catalogBinAccount = primaryBinAccount
                    || (window.CList.accounts || []).map(a => parseAccountValue(a)).filter(Boolean)
                        .find(pv => pv.type === 'CListBin' && (pv.permissions || '').includes('b'));
                if (catalogBinAccount) _updatePagesCatalog(token, encKey, catalogBinAccount);
            }).catch(e => console.error('[pages catalog] post-publish update failed:', e));
        }
    });

    if (typeof openRightInterface === 'function') openRightInterface('post-instructions');
};

// ── Collection editor panel (opened by collection-editor.js in the write-pane) ──

window.showCollectionEditorPanel = async function showCollectionEditorPanel(container) {
    const titleEl = document.getElementById('write-title');
    if (_activeCollection) {
        const { col, token, encKey } = _activeCollection;
        if (titleEl) titleEl.textContent = col.name || '';
        _renderCollectionEditor(container, col, token, encKey);
    } else {
        if (titleEl) titleEl.textContent = '';
        _renderCollectionEditor(container, { name: '', items: [] }, null, null);
    }
};

// Render the main collection editor into container.
function _renderCollectionEditor(container, col, token, encKey) {
    container.innerHTML = '';
    const draftItems = col.items.map(i => ({ ...i }));
    _draftItems    = draftItems;
    _refreshEditor = null; // will be set after renderEntries is defined

    // ── Entry list ──
    const list = document.createElement('div');
    list.className = 'collection-editor-list';
    container.appendChild(list);

    function renderEntries() {
        list.innerHTML = '';
        draftItems.forEach((item, idx) =>
            list.appendChild(_renderEntryRow(item, idx, draftItems, renderEntries))
        );
        const addBtn = document.createElement('button');
        addBtn.className   = 'btn';
        addBtn.textContent = '+ Add entry';
        addBtn.style.marginTop = '12px';
        addBtn.onclick = () => { draftItems.push({ title: '', url: '' }); renderEntries(); };
        list.appendChild(addBtn);
    }
    _refreshEditor = renderEntries;
    renderEntries();
}

// Render a single collapsible entry row.
function _renderEntryRow(item, idx, draftItems, refresh) {
    const row      = document.createElement('div');
    row.className  = 'collection-editor-entry';

    const bar      = document.createElement('div');
    bar.className  = 'collection-editor-entry-bar';

    const upBtn    = document.createElement('button');
    upBtn.className = 'clist-action-btn';
    upBtn.title     = 'Move up';
    upBtn.innerHTML = '<span class="material-icons md-18 md-light">arrow_upward</span>';
    upBtn.onclick   = (e) => { e.stopPropagation(); if (idx > 0) { [draftItems[idx-1], draftItems[idx]] = [draftItems[idx], draftItems[idx-1]]; refresh(); } };

    const downBtn   = document.createElement('button');
    downBtn.className = 'clist-action-btn';
    downBtn.title     = 'Move down';
    downBtn.innerHTML = '<span class="material-icons md-18 md-light">arrow_downward</span>';
    downBtn.onclick   = (e) => { e.stopPropagation(); if (idx < draftItems.length-1) { [draftItems[idx], draftItems[idx+1]] = [draftItems[idx+1], draftItems[idx]]; refresh(); } };

    const delBtn    = document.createElement('button');
    delBtn.className = 'clist-action-btn';
    delBtn.title     = 'Remove entry';
    delBtn.innerHTML = '<span class="material-icons md-18 md-light">delete_outline</span>';
    delBtn.onclick   = (e) => { e.stopPropagation(); draftItems.splice(idx, 1); refresh(); };

    const chevron   = document.createElement('span');
    chevron.className   = 'material-icons collection-editor-chevron';
    chevron.textContent = 'expand_more';

    const labelEl   = document.createElement('span');
    labelEl.className   = 'collection-editor-entry-label';
    labelEl.textContent = _collectionItemDisplayTitle(item) || '(untitled)';

    bar.appendChild(upBtn);
    bar.appendChild(downBtn);
    bar.appendChild(chevron);
    bar.appendChild(labelEl);
    bar.appendChild(delBtn);

    const fields    = document.createElement('div');
    fields.className = 'collection-editor-entry-fields';
    fields.style.display = 'none';

    bar.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const open = fields.style.display !== 'none';
        fields.style.display    = open ? 'none' : 'block';
        chevron.textContent     = open ? 'expand_more' : 'expand_less';
    });

    _renderEntryFields(item, fields, () => {
        labelEl.textContent = _collectionItemDisplayTitle(item) || '(untitled)';
    });

    row.appendChild(bar);
    row.appendChild(fields);
    return row;
}

// Render editable fields for a single entry.
function _renderEntryFields(item, container, onTitleChange) {
    [
        { key: 'title',       label: 'Title',       tag: 'input',    type: 'text' },
        { key: 'url',         label: 'URL',         tag: 'input',    type: 'url'  },
        { key: 'author_name', label: 'Author',      tag: 'input',    type: 'text' },
        { key: 'feed',        label: 'Feed',        tag: 'input',    type: 'url'  },
        { key: 'summary',     label: 'Description', tag: 'textarea', type: null   },
    ].forEach(({ key, label, tag, type }) => {
        const wrapper   = document.createElement('div');
        wrapper.className = 'collection-editor-field';

        const labelEl   = document.createElement('label');
        labelEl.textContent = label;
        wrapper.appendChild(labelEl);

        const input     = document.createElement(tag);
        if (type) input.type = type;
        input.value     = item[key] || '';
        input.className = 'collection-editor-input';
        input.addEventListener('input', () => {
            item[key] = input.value;
            if (key === 'title' && onTitleChange) onTitleChange();
        });
        wrapper.appendChild(input);
        container.appendChild(wrapper);
    });
}
