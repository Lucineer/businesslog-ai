/* ============================================================
   BusinessLog AI — App Logic
   ============================================================ */

(function () {
  'use strict';

  // ---- State ----
  const state = {
    currentUser: null,
    token: null,
    isGuest: false,
    guestMessagesLeft: 3,
    conversations: [],
    activeConversation: null,
    messages: [],
    adminData: { users: [], analytics: {} },
    ws: null,
    _pendingFile: null
  };

  // ---- DOM Helpers ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    children.forEach(c => { if (typeof c === 'string') e.appendChild(document.createTextNode(c)); else if (c) e.appendChild(c); });
    return e;
  }

  // ---- Toast Notifications ----
  function showToast(message, type = 'info') {
    const container = $('#toast-container');
    const toast = el('div', { class: 'toast ' + type, text: message });
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
  }

  function showSpinner() { $('#loading-spinner').classList.remove('hidden'); }
  function hideSpinner() { $('#loading-spinner').classList.add('hidden'); }

  // ---- Avatar Colors ----
  const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#06b6d4', '#ef4444', '#6366f1'];
  function avatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }
  function initials(name) {
    return (name || '?').split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }
  function renderAvatar(elem, name, size) {
    const cls = 'avatar avatar-' + (size || 'md');
    elem.className = cls;
    elem.style.background = avatarColor(name);
    elem.textContent = initials(name);
  }

  // ---- API Helper ----
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    try {
      const res = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
      if (res.status === 401 && !state.isGuest) { logout(); throw new Error('Session expired'); }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Request failed (' + res.status + ')');
      }
      return await res.json();
    } catch (err) {
      showToast(err.message, 'error');
      throw err;
    }
  }

  // ============================================================
  //  AUTH
  // ============================================================

  function showLoginModal() {
    $('#auth-modal').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }

  function hideLoginModal() {
    $('#auth-modal').classList.add('hidden');
    $('#app').classList.remove('hidden');
  }

  function enterGuestMode() {
    state.isGuest = true;
    state.guestMessagesLeft = 3;
    state.currentUser = { id: 'guest', name: 'Guest', email: '', role: 'guest' };
    $('#guest-banner').classList.remove('hidden');
    $('#guest-count').textContent = state.guestMessagesLeft;
    hideLoginModal();
    initApp();
  }

  async function register(name, email, password, team) {
    showSpinner();
    try {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, team })
      });
      state.token = data.token;
      state.currentUser = data.user;
      state.isGuest = false;
      localStorage.setItem('bl_token', data.token);
      $('#guest-banner').classList.add('hidden');
      hideLoginModal();
      initApp();
      showToast('Account created!', 'success');
    } catch (_) { /* api() already shows toast */ }
    hideSpinner();
  }

  async function login(email, password) {
    showSpinner();
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      state.token = data.token;
      state.currentUser = data.user;
      state.isGuest = false;
      localStorage.setItem('bl_token', data.token);
      $('#guest-banner').classList.add('hidden');
      hideLoginModal();
      initApp();
      showToast('Welcome back!', 'success');
    } catch (_) { /* api() already shows toast */ }
    hideSpinner();
  }

  function logout() {
    state.token = null;
    state.currentUser = null;
    state.isGuest = false;
    state.conversations = [];
    state.messages = [];
    state.activeConversation = null;
    localStorage.removeItem('bl_token');
    if (state.ws) { state.ws.close(); state.ws = null; }
    $('#guest-banner').classList.add('hidden');
    showLoginModal();
  }

  function checkAuth() {
    const token = localStorage.getItem('bl_token');
    if (!token) {
      // Auto-enter guest mode
      enterGuestMode();
      return;
    }
    state.token = token;
    // Validate token by fetching profile
    api('/api/auth/me').then(user => {
      state.currentUser = user;
      state.isGuest = false;
      hideLoginModal();
      initApp();
    }).catch(() => {
      // Token expired, enter guest mode
      localStorage.removeItem('bl_token');
      enterGuestMode();
    });
  }

  // ============================================================
  //  CONVERSATIONS & CHAT
  // ============================================================

  async function loadConversations() {
    if (state.isGuest) return;
    try {
      state.conversations = await api('/api/conversations');
      renderConversations();
    } catch (_) {}
  }

  function renderConversations() {
    const list = $('#conversation-list');
    list.innerHTML = '';
    state.conversations.forEach(conv => {
      const li = el('li', { class: 'conv-item' + (conv.id === (state.activeConversation && state.activeConversation.id) ? ' active' : '') },
        el('span', { class: 'avatar avatar-md' }),
        el('div', { class: 'conv-meta' },
          el('span', { class: 'conv-name', text: conv.name || conv.title || 'Chat' }),
          el('span', { class: 'conv-preview', text: conv.lastMessage || '' })
        )
      );
      renderAvatar(li.querySelector('.avatar'), conv.name || 'C', 'md');
      li.addEventListener('click', () => selectConversation(conv));
      list.appendChild(li);
    });
  }

  async function selectConversation(conv) {
    state.activeConversation = conv;
    $('#chat-title').textContent = conv.name || conv.title || 'Chat';
    renderAvatar($('#chat-avatar'), conv.name || 'C', 'md');
    $('#empty-chat').classList.add('hidden');
    await loadMessages(conv.id);
    renderConversations();
  }

  async function loadMessages(convId) {
    try {
      state.messages = await api('/api/conversations/' + convId + '/messages');
      renderMessages();
    } catch (_) {}
  }

  function renderMessages() {
    const container = $('#messages-container');
    container.innerHTML = '';
    state.messages.forEach(msg => {
      const isUser = msg.senderId === (state.currentUser && state.currentUser.id);
      const row = el('div', { class: 'msg-row ' + (isUser ? 'user' : 'agent') });
      if (!isUser) {
        const av = el('span', { class: 'avatar avatar-sm' });
        renderAvatar(av, msg.senderName || 'AI', 'sm');
        row.appendChild(av);
      }
      const bubble = el('div', { class: 'msg-bubble', text: msg.text });
      if (msg.file) {
        bubble.appendChild(el('div', { class: 'msg-file', text: '\uD83D\uDCCE ' + msg.file }));
      }
      bubble.appendChild(el('div', { class: 'msg-time', text: formatTime(msg.createdAt) }));
      row.appendChild(bubble);
      container.appendChild(row);
    });
    container.scrollTop = container.scrollHeight;
  }

  async function sendMessage(text, file) {
    if (state.isGuest) {
      state.guestMessagesLeft--;
      $('#guest-count').textContent = state.guestMessagesLeft;
      if (state.guestMessagesLeft <= 0) {
        showToast('Free messages used up. Please sign up to continue.', 'error');
        showLoginModal();
        return;
      }
    }

    if (!state.activeConversation) { showToast('Select a conversation first', 'error'); return; }
    // Optimistic render
    const tempMsg = { senderId: state.currentUser.id, senderName: state.currentUser.name, text, createdAt: new Date().toISOString(), file: file ? file.name : null };
    state.messages.push(tempMsg);
    renderMessages();

    try {
      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('text', text);
        const uploadHeaders = {};
        if (state.token) uploadHeaders['Authorization'] = 'Bearer ' + state.token;
        const res = await fetch('/api/files', { method: 'POST', headers: uploadHeaders, body: formData });
        if (!res.ok) throw new Error('File upload failed');
      }
      await api('/api/conversations/' + state.activeConversation.id + '/messages', {
        method: 'POST',
        body: JSON.stringify({ text, file: file ? file.name : null })
      });
    } catch (_) { showToast('Failed to send message', 'error'); }
  }

  function receiveMessage(msg) {
    if (state.activeConversation && msg.conversationId === state.activeConversation.id) {
      state.messages.push(msg);
      renderMessages();
    }
    // Update preview in conversation list
    const conv = state.conversations.find(c => c.id === msg.conversationId);
    if (conv) { conv.lastMessage = msg.text; renderConversations(); }
  }

  function handleFileUpload(file) {
    if (!file) return;
    $('#file-preview').classList.remove('hidden');
    $('#file-name').textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
    state._pendingFile = file;
  }

  // ============================================================
  //  ADMIN PANEL
  // ============================================================

  function toggleAdmin() {
    if (state.isGuest) { showToast('Sign in to access admin panel', 'error'); return; }
    if (state.currentUser && state.currentUser.role !== 'admin') { showToast('Admin access required', 'error'); return; }
    const panel = $('#admin-panel');
    const grid = $('.main-grid');
    const isOpen = !panel.classList.contains('hidden');
    if (isOpen) {
      panel.classList.add('hidden');
      grid.classList.remove('admin-open');
    } else {
      panel.classList.remove('hidden');
      grid.classList.add('admin-open');
      loadUsers();
      loadAnalytics();
      loadAuditLog();
    }
  }

  async function loadUsers() {
    try {
      const data = await api('/api/users');
      state.adminData.users = data;
      renderUsers();
      renderTeamMembers(data);
    } catch (_) {}
  }

  function renderUsers() {
    const list = $('#user-list');
    list.innerHTML = '';
    state.adminData.users.forEach(user => {
      const roleBadge = el('span', { class: 'user-role-badge ' + user.role, text: user.role });
      const li = el('li', { class: 'user-item' },
        el('span', { class: 'avatar avatar-sm' }),
        el('div', { class: 'user-info' },
          el('span', { class: 'user-name', text: user.name }),
          el('span', { class: 'user-email', text: user.email })
        ),
        el('select', { class: 'user-role-select' },
          el('option', { value: 'member', text: 'Member' }),
          el('option', { value: 'admin', text: 'Admin' }),
          el('option', { value: 'viewer', text: 'Viewer' })
        ),
        el('button', { class: 'btn btn-icon btn-sm user-remove', 'aria-label': 'Remove user', text: '\u00D7' })
      );
      renderAvatar(li.querySelector('.avatar'), user.name, 'sm');
      const sel = li.querySelector('select');
      sel.value = user.role || 'member';
      sel.addEventListener('change', () => changeRole(user.id, sel.value));
      li.querySelector('.user-remove').addEventListener('click', () => removeUser(user.id));
      list.appendChild(li);
    });
  }

  function renderTeamMembers(users) {
    const container = $('#team-members-list');
    if (!container) return;
    container.innerHTML = '';
    (users || []).slice(0, 8).forEach(user => {
      const member = el('div', { class: 'team-member' },
        el('span', { class: 'avatar' }),
        el('span', { class: 'team-member-name', text: user.name }),
        el('span', { class: 'team-member-status' })
      );
      renderAvatar(member.querySelector('.avatar'), user.name, 'sm');
      container.appendChild(member);
    });
  }

  async function inviteUser(email, role) {
    showSpinner();
    try {
      await api('/api/users/invite', { method: 'POST', body: JSON.stringify({ email, role }) });
      showToast('Invite sent to ' + email, 'success');
      loadUsers();
    } catch (_) {}
    hideSpinner();
  }

  async function removeUser(id) {
    if (!confirm('Remove this user?')) return;
    showSpinner();
    try {
      await api('/api/users/' + id, { method: 'DELETE' });
      showToast('User removed', 'success');
      loadUsers();
    } catch (_) {}
    hideSpinner();
  }

  async function changeRole(id, role) {
    try {
      await api('/api/users/' + id + '/role', { method: 'PUT', body: JSON.stringify({ role }) });
      showToast('Role updated', 'success');
    } catch (_) {}
  }

  async function loadAnalytics() {
    const range = $('#date-range').value;
    try {
      const data = await api('/api/analytics/dashboard?range=' + range);
      state.adminData.analytics = data;
      renderAnalytics(data);
    } catch (_) {}
  }

  function renderAnalytics(data) {
    $('#stat-messages').textContent = data.totalMessages || 0;
    $('#stat-active-users').textContent = data.activeUsers || 0;
    $('#stat-avg-response').textContent = (data.avgResponseTime || 0).toFixed(1) + 'm';
    $('#stat-topics').textContent = (data.topTopics || []).length;
    renderCSSBarChart('chart-messages-bar', data.messagesByDay || generateSampleData(7, 50, 200), 'Messages');
    renderCSSBarChart('chart-users-bar', data.activeUsersByDay || generateSampleData(7, 5, 30), 'Users');
    renderTopicBars('chart-topics-bar', data.topTopics || [
      { topic: 'Financial Analysis', count: 35 }, { topic: 'Strategy', count: 25 },
      { topic: 'Process Optimization', count: 20 }, { topic: 'Communication', count: 15 }
    ]);
  }

  function generateSampleData(days, min, max) {
    const data = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      data.push({ date: d.toLocaleDateString('en', { weekday: 'short' }), value: Math.floor(Math.random() * (max - min) + min) });
    }
    return data;
  }

  function renderCSSBarChart(containerId, data, label) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const title = container.querySelector('h4');
    container.innerHTML = '';
    if (title) container.appendChild(title);
    else container.appendChild(el('h4', { text: label }));

    if (!data.length) return;
    const maxVal = Math.max(...data.map(d => d.value), 1);

    data.forEach(d => {
      const pct = Math.round((d.value / maxVal) * 100);
      const row = el('div', { class: 'css-bar-row' },
        el('span', { class: 'css-bar-label', text: d.date }),
        el('div', { class: 'css-bar-track' },
          el('div', { class: 'css-bar-fill', style: 'width:' + pct + '%' },
            el('span', { class: 'css-bar-val', text: String(d.value) })
          )
        )
      );
      container.appendChild(row);
    });
  }

  function renderTopicBars(containerId, topics) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    container.appendChild(el('h4', { text: 'Top Topics' }));

    if (!topics.length) return;
    const maxVal = Math.max(...topics.map(t => t.count), 1);

    topics.forEach(t => {
      const pct = Math.round((t.count / maxVal) * 100);
      const row = el('div', { class: 'css-bar-row' },
        el('span', { class: 'css-bar-label', text: t.topic ? t.topic.slice(0, 10) : '' }),
        el('div', { class: 'css-bar-track' },
          el('div', { class: 'css-bar-fill success', style: 'width:' + pct + '%' },
            el('span', { class: 'css-bar-val', text: String(t.count) })
          )
        )
      );
      container.appendChild(row);
    });
  }

  // ---- Audit Log ----

  async function loadAuditLog() {
    try {
      const data = await api('/api/export?format=audit');
      renderAuditLog(data.entries || generateSampleAuditLog());
    } catch (_) {
      renderAuditLog(generateSampleAuditLog());
    }
  }

  function generateSampleAuditLog() {
    return [
      { type: 'action', text: '<strong>Admin</strong> changed role of <strong>Jane</strong> to Member', time: '2 min ago' },
      { type: 'info', text: '<strong>Alice</strong> logged in from 192.168.1.10', time: '15 min ago' },
      { type: 'action', text: '<strong>Admin</strong> exported analytics report', time: '1 hour ago' },
      { type: 'warning', text: 'Failed login attempt for <strong>bob@company.com</strong>', time: '3 hours ago' },
      { type: 'info', text: '<strong>Bob</strong> uploaded file Q1-report.xlsx', time: '5 hours ago' },
      { type: 'action', text: '<strong>Admin</strong> invited <strong>carol@company.com</strong>', time: '1 day ago' },
    ];
  }

  function renderAuditLog(entries) {
    const list = $('#audit-log-list');
    if (!list) return;
    list.innerHTML = '';
    entries.forEach(entry => {
      const item = el('div', { class: 'audit-entry' },
        el('span', { class: 'audit-dot ' + (entry.type || 'info') }),
        el('span', { class: 'audit-text', html: entry.text }),
        el('span', { class: 'audit-time', text: entry.time })
      );
      list.appendChild(item);
    });
  }

  async function exportReport(type, range) {
    showSpinner();
    try {
      const res = await fetch('/api/analytics/report?type=' + type + '&range=' + range, {
        headers: { 'Authorization': 'Bearer ' + state.token }
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = type + '-report.csv'; a.click();
      URL.revokeObjectURL(url);
      showToast('Export downloaded', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
    hideSpinner();
  }

  async function exportJSON() {
    showSpinner();
    try {
      const res = await fetch('/api/export?format=json', {
        headers: { 'Authorization': 'Bearer ' + state.token }
      });
      if (!res.ok) throw new Error('Export failed');
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'businesslog-export.json'; a.click();
      URL.revokeObjectURL(url);
      showToast('JSON export downloaded', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
    hideSpinner();
  }

  // ============================================================
  //  WEBSOCKET
  // ============================================================

  function connectWebSocket() {
    if (state.isGuest) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = protocol + '//' + location.host + '/ws?token=' + state.token;
    const ws = new WebSocket(url);

    ws.onopen = () => { console.info('[ws] connected'); };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'message') receiveMessage(msg.payload);
        else if (msg.type === 'user_joined') { showToast(msg.payload.name + ' joined', 'success'); loadUsers(); }
        else if (msg.type === 'user_left') { loadUsers(); }
      } catch (_) {}
    };
    ws.onclose = () => {
      console.info('[ws] disconnected, reconnecting in 3s');
      setTimeout(connectWebSocket, 3000);
    };
    ws.onerror = () => ws.close();
    state.ws = ws;
  }

  // ============================================================
  //  UI TOGGLES
  // ============================================================

  function toggleSidebar() {
    const grid = $('.main-grid');
    grid.classList.toggle('sidebar-open');
  }

  function toggleUserDropdown() {
    $('#user-dropdown').classList.toggle('hidden');
  }

  function switchAdminSection(section) {
    $$('.admin-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === section));
    $$('.admin-section').forEach(s => s.classList.add('hidden'));
    const target = $('#admin-' + section);
    if (target) target.classList.remove('hidden');
    if (section === 'analytics') loadAnalytics();
    if (section === 'audit') loadAuditLog();
  }

  // ============================================================
  //  TIME FORMATTING
  // ============================================================

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  }

  // ============================================================
  //  INIT APP
  // ============================================================

  function initApp() {
    if (state.currentUser) {
      renderAvatar($('#user-avatar-small'), state.currentUser.name, 'sm');
      const ddAvatar = $('#dropdown-avatar');
      if (ddAvatar) renderAvatar(ddAvatar, state.currentUser.name, 'sm');
      $('#dropdown-name').textContent = state.currentUser.name;
      $('#dropdown-email').textContent = state.currentUser.email || 'Guest';
      const roleEl = $('#dropdown-role');
      if (roleEl) roleEl.textContent = state.currentUser.role || 'guest';

      // Show/hide admin button based on role
      const adminBtn = $('#admin-toggle');
      if (adminBtn) {
        adminBtn.style.display = (state.currentUser.role === 'admin') ? '' : 'none';
      }
    }
    loadConversations();
    connectWebSocket();
  }

  // ============================================================
  //  EVENT LISTENERS
  // ============================================================

  function bindEvents() {
    // Auth modal tabs
    $$('.modal-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.modal-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const isLogin = tab.dataset.tab === 'login';
        $('#login-form').classList.toggle('hidden', !isLogin);
        $('#register-form').classList.toggle('hidden', isLogin);
      });
    });
    $('#switch-to-register').addEventListener('click', (e) => { e.preventDefault(); $$('.modal-tab')[1].click(); });
    $('#switch-to-login').addEventListener('click', (e) => { e.preventDefault(); $$('.modal-tab')[0].click(); });

    // Auth forms
    $('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      login($('#login-email').value, $('#login-password').value);
    });
    $('#register-form').addEventListener('submit', (e) => {
      e.preventDefault();
      register($('#register-name').value, $('#register-email').value, $('#register-password').value, $('#register-team').value);
    });

    // Guest mode buttons
    $('#guest-signup').addEventListener('click', () => { $$('.modal-tab')[1].click(); showLoginModal(); });
    $('#guest-login').addEventListener('click', () => { $$('.modal-tab')[0].click(); showLoginModal(); });

    // Top bar
    $('#sidebar-toggle').addEventListener('click', toggleSidebar);
    $('#admin-toggle').addEventListener('click', toggleAdmin);
    $('#user-menu-btn').addEventListener('click', toggleUserDropdown);
    $('#btn-logout').addEventListener('click', logout);
    $('#admin-close').addEventListener('click', toggleAdmin);

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.user-menu')) $('#user-dropdown').classList.add('hidden');
    });

    // New chat
    $('#new-chat-btn').addEventListener('click', () => {
      const name = prompt('Start a new chat with:');
      if (!name) return;
      api('/api/conversations', { method: 'POST', body: JSON.stringify({ name }) })
        .then(conv => { state.conversations.unshift(conv); renderConversations(); selectConversation(conv); })
        .catch(() => showToast('Could not create chat', 'error'));
    });

    // Search
    $('#conversation-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      $$('.conv-item').forEach(li => {
        li.style.display = li.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    // Send message
    $('#message-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#message-input');
      const text = input.value.trim();
      if (!text && !state._pendingFile) return;
      sendMessage(text, state._pendingFile || null);
      input.value = '';
      clearFilePreview();
    });

    // File upload
    $('#file-input').addEventListener('change', (e) => {
      if (e.target.files[0]) handleFileUpload(e.target.files[0]);
    });
    $('#file-remove').addEventListener('click', clearFilePreview);

    // Admin nav
    $$('.admin-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => switchAdminSection(btn.dataset.section));
    });

    // Invite user
    $('#invite-user-btn').addEventListener('click', () => {
      $('#invite-form').classList.toggle('hidden');
    });
    $('#invite-cancel').addEventListener('click', () => { $('#invite-form').classList.add('hidden'); });
    $('#invite-send').addEventListener('click', () => {
      const email = $('#invite-email').value.trim();
      const role = $('#invite-role').value;
      if (!email) { showToast('Enter an email address', 'error'); return; }
      inviteUser(email, role);
      $('#invite-email').value = '';
      $('#invite-form').classList.add('hidden');
    });

    // Team settings
    $('#team-settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      showSpinner();
      api('/api/team/settings', {
        method: 'PUT',
        body: JSON.stringify({
          name: $('#team-name').value,
          defaultChannel: $('#default-channel').value,
          notifications: {
            email: $('#notify-email').checked,
            desktop: $('#notify-desktop').checked,
            mentions: $('#notify-mentions').checked,
            daily: $('#notify-daily').checked
          }
        })
      }).then(() => showToast('Settings saved', 'success'))
        .catch(() => showToast('Could not save settings', 'error'))
        .finally(hideSpinner);
    });

    // Analytics date range
    $('#date-range').addEventListener('change', loadAnalytics);

    // Export buttons
    $('#export-messages').addEventListener('click', () => exportReport('messages', $('#export-date-range').value));
    $('#export-users').addEventListener('click', () => exportReport('users', $('#export-date-range').value));
    $('#export-analytics').addEventListener('click', () => exportReport('analytics', $('#export-date-range').value));
    $('#export-json').addEventListener('click', () => exportJSON());
  }

  function clearFilePreview() {
    $('#file-preview').classList.add('hidden');
    $('#file-name').textContent = '';
    state._pendingFile = null;
    $('#file-input').value = '';
  }

  // ============================================================
  //  BOOT
  // ============================================================

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    checkAuth();
  });

})();
