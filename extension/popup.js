// popup.js — CList Annotate & Collect browser extension
//
// Copyright Stephen Downes 2025, downes.ca
// Licensed under Creative Commons Attribution 4.0 International

const DEFAULT_KVSTORE  = 'https://kvstore.mooc.ca';
const DEFAULT_ANNO_SVC = 'https://annotations.mooc.ca';

const IS_SIDEBAR = new URLSearchParams(location.search).get('mode') === 'sidebar';

// ── Storage wrappers ───────────────────────────────────────────────────────

function storeGet(keys) {
    return new Promise(r => chrome.storage.local.get(keys, r));
}
function storeSet(obj) {
    return new Promise(r => chrome.storage.local.set(obj, r));
}
function sessionGet(keys) {
    if (chrome.storage.session) return new Promise(r => chrome.storage.session.get(keys, r));
    return Promise.resolve({});
}
function sessionSet(obj) {
    if (chrome.storage.session) return new Promise(r => chrome.storage.session.set(obj, r));
    return Promise.resolve();
}
function sessionClear() {
    if (chrome.storage.session) return new Promise(r => chrome.storage.session.clear(r));
    return Promise.resolve();
}

// ── State ──────────────────────────────────────────────────────────────────

let _state = {
    kvstoreUrl: DEFAULT_KVSTORE,
    annoSvcUrl: DEFAULT_ANNO_SVC,
    username:   '',
    token:      '',
    encKey:     null,   // CryptoKey, held in memory only
};

// ── Security helpers ───────────────────────────────────────────────────────

// Decode JWT payload without verifying signature — for expiry check only.
// Security verification still happens server-side on every request.
function isTokenExpired(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp;
    } catch {
        return false;
    }
}

// Import a raw AES-GCM key from base64. extractable:false — key cannot leave JS memory.
async function importEncKey(b64) {
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Reject non-HTTPS server URLs — auth_hash would be exposed over plaintext HTTP.
function requireHttps(url, label) {
    if (!/^https:\/\//i.test(url)) throw new Error(`${label} must use HTTPS (https://…)`);
}

// ── Tab helpers ────────────────────────────────────────────────────────────

function getCurrentTab() {
    return new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, tabs => r(tabs[0])));
}

// ── Login ──────────────────────────────────────────────────────────────────

async function doLogin(kvstoreUrl, username, password) {
    // PBKDF2 is slow (100k iterations × 2 = ~3-4s on most hardware) — run in parallel
    const [encKey, authHash] = await Promise.all([
        deriveEncKey(password, username),
        deriveAuthHash(password, username),
    ]);
    const resp = await fetch(`${kvstoreUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, auth_hash: authHash }),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(serverErr(err, resp.status));
    }
    const data = await resp.json();
    return { token: data.token, username: data.username, encKey };
}

async function ensureEncKey() {
    if (_state.encKey) return _state.encKey;
    const { encKeyB64 } = await sessionGet(['encKeyB64']);
    if (!encKeyB64) return null;
    try {
        _state.encKey = await importEncKey(encKeyB64);
        return _state.encKey;
    } catch {
        return null;
    }
}

// ── Annotations API ────────────────────────────────────────────────────────

async function postAnnotation({ url, title, body, tags, visibility }) {
    const resp = await fetch(`${_state.annoSvcUrl}/annotations`, {
        method: 'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + _state.token,
        },
        body: JSON.stringify({
            target_url:      url,
            target_selector: { title: title || '' },
            body,
            tags:       tags || [],
            visibility: visibility || 'public',
            motivation: 'commenting',
        }),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(serverErr(err, resp.status));
    }
    return resp.json();
}

async function fetchAnnotations(url) {
    const resp = await fetch(
        `${_state.annoSvcUrl}/annotations?target=${encodeURIComponent(url)}&limit=50`,
        { headers: { Accept: 'application/json' } }
    );
    if (!resp.ok) throw new Error(`Server error (${resp.status})`);
    const data = await resp.json();
    return data.items || [];
}

// ── Collections API ────────────────────────────────────────────────────────

async function fetchAllKvs() {
    const resp = await fetch(`${_state.kvstoreUrl}/get_kvs/`, {
        headers: { Authorization: 'Bearer ' + _state.token },
    });
    if (!resp.ok) throw new Error(`kvstore error ${resp.status}`);
    return resp.json();
}

async function getCollections(encKey) {
    const kvs = await fetchAllKvs();
    const colls = (kvs || []).filter(kv => kv.key.startsWith('collection:'));
    return Promise.all(colls.map(async kv => {
        let items = [];
        try { items = JSON.parse(await decryptWithKey(encKey, kv.value)); }
        catch (e) { console.warn('[collections] decryption failed for', kv.key, e); }
        return { name: kv.key.replace(/^collection:/, ''), key: kv.key, items };
    }));
}

// isNew=true → POST /add_kv/ (create); isNew=false → POST /update_kv/ (update existing)
async function saveCollectionItems(key, items, encKey, isNew = false) {
    const encrypted = await encryptWithKey(encKey, JSON.stringify(items));
    const endpoint  = isNew ? '/add_kv/' : '/update_kv/';
    const resp = await fetch(`${_state.kvstoreUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _state.token },
        body: JSON.stringify({ key, value: encrypted }),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(serverErr(err, resp.status));
    }
}

async function addToCollection(collKey, item, allKvs, encKey) {
    const existing = (allKvs || []).find(kv => kv.key === collKey);
    let items = [];
    if (existing) {
        try { items = JSON.parse(await decryptWithKey(encKey, existing.value)); }
        catch (e) { console.warn('[collections] decryption failed for', collKey, e); }
    }
    if (!items.some(i => i.url === item.url)) items.push(item);
    await saveCollectionItems(collKey, items, encKey, !existing);
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Return a safe, length-capped message from a server error response.
// Shows the server's message if it's short enough to be a normal message;
// falls back to a generic string if it looks like a stack trace or verbose detail.
function serverErr(err, status) {
    const raw = String(err?.detail || err?.error || '').trim();
    return (raw && raw.length < 120) ? raw : `Server error (${status})`;
}

function setStatus(msg, isError = false) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'status ' + (isError ? 'error' : 'ok');
    if (!isError && msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById(id).style.display = 'flex';
}

function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p =>
        p.style.display = (p.id === 'tab-' + name) ? 'flex' : 'none');
}

// ── Screens ────────────────────────────────────────────────────────────────

// Update the URL bar and annotatable state for the current active tab.
// Also refreshes whichever data panel (Read/Collect) is currently visible.
async function refreshTabUrl() {
    const tab = await getCurrentTab();
    const url = tab?.url || '';
    const urlEl = document.getElementById('current-url');
    urlEl.textContent = url.length > 58 ? url.slice(0, 55) + '…' : url;
    urlEl.title = url;

    const annotatable = /^https?:\/\//i.test(url);
    document.getElementById('tab-annotate').dataset.url = url;
    document.getElementById('no-url-warning').style.display = annotatable ? 'none' : 'block';
    document.getElementById('annotate-form').style.display  = annotatable ? 'flex' : 'none';

    // Reload whichever data panel is open so it reflects the new page
    const activeName = document.querySelector('.tab.active')?.dataset.tab;
    if (activeName === 'read')    loadAnnotations();
    if (activeName === 'collect') loadCollections();
}

let _tabListenersAdded = false;

async function showMain() {
    document.getElementById('display-username').textContent = _state.username;
    await refreshTabUrl();
    switchTab('annotate');
    showScreen('screen-main');

    // Attach tab-tracking listeners once — they keep the sidebar in sync while browsing
    if (!_tabListenersAdded) {
        _tabListenersAdded = true;
        chrome.tabs.onActivated.addListener(() => {
            _cachedKvs = null;
            refreshTabUrl();
        });
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (tab.active && changeInfo.status === 'complete') {
                _cachedKvs = null;
                refreshTabUrl();
            }
        });
    }
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    // Non-sensitive settings persist locally; token + encKey live in session only
    const stored  = await storeGet(['kvstoreUrl', 'annoSvcUrl', 'username']);
    const session = await sessionGet(['token', 'encKeyB64']);

    _state.kvstoreUrl = stored.kvstoreUrl || DEFAULT_KVSTORE;
    _state.annoSvcUrl = stored.annoSvcUrl || DEFAULT_ANNO_SVC;
    _state.username   = stored.username   || '';
    _state.token      = session.token     || '';

    document.getElementById('kvstore-url').value  = _state.kvstoreUrl;
    document.getElementById('anno-svc-url').value = _state.annoSvcUrl;
    if (_state.username) document.getElementById('login-username').value = _state.username;

    // Wire login
    document.getElementById('btn-login').addEventListener('click', handleLogin);
    document.getElementById('login-password').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleLogin();
    });

    // Apply sidebar body class and configure toggle bar
    if (IS_SIDEBAR) {
        document.body.classList.add('sidebar-mode');
        document.getElementById('btn-pin').textContent = '← Close sidebar';
    }
    document.getElementById('btn-pin').addEventListener('click', handlePinToggle);

    // Wire logout
    document.getElementById('btn-logout').addEventListener('click', handleLogout);

    // Wire settings toggle
    document.getElementById('btn-settings').addEventListener('click', () => {
        const s = document.getElementById('settings-section');
        const opening = s.style.display === 'none' || s.style.display === '';
        if (opening) {
            document.getElementById('settings-kvstore-url').value  = _state.kvstoreUrl;
            document.getElementById('settings-anno-svc-url').value = _state.annoSvcUrl;
        }
        s.style.display = opening ? 'flex' : 'none';
    });
    document.getElementById('btn-save-settings').addEventListener('click', handleSaveSettings);

    // Wire tabs
    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = btn.dataset.tab;
            switchTab(name);
            if (name === 'read')    loadAnnotations();
            if (name === 'collect') loadCollections();
        });
    });

    // Wire annotate
    document.getElementById('btn-annotate').addEventListener('click', handleAnnotate);
    document.getElementById('anno-body').addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAnnotate();
    });

    // Wire collection create
    document.getElementById('btn-create-collection').addEventListener('click', handleCreateCollection);

    // Restore session: token + encKey are both session-only
    if (_state.token && !isTokenExpired(_state.token)) {
        if (session.encKeyB64) {
            _state.encKey = await importEncKey(session.encKeyB64).catch(() => null);
        }
        await showMain();
    } else {
        if (_state.token) await sessionClear();  // expired — wipe stale session
        _state.token = '';
        showScreen('screen-login');
    }
});

// ── Login handler ──────────────────────────────────────────────────────────

async function handleLogin() {
    const kvstoreUrl = document.getElementById('kvstore-url').value.trim().replace(/\/$/, '');
    const annoSvcUrl = document.getElementById('anno-svc-url').value.trim().replace(/\/$/, '');
    const username   = document.getElementById('login-username').value.trim().toLowerCase();
    const password   = document.getElementById('login-password').value;
    const errEl      = document.getElementById('login-error');
    errEl.textContent = '';

    if (!username || !password) {
        errEl.textContent = 'Username and password are required.';
        return;
    }
    try { requireHttps(kvstoreUrl, 'kvstore URL'); requireHttps(annoSvcUrl, 'Annotations URL'); }
    catch (e) { errEl.textContent = e.message; return; }

    const btn = document.getElementById('btn-login');
    btn.disabled = true;
    btn.textContent = 'Deriving keys…';

    try {
        const { token, username: uname, encKey } = await doLogin(kvstoreUrl, username, password);

        // Export encKey to raw bytes for session storage — never store the password
        const rawKey    = await crypto.subtle.exportKey('raw', encKey);
        const encKeyB64 = btoa(String.fromCharCode(...new Uint8Array(rawKey)));

        _state = { kvstoreUrl, annoSvcUrl, username: uname, token, encKey };
        await storeSet({ kvstoreUrl, annoSvcUrl, username: uname });  // no token in local storage
        await sessionSet({ token, encKeyB64 });                       // token + encKey in session
        document.getElementById('login-password').value = '';
        await showMain();
    } catch (e) {
        errEl.textContent = e.message;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Log In';
    }
}

async function handleLogout() {
    _state.token  = '';
    _state.encKey = null;
    await sessionClear();
    showScreen('screen-login');
}

async function handlePinToggle() {
    const hasSidebarAction = typeof browser !== 'undefined' && browser.sidebarAction;

    if (IS_SIDEBAR) {
        // ── Close sidebar ──────────────────────────────────────────────────
        if (hasSidebarAction) {
            try { await browser.sidebarAction.close(); } catch {}
            // Reopen as popup so the user lands back in "own box" mode (Firefox 118+)
            if (browser.action?.openPopup) browser.action.openPopup().catch(() => {});
        } else if (chrome.sidePanel) {
            await storeSet({ sidebarMode: false });
            chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
            chrome.action.setPopup({ popup: 'popup.html' });
            window.close();
        } else {
            window.close();
        }
    } else {
        // ── Open as sidebar ────────────────────────────────────────────────
        if (hasSidebarAction) {
            browser.sidebarAction.open().catch(() => {});
            window.close();
        } else if (chrome.sidePanel) {
            await storeSet({ sidebarMode: true });
            chrome.action.setPopup({ popup: '' });
            chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
            const win = await new Promise(r => chrome.windows.getCurrent(r));
            chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
            window.close();
        }
    }
}

async function handleSaveSettings() {
    const kvstoreUrl = document.getElementById('settings-kvstore-url').value.trim().replace(/\/$/, '');
    const annoSvcUrl = document.getElementById('settings-anno-svc-url').value.trim().replace(/\/$/, '');
    if (!kvstoreUrl || !annoSvcUrl) {
        setStatus('Both URLs are required.', true);
        return;
    }
    try { requireHttps(kvstoreUrl, 'kvstore URL'); requireHttps(annoSvcUrl, 'Annotations URL'); }
    catch (e) { setStatus(e.message, true); return; }
    _state.kvstoreUrl = kvstoreUrl;
    _state.annoSvcUrl = annoSvcUrl;
    await storeSet({ kvstoreUrl, annoSvcUrl });
    document.getElementById('settings-section').style.display = 'none';
    setStatus('Settings saved.');
}

// ── Annotate handler ───────────────────────────────────────────────────────

async function handleAnnotate() {
    const tab   = await getCurrentTab();
    const url   = tab?.url   || '';
    const title = (tab?.title || '').slice(0, 500);  // cap — page controls its own title
    const body  = document.getElementById('anno-body').value.trim();
    if (!body) { setStatus('Annotation text is required.', true); return; }

    const tags       = document.getElementById('anno-tags').value.split(',').map(t => t.trim()).filter(Boolean);
    const visibility = document.getElementById('anno-visibility').value;

    const btn = document.getElementById('btn-annotate');
    btn.disabled = true;
    try {
        await postAnnotation({ url, title, body, tags, visibility });
        document.getElementById('anno-body').value = '';
        document.getElementById('anno-tags').value = '';
        setStatus('Annotation saved.');
    } catch (e) {
        setStatus('Failed: ' + e.message, true);
    } finally {
        btn.disabled = false;
    }
}

// ── Read annotations ───────────────────────────────────────────────────────

async function loadAnnotations() {
    const container = document.getElementById('anno-list');
    container.innerHTML = '<p class="msg-loading">Loading…</p>';

    const tab = await getCurrentTab();
    const url = tab?.url || '';
    if (!/^https?:\/\//i.test(url)) {
        container.innerHTML = '<p class="msg-empty">Cannot fetch annotations for this page.</p>';
        return;
    }
    try {
        const items = await fetchAnnotations(url);
        if (!items.length) {
            container.innerHTML = '<p class="msg-empty">No annotations for this page.</p>';
            return;
        }
        container.innerHTML = '';
        items.forEach(anno => {
            const div  = document.createElement('div');
            div.className = 'anno-item';
            const _b      = anno.body;
            const bodyRaw = !_b ? '' : typeof _b === 'string' ? _b
                : Array.isArray(_b) ? _b.map(i => i?.value || '').join(' ')
                : typeof _b === 'object' ? (_b.value || '') : String(_b);
            const bodyText = bodyRaw.replace(/<[^>]+>/g, '').slice(0, 300);
            const creator  = (anno.creator?.id || anno.creator || '')
                .replace(/^did:web:[^:]+:users:/, '').replace(/^acct:([^@]+)@.+$/, '$1') || 'Unknown';
            const date = anno.created ? new Date(anno.created).toLocaleDateString() : '';
            div.innerHTML =
                `<div class="anno-creator">${esc(creator)}<span class="anno-date">${esc(date)}</span></div>` +
                `<div class="anno-body">${esc(bodyText)}${bodyRaw.length > 300 ? '…' : ''}</div>`;
            container.appendChild(div);
        });
    } catch (e) {
        container.innerHTML = `<p class="msg-error">Error: ${esc(e.message)}</p>`;
    }
}

// ── Collect handlers ───────────────────────────────────────────────────────

let _cachedKvs = null;

async function loadCollections() {
    const container = document.getElementById('collection-list');
    container.innerHTML = '<p class="msg-loading">Loading…</p>';

    const encKey = await ensureEncKey();
    if (!encKey) {
        container.innerHTML = '<p class="msg-error">Session expired — please log out and log in again.</p>';
        return;
    }
    const tab   = await getCurrentTab();
    const url   = tab?.url   || '';
    const title = tab?.title || '';

    try {
        _cachedKvs = await fetchAllKvs();
        const colls = await Promise.all(
            (_cachedKvs || []).filter(kv => kv.key.startsWith('collection:')).map(async kv => {
                let items = [];
                try { items = JSON.parse(await decryptWithKey(encKey, kv.value)); }
                catch (e) { console.warn('[collections] decryption failed for', kv.key, e); }
                return { name: kv.key.replace(/^collection:/, ''), key: kv.key, items };
            })
        );

        container.innerHTML = '';
        if (!colls.length) {
            const msg = document.createElement('p');
            msg.className = 'msg-empty';
            msg.textContent = 'No collections yet. Create one below.';
            container.appendChild(msg);
        }

        for (const col of colls) {
            const alreadyIn = col.items.some(i => i.url === url);
            const row       = document.createElement('div');
            row.className   = 'coll-row';

            const nameSpan = document.createElement('span');
            nameSpan.className   = 'coll-name';
            nameSpan.textContent = col.name;

            const badge = document.createElement('span');
            badge.className   = 'coll-count';
            badge.textContent = col.items.length;

            const addBtn = document.createElement('button');
            addBtn.className = 'btn-add-coll' + (alreadyIn ? ' added' : '');
            addBtn.textContent = alreadyIn ? '✓ Added' : 'Add';
            addBtn.disabled    = alreadyIn;

            if (!alreadyIn) {
                addBtn.addEventListener('click', async () => {
                    addBtn.disabled    = true;
                    addBtn.textContent = '…';
                    try {
                        await addToCollection(col.key, { url, title, saved_at: new Date().toISOString() }, _cachedKvs, encKey);
                        addBtn.textContent = '✓ Added';
                        addBtn.className   = 'btn-add-coll added';
                        badge.textContent  = col.items.length + 1;
                        setStatus('Added to "' + col.name + '".');
                    } catch (e) {
                        addBtn.disabled    = false;
                        addBtn.textContent = 'Add';
                        setStatus('Failed: ' + e.message, true);
                    }
                });
            }

            row.appendChild(nameSpan);
            row.appendChild(badge);
            row.appendChild(addBtn);
            container.appendChild(row);
        }
    } catch (e) {
        container.innerHTML = `<p class="msg-error">Error: ${esc(e.message)}</p>`;
    }
}

async function handleCreateCollection() {
    const nameInput = document.getElementById('new-collection-name');
    const name = nameInput.value.trim();
    if (!name || !/^[a-zA-Z0-9#\-_ ]+$/.test(name)) {
        setStatus('Letters, numbers, #, -, _, space only.', true);
        return;
    }
    const encKey = await ensureEncKey();
    if (!encKey) { setStatus('Session expired — please log in again.', true); return; }

    const btn = document.getElementById('btn-create-collection');
    btn.disabled = true;
    try {
        await saveCollectionItems('collection:' + name, [], encKey, true);
        nameInput.value = '';
        setStatus('"' + name + '" created.');
        await loadCollections();
    } catch (e) {
        setStatus('Failed: ' + e.message, true);
    } finally {
        btn.disabled = false;
    }
}
