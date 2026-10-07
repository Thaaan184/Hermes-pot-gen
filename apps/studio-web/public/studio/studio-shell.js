/**
 * AI Design Studio — Studio Shell Orchestrator
 * Integrates Studio branding, topbar controls, document rename, cloud sync status,
 * AI Copilot drawer, export entry, and navigation guard over the native Penpot workspace.
 */

(function () {
  'use strict';

  if (window.__studioShellInitialized) return;
  window.__studioShellInitialized = true;

  function mountStudioShell() {
    if (document.getElementById('studio-shell-bar')) return;

    // 1. Mount Studio Shell Topbar
    const topbar = document.createElement('header');
    topbar.id = 'studio-shell-bar';
    topbar.className = 'studio-shell-topbar';
    topbar.innerHTML = `
      <div class="studio-topbar-left">
        <button id="studio-btn-back" class="studio-btn-back" title="Back to Canvases">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          <span>Back to Studio</span>
        </button>
        <div class="studio-topbar-divider"></div>
        <div class="studio-badge">STUDIO</div>
        <div class="studio-title-box">
          <input id="studio-title-input" type="text" value="Untitled Canvas" spellcheck="false" title="Click to rename" />
        </div>
        <div id="studio-save-pill" class="studio-save-pill saved">
          <span class="save-dot"></span>
          <span class="save-text">Saved</span>
        </div>
      </div>
      <div class="studio-topbar-right">
        <button id="studio-btn-export" class="studio-btn-export" title="Export Design">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          <span>Export</span>
        </button>
        <button id="studio-btn-ai" class="studio-btn-ai" title="Toggle AI Copilot">
          <span class="ai-sparkle">✨</span>
          <span>AI Copilot</span>
        </button>
      </div>
    `;
    document.body.prepend(topbar);

    // 2. Mount AI Copilot Drawer
    const drawer = document.createElement('aside');
    drawer.id = 'studio-ai-drawer';
    drawer.className = 'studio-ai-drawer';
    drawer.innerHTML = `
      <div class="drawer-header">
        <div class="drawer-title">
          <span style="color:#38BDF8">✨</span>
          <span>AI Copilot</span>
        </div>
        <button id="drawer-close" class="drawer-close-btn" title="Close Drawer">✕</button>
      </div>
      <div class="drawer-body">
        <div id="drawer-messages" class="drawer-messages">
          <div class="ai-bubble intro">Describe UI components, layouts, or banners to generate or adjust on this canvas.</div>
        </div>
        <div class="drawer-input-area">
          <textarea id="drawer-prompt" placeholder="E.g., Create a modern SaaS pricing card..." rows="3"></textarea>
          <button id="drawer-send">Generate</button>
        </div>
      </div>
    `;
    document.body.appendChild(drawer);

    // 3. Offset Workspace Root
    const appEl = document.getElementById('app');
    if (appEl) {
      appEl.style.marginTop = '48px';
      appEl.style.height = 'calc(100vh - 48px)';
    }

    // 4. Wire Navigation & Back Button
    document.getElementById('studio-btn-back').onclick = () => {
      window.location.href = '/studio/';
    };

    // 5. Wire AI Copilot Interaction
    const aiBtn = document.getElementById('studio-btn-ai');
    const closeBtn = document.getElementById('drawer-close');
    const sendBtn = document.getElementById('drawer-send');
    const promptInput = document.getElementById('drawer-prompt');
    const msgList = document.getElementById('drawer-messages');

    function toggleDrawer(open) {
      const willOpen = typeof open === 'boolean' ? open : !drawer.classList.contains('open');
      drawer.classList.toggle('open', willOpen);
      aiBtn.classList.toggle('active', willOpen);
      if (willOpen && promptInput) promptInput.focus();
    }

    aiBtn.onclick = () => toggleDrawer();
    closeBtn.onclick = () => toggleDrawer(false);

    function addBubble(text, type) {
      const b = document.createElement('div');
      b.className = `ai-bubble ${type || 'status'}`;
      b.textContent = text;
      msgList.appendChild(b);
      msgList.scrollTop = msgList.scrollHeight;
    }

    sendBtn.onclick = async () => {
      const val = promptInput.value.trim();
      if (!val) return;
      promptInput.value = '';
      sendBtn.disabled = true;
      addBubble(val, 'user');

      const fileIdMatch = window.location.hash.match(/file-id=([a-f0-9\-]+)/i);
      const fileId = fileIdMatch ? fileIdMatch[1] : null;

      try {
        const res = await fetch('/studio-api/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: val, canvasId: fileId })
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try {
              const data = JSON.parse(line.slice(5).trim());
              if (data.type === 'status') addBubble(data.message, 'status');
              else if (data.type === 'result') addBubble(data.message || 'Completed!', 'success');
              else if (data.type === 'error') addBubble(data.message, 'error');
            } catch (e) {}
          }
        }
      } catch (err) {
        addBubble('Error: ' + err.message, 'error');
      } finally {
        sendBtn.disabled = false;
      }
    };

    // Enter to submit prompt
    promptInput.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendBtn.click();
    };

    // 6. Wire Export
    document.getElementById('studio-btn-export').onclick = () => {
      const exportIcon = document.querySelector('[aria-label="Export"], [data-testid="export"]');
      if (exportIcon) {
        exportIcon.click();
      } else {
        alert('Select a board or frame on the canvas to export.');
      }
    };

    // 7. Title Sync & Rename
    const titleInput = document.getElementById('studio-title-input');
    const savePill = document.getElementById('studio-save-pill');
    const saveText = savePill.querySelector('.save-text');

    setInterval(() => {
      const titleMatch = document.title.match(/^(.*?) - Penpot$/);
      if (titleMatch && titleMatch[1] && document.activeElement !== titleInput) {
        if (titleInput.value !== titleMatch[1]) {
          titleInput.value = titleMatch[1];
        }
      }
    }, 1500);

    titleInput.onkeydown = (e) => {
      if (e.key === 'Enter') titleInput.blur();
    };

    titleInput.onblur = async () => {
      const newName = titleInput.value.trim();
      const fileIdMatch = window.location.hash.match(/file-id=([a-f0-9\-]+)/i);
      if (!newName || !fileIdMatch) return;

      savePill.classList.add('saving');
      saveText.textContent = 'Saving...';
      try {
        await fetch(`/studio-api/api/canvas/${fileIdMatch[1]}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
        });
        savePill.classList.remove('saving');
        saveText.textContent = 'Saved';
        document.title = `${newName} - Penpot`;
      } catch (e) {
        saveText.textContent = 'Error';
      }
    };
  }

  // 8. Navigation Guard against Penpot dashboard leaks
  function guardNavigation() {
    window.addEventListener('hashchange', () => {
      if (window.location.hash.includes('dashboard') || window.location.hash.startsWith('#/auth') || window.location.hash === '#/') {
        window.location.replace('/studio/');
      }
    });

    const obs = new MutationObserver(() => {
      // Hide Penpot's internal left header
      const leftHeader = document.querySelector('.main_ui_workspace_left_header__workspace-header-left');
      if (leftHeader && leftHeader.style.display !== 'none') {
        leftHeader.style.display = 'none';
      }

      // If workspace is mounted, ensure Studio Shell is mounted
      const ws = document.querySelector('.main_ui_workspace__workspace');
      if (ws) {
        mountStudioShell();
      }
    });

    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      guardNavigation();
      setInterval(() => {
        if (document.querySelector('.main_ui_workspace__workspace')) {
          mountStudioShell();
        }
      }, 400);
    });
  } else {
    guardNavigation();
    setInterval(() => {
      if (document.querySelector('.main_ui_workspace__workspace')) {
        mountStudioShell();
      }
    }, 400);
  }
})();
