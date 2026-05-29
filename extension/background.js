// background.js — service worker for CList Annotate & Collect
//
// Restores sidebar/popup mode on browser restart, and handles action-icon clicks
// when the popup has been suppressed (sidebar mode on Chrome).

chrome.runtime.onStartup.addListener(restoreMode);
chrome.runtime.onInstalled.addListener(restoreMode);

async function restoreMode() {
    const { sidebarMode } = await chrome.storage.local.get('sidebarMode');
    if (sidebarMode && chrome.sidePanel) {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
        chrome.action.setPopup({ popup: '' });
    }
}

// When popup is suppressed (sidebar mode), action clicks land here.
// Re-open the side panel on the clicked window (user-gesture context — sidePanel.open() allowed).
chrome.action.onClicked.addListener(tab => {
    if (chrome.sidePanel) {
        chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    }
});
