console.log('[annotations] annotate.js loading');
//  annotate.js  -  Annotation store account type for CList
//  Part of CList, the next generation of learning and connecting with your community
//
//  Copyright National Research Council of Canada 2025
//  Licensed under Creative Commons Attribution 4.0 International https://creativecommons.org/licenses/by/4.0/
//
//  This software carries NO WARRANTY OF ANY KIND.
//  This software is provided "AS IS," and you, its user, assume all risks when using it.

window.accountSchemas = window.accountSchemas || {};
window.accountSchemas['Annotate'] = {
    type: 'Annotate',
    instanceFromKey: true,
    kvKey: { label: 'Store URL', placeholder: 'https://annotations.mooc.ca' },
    fields: [
        { key: 'title',       label: 'Title',       editable: true, inputType: 'text', placeholder: 'My Annotations', default: '' },
        { key: 'permissions', label: 'Permissions', editable: true, inputType: 'text', placeholder: 'rw',              default: 'rw' },
    ]
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function _annoHe(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Convert a did:web:host:users:username DID to a human-readable profile URL.
// Passes the visitor's kvstore URL (so the profile page can build a Follow link)
// and their token in the URL fragment (fragments are not sent to the server,
// so the token doesn't appear in logs; the follow page uses it to skip re-login).
function _didToProfileUrl(did) {
    const m = String(did || '').match(/^did:web:([^:]+):users:(.+)$/);
    if (!m) return null;
    const base = `https://${m[1]}/users/${m[2]}/did.html`;
    const myKvstore = typeof flaskSiteUrl !== 'undefined' ? flaskSiteUrl : null;
    if (!myKvstore) return base;
    const params = `?mykvstore=${encodeURIComponent(myKvstore)}`;
    return base + params;
}

// ── Add-annotation form ────────────────────────────────────────────────────────

async function _submitAnnotation(panel, itemID, url, bodyText, tags, visibility, acct, token) {
    const payload = {
        target_url: url,
        body: bodyText,
        tags: tags.length ? tags : [],
        visibility,
        motivation: 'commenting',
    };

    try {
        const resp = await fetch(`${acct.instance}/annotations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': 'Bearer ' + token,
            },
            body: JSON.stringify(payload),
        });

        if (resp.ok) {
            // Force reload of the panel
            delete panel.dataset.loaded;
            await window.showAnnotations(itemID);
        } else {
            const err = await resp.json().catch(() => ({}));
            if (resp.status === 403 && (err.detail || '').includes('Not registered')) {
                showStatusMessage('Not registered on this annotation server — please re-add the account in Account Settings.');
            } else {
                showStatusMessage('Failed to save annotation: ' + (err.detail || resp.status));
            }
            console.error('Annotation POST failed', resp.status, err);
        }
    } catch (e) {
        showStatusMessage('Error saving annotation — check your connection and try again.');
        console.error('Annotation POST error', e);
    }
}

function _appendAddForm(panel, itemID, url, writeAccts, token) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'margin-top:8px;border-top:1px solid #e8e8e8;padding-top:6px;';

    const toggle = document.createElement('button');
    toggle.textContent = '+ Add annotation';
    toggle.style.cssText = 'background:none;border:none;color:#2068ba;font-size:0.8rem;cursor:pointer;padding:0;margin-bottom:4px;';

    const form = document.createElement('div');
    form.style.display = 'none';

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Your annotation…';
    textarea.rows = 3;
    textarea.style.cssText = 'width:100%;box-sizing:border-box;font-size:0.82rem;resize:vertical;margin-bottom:4px;';

    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.placeholder = 'Tags (comma-separated, optional)';
    tagsInput.style.cssText = 'width:100%;box-sizing:border-box;font-size:0.82rem;margin-bottom:4px;';

    const visRow = document.createElement('div');
    visRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:0.8rem;color:#555;';

    const visLabel = document.createElement('label');
    visLabel.textContent = 'Visibility:';

    const visSelect = document.createElement('select');
    visSelect.style.cssText = 'font-size:0.8rem;width:auto;padding:2px 4px;margin:0;';
    [['public','Public'],['private','Private']].forEach(([val, text]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = text;
        visSelect.appendChild(opt);
    });

    visRow.appendChild(visLabel);
    visRow.appendChild(visSelect);

    // If multiple write stores, let user pick which one
    let storeSelect = null;
    if (writeAccts.length > 1) {
        const storeLabel = document.createElement('label');
        storeLabel.textContent = 'Store:';
        storeSelect = document.createElement('select');
        storeSelect.style.cssText = 'font-size:0.8rem;width:auto;padding:2px 4px;margin:0;';
        writeAccts.forEach((acct, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = acct.title || acct.instance;
            storeSelect.appendChild(opt);
        });
        visRow.appendChild(storeLabel);
        visRow.appendChild(storeSelect);
    }

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;';

    const submitBtn = document.createElement('button');
    submitBtn.textContent = 'Save';
    submitBtn.style.cssText = 'font-size:0.8rem;padding:3px 10px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'font-size:0.8rem;padding:3px 10px;background:#eee;color:#555;';

    btnRow.appendChild(submitBtn);
    btnRow.appendChild(cancelBtn);

    form.appendChild(textarea);
    form.appendChild(tagsInput);
    form.appendChild(visRow);
    form.appendChild(btnRow);

    toggle.addEventListener('click', () => {
        const shown = form.style.display === 'block';
        form.style.display = shown ? 'none' : 'block';
        toggle.textContent = shown ? '+ Add annotation' : '− Add annotation';
        if (!shown) textarea.focus();
    });

    cancelBtn.addEventListener('click', () => {
        form.style.display = 'none';
        toggle.textContent = '+ Add annotation';
        textarea.value = '';
        tagsInput.value = '';
    });

    submitBtn.addEventListener('click', async () => {
        const bodyText = textarea.value.trim();
        if (!bodyText) { showStatusMessage('Annotation text is required.'); return; }

        const tags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
        const visibility = visSelect.value;
        const acct = storeSelect ? writeAccts[parseInt(storeSelect.value, 10)] : writeAccts[0];

        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';
        await _submitAnnotation(panel, itemID, url, bodyText, tags, visibility, acct, token);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save';
    });

    wrapper.appendChild(toggle);
    wrapper.appendChild(form);
    panel.appendChild(wrapper);
}

// ── Render ─────────────────────────────────────────────────────────────────────

function _renderAnnotations(panel, annotations, writeAccts, url, token, itemID) {
    panel.innerHTML = '';

    const header = document.createElement('div');
    header.style.cssText = 'font-size:0.75rem;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;';
    header.textContent = annotations.length
        ? `${annotations.length} annotation${annotations.length === 1 ? '' : 's'}`
        : 'Annotations';
    panel.appendChild(header);

    if (!annotations.length) {
        const empty = document.createElement('span');
        empty.className = 'feed-status-message';
        empty.textContent = 'No annotations for this page yet.';
        panel.appendChild(empty);
    } else {
        annotations.forEach(anno => {
            const div = document.createElement('div');
            div.className = 'annotation-item';

            const creatorId = anno.creator?.id || anno.creator || '';
            const creator = creatorId.replace(/^did:web:[^:]+:users:/, '') || 'Unknown';
            const body = anno.body?.value || anno.body || '';
            const date = anno.created ? new Date(anno.created).toLocaleDateString() : '';
            const tags = Array.isArray(anno.tag) ? anno.tag.join(', ') : '';

            const safeBody = typeof sanitizeHtml === 'function'
                ? sanitizeHtml(body).toString()
                : _annoHe(body);
            div.innerHTML =
                `<span class="annotation-creator">${_annoHe(creator)}</span>` +
                `<span class="annotation-date">${_annoHe(date)}</span>` +
                `<div class="annotation-body">${safeBody}</div>` +
                (tags ? `<div class="annotation-tags">${_annoHe(tags)}</div>` : '');

            panel.appendChild(div);
        });
    }

    if (writeAccts && writeAccts.length && token) {
        _appendAddForm(panel, itemID, url, writeAccts, token);
    }
}

// ── Open write-pane annotation editor ─────────────────────────────────────────

let _annotationTarget = null;   // full reference object captured when editor is opened

window.clistAnnotate = function(itemId) {
    const el = document.getElementById(itemId);
    if (!el || !el.reference) {
        showStatusMessage('No reference found for this item.');
        return;
    }
    _annotationTarget = { ...el.reference };

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';
    const content = selectedText
        ? { type: 'text/plain', value: `${el.reference.author_name || 'Unknown'} wrote: "${selectedText}"\n` }
        : { type: 'text/plain', value: '' };

    if (typeof loadContent === 'function') loadContent(content, itemId);

    if (typeof snapPanes === 'function' && typeof mainContent !== 'undefined' && typeof readPane !== 'undefined') {
        const ratio = readPane.getBoundingClientRect().width / mainContent.getBoundingClientRect().width;
        if (ratio > 0.65) snapPanes('left');
    } else if (typeof mobShowWrite === 'function') {
        mobShowWrite();
    }
};

window.openAnnotationEditor = function(itemId) {
    const el = document.getElementById(itemId);
    if (!el || !el.reference) {
        showStatusMessage('No reference found for this item.');
        return;
    }
    _annotationTarget = { ...el.reference };

    // Clear the active editor content
    const textarea = document.getElementById('text-column');
    if (textarea) {
        textarea.value = '';
        textarea.setSelectionRange(0, 0);
    }
    if (window.tinymce && tinymce.activeEditor) {
        tinymce.activeEditor.setContent('');
    }

    // Load empty content so the reference system registers this item
    const handler = typeof editorHandlers !== 'undefined' && editorHandlers[currentEditor];
    if (handler && typeof handler.loadContent === 'function') {
        handler.loadContent({ type: 'text/html', value: '' }, itemId);
    }

    // Show write pane if the divider is at the far right (read pane taking >65% of width)
    if (typeof snapPanes === 'function' && typeof mainContent !== 'undefined' && typeof readPane !== 'undefined') {
        const ratio = readPane.getBoundingClientRect().width / mainContent.getBoundingClientRect().width;
        if (ratio > 0.65) snapPanes('left');
    } else if (typeof mobShowWrite === 'function') {
        mobShowWrite();
    }
};

// ── Publish handler ────────────────────────────────────────────────────────────

(function() {
    window.publishHandlers = window.publishHandlers || {};
    window.publishHandlers['Annotate'] = {
        construct: function(title, post) {
            // Extract just the editor body from the packagePost() wrapper
            const parsed = new DOMParser().parseFromString(post, 'text/html');
            const postContent = parsed.getElementById('post-content');
            return postContent ? postContent.innerHTML.trim() : post;
        },
        publish: async function(accountData, title, content) {
            // Collect targets: use the editor's full reference list if populated,
            // otherwise fall back to the single _annotationTarget set by openAnnotationEditor.
            const editorDivId = (typeof currentEditor !== 'undefined' && currentEditor === 'tinymce')
                ? 'tinymceEditorDiv' : 'textEditorDiv';
            const editorDiv = document.getElementById(editorDivId);
            const refs = (editorDiv?.references && editorDiv.references.length)
                ? editorDiv.references
                : (_annotationTarget ? [_annotationTarget] : null);

            if (!refs || !refs.length) {
                showStatusMessage('No target — load items into the editor before annotating.');
                return null;
            }

            const token = getSiteSpecificCookie(flaskSiteUrl, 'access_token') || '';
            if (!token) {
                showStatusMessage('Not logged in — cannot post annotation.');
                return null;
            }

            let successCount = 0;
            let failCount = 0;
            let firstId = null;

            for (const ref of refs) {
                if (!ref.url || ref.url === '(no URL provided)') continue;
                const payload = {
                    target_url:      ref.url,
                    target_selector: {
                        title:       ref.title       || '',
                        author_name: ref.author_name || '',
                        feed:        ref.feed        || '',
                        created_at:  ref.created_at  || '',
                        guid:        ref.guid        || '',
                    },
                    body:       content,
                    tags:       [],
                    visibility: 'public',
                    motivation: 'commenting',
                };
                try {
                    const resp = await fetch(`${accountData.instance}/annotations`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'Authorization': 'Bearer ' + token,
                        },
                        body: JSON.stringify(payload),
                    });
                    if (resp.ok) {
                        const anno = await resp.json();
                        if (!firstId) firstId = anno.id || null;
                        successCount++;
                    } else {
                        const err = await resp.json().catch(() => ({}));
                        if (resp.status === 403 && (err.detail || '').includes('Not registered')) {
                            showStatusMessage('Not registered on this annotation server — please re-add the account in Account Settings.');
                        } else {
                            showStatusMessage('Annotation failed: ' + (err.detail || resp.status));
                        }
                        console.error('Annotation POST failed', resp.status, err, 'for', ref.url);
                        failCount++;
                    }
                } catch (e) {
                    showStatusMessage('Error posting annotation — check your connection and try again.');
                    console.error('Annotation POST error for', ref.url, e);
                    failCount++;
                }
            }

            _annotationTarget = null;

            if (successCount === 0) return null;

            if (successCount === 1) {
                // Single item: let the caller display the link in #post-result normally
                return firstId;
            }

            // Convergent: append a link row per item directly into #post-result
            const resultDiv = document.getElementById('post-result');
            if (resultDiv) {
                refs.forEach(ref => {
                    if (!ref.url || ref.url === '(no URL provided)') return;
                    const p = document.createElement('p');
                    p.className = 'feed-status-message';
                    p.innerHTML = `Annotated: <a href="${ref.url}" target="_blank">${ref.url}</a>`;
                    resultDiv.appendChild(p);
                });
            }
            showStatusMessage(`Annotation posted to ${successCount} items (convergent annotation)${failCount ? `, ${failCount} failed` : ''}.`);
            return null;
        }
    };
})();

// ── Show annotations for a feed item ──────────────────────────────────────────

window.showAnnotations = async function(itemID) {
    const el = document.getElementById(itemID);
    if (!el) return;

    const url = el.reference?.url;
    if (!url || url === '(no URL provided)') {
        showStatusMessage('No URL associated with this item.');
        return;
    }

    const panel = document.getElementById('annotations-' + itemID);
    if (!panel) return;

    const btn = document.getElementById('anno-btn-' + itemID);

    // Toggle if already loaded
    if (panel.dataset.loaded === 'true') {
        const isVisible = panel.style.display === 'block';
        panel.style.display = isVisible ? 'none' : 'block';
        if (btn) btn.classList.toggle('action-active', !isVisible);
        return;
    }

    // First load — show loading state
    panel.style.display = 'block';
    panel.innerHTML = '<span style="color:#aaa;font-size:0.82rem;">Loading annotations…</span>';
    if (btn) btn.classList.add('action-active');

    try {
        // Find configured Annotate accounts
        const annotateAccounts = (accounts || [])
            .map(a => parseAccountValue(a))
            .filter(d => d && d.type === 'Annotate' && d.instance);

        if (!annotateAccounts.length) {
            panel.dataset.loaded = 'true';
            panel.innerHTML = '<span class="feed-status-message">No annotation store configured. Add an Annotate account to get started.</span>';
            return;
        }

        // Determine write-capable accounts and current auth token
        const token = getSiteSpecificCookie(flaskSiteUrl, 'access_token') || '';
        const writeAccts = token
            ? annotateAccounts.filter(a => (a.permissions || 'rw').includes('w'))
            : [];

        // Fetch from all configured stores in parallel
        const allAnnotations = [];
        await Promise.all(annotateAccounts.map(async acct => {
            try {
                const resp = await fetch(
                    `${acct.instance}/annotations?target=${encodeURIComponent(url)}&limit=50`,
                    { headers: { 'Accept': 'application/json' } }
                );
                if (resp.ok) {
                    const data = await resp.json();
                    allAnnotations.push(...(data.items || []));
                } else {
                    console.error('Annotation store returned', resp.status, 'for', acct.instance);
                }
            } catch (e) {
                console.error('Annotation fetch error from', acct.instance, e);
            }
        }));

        panel.dataset.loaded = 'true';
        _renderAnnotations(panel, allAnnotations, writeAccts, url, token, itemID);
    } catch (e) {
        console.error('showAnnotations error:', e);
        panel.dataset.loaded = 'true';
        panel.innerHTML = '<span class="error-message">Failed to load annotations: ' + _annoHe(e.message) + '</span>';
    }
};

// ── Federated annotation discovery ────────────────────────────────────────────
// Reads the encrypted follows list, fetches each followed user's DID document,
// and returns any AnnotationService endpoints found there.
// Result is cached for 5 minutes so the MutationObserver-triggered batch check
// doesn't re-fetch DID documents on every feed update.

let _federatedCache     = null;
let _federatedCacheTime = 0;
const _FEDERATED_TTL    = 5 * 60 * 1000;

let _followedDidsCache     = null;
let _followedDidsCacheTime = 0;

window._clistAnnotateInvalidateFollowCache = function() {
    _followedDidsCache = null;
    _federatedCache    = null;
};

async function _getFederatedAnnotationAccounts() {
    if (_federatedCache && Date.now() - _federatedCacheTime < _FEDERATED_TTL) {
        return _federatedCache;
    }

    const token  = getSiteSpecificCookie(flaskSiteUrl, 'access_token');
    const encKey = token ? await getEncKey(flaskSiteUrl) : null;
    if (!encKey) { _federatedCache = []; return []; }

    // Fetch all KV pairs and find follow entries
    let kvs = [];
    try {
        const resp = await fetch(`${flaskSiteUrl}/get_kvs/`,
            { headers: { Authorization: 'Bearer ' + token } });
        if (resp.ok) kvs = await resp.json();
    } catch (e) {
        console.error('Federated annotation: KV fetch failed', e);
    }

    const followKvs = kvs.filter(kv => kv.key.startsWith('social:following:'));

    // Decrypt each follow to get the target DID
    const followedDids = (await Promise.all(followKvs.map(async kv => {
        try {
            const data = JSON.parse(await decryptWithKey(encKey, kv.value));
            return data.did || null;
        } catch { return null; }
    }))).filter(Boolean);

    // For each followed DID, fetch their DID document and extract AnnotationService endpoints
    const seen = new Set();
    const fedAccounts = (await Promise.all(followedDids.map(async did => {
        try {
            const m = did.match(/^did:web:([^:]+):users:(.+)$/);
            if (!m) return [];
            const resp = await fetch(`https://${m[1]}/users/${m[2]}/did.json`,
                { headers: { Accept: 'application/json' } });
            if (!resp.ok) return [];
            const doc = await resp.json();
            return (doc.service || [])
                .filter(s => s.type === 'AnnotationService' && s.serviceEndpoint)
                .map(s => ({ instance: s.serviceEndpoint }));
        } catch { return []; }
    }))).flat().filter(acct => {
        if (seen.has(acct.instance)) return false;
        seen.add(acct.instance);
        return true;
    });

    _federatedCache     = fedAccounts;
    _federatedCacheTime = Date.now();
    return fedAccounts;
}

// Returns the Set of DIDs the logged-in user is following (from encrypted kvstore entries).
// Cached for the same TTL as the federated cache.
async function _getFollowedDids() {
    if (_followedDidsCache && Date.now() - _followedDidsCacheTime < _FEDERATED_TTL) {
        return _followedDidsCache;
    }
    const token  = getSiteSpecificCookie(flaskSiteUrl, 'access_token');
    const encKey = token ? await getEncKey(flaskSiteUrl) : null;
    if (!encKey) { _followedDidsCache = new Set(); return _followedDidsCache; }
    let kvs = [];
    try {
        const resp = await fetch(`${flaskSiteUrl}/get_kvs/`,
            { headers: { Authorization: 'Bearer ' + token } });
        if (resp.ok) kvs = await resp.json();
    } catch (e) { console.error('_getFollowedDids: KV fetch failed', e); }
    const dids = new Set((await Promise.all(
        kvs.filter(kv => kv.key.startsWith('social:following:'))
           .map(async kv => {
               try {
                   const data = JSON.parse(await decryptWithKey(encKey, kv.value));
                   return data.did || null;
               } catch { return null; }
           })
    )).filter(Boolean));
    _followedDidsCache     = dids;
    _followedDidsCacheTime = Date.now();
    return dids;
}

// Returns the combined list of local + federated annotation accounts, deduplicated by instance URL.
async function _allAnnotationAccounts() {
    const local = (accounts || [])
        .map(a => parseAccountValue(a))
        .filter(d => d && d.type === 'Annotate' && d.instance);
    const federated = await _getFederatedAnnotationAccounts();
    const seen = new Set(local.map(a => a.instance));
    return [...local, ...federated.filter(a => !seen.has(a.instance))];
}

// ── Batch annotation check (runs after feed renders) ──────────────────────────

window.checkAnnotationsBatch = async function() {
    console.log('[annotations] checkAnnotationsBatch called');
    try {
        const allAccounts = await _allAnnotationAccounts();
        if (!allAccounts.length) return;

        const items = Array.from(document.querySelectorAll('.statusSpecific'))
            .filter(el => el.reference && el.reference.url && el.reference.url !== '(no URL provided)');
        console.log('[annotations] batch check: found', items.length, 'items with reference URLs');
        if (!items.length) return;

        const urlToItems = {};
        items.forEach(el => {
            const ref = el.reference;
            const urlSet = [ref.url];
            if (ref.guid && ref.guid !== ref.url) urlSet.push(ref.guid);
            urlSet.forEach(u => {
                if (!urlToItems[u]) urlToItems[u] = [];
                urlToItems[u].push(el);
            });
        });
        const urls = Object.keys(urlToItems);
        console.log('[annotations] batch check: sending', urls.length, 'URLs to server');

        const counts = {};
        await Promise.all(allAccounts.map(async acct => {
            try {
                const resp = await fetch(`${acct.instance}/annotations/batch-check`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ urls }),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    console.log('[annotations] batch check response from', acct.instance, data.results);
                    Object.entries(data.results || {}).forEach(([url, cnt]) => {
                        counts[url] = (counts[url] || 0) + cnt;
                    });
                } else {
                    console.error('[annotations] batch check: server returned', resp.status, 'from', acct.instance);
                }
            } catch (e) {
                console.error('[annotations] batch check error from', acct.instance, e);
            }
        }));

        const matchedCount = Object.values(counts).filter(c => c > 0).length;
        console.log('[annotations] batch check: counts for', matchedCount, 'URLs:', counts);

        items.forEach(el => {
            const ref = el.reference;
            const count = counts[ref.url] || counts[ref.guid] || 0;
            if (!count) return;
            const itemId = el.id;
            if (!itemId) { console.warn('[annotations] item has no id', el); return; }
            const liveEl = document.getElementById(itemId);
            if (!liveEl) { console.warn('[annotations] getElementById returned null for', itemId); return; }
            const statusActions = liveEl.parentElement?.querySelector(':scope > .status-actions');
            if (!statusActions) { console.warn('[annotations] no .status-actions found for', itemId, 'parent:', liveEl.parentElement); return; }
            if (statusActions.querySelector('.anno-read-btn')) return;
            console.log('[annotations] injecting button for', itemId, 'count:', count);
            const btn = document.createElement('button');
            btn.className = 'anno-read-btn';
            btn.title = 'Read annotations';
            btn.innerHTML = `<span class="material-icons md-18">rate_review</span>&thinsp;(${count})`;
            btn.addEventListener('click', () => window.showAnnotationThread(itemId));
            statusActions.appendChild(btn);
        });

        // Inject "Follow feed author" buttons for items whose feed advertises a DID.
        // Runs async after annotation counts so it doesn't block the main check.
        const batchToken = getSiteSpecificCookie(flaskSiteUrl, 'access_token') || '';
        if (batchToken) {
            const batchMyKvDomain = (flaskSiteUrl || '').replace(/^https?:\/\//, '');
            const batchMyDid = (typeof username !== 'undefined' && username)
                ? `did:web:${batchMyKvDomain}:users:${username}` : '';
            const batchFollowedDids = await _getFollowedDids();

            // Collect unique feed URLs from all visible items
            const feedUrlToItems = new Map();
            items.forEach(el => {
                const fu = el.reference?.feedUrl;
                if (!fu) return;
                if (!feedUrlToItems.has(fu)) feedUrlToItems.set(fu, []);
                feedUrlToItems.get(fu).push(el);
            });

            await Promise.all([...feedUrlToItems.entries()].map(async ([fu, els]) => {
                const authorDid = await _getAuthorDidFromFeed(fu);
                if (!authorDid || authorDid === batchMyDid || batchFollowedDids.has(authorDid)) return;
                const authorUsername = authorDid.replace(/^did:web:[^:]+:users:/, '');
                els.forEach(el => {
                    const liveEl = document.getElementById(el.id);
                    if (!liveEl) return;
                    const clistActions = liveEl.closest('.status-box')?.querySelector(':scope > .clist-actions');
                    if (!clistActions || clistActions.querySelector('.anno-follow-author-btn')) return;
                    const followBtn = document.createElement('button');
                    followBtn.className = 'clist-action-btn anno-follow-author-btn';
                    followBtn.title = 'Follow ' + authorUsername;
                    followBtn.innerHTML = '<span class="material-icons md-18 md-light">person_add</span>';
                    followBtn.addEventListener('click', () => {
                        _followUser(authorDid, batchToken, followBtn).catch(e => {
                            showStatusMessage('Follow error: ' + e.message);
                            console.error('Follow error', e);
                        });
                        // Remove buttons for all other items from the same feed
                        document.querySelectorAll('.anno-follow-author-btn').forEach(b => {
                            if (b !== followBtn) { b.disabled = true; b.title = 'Following ' + authorUsername; }
                        });
                    });
                    clistActions.appendChild(followBtn);
                });
            }));
        }
    } catch (e) {
        console.error('[annotations] checkAnnotationsBatch failed:', e);
        showStatusMessage('Annotation check failed: ' + e.message);
    }
};


// ── Annotation thread view (replaces feed contents, restores on close) ────────

let _popstateHandler  = null;
let _savedFeedContent = null;
let _savedScrollTop   = 0;

async function _flowAnnotation(anno, targetUrl, writeAccts, token, btn) {
    const body = anno.body?.value || anno.body || '';
    const creatorId = anno.creator?.id || anno.creator || '';
    const payload = {
        target_url: targetUrl,
        body,
        target_selector: { via: creatorId, via_annotation_id: anno.id || '' },
        tags: Array.isArray(anno.tag) ? anno.tag : [],
        visibility: 'public',
        motivation: 'flowing',
    };
    btn.disabled = true;
    let lastErr = null;
    for (const acct of writeAccts.filter(a => a.type === 'Annotate')) {
        try {
            const resp = await fetch(`${acct.instance}/annotations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
                           'Authorization': 'Bearer ' + token },
                body: JSON.stringify(payload),
            });
            if (resp.ok) {
                btn.innerHTML = '<span class="material-icons md-18 md-light">check</span>';
                showStatusMessage('Annotation flowed to ' + (acct.title || acct.instance));
                return;
            }
            const err = await resp.json().catch(() => ({}));
            console.error('Flow failed on', acct.instance, resp.status, err);
            lastErr = err;
        } catch (e) {
            console.error('Flow error on', acct.instance, e);
            lastErr = { detail: e.message };
        }
    }
    // All accounts tried and failed
    showStatusMessage('Flow failed: ' + (lastErr?.detail || 'no writable annotation store succeeded'));
    console.error('Flow failed on all accounts', lastErr);
    btn.disabled = false;
}

// Look up a DID by social handle (e.g. "user@mastodon.social") across known kvstore instances.
// Queries each kvstore's /users/by-handle endpoint and returns the first matched DID, or null.
// kvstoreUrls defaults to the user's own flaskSiteUrl plus any configured kvstore accounts.
async function findDidByHandle(handle) {
    if (!handle) return null;

    // Collect kvstore URLs to search: own + any additional configured kvstore accounts
    const kvUrls = new Set([flaskSiteUrl].filter(Boolean));
    (window.accounts || []).forEach(a => {
        const d = parseAccountValue(a);
        if (d && d.type === 'kvstore' && d.instance) kvUrls.add(d.instance);
    });

    for (const url of kvUrls) {
        try {
            const resp = await fetch(
                `${url}/users/by-handle?handle=${encodeURIComponent(handle)}`,
                { headers: { Accept: 'application/json' } }
            );
            if (resp.ok) {
                const data = await resp.json();
                if (data.results && data.results.length) return data.results[0].did;
            }
        } catch (e) {
            console.warn('findDidByHandle: error querying', url, e);
        }
    }
    return null;
}

// Fetch the author_did advertised in a feed's metadata via opml2json /feed_meta.
// Uses the configured OPML2JSON account URL if available, falling back to the default.
// Returns a DID string or null. No auth needed — /feed_meta is public.
// Results are cached in-memory for the session to avoid repeated lookups in checkAnnotationsBatch.
const _feedAuthorDidCache = new Map();

async function _getAuthorDidFromFeed(feedUrl) {
    if (!feedUrl || feedUrl === '(no feed specified)') return null;
    if (_feedAuthorDidCache.has(feedUrl)) return _feedAuthorDidCache.get(feedUrl);
    let serviceUrl = 'https://opml2json.downes.ca';
    try {
        const accts = Array.isArray(window.accounts) ? window.accounts : [];
        const found = accts.find(a => {
            const d = parseAccountValue(a);
            return d && d.type === 'OPML2JSON';
        });
        if (found) {
            const d = parseAccountValue(found);
            if (d && d.instance) serviceUrl = d.instance;
        }
    } catch (e) { console.error('_getAuthorDidFromFeed: error reading OPML2JSON account, using default', e); }
    let result = null;
    try {
        const resp = await fetch(`${serviceUrl}/feed_meta?url=${encodeURIComponent(feedUrl)}`);
        if (resp.ok) {
            const data = await resp.json();
            result = (data.ok && data.author_did) ? data.author_did : null;
        }
    } catch (e) {
        console.warn('_getAuthorDidFromFeed failed:', e);
    }
    _feedAuthorDidCache.set(feedUrl, result);
    return result;
}

async function _followUser(did, token, btn) {
    let encKey;
    try {
        encKey = await getEncKey(flaskSiteUrl);
    } catch (e) {
        console.error('_followUser: getEncKey failed:', e);
        showStatusMessage('Could not retrieve encryption key — please log in again.');
        return;
    }
    if (!encKey) { showStatusMessage('Encryption key not available — please log in.'); return; }
    const key   = `social:following:${did}`;
    const value = { did, since: new Date().toISOString() };
    btn.disabled = true;
    try {
        const encryptedValue = await encryptWithKey(encKey, JSON.stringify(value));
        const resp = await fetch(`${flaskSiteUrl}/add_kv/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ key, value: encryptedValue }),
        });
        if (resp.ok) {
            btn.innerHTML = '<span class="material-icons md-18 md-light">how_to_reg</span>';
            btn.title = 'Following';
            showStatusMessage('Now following ' + did.replace(/^did:web:[^:]+:users:/, ''));
            _followedDidsCache = null;
            _federatedCache    = null;
        } else {
            showStatusMessage('Follow failed (server error ' + resp.status + ') — try again or re-add your account.');
            console.error('Follow failed', resp.status);
            btn.disabled = false;
        }
    } catch (e) {
        showStatusMessage('Error following user — check your connection and try again.');
        console.error('Follow error', e);
        btn.disabled = false;
    }
}

window.showAnnotationThread = async function(itemId) {
    const el = document.getElementById(itemId);
    if (!el || !el.reference) return;
    const fc = document.getElementById('feed-container');
    if (!fc) return;

    try {
    const url  = el.reference.url;
    const guid = el.reference.guid;
    const checkUrls = guid && guid !== url ? [url, guid] : [url];

    const token = getSiteSpecificCookie(flaskSiteUrl, 'access_token') || '';
    const annotateAccounts = (accounts || [])
        .map(a => parseAccountValue(a))
        .filter(d => d && d.type === 'Annotate' && d.instance);
    const writeAccts = token
        ? annotateAccounts.filter(a => (a.permissions || 'rw').includes('w'))
        : [];

    // Compute logged-in user's DID here (before forEach where `username` would be shadowed)
    const myKvDomain = (flaskSiteUrl || '').replace(/^https?:\/\//, '');
    const myDid = (typeof username !== 'undefined' && username)
        ? `did:web:${myKvDomain}:users:${username}` : '';

    const followedDids = await _getFollowedDids();

    // Fetch all annotations for this URL (local + federated servers)
    const rawAnnotations = [];
    await Promise.all((await _allAnnotationAccounts()).map(async acct => {
        try {
            await Promise.all(checkUrls.map(async u => {
                const resp = await fetch(
                    `${acct.instance}/annotations?target=${encodeURIComponent(u)}&limit=50`,
                    { headers: { 'Accept': 'application/json' } }
                );
                if (resp.ok) {
                    const data = await resp.json();
                    rawAnnotations.push(...(data.items || []));
                }
            }));
        } catch (e) {
            console.error('Annotation fetch error', e);
        }
    }));
    const seen = new Set();
    const allAnnotations = rawAnnotations.filter(a => {
        const id = a.id || JSON.stringify(a);
        if (seen.has(id)) return false;
        seen.add(id); return true;
    });

    // When logged in: show only own annotations + annotations from followed users.
    // When not logged in: show all (federated set is empty anyway, so these are just local public annotations).
    const displayAnnotations = token
        ? allAnnotations.filter(a => {
              const c = a.creator?.id || a.creator || '';
              return (myDid && c === myDid) || followedDids.has(c);
          })
        : allAnnotations;

    // Save the current feed and scroll position
    _savedScrollTop   = fc.scrollTop;
    _savedFeedContent = document.createDocumentFragment();
    while (fc.firstChild) _savedFeedContent.appendChild(fc.firstChild);

    // Header with close button
    const header = document.createElement('div');
    header.className = 'annotation-thread-header';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'annotation-thread-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', window.closeAnnotationThread);
    const heading = document.createElement('span');
    heading.textContent = displayAnnotations.length
        ? `${displayAnnotations.length} annotation${displayAnnotations.length === 1 ? '' : 's'} for this item`
        : 'Annotations';
    header.appendChild(closeBtn);
    header.appendChild(heading);
    fc.appendChild(header);

    // Async: if the feed advertises a DID and we're not already following, offer a Follow button
    const feedUrl = el.reference?.feedUrl;
    if (feedUrl && token) {
        _getAuthorDidFromFeed(feedUrl).then(authorDid => {
            if (!authorDid || authorDid === myDid || followedDids.has(authorDid)) return;
            const authorUsername = authorDid.replace(/^did:web:[^:]+:users:/, '');
            const banner = document.createElement('div');
            banner.className = 'annotation-feed-author-banner';
            const label = document.createElement('span');
            label.textContent = `Feed author: ${authorUsername}`;
            const followBtn = document.createElement('button');
            followBtn.className = 'clist-action-btn';
            followBtn.title = 'Follow this person';
            followBtn.innerHTML = '<span class="material-icons md-18 md-light">person_add</span> Follow';
            followBtn.addEventListener('click', () => {
                _followUser(authorDid, token, followBtn).catch(e => {
                    showStatusMessage('Follow error: ' + e.message);
                    console.error('Follow error', e);
                });
                label.textContent = 'Following ' + authorUsername;
            });
            banner.appendChild(label);
            banner.appendChild(followBtn);
            const headerEl = fc.querySelector('.annotation-thread-header');
            if (headerEl && headerEl.nextSibling) {
                fc.insertBefore(banner, headerEl.nextSibling);
            } else {
                fc.appendChild(banner);
            }
        }).catch(e => console.warn('Feed author DID lookup failed:', e));
    }

    // Original item (cloned, stripped of action buttons)
    const original = el.closest('.status-box');
    if (original) {
        const clone = original.cloneNode(true);
        clone.querySelectorAll('.status-actions, .clist-actions, .annotations-panel').forEach(n => n.remove());
        fc.appendChild(clone);
    }

    // Annotations list
    if (!displayAnnotations.length) {
        const empty = document.createElement('p');
        empty.className = 'feed-status-message';
        empty.textContent = token
            ? 'No annotations from people you follow.'
            : 'No public annotations found for this item.';
        fc.appendChild(empty);
    } else {
        displayAnnotations.forEach(anno => {
            const box = document.createElement('div');
            box.className = 'status-box';
            const creatorId = anno.creator?.id || anno.creator || '';
            const username = creatorId.replace(/^did:web:[^:]+:users:/, '') || 'Unknown';
            const profileUrl = _didToProfileUrl(creatorId);
            const didIcon = profileUrl
                ? ` <a href="${_annoHe(profileUrl)}" target="_blank" title="DID profile" class="did-profile-link"><span class="material-icons md-18">account_circle</span></a>`
                : '';
            const body = anno.body?.value || anno.body || '';
            const date = anno.created ? new Date(anno.created).toLocaleDateString() : '';
            const tags = Array.isArray(anno.tag) ? anno.tag.join(', ') : '';
            const safeBody = typeof sanitizeHtml === 'function'
                ? sanitizeHtml(body).toString()
                : _annoHe(body);
            const content = document.createElement('div');
            content.className = 'status-content';
            content.innerHTML =
                `<div class="annotation-meta">` +
                    `<span class="annotation-creator">${_annoHe(username)}</span>${didIcon}` +
                    `<span class="annotation-date">${_annoHe(date)}</span>` +
                `</div>` +
                `<div class="annotation-body">${safeBody}</div>` +
                (tags ? `<div class="annotation-tags">${_annoHe(tags)}</div>` : '');

            // Show ↩ via attribution if this is a flowed annotation
            const via = anno.target_selector?.via || '';
            if (via) {
                const viaUsername = via.replace(/^did:web:[^:]+:users:/, '');
                const viaUrl = _didToProfileUrl(via);
                const viaEl = document.createElement('div');
                viaEl.className = 'annotation-via';
                viaEl.innerHTML = `↩ via ${viaUrl
                    ? `<a href="${_annoHe(viaUrl)}" target="_blank">${_annoHe(viaUsername)}</a>`
                    : _annoHe(viaUsername)}`;
                content.appendChild(viaEl);
            }

            box.appendChild(content);

            // Action buttons (Flow, Follow) — only for annotations not owned by the logged-in user
            if (token && creatorId !== myDid) {
                const actions = document.createElement('div');
                actions.className = 'status-actions';
                if (writeAccts.length) {
                    const flowBtn = document.createElement('button');
                    flowBtn.className = 'clist-action-btn';
                    flowBtn.title = 'Flow — add to your annotations';
                    flowBtn.innerHTML = '<span class="material-icons md-18 md-light">forward</span>';
                    flowBtn.addEventListener('click', () => _flowAnnotation(anno, url, writeAccts, token, flowBtn).catch(e => {
                        showStatusMessage('Flow error: ' + e.message);
                        console.error('Flow error', e);
                    }));
                    actions.appendChild(flowBtn);
                }
                const alreadyFollowing = followedDids.has(creatorId);
                const followBtn = document.createElement('button');
                followBtn.className = 'clist-action-btn';
                followBtn.title = alreadyFollowing ? 'Following' : 'Follow this person';
                followBtn.innerHTML = `<span class="material-icons md-18 md-light">${alreadyFollowing ? 'how_to_reg' : 'person_add'}</span>`;
                followBtn.disabled = alreadyFollowing;
                if (!alreadyFollowing) {
                    followBtn.addEventListener('click', () => _followUser(creatorId, token, followBtn).catch(e => {
                        showStatusMessage('Follow error: ' + e.message);
                        console.error('Follow error', e);
                    }));
                }
                actions.appendChild(followBtn);
                box.appendChild(actions);
            }

            fc.appendChild(box);
        });
    }

    fc.scrollTop = 0;

    // Browser back button support
    history.pushState({ annotationThread: true, itemId }, '');
    _popstateHandler = function(e) {
        if (e.state && e.state.annotationThread) return;
        window.closeAnnotationThread();
    };
    window.addEventListener('popstate', _popstateHandler);
    } catch (e) {
        console.error('[annotations] showAnnotationThread failed:', e);
        if (_savedFeedContent) {
            while (fc.firstChild) fc.removeChild(fc.firstChild);
            fc.appendChild(_savedFeedContent);
            fc.scrollTop = _savedScrollTop;
            _savedFeedContent = null;
        }
        showStatusMessage('Failed to load annotation thread: ' + e.message);
    }
};

window.closeAnnotationThread = function() {
    const fc = document.getElementById('feed-container');
    if (_savedFeedContent) {
        while (fc.firstChild) fc.removeChild(fc.firstChild);
        fc.appendChild(_savedFeedContent);
        fc.scrollTop = _savedScrollTop;
        _savedFeedContent = null;
    }
    if (_popstateHandler) {
        window.removeEventListener('popstate', _popstateHandler);
        _popstateHandler = null;
    }
};
