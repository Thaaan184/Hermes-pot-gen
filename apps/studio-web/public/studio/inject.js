(function() {
  'use strict';

  // 0. Redirect naked root / login / Penpot dashboard back to AI Design Studio dashboard
  var h = window.location.hash;
  if (!h || h === '#/' || h.startsWith('#/auth') || h.startsWith('#/dashboard')) {
    window.location.replace('/studio/');
    return;
  }

  // 0b. Auto-heal missing team-id in workspace route (Penpot Clojure router requires team-id)
  if (h.indexOf('workspace') !== -1 && h.indexOf('team-id=') === -1) {
    var fileMatch = h.match(/file-id=([a-f0-9\-]+)/i);
    if (fileMatch) {
      var targetFileId = fileMatch[1];
      fetch('/studio-api/api/auth-session')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data && data.teamId) {
            window.location.replace('/#/workspace?team-id=' + data.teamId + '&file-id=' + targetFileId);
          }
        })
        .catch(function() {});
    }
  }

  // 1. Brand title
  function updateTitle() {
    if (document.title && !document.title.includes('AI Design Studio')) {
      document.title = document.title.replace(/Penpot/gi, 'AI Design Studio');
      if (!document.title.includes('AI Design Studio')) {
        document.title = 'AI Design Studio';
      }
    }
  }

  // 2. Anti-tab-throttle heartbeat (gentle, prevents browser throttling)
  var heartbeatInterval = setInterval(function() {
    document.dispatchEvent(new MouseEvent('mousemove', {bubbles: true}));
  }, 20000);

  // 3. Detect if we're in the workspace/editor view
  function isEditorView() {
    return window.location.hash.includes('workspace') || window.location.pathname.includes('workspace');
  }

  // 4. AI Copilot Panel
  function mountCopilot() {
    if (document.getElementById('ai-studio-copilot')) return;

    var panel = document.createElement('div');
    panel.id = 'ai-studio-copilot';
    panel.innerHTML = [
      '<div id="ai-copilot-header">',
      '  <span>AI Copilot</span>',
      '  <div style="display:flex;gap:8px;align-items:center">',
      '    <span id="ai-copilot-status-dot" style="width:8px;height:8px;border-radius:50%;background:#10B981;display:inline-block"></span>',
      '    <button id="ai-copilot-toggle" title="Minimize">\u2014</button>',
      '  </div>',
      '</div>',
      '<div id="ai-copilot-body">',
      '  <div id="ai-copilot-messages"></div>',
      '  <div id="ai-copilot-input-area">',
      '    <textarea id="ai-copilot-prompt" placeholder="What do you want to create or change?" rows="3"></textarea>',
      '    <button id="ai-copilot-send">Generate</button>',
      '  </div>',
      '</div>'
    ].join('');

    // Styles
    var style = document.createElement('style');
    style.textContent = [
      '#ai-studio-copilot{',
      '  position:fixed;bottom:24px;right:24px;width:320px;',
      '  background:#0F172A;border:1px solid #1E293B;border-radius:12px;',
      '  box-shadow:0 8px 32px rgba(0,0,0,0.5);z-index:9999;',
      '  font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;font-size:13px;color:#F8FAFC;',
      '  display:flex;flex-direction:column;overflow:hidden;',
      '}',
      '#ai-copilot-header{',
      '  display:flex;justify-content:space-between;align-items:center;',
      '  padding:12px 16px;background:#162032;border-bottom:1px solid #1E293B;',
      '  font-weight:600;font-size:14px;cursor:default;',
      '}',
      '#ai-copilot-toggle{background:none;border:none;color:#94A3B8;cursor:pointer;font-size:16px;padding:0 4px;}',
      '#ai-copilot-body{padding:12px;display:flex;flex-direction:column;gap:8px;}',
      '#ai-copilot-messages{max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;min-height:0;}',
      '.ai-msg{padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;}',
      '.ai-msg-status{background:#162032;color:#94A3B8;}',
      '.ai-msg-success{background:#062820;color:#6EE7B7;border:1px solid #10B981;}',
      '.ai-msg-error{background:#2A1215;color:#FCA5A5;border:1px solid #EF4444;}',
      '#ai-copilot-input-area{display:flex;flex-direction:column;gap:8px;}',
      '#ai-copilot-prompt{',
      '  background:#162032;border:1px solid #1E293B;border-radius:8px;',
      '  color:#F8FAFC;padding:8px;font-size:12px;resize:none;outline:none;',
      '  font-family:inherit;',
      '}',
      '#ai-copilot-prompt:focus{border-color:#38BDF8;}',
      '#ai-copilot-send{',
      '  background:#0284C7;color:#fff;border:none;border-radius:8px;',
      '  padding:8px 16px;cursor:pointer;font-size:13px;font-weight:600;',
      '  transition:background 0.15s;',
      '}',
      '#ai-copilot-send:hover{background:#0369A1;}',
      '#ai-copilot-send:disabled{background:#1E293B;color:#64748B;cursor:not-allowed;}'
    ].join('');
    document.head.appendChild(style);
    document.body.appendChild(panel);

    // Toggle collapse
    var collapsed = false;
    document.getElementById('ai-copilot-toggle').addEventListener('click', function() {
      var body = document.getElementById('ai-copilot-body');
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'flex';
      this.textContent = collapsed ? '+' : '\u2014';
    });

    // Submit
    document.getElementById('ai-copilot-send').addEventListener('click', sendPrompt);
    document.getElementById('ai-copilot-prompt').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendPrompt();
    });
  }

  function addMessage(text, type) {
    var msgs = document.getElementById('ai-copilot-messages');
    if (!msgs) return;
    var el = document.createElement('div');
    el.className = 'ai-msg ai-msg-' + (type || 'status');
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  function sendPrompt() {
    var prompt = document.getElementById('ai-copilot-prompt').value.trim();
    if (!prompt) return;
    var btn = document.getElementById('ai-copilot-send');
    btn.disabled = true;

    var hash = window.location.hash;
    var fileIdMatch = hash.match(/file-id=([^&]+)/);
    var pageIdMatch = hash.match(/page-id=([^&]+)/);
    var canvasId = fileIdMatch ? fileIdMatch[1] : '';
    var pageId = pageIdMatch ? pageIdMatch[1] : '';

    addMessage('You: ' + prompt, 'status');
    document.getElementById('ai-copilot-prompt').value = '';

    // Use fetch with ReadableStream for SSE
    fetch('/studio-api/api/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({prompt: prompt, canvasId: canvasId, pageId: pageId, selectedIds: []})
    }).then(function(res) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';

      function read() {
        return reader.read().then(function(r) {
          if (r.done) { btn.disabled = false; return; }
          buf += decoder.decode(r.value, {stream:true});
          var lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(function(line) {
            if (!line.startsWith('data:')) return;
            try {
              var msg = JSON.parse(line.slice(5).trim());
              if (msg.type === 'status') addMessage('\u27f3 ' + msg.message, 'status');
              else if (msg.type === 'result') addMessage('\u2713 ' + (msg.message || 'Done'), 'success');
              else if (msg.type === 'error') addMessage('\u2717 ' + msg.message, 'error');
            } catch(e) {}
          });
          return read();
        });
      }
      return read();
    }).catch(function(err) {
      addMessage('Error: ' + err.message, 'error');
      btn.disabled = false;
    });
  }

  // Init
  updateTitle();
  document.addEventListener('DOMContentLoaded', updateTitle);

  // Wait for editor DOM before mounting
  var initObserver = new MutationObserver(function(mutations, obs) {
    if (isEditorView() && document.body) {
      mountCopilot();
      obs.disconnect();
    }
  });
  initObserver.observe(document, {childList: true, subtree: true});

  // Also check immediately
  if (document.body && isEditorView()) mountCopilot();

  // Re-mount on hash change (SPA navigation)
  window.addEventListener('hashchange', function() {
    setTimeout(function() {
      if (isEditorView()) mountCopilot();
    }, 1000);
  });
})();
