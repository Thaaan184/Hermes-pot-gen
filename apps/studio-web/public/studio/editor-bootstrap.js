/**
 * AI Design Studio — Editor Bootstrap & Acquisition Orchestrator
 * Acquires native Penpot Workspace Core directly into Studio DOM.
 */

(function () {
  'use strict';

  function logStage(stage, detail) {
    console.log(`[StudioAcquisition] ${stage}`, detail || '');
  }

  function showStudioError(stage, err) {
    console.error(`[StudioAcquisition Error at ${stage}]:`, err);
    const container = document.getElementById('studio-error-container');
    if (!container) return;
    document.getElementById('studio-error-stage').textContent = `Stage: ${stage}`;
    document.getElementById('studio-error-msg').textContent = err.message || String(err);
    container.style.display = 'flex';
  }

  function resolveFileId() {
    const path = window.location.pathname;
    const match = path.match(/\/studio\/canvas\/([a-f0-9\-]+)/i);
    if (match) return match[1];

    const hashMatch = window.location.hash.match(/file-id=([a-f0-9\-]+)/i);
    if (hashMatch) return hashMatch[1];

    const searchMatch = window.location.search.match(/file-id=([a-f0-9\-]+)/i);
    if (searchMatch) return searchMatch[1];

    return null;
  }

  function initAiDrawer(fileId) {
    const drawer = document.getElementById('studio-ai-drawer');
    const toggleBtn = document.getElementById('studio-btn-ai');
    const closeBtn = document.getElementById('drawer-close');
    const sendBtn = document.getElementById('drawer-send');
    const promptInput = document.getElementById('drawer-prompt');
    const msgList = document.getElementById('drawer-messages');

    if (!drawer || !toggleBtn) return;

    function toggleDrawer(open) {
      const willOpen = typeof open === 'boolean' ? open : !drawer.classList.contains('open');
      drawer.classList.toggle('open', willOpen);
      toggleBtn.classList.toggle('active', willOpen);
      if (willOpen && promptInput) promptInput.focus();
    }

    toggleBtn.addEventListener('click', () => toggleDrawer());
    if (closeBtn) closeBtn.addEventListener('click', () => toggleDrawer(false));

    function appendMessage(text, type) {
      if (!msgList) return;
      const el = document.createElement('div');
      el.className = `ai-bubble ${type || 'status'}`;
      el.textContent = text;
      msgList.appendChild(el);
      msgList.scrollTop = msgList.scrollHeight;
      return el;
    }

    function submitPrompt() {
      const prompt = promptInput.value.trim();
      if (!prompt) return;
      promptInput.value = '';
      sendBtn.disabled = true;

      appendMessage(prompt, 'user');

      fetch('/studio-api/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, canvasId: fileId, selectedIds: [] }),
      }).then(res => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        function readStream() {
          return reader.read().then(({ done, value }) => {
            if (done) { sendBtn.disabled = false; return; }
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            lines.forEach(line => {
              if (!line.startsWith('data:')) return;
              try {
                const msg = JSON.parse(line.slice(5).trim());
                if (msg.type === 'status') appendMessage(msg.message, 'status');
                else if (msg.type === 'result') appendMessage(msg.message || 'Design updated!', 'success');
                else if (msg.type === 'error') appendMessage(msg.message, 'error');
              } catch(e) {}
            });
            return readStream();
          });
        }
        return readStream();
      }).catch(err => {
        appendMessage(`Error: ${err.message}`, 'error');
        sendBtn.disabled = false;
      });
    }

    if (sendBtn) sendBtn.addEventListener('click', submitPrompt);
    if (promptInput) {
      promptInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitPrompt();
      });
    }
  }

  function initDocumentSync(fileId) {
    const titleInput = document.getElementById('studio-canvas-title');
    const statusPill = document.getElementById('studio-save-status');
    const statusText = statusPill?.querySelector('.status-text');

    // Polling file sync and status
    setInterval(() => {
      try {
        const $APP = window.$APP;
        if (!$APP) return;

        if ($APP.$app$main$refs$current_file$$ && titleInput && document.activeElement !== titleInput) {
          const currentFile = $APP.$rumext$v2$deref$$($APP.$app$main$refs$current_file$$);
          if (currentFile) {
            const name = $APP.$cljs$cst$454$name$$.$cljs$core$IFn$_invoke$arity$1$(currentFile);
            if (name && titleInput.value !== name) {
              titleInput.value = name;
              document.title = `${name} — Studio Design Editor`;
            }
          }
        }

        if ($APP.$app$main$refs$persistence$$ && statusPill && statusText) {
          const persist = $APP.$rumext$v2$deref$$($APP.$app$main$refs$persistence$$);
          const st = persist ? $APP.$cljs$cst$12$status$$.$cljs$core$IFn$_invoke$arity$1$(persist) : null;
          const isSaving = st && String(st).includes('saving');
          statusPill.classList.toggle('saving', !!isSaving);
          statusText.textContent = isSaving ? 'Saving...' : 'Saved';
        }
      } catch(e) {}
    }, 1500);

    // Two-way rename
    if (titleInput) {
      titleInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') titleInput.blur();
      });
      titleInput.addEventListener('blur', () => {
        const val = titleInput.value.trim();
        if (!val || !window.$APP) return;
        try {
          const $APP = window.$APP;
          $APP.$app$main$store$emit_BANG_$$.$cljs$core$IFn$_invoke$arity$1$(
            $APP.$app$main$data$workspace$rename_file$$(
              $APP.$app$common$uuid$parse_STAR_$$(fileId), val
            )
          );
        } catch(e) {
          console.warn('[StudioAcquisition] rename failed:', e);
        }
      });
    }

    // Export button
    const exportBtn = document.getElementById('studio-btn-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        alert('Select a board or frame on the canvas to export.');
      });
    }
  }

  function enforceNavigationGuard() {
    window.addEventListener('hashchange', () => {
      const h = window.location.hash;
      if (h.includes('dashboard') || h.startsWith('#/auth') || h === '#/') {
        console.warn('[StudioAcquisition] Neutralized dashboard redirect. Redirecting to Studio...');
        window.location.replace('/studio/');
      }
    });

    // Guard native links
    const obs = new MutationObserver(() => {
      const leftHeader = document.querySelector('.main_ui_workspace_left_header__workspace-header-left');
      if (leftHeader) leftHeader.style.display = 'none';

      const dashLinks = document.querySelectorAll('a[href*="#/dashboard"]');
      dashLinks.forEach(a => {
        a.href = '/studio/';
        a.onclick = e => {
          e.preventDefault();
          window.location.href = '/studio/';
        };
      });
    });

    obs.observe(document.body, { childList: true, subtree: true });
  }

  async function bootstrap() {
    let currentStage = 'init';
    try {
      // 1. File Resolution
      currentStage = 'file';
      logStage(currentStage);
      const fileId = resolveFileId();
      if (!fileId) throw new Error('No valid Canvas/File ID found in URL.');

      // 2. Auth Session Resolution
      currentStage = 'auth';
      logStage(currentStage);
      const authRes = await fetch('/studio-api/api/auth-session');
      if (!authRes.ok) throw new Error(`Auth service returned HTTP ${authRes.status}`);
      const authData = await authRes.json();
      if (!authData.ok) throw new Error('Failed to resolve authenticated Studio session');

      // 3. Team Resolution
      currentStage = 'team';
      logStage(currentStage);
      const teamId = authData.teamId;
      if (!teamId) throw new Error('No Team ID found for current session');

      // 4. Ensure public URI matches current location exactly
      globalThis.penpotPublicURI = window.location.origin + window.location.pathname;

      // 5. Workspace Route Preparation
      currentStage = 'workspace-routing';
      logStage(currentStage, { fileId, teamId });
      const targetHash = `#/workspace?team-id=${teamId}&file-id=${fileId}`;
      window.location.hash = targetHash;

      // Initialize UI controls
      initAiDrawer(fileId);
      enforceNavigationGuard();

      // 6. Dynamic Penpot Engine Acquisition
      currentStage = 'penpot-core-load';
      logStage(currentStage);
      await import('/js/libs.js?version=2.18.3-1791289595');
      const { init } = await import('/js/main.js?version=2.18.3-1791289595');
      const defaultTranslations = (
        await import('/js/translation.en.js?version=2.18.3-1791289595')
      ).default;

      // 7. Mount Native Workspace into #app
      currentStage = 'workspace-mount';
      logStage(currentStage);
      init({ defaultTranslations });

      // 8. Wire Studio Topbar State
      initDocumentSync(fileId);
      logStage('workspace-ready');

    } catch (err) {
      showStudioError(currentStage, err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
