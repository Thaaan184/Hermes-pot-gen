/**
 * AI Design Studio — Editor Bootstrap & Shell Orchestrator
 * Mounts Penpot Workspace Core inside Studio Shell and isolates navigation.
 */

(function() {
  'use strict';

  // ── Logging helper ──
  function logStage(stage, detail) {
    console.log(`[StudioEditor] ${stage}`, detail || '');
  }

  // ── Error Boundary UI ──
  function showStudioError(stage, err) {
    console.error(`[StudioEditor Error at ${stage}]:`, err);
    const container = document.getElementById('studio-error-container');
    if (!container) return;
    document.getElementById('studio-error-stage').textContent = `Stage: ${stage}`;
    document.getElementById('studio-error-msg').textContent = err.message || String(err);
    container.style.display = 'flex';
  }

  // ── Extract file ID from path / URL ──
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

  // ── AI Copilot Drawer Logic ──
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

  // ── Sync Title & Persistence ──
  function initDocumentSync(fileId, sharedMod) {
    const titleInput = document.getElementById('studio-canvas-title');
    const statusPill = document.getElementById('studio-save-status');
    const statusText = statusPill?.querySelector('.status-text');

    // Poll Penpot document store for file name and save state
    setInterval(() => {
      try {
        if (!sharedMod || !sharedMod.$APP) return;
        const $APP = sharedMod.$APP;
        if (!$APP.$app$main$refs$current_file$$) return;

        const currentFile = $APP.$rumext$v2$deref$$($APP.$app$main$refs$current_file$$);
        if (currentFile && titleInput && document.activeElement !== titleInput) {
          const name = $APP.$cljs$cst$454$name$$.$cljs$core$IFn$_invoke$arity$1$(currentFile);
          if (name && titleInput.value !== name) {
            titleInput.value = name;
            document.title = `${name} — Studio Design Editor`;
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
        if (!val || !sharedMod?.$APP) return;
        try {
          const $APP = sharedMod.$APP;
          $APP.$app$main$store$emit_BANG_$$.$cljs$core$IFn$_invoke$arity$1$(
            $APP.$app$main$data$workspace$rename_file$$($APP.$app$common$uuid$parse_STAR_$$(fileId), val)
          );
        } catch(e) {
          console.warn('[StudioEditor] rename failed:', e);
        }
      });
    }

    // Export Button
    const exportBtn = document.getElementById('studio-btn-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        // Trigger export panel or modal in Penpot workspace
        try {
          const $APP = sharedMod.$APP;
          // Trigger export dialog if available
          alert('Select a board or shape on canvas to export (PNG/SVG/PDF).');
        } catch(e) {}
      });
    }
  }

  // ── Navigation Isolation ──
  function enforceNavigationGuard() {
    // Intercept hash change towards Penpot dashboard
    window.addEventListener('hashchange', () => {
      const h = window.location.hash;
      if (h.includes('dashboard') || h.startsWith('#/auth') || h === '#/') {
        console.warn('[StudioEditor] Blocked navigation to Penpot dashboard. Redirecting to Studio...');
        window.location.replace('/studio/');
      }
    });

    // MutationObserver to neutralize any click leaks from native UI
    const obs = new MutationObserver(() => {
      const leftHeader = document.querySelector('.main_ui_workspace_left_header__workspace-header-left');
      if (leftHeader) leftHeader.style.display = 'none';

      // Intercept any anchor linking to dashboard
      const dashLinks = document.querySelectorAll('a[href*="#/dashboard"]');
      dashLinks.forEach(a => {
        a.href = '/studio/';
        a.onclick = e => { e.preventDefault(); window.location.href = '/studio/'; };
      });
    });

    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── Main Bootstrap Pipeline ──
  async function bootstrap() {
    let currentStage = 'init';
    try {
      // 1. File resolution
      currentStage = 'file';
      logStage(currentStage);
      const fileId = resolveFileId();
      if (!fileId) throw new Error('No valid Canvas/File ID found in URL.');

      // 2. Auth & Session resolution
      currentStage = 'auth';
      logStage(currentStage);
      const authRes = await fetch('/studio-api/api/auth-session');
      if (!authRes.ok) throw new Error(`Auth service returned HTTP ${authRes.status}`);
      const authData = await authRes.json();
      if (!authData.ok) throw new Error('Failed to resolve authenticated Studio session');

      // 3. Team resolution
      currentStage = 'team';
      logStage(currentStage);
      const teamId = authData.teamId;
      if (!teamId) throw new Error('No Team ID associated with service account');

      // 4. Setup internal router hash
      currentStage = 'workspace-state';
      logStage(currentStage, { fileId, teamId });
      const targetHash = `#/workspace?team-id=${teamId}&file-id=${fileId}`;
      if (window.location.hash !== targetHash) {
        window.location.hash = targetHash;
      }

      // Initialize AI Drawer
      initAiDrawer(fileId);

      // Enforce navigation isolation
      enforceNavigationGuard();

      // 5. Load Penpot Modules & Synchronize
      currentStage = 'sync';
      logStage(currentStage);
      const [mainMod, transMod, sharedMod] = await Promise.all([
        import('/js/main.js'),
        import('/js/translation.en.js?version=2.18.3-1791289595'),
        import('/js/shared.js')
      ]);

      // 6. Mount Real Workspace Core
      currentStage = 'workspace-mounted';
      logStage(currentStage);
      mainMod.init({ defaultTranslations: transMod.default });

      // 7. Wire up Studio topbar sync
      initDocumentSync(fileId, sharedMod);

    } catch (err) {
      showStudioError(currentStage, err);
    }
  }

  // Start bootstrap on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
