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

    const token = getSiteSpecificCookie(window.CList.config.flaskSiteUrl, 'access_token');
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

    // Close when clicking outside the picker
    const outsideHandler = (e) => {
        if (!picker.contains(e.target) && e.target.id !== `collect-btn-${itemId}`) {
            picker.remove();
            document.removeEventListener('click', outsideHandler, true);
        }
    };
    setTimeout(() => document.addEventListener('click', outsideHandler, true), 0);

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
                btn.addEventListener('click', () =>
                    _addItemToCollection(itemId, col.name, col.encValue, token, encKey, picker, outsideHandler));
                li.appendChild(btn);
                list.appendChild(li);
            }
            picker.appendChild(list);
        }

        // New-collection input row
        const newRow    = document.createElement('div');
        newRow.className = 'collection-picker-new';
        const nameInput = document.createElement('input');
        nameInput.type        = 'text';
        nameInput.className   = 'input-field';
        nameInput.placeholder = 'New collection name…';
        nameInput.maxLength   = 50;
        const createBtn = document.createElement('button');
        createBtn.className   = 'btn';
        createBtn.textContent = 'Create & add';
        createBtn.addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (!name) { showStatusMessage('Please enter a collection name.'); return; }
            if (!_COLLECTION_NAME_RE.test(name)) {
                showStatusMessage('Name may only contain letters, digits, spaces, #, -, and _.');
                return;
            }
            _addItemToCollection(itemId, name, null, token, encKey, picker, outsideHandler);
        });
        nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });
        newRow.appendChild(nameInput);
        newRow.appendChild(createBtn);
        picker.appendChild(newRow);

    } catch (e) {
        console.error('[collection] picker error', e);
        picker.innerHTML = `<p class="feed-status-message">Could not load collections: ${e.message}</p>`;
    }
}

async function _addItemToCollection(itemId, collectionName, encValue, token, encKey, picker, outsideHandler) {
    const cleanup = () => {
        picker.remove();
        document.removeEventListener('click', outsideHandler, true);
    };
    try {
        let items = [];
        if (encValue) {
            try { items = JSON.parse(await decryptWithKey(encKey, encValue)) || []; } catch { items = []; }
        }

        const specificEl = document.getElementById(itemId);
        const ref   = specificEl?.reference || {};
        const url   = ref.url   || '';
        const title = ref.title || url || itemId;

        if (url && items.some(i => i.url === url)) {
            showStatusMessage(`Already in "${collectionName}".`);
            cleanup();
            return;
        }

        items.push({ id: itemId, title, url, ...ref });

        const encrypted = await encryptWithKey(encKey, JSON.stringify(items));
        const kvPayload = { key: `collection:${collectionName}`, value: encrypted };
        const kvHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
        let saveResp = await fetch(`${window.CList.config.flaskSiteUrl}/add_kv/`, {
            method: 'POST', headers: kvHeaders, body: JSON.stringify(kvPayload),
        });
        if (saveResp.status === 409) {
            saveResp = await fetch(`${window.CList.config.flaskSiteUrl}/update_kv/`, {
                method: 'POST', headers: kvHeaders, body: JSON.stringify(kvPayload),
            });
        }
        if (!saveResp.ok) throw new Error(`kvstore error ${saveResp.status}`);

        const btn = document.getElementById(`collect-btn-${itemId}`);
        if (btn) btn.classList.add('action-active');
        cleanup();
        showStatusMessage(`Added to "${collectionName}".`);
    } catch (e) {
        console.error('[collection] add failed', e);
        showStatusMessage('Could not add to collection: ' + e.message);
    }
}

// Open a collection's items as editor references and open the write pane.
function _loadCollectionIntoEditor(items) {
    if (!items?.length) { showStatusMessage('This collection is empty.'); return; }

    // ── 1. Build editor body content ────────────────────────────────────────
    const isHtmlEditor = (typeof currentEditor !== 'undefined' && currentEditor === 'tinymce');
    const filteredItems = items.filter(item => item.url);

    const paragraphs = filteredItems.map(item => {
        const author = (item.author_name && !item.author_name.startsWith('('))
            ? item.author_name : (item.feed || 'Unknown');
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
    const editorDivId = isHtmlEditor ? 'tinymceEditorDiv' : 'textEditorDiv';
    const editorDiv = document.getElementById(editorDivId);
    if (!editorDiv) return;

    editorDiv.references = editorDiv.references || [];
    const existingUrls = new Set(editorDiv.references.map(r => r.url));
    let added = 0;

    for (const item of items) {
        if (!item.url || existingUrls.has(item.url)) continue;
        editorDiv.references.push({ ...item, statusID: item.id });
        existingUrls.add(item.url);
        added++;
    }

    if (added > 0) {
        const refsBtn = document.getElementById('references-button');
        if (refsBtn) refsBtn.style.display = '';
    }

    if (typeof displayReferences === 'function') displayReferences(editorDiv);
    showStatusMessage('References loaded — click Refs to view');
}

// Remove one item from a collection in kvstore and update the UI in place.
async function _removeItemFromCollection(col, itemUrl, token, encKey, countSpan, itemsDiv) {
    try {
        col.items = col.items.filter(i => i.url !== itemUrl);
        const encrypted = await encryptWithKey(encKey, JSON.stringify(col.items));
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

        // Social platform items store the platform name as title — use author_name instead
        const isSocial = item.service === 'Mastodon' || item.service === 'Bluesky'
                      || item.title === 'Mastodon'   || item.title === 'Bluesky';
        const displayTitle = isSocial
            ? (item.author_name || item.title || item.url)
            : (item.title || item.url);

        // For social items, build "Platform (@handle)" as the feed byline
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
    const feedContainer = document.getElementById('feed-container');
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
    loadBtn.onclick   = () => _loadCollectionIntoEditor(col.items);

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

// List all saved collections from kvstore.
window.showSavedCollections = async function() {
    // Clean up any detail-view popstate handler if navigating here directly
    if (_collectionsPopstateHandler) {
        window.removeEventListener('popstate', _collectionsPopstateHandler);
        _collectionsPopstateHandler = null;
    }

    const feedSection   = document.getElementById('feed-section');
    const feedMenu      = document.getElementById('feed-menu');
    const feedContainer = document.getElementById('feed-container');
    if (!feedContainer) return;

    if (feedSection) feedSection.style.display = '';   // restore CSS flex layout
    if (feedMenu)  { feedMenu.style.display = '';  feedMenu.innerHTML = ''; }
    feedContainer.innerHTML = '<p class="feed-status-message">Loading collections…</p>';

    const token = getSiteSpecificCookie(window.CList.config.flaskSiteUrl, 'access_token');
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
                const items = JSON.parse(await decryptWithKey(encKey, kv.value));
                collections.push({ key: kv.key, name: kv.key.replace(/^collection:/, ''), items });
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
    } catch (e) {
        console.error('[collection] load failed', e);
        feedContainer.innerHTML = `<p class="feed-status-message">Could not load collections: ${e.message}</p>`;
    }
};
