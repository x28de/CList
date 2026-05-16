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
            showStatusMessage('Failed to save annotation: ' + (err.detail || resp.status));
            console.error('Annotation POST failed', resp.status, err);
        }
    } catch (e) {
        showStatusMessage('Error saving annotation.');
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

            div.innerHTML =
                `<span class="annotation-creator">${_annoHe(creator)}</span>` +
                `<span class="annotation-date">${_annoHe(date)}</span>` +
                `<div class="annotation-body">${_annoHe(body)}</div>` +
                (tags ? `<div class="annotation-tags">${_annoHe(tags)}</div>` : '');

            panel.appendChild(div);
        });
    }

    if (writeAccts && writeAccts.length && token) {
        _appendAddForm(panel, itemID, url, writeAccts, token);
    }
}

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
};
