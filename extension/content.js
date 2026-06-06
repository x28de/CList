// content.js — CList drag-and-drop source enrichment
//
// Injects source metadata into every drag so that CList can attribute dragged
// content to the correct page even when the drag data contains only plain text.
//
// Uses capture phase so it fires before any page-level dragstart handlers.

// Tell the opener (CList) who we are as soon as the page loads.
// This is more reliable than dragstart, which Firefox does not always fire for
// text-selection drags in popup windows.
function notifyOpener() {
    if (!window.opener) return;
    try {
        window.opener.postMessage(
            { type: 'clist-drag-source', url: location.href, title: document.title },
            '*'
        );
    } catch (_) {}
}

notifyOpener();

// Re-notify if the page navigates (single-page apps, hash changes, etc.)
window.addEventListener('popstate',    notifyOpener);
window.addEventListener('hashchange',  notifyOpener);

// When running inside a popup opened by CList, keep link navigation within the
// popup instead of spawning yet another window for every _blank link.
if (window.opener) {
    document.addEventListener('click', function(e) {
        const a = e.target.closest('a');
        if (!a || !a.href) return;
        if (a.target && a.target !== '_self' && a.target !== '_parent' && a.target !== '_top') {
            e.preventDefault();
            window.location.href = a.href;
        }
    }, true);
}

// Best-effort: also inject drag data directly on dragstart (works in Chrome;
// Firefox text-selection drags may bypass this, hence the opener approach above).
document.addEventListener('dragstart', function(e) {
    const dt = e.dataTransfer;
    if (!dt) return;
    if (!dt.getData('text/uri-list')) {
        try { dt.setData('text/uri-list', location.href); } catch (_) {}
    }
    try { dt.setData('text/x-clist-title', document.title); } catch (_) {}
    // Notify opener on drag too — catches SPA navigation that skips popstate.
    notifyOpener();
}, true);
