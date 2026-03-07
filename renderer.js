/* ═══════════════════════════════════════════
   ClipStack Renderer — Full Feature
   ═══════════════════════════════════════════ */

// ── DOM REFS ─────────────────────────────────
const $ = id => document.getElementById(id);
const feedEl = $('feed');
const snippetsFeed = $('snippets-feed');
const statsView = $('stats-view');
const noticeEl = $('notice');
const searchInput = $('search-input');

// ── STATE ─────────────────────────────────────
let state = { items: [], pinnedKeys: [], snippets: [], settings: {}, subscription: { plan: 'free' }, hasOnboarded: false };
let activeTab = 'history';
let typeFilter = 'all';
let searchQuery = '';
let selectedKey = null;
let openMenuKey = null;
let revealedKeys = new Set();
let selectedKeys = new Set();
let editingKey = null;
let transformKey = null;
let tagKey = null;
let snippetKey = null;
let noticeTimer = null;

// ── UTILS ─────────────────────────────────────
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDate(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return ''; }
}

function isPinned(key) {
  return (state.pinnedKeys || []).includes(key);
}

function isProUser() {
  // return true; // TODO: restore when Stripe billing is live
  return (state.subscription?.plan || 'free') !== 'free';
}

const SENSITIVE_RE = [
  /sk-[a-zA-Z0-9]{20,}/,
  /ghp_[a-zA-Z0-9]{30,}/,
  /AKIA[A-Z0-9]{16}/,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /[a-f0-9]{32,64}/,
  /\b(?:\d[ -]?){13,16}\b/,
  /password\s*[=:]\s*\S+/i,
  /secret\s*[=:]\s*\S+/i,
  /api[_-]?key\s*[=:]\s*\S+/i,
  /token\s*[=:]\s*\S+/i,
];

function isSensitive(value) {
  if (typeof value !== 'string') return false;
  return SENSITIVE_RE.some(re => re.test(value));
}

function showNotice(msg, type = 'success') {
  if (!noticeEl) return;
  noticeEl.textContent = msg;
  noticeEl.className = `notice show ${type}`;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => noticeEl.className = 'notice', 3500);
}

function applyTransform(t, value) {
  try {
    switch (t) {
      case 'uppercase': return value.toUpperCase();
      case 'lowercase': return value.toLowerCase();
      case 'titlecase': return value.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
      case 'trim': return value.trim().replace(/\s+/g, ' ');
      case 'json': return JSON.stringify(JSON.parse(value), null, 2);
      case 'minify': return JSON.stringify(JSON.parse(value));
      case 'base64enc': return btoa(unescape(encodeURIComponent(value)));
      case 'base64dec': return decodeURIComponent(escape(atob(value)));
      case 'urlenc': return encodeURIComponent(value);
      case 'urldec': return decodeURIComponent(value);
      case 'removedups': {
        const lines = value.split('\n');
        return [...new Set(lines)].join('\n');
      }
      case 'wordcount': {
        const words = value.trim().split(/\s+/).filter(Boolean).length;
        const chars = value.length;
        const lines = value.split('\n').length;
        return `Words: ${words} | Chars: ${chars} | Lines: ${lines}`;
      }
      default: return value;
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// ── SUBSCRIPTION UI ───────────────────────────
function updatePlanUI() {
  const plan = state.subscription?.plan || 'free';
  const badge = $('plan-badge');
  const upgradeBtn = $('upgrade-btn');

  badge.textContent = plan.toUpperCase();
  badge.className = `plan-badge ${plan}`;

  if (plan === 'free') {
    upgradeBtn.classList.remove('hidden');
    $('pro-banner').classList.remove('hidden');
  } else {
    upgradeBtn.classList.add('hidden');
    $('pro-banner').classList.add('hidden');
  }

  // Sub info block in settings
  const block = $('sub-info-block');
  if (block) {
    const expiry = state.subscription?.expiresAt
      ? `Expires: ${new Date(state.subscription.expiresAt).toLocaleDateString()}`
      : plan === 'free' ? 'Upgrade for full access' : 'Lifetime / Annual';
    block.innerHTML = `<div class="sub-plan-row">${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan</div><div class="sub-plan-detail">${expiry}</div>`;
  }
}

function openSubModal() {
  $('subscription-modal').classList.remove('hidden');
  const plan = state.subscription?.plan || 'free';
  $('plan-free-btn').disabled = plan === 'free';
  $('plan-free-btn').textContent = plan === 'free' ? 'Current Plan' : 'Downgrade';
}
function closeSubModal() { $('subscription-modal').classList.add('hidden'); }

// ── ONBOARDING ─────────────────────────────────
function checkOnboarding() {
  if (!state.hasOnboarded) {
    $('onboarding').classList.remove('hidden');
  }
}

$('onboarding-btn').addEventListener('click', async () => {
  $('onboarding').classList.add('hidden');
  await window.clipAPI.setOnboarded();
});

// ── SETTINGS PANEL ─────────────────────────────
function openSettings() {
  const panel = $('settings-panel');
  // Create backdrop + inner wrapper if needed
  if (!panel.querySelector('.side-panel-inner')) {
    const inner = document.createElement('div');
    inner.className = 'side-panel-inner';
    inner.appendChild($('side-panel-hdr') || panel.querySelector('.side-panel-hdr'));
    while (panel.children.length > 0) inner.appendChild(panel.children[0]);
    panel.appendChild(inner);
  }
  panel.classList.remove('hidden');
  syncSettingsUI();
}

function closeSettings() { $('settings-panel').classList.add('hidden'); }

function syncSettingsUI() {
  const s = state.settings || {};
  const sub = state.subscription || {};

  // Theme
  document.querySelectorAll('.theme-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.v === (s.theme || 'system'));
  });

  // Toggles
  const setChk = (id, val) => { const el = $(id); if (el) el.checked = !!val; };
  setChk('s-pause', s.pauseCapture);
  setChk('s-mask', s.maskSensitive);
  setChk('s-source', s.trackSource);
  setChk('s-login', s.launchAtLogin);
  setChk('s-autopaste', s.autoPasteOnCmdEnter);

  // Max items
  const maxSel = $('s-max-items');
  if (maxSel) maxSel.value = String(s.maxItems || 200);

  // Excluded apps
  renderExcludedList(s.excludedApps || []);
  updatePlanUI();
}

function renderExcludedList(apps) {
  const list = $('excluded-list');
  if (!list) return;
  list.innerHTML = apps.length ? '' : '<div style="font-size:11px;color:var(--text-3)">No apps excluded yet.</div>';
  apps.forEach(app => {
    const item = document.createElement('div');
    item.className = 'ex-item';
    item.innerHTML = `<span>${app}</span><button class="ex-remove" data-app="${app}">×</button>`;
    list.appendChild(item);
  });
}

// ── TABS ───────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

  feedEl.classList.toggle('hidden', tab !== 'history');
  snippetsFeed.classList.toggle('hidden', tab !== 'snippets');
  statsView.classList.toggle('hidden', tab !== 'stats');
  $('filter-bar').classList.toggle('hidden', tab !== 'history');

  if (tab === 'history') renderFeed();
  else if (tab === 'snippets') renderSnippetsFeed();
  else if (tab === 'stats') renderStats();
}

function updateTabCounts() {
  const hist = $('hist-count');
  const snip = $('snip-count');
  if (hist) hist.textContent = (state.items || []).length;
  if (snip) snip.textContent = (state.snippets || []).length;
}

// ── FILTERING ──────────────────────────────────
function getFilteredItems() {
  let items = [...(state.items || [])];
  const pinned = new Set(state.pinnedKeys || []);

  // Pin sort
  items.sort((a, b) => {
    const ap = pinned.has(a.key) ? 1 : 0;
    const bp = pinned.has(b.key) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.ts || 0) - (a.ts || 0);
  });

  // Type filter
  if (typeFilter !== 'all') {
    if (typeFilter === 'sensitive') {
      items = items.filter(i => i.sensitive || isSensitive(i.value));
    } else {
      items = items.filter(i => i.type === typeFilter);
    }
  }

  // Search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(i => {
      if (i.type === 'image') return false;
      return (i.value || '').toLowerCase().includes(q)
        || (i.tags || []).some(t => t.toLowerCase().includes(q))
        || (i.snippetName || '').toLowerCase().includes(q);
    });
  }

  return items;
}

// ── CARD CREATION ──────────────────────────────
function createCard(item, isSnippet = false) {
  const card = document.createElement('article');
  const isSelected = item.key === selectedKey;
  const isMultiSel = selectedKeys.has(item.key);
  const pinned = isPinned(item.key);
  const sensitive = item.sensitive || (state.settings?.maskSensitive && isSensitive(item.value));
  const isEditing = editingKey === item.key;
  const revealed = revealedKeys.has(item.key);

  card.className = `card${isSelected ? ' selected-highlight' : ''}${isMultiSel ? ' multi-selected' : ''}`;
  card.dataset.key = item.key;

  // ── Card Top ──
  const top = document.createElement('div');
  top.className = 'card-top';

  const left = document.createElement('div');
  left.className = 'card-left';

  // Multi-select checkbox
  if (selectedKeys.size > 0 || false) { // show when in bulk mode
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'multi-check';
    chk.checked = isMultiSel;
    chk.addEventListener('click', e => { e.stopPropagation(); toggleMultiSelect(item.key); });
    left.appendChild(chk);
  }

  // Type badge
  const tb = document.createElement('span');
  const typeLabel = sensitive && !revealed ? 'sensitive' : (item.type || 'text');
  tb.className = `type-badge type-${typeLabel}`;
  tb.textContent = typeLabel.toUpperCase();
  left.appendChild(tb);

  // Snippet name label
  if (isSnippet && item.snippetName) {
    const sn = document.createElement('span');
    sn.className = 'snippet-name';
    sn.textContent = item.snippetName;
    left.appendChild(sn);
  }

  // Time ago
  const ta = document.createElement('span');
  ta.className = 'meta-badge';
  ta.textContent = timeAgo(item.ts);
  ta.title = fmtDate(item.ts);
  left.appendChild(ta);

  // Pin indicator
  if (pinned) {
    const dot = document.createElement('span');
    dot.className = 'pin-dot';
    dot.title = 'Pinned';
    left.appendChild(dot);
  }

  // Source app
  if (item.source && state.settings?.trackSource) {
    const src = document.createElement('span');
    src.className = 'source-tag';
    src.textContent = `• ${item.source}`;
    left.appendChild(src);
  }

  // Tags
  if ((item.tags || []).length > 0) {
    const tagsRow = document.createElement('div');
    tagsRow.className = 'card-tags';
    item.tags.forEach(tag => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.textContent = `#${tag}`;
      tagsRow.appendChild(pill);
    });
    left.appendChild(tagsRow);
  }

  const right = document.createElement('div');
  right.className = 'card-right';

  // Size label
  if (item.type !== 'image') {
    const sz = document.createElement('span');
    sz.className = 'meta-badge';
    sz.textContent = `${(item.value || '').length}c`;
    right.appendChild(sz);
  }

  // Kebab menu
  const menuWrap = document.createElement('div');
  menuWrap.className = 'menu-wrap';

  const kebab = document.createElement('button');
  kebab.className = 'kebab-btn';
  kebab.textContent = '···';
  kebab.addEventListener('click', e => {
    e.stopPropagation();
    openMenuKey = openMenuKey === item.key ? null : item.key;
    renderFeedCurrent();
  });

  const dd = document.createElement('div');
  dd.className = `dropdown${openMenuKey === item.key ? ' open' : ''}`;

  const menuItems = buildMenuItems(item, sensitive, revealed, isSnippet);
  menuItems.forEach(mi => {
    if (mi === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'dd-sep';
      dd.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.className = `dd-item${mi.danger ? ' danger' : ''}`;
      btn.innerHTML = `${mi.icon || ''} ${mi.label}${mi.pro && !isProUser() ? '<span class="dd-pro-lock">PRO</span>' : ''}`;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openMenuKey = null;
        mi.action();
      });
      dd.appendChild(btn);
    }
  });

  menuWrap.appendChild(kebab);
  menuWrap.appendChild(dd);
  right.appendChild(menuWrap);

  top.appendChild(left);
  top.appendChild(right);

  // ── Card Body ──
  const body = document.createElement('div');
  body.className = 'card-body';

  if (isEditing) {
    const ta2 = document.createElement('textarea');
    ta2.className = 'body-edit-area';
    ta2.value = item.value;
    ta2.rows = 4;
    ta2.addEventListener('click', e => e.stopPropagation());

    const acts = document.createElement('div');
    acts.className = 'edit-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary btn-sm';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async e => {
      e.stopPropagation();
      await window.clipAPI.editItem(item.key, ta2.value);
      editingKey = null;
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-ghost btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', e => { e.stopPropagation(); editingKey = null; renderFeedCurrent(); });

    acts.appendChild(saveBtn);
    acts.appendChild(cancelBtn);
    body.appendChild(ta2);
    body.appendChild(acts);
  } else if (item.type === 'image') {
    const wrap = document.createElement('div');
    wrap.className = 'body-image-wrap';
    const img = document.createElement('img');
    img.alt = 'Clipboard image';
    img.src = item.value;
    // Click bubbles up to the card to trigger paste
    wrap.appendChild(img);
    body.appendChild(wrap);
  } else if (sensitive && !revealed) {
    const wrap = document.createElement('div');
    wrap.className = 'body-sensitive';
    const blur = document.createElement('div');
    blur.className = 'sensitive-blur';
    blur.textContent = item.value.slice(0, 80);
    const revBtn = document.createElement('button');
    revBtn.className = 'sensitive-reveal-btn';
    revBtn.innerHTML = '🔒 Click to reveal';
    revBtn.addEventListener('click', e => {
      e.stopPropagation();
      revealedKeys.add(item.key);
      renderFeedCurrent();
    });
    wrap.appendChild(blur);
    wrap.appendChild(revBtn);
    body.appendChild(wrap);
  } else if (item.type === 'link') {
    const link = document.createElement('a');
    link.className = 'body-link';
    link.textContent = item.value;
    link.href = '#';
    link.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      await window.clipAPI.openExternal(item.value);
    });
    body.appendChild(link);
  } else if (item.type === 'code') {
    const pre = document.createElement('div');
    pre.className = 'body-code';
    pre.textContent = item.value;
    body.appendChild(pre);
  } else {
    const div = document.createElement('div');
    div.className = 'body-text';
    div.textContent = item.value;
    body.appendChild(div);
  }

  card.appendChild(top);
  card.appendChild(body);

  // ── Click to paste ──
  card.addEventListener('click', async () => {
    openMenuKey = null;
    if (selectedKeys.size > 0) {
      toggleMultiSelect(item.key);
      return;
    }
    if (state.settings?.autoPasteOnCmdEnter !== false) {
      const ok = await window.clipAPI.copyAndPaste(item.key);
      if (!ok) showNotice('Paste failed', 'error');
    } else {
      await window.clipAPI.copyItem(item.key);
      showNotice('Copied!');
    }
  });

  return card;
}

function buildMenuItems(item, sensitive, revealed, isSnippet) {
  const items = [
    { icon: '📋', label: 'Copy', action: async () => { await window.clipAPI.copyItem(item.key); showNotice('Copied!'); } },
    { icon: '📌', label: isPinned(item.key) ? 'Unpin' : 'Pin', action: async () => { await window.clipAPI.togglePin(item.key); } },
    'sep',
  ];

  if (item.type !== 'image') {
    items.push({ icon: '✏️', label: 'Edit', action: () => { editingKey = item.key; renderFeedCurrent(); } });
    items.push({
      icon: '🔄', label: 'Transform', pro: true, action: () => {
        if (!isProUser()) { openSubModal(); return; }
        transformKey = item.key;
        showTransformPanel();
      }
    });
    items.push({
      icon: '🏷️', label: 'Tags', pro: true, action: () => {
        if (!isProUser()) { openSubModal(); return; }
        openTagModal(item.key);
      }
    });
    items.push('sep');
  }

  if (!isSnippet) {
    items.push({
      icon: '📄', label: 'Save as Snippet', pro: true, action: () => {
        if (!isProUser()) { openSubModal(); return; }
        snippetKey = item.key;
        openSnippetModal();
      }
    });
  } else {
    items.push({ icon: '🗑️', label: 'Remove Snippet', danger: true, action: async () => { await window.clipAPI.deleteSnippet(item.key); } });
  }

  items.push({ icon: '☑️', label: 'Multi-select', action: () => { toggleMultiSelect(item.key); } });
  items.push('sep');
  items.push({ icon: '🗑️', label: 'Delete', danger: true, action: async () => { await window.clipAPI.deleteItem(item.key); } });

  return items;
}

// ── FEED RENDER ───────────────────────────────
function renderFeed() {
  if (activeTab !== 'history') return;
  const items = getFilteredItems();
  feedEl.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<div class="empty-icon">📋</div><div class="empty-title">${searchQuery ? 'No results found' : 'No clipboard items yet'}</div><div class="empty-sub">${searchQuery ? 'Try a different search term' : 'Copy something to get started'}</div>`;
    feedEl.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach(item => frag.appendChild(createCard(item, false)));
  feedEl.appendChild(frag);
}

function renderSnippetsFeed() {
  if (activeTab !== 'snippets') return;
  const snippets = state.snippets || [];
  snippetsFeed.innerHTML = '';

  if (!snippets.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<div class="empty-icon">📄</div><div class="empty-title">No snippets yet</div><div class="empty-sub">Right-click any clip → "Save as Snippet"</div>`;
    snippetsFeed.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  snippets.forEach(item => frag.appendChild(createCard(item, true)));
  snippetsFeed.appendChild(frag);
}

function renderFeedCurrent() {
  if (activeTab === 'history') renderFeed();
  else if (activeTab === 'snippets') renderSnippetsFeed();
  else renderStats();
}

// ── STATS ─────────────────────────────────────
function renderStats() {
  const items = state.items || [];
  const snippets = state.snippets || [];
  const total = items.length;

  const byType = { text: 0, code: 0, link: 0, image: 0 };
  let totalHits = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  items.forEach(i => {
    if (byType[i.type] !== undefined) byType[i.type]++;
    totalHits += (i.hits || 1);
  });

  const todayItems = items.filter(i => i.ts >= today.getTime()).length;
  const topItems = [...items].sort((a, b) => (b.hits || 1) - (a.hits || 1)).slice(0, 5);

  statsView.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-val">${total}</div><div class="stat-lbl">Total Clips</div></div>
      <div class="stat-card"><div class="stat-val">${todayItems}</div><div class="stat-lbl">Added Today</div></div>
      <div class="stat-card"><div class="stat-val">${snippets.length}</div><div class="stat-lbl">Snippets</div></div>
      <div class="stat-card"><div class="stat-val">${totalHits}</div><div class="stat-lbl">Total Uses</div></div>
    </div>
    <div class="stats-section-title">By Type</div>
    ${['text', 'code', 'link', 'image'].map(t => {
    const pct = total ? Math.round(byType[t] / total * 100) : 0;
    const colors = { text: '#4A9EFF', code: '#A78BFA', link: '#22D78B', image: '#FB923C' };
    return `<div class="type-bar">
        <div class="type-bar-row"><span>${t.charAt(0).toUpperCase() + t.slice(1)}</span><span>${byType[t]} (${pct}%)</span></div>
        <div class="type-bar-bg"><div class="type-bar-fill" style="width:${pct}%;background:${colors[t]}"></div></div>
      </div>`;
  }).join('')}
    ${topItems.length ? `
    <div class="stats-section-title">Most Used</div>
    ${topItems.filter(i => i.type !== 'image').map((item, i) => `
      <div class="top-item">
        <div class="top-item-rank">#${i + 1}</div>
        <div class="top-item-text">${escapeHtml(item.value.slice(0, 60))}</div>
        <div class="top-item-hits">${item.hits || 1}×</div>
      </div>`).join('')}` : ''}
  `;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── IMAGE PREVIEW ─────────────────────────────
function openImagePreview(src, info) {
  $('img-preview-img').src = src;
  $('img-preview-info').textContent = info || '';
  $('img-preview-modal').classList.remove('hidden');
}
function closeImagePreview() { $('img-preview-modal').classList.add('hidden'); }

// ── TRANSFORM PANEL ────────────────────────────
function showTransformPanel() {
  const tp = $('transform-panel');
  tp.style.top = '200px';
  tp.style.right = '14px';
  tp.style.left = 'auto';
  tp.classList.remove('hidden');
}
function hideTransformPanel() { $('transform-panel').classList.add('hidden'); }

// ── TAG MODAL ─────────────────────────────────
function openTagModal(key) {
  tagKey = key;
  const item = (state.items || []).find(i => i.key === key);
  const existing = $('tag-existing');
  existing.innerHTML = '';
  (item?.tags || []).forEach(tag => {
    const pill = document.createElement('div');
    pill.className = 'tag-existing-pill';
    pill.innerHTML = `#${tag} <button class="tag-pill-rm" data-tag="${tag}">×</button>`;
    existing.appendChild(pill);
  });
  $('tag-input').value = '';
  $('tag-modal').classList.remove('hidden');
  setTimeout(() => $('tag-input').focus(), 100);
}
function closeTagModal() { $('tag-modal').classList.add('hidden'); tagKey = null; }

// ── SNIPPET MODAL ─────────────────────────────
function openSnippetModal() {
  $('snippet-name-input').value = '';
  $('snippet-modal').classList.remove('hidden');
  setTimeout(() => $('snippet-name-input').focus(), 100);
}
function closeSnippetModal() { $('snippet-modal').classList.add('hidden'); snippetKey = null; }

// ── MULTI SELECT ──────────────────────────────
function toggleMultiSelect(key) {
  if (selectedKeys.has(key)) selectedKeys.delete(key);
  else selectedKeys.add(key);
  updateBulkBar();
  renderFeedCurrent();
}

function updateBulkBar() {
  const bar = $('bulk-bar');
  if (selectedKeys.size > 0) {
    bar.classList.remove('hidden');
    $('bulk-count').textContent = `${selectedKeys.size} selected`;
  } else {
    bar.classList.add('hidden');
  }
}

function clearMultiSelect() {
  selectedKeys.clear();
  updateBulkBar();
  renderFeedCurrent();
}

// ── KEYBOARD NAVIGATION ─────────────────────
function handleKeydown(e) {
  const active = document.activeElement;
  const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');

  if (e.key === 'Escape') {
    if (openMenuKey) { openMenuKey = null; renderFeedCurrent(); return; }
    if (!$('img-preview-modal').classList.contains('hidden')) { closeImagePreview(); return; }
    if (!$('tag-modal').classList.contains('hidden')) { closeTagModal(); return; }
    if (!$('snippet-modal').classList.contains('hidden')) { closeSnippetModal(); return; }
    if (!$('subscription-modal').classList.contains('hidden')) { closeSubModal(); return; }
    if (!$('settings-panel').classList.contains('hidden')) { closeSettings(); return; }
    if (!$('transform-panel').classList.contains('hidden')) { hideTransformPanel(); return; }
    if (selectedKeys.size > 0) { clearMultiSelect(); return; }
    if (searchQuery) { searchQuery = ''; searchInput.value = ''; $('search-clear').classList.add('hidden'); renderFeed(); return; }
    window.clipAPI && window.clipAPI.copyAndPaste && null; // handled elsewhere
    return;
  }

  if (isTyping) return;

  if (activeTab === 'history') {
    const items = getFilteredItems();
    if (!items.length) return;
    const idx = items.findIndex(i => i.key === selectedKey);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = items[Math.min(items.length - 1, idx + 1)];
      selectedKey = next?.key || null;
      renderFeed();
      scrollToSelected();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = items[Math.max(0, idx - 1)];
      selectedKey = prev?.key || null;
      renderFeed();
      scrollToSelected();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedKey) {
        window.clipAPI.copyAndPaste(selectedKey).then(ok => { if (!ok) showNotice('Paste failed', 'error'); });
      }
    }
  }
}

function scrollToSelected() {
  const card = feedEl.querySelector('.selected-highlight');
  if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── EVENT WIRING ──────────────────────────────
document.addEventListener('keydown', handleKeydown);

// Document click to close dropdowns
document.addEventListener('click', () => {
  if (openMenuKey) { openMenuKey = null; renderFeedCurrent(); }
  hideTransformPanel();
});

// Search
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  $('search-clear').classList.toggle('hidden', !searchQuery);
  renderFeed();
});

$('search-clear').addEventListener('click', () => {
  searchQuery = ''; searchInput.value = '';
  $('search-clear').classList.add('hidden');
  renderFeed();
});

// Tabs
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Filter chips
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    typeFilter = chip.dataset.f;
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.f === typeFilter));
    renderFeed();
  });
});

// Pause button
$('pause-btn').addEventListener('click', async () => {
  await window.clipAPI.togglePause();
});

// Settings
$('settings-btn').addEventListener('click', () => openSettings());
$('settings-close').addEventListener('click', closeSettings);

// The settings panel needs a backdrop click to close
$('settings-panel').addEventListener('click', e => {
  if (e.target === $('settings-panel')) closeSettings();
});

// Upgrade buttons
$('upgrade-btn')?.addEventListener('click', openSubModal);
$('pro-banner-btn')?.addEventListener('click', openSubModal);
$('manage-sub-btn')?.addEventListener('click', () => { closeSettings(); openSubModal(); });

// Sub modal close
$('sub-modal-close').addEventListener('click', closeSubModal);
$('sub-modal-backdrop').addEventListener('click', closeSubModal);

// Image preview close
$('img-preview-close').addEventListener('click', closeImagePreview);
$('img-preview-backdrop').addEventListener('click', closeImagePreview);

// Tag modal
$('tag-modal-close').addEventListener('click', closeTagModal);
$('tag-modal-backdrop').addEventListener('click', closeTagModal);

$('tag-add-btn').addEventListener('click', async () => {
  const val = $('tag-input').value.trim().replace(/^#/, '');
  if (!val || !tagKey) return;
  const item = (state.items || []).find(i => i.key === tagKey);
  const tags = [...new Set([...(item?.tags || []), val])];
  await window.clipAPI.setTags(tagKey, tags);
  $('tag-input').value = '';
});

$('tag-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('tag-add-btn').click();
});

// Tag existing pill remove
$('tag-existing').addEventListener('click', async e => {
  if (e.target.classList.contains('tag-pill-rm')) {
    const tag = e.target.dataset.tag;
    const item = (state.items || []).find(i => i.key === tagKey);
    const tags = (item?.tags || []).filter(t => t !== tag);
    await window.clipAPI.setTags(tagKey, tags);
  }
});

// Snippet modal
$('snippet-modal-close').addEventListener('click', closeSnippetModal);
$('snippet-modal-backdrop').addEventListener('click', closeSnippetModal);
$('snippet-save-btn').addEventListener('click', async () => {
  const name = $('snippet-name-input').value.trim();
  if (!name || !snippetKey) { showNotice('Enter a snippet name', 'error'); return; }
  await window.clipAPI.convertToSnippet(snippetKey, name);
  closeSnippetModal();
  showNotice('Saved as snippet!');
});
$('snippet-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('snippet-save-btn').click(); });

// Transform panel
document.querySelectorAll('.tp-opt').forEach(btn => {
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    const transform = btn.dataset.t;
    const item = (state.items || []).find(i => i.key === transformKey);
    if (!item) { hideTransformPanel(); return; }
    const newVal = applyTransform(transform, item.value);
    if (transform === 'wordcount') {
      showNotice(newVal);
    } else {
      await window.clipAPI.editItem(transformKey, newVal);
      showNotice('Transformed!');
    }
    hideTransformPanel();
    transformKey = null;
  });
});

// Settings controls
document.querySelectorAll('.theme-opt').forEach(btn => {
  btn.addEventListener('click', async () => {
    const theme = btn.dataset.v;
    document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.v === theme));
    applyTheme(theme);
    await window.clipAPI.updateSettings({ theme });
  });
});

function applyTheme(theme) {
  const body = document.body;
  if (theme === 'dark') body.dataset.theme = 'dark';
  else if (theme === 'light') body.dataset.theme = 'light';
  else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    body.dataset.theme = prefersDark ? 'dark' : 'light';
  }
}

$('s-pause').addEventListener('change', async e => { await window.clipAPI.updateSettings({ pauseCapture: e.target.checked }); updatePauseBtn(); });
$('s-mask').addEventListener('change', async e => { await window.clipAPI.updateSettings({ maskSensitive: e.target.checked }); });
$('s-source').addEventListener('change', async e => { await window.clipAPI.updateSettings({ trackSource: e.target.checked }); });
$('s-login').addEventListener('change', async e => { await window.clipAPI.setLoginItem(e.target.checked); await window.clipAPI.updateSettings({ launchAtLogin: e.target.checked }); });
$('s-autopaste').addEventListener('change', async e => { await window.clipAPI.updateSettings({ autoPasteOnCmdEnter: e.target.checked }); });
$('s-max-items').addEventListener('change', async e => { await window.clipAPI.updateSettings({ maxItems: Number(e.target.value) }); });

function updatePauseBtn() {
  const paused = state.settings?.pauseCapture;
  $('pause-btn').classList.toggle('active', !!paused);
  $('pause-btn').title = paused ? 'Resume Capture' : 'Pause Capture';
}

// Excluded apps
$('add-ex-btn').addEventListener('click', async () => {
  const val = $('add-ex-input').value.trim();
  if (!val) return;
  const apps = [...(state.settings?.excludedApps || [])];
  if (!apps.includes(val)) apps.push(val);
  await window.clipAPI.updateSettings({ excludedApps: apps });
  $('add-ex-input').value = '';
});
$('add-ex-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('add-ex-btn').click(); });

$('excluded-list').addEventListener('click', async e => {
  if (e.target.classList.contains('ex-remove')) {
    const app = e.target.dataset.app;
    const apps = (state.settings?.excludedApps || []).filter(a => a !== app);
    await window.clipAPI.updateSettings({ excludedApps: apps });
  }
});

// Export
$('export-btn').addEventListener('click', async () => {
  if (!isProUser()) { showNotice('Export requires Pro plan', 'error'); openSubModal(); return; }
  await window.clipAPI.exportHistory();
  showNotice('History exported!');
});

// Clear
$('clear-btn').addEventListener('click', async () => {
  if (!confirm('Clear all clipboard history?')) return;
  await window.clipAPI.clearHistory();
  showNotice('History cleared');
});

// Bulk delete
$('bulk-delete-btn').addEventListener('click', async () => {
  if (!selectedKeys.size) return;
  if (!confirm(`Delete ${selectedKeys.size} items?`)) return;
  await window.clipAPI.deleteItems([...selectedKeys]);
  clearMultiSelect();
  showNotice('Deleted!');
});
$('bulk-cancel-btn').addEventListener('click', clearMultiSelect);

// License activation
$('activate-btn').addEventListener('click', async () => {
  const key = $('license-input').value.trim();
  if (!key) return;
  const result = await window.clipAPI.activateLicense(key);
  if (result?.success) {
    showNotice('License activated! Welcome to ' + result.plan + '!');
    closeSubModal();
  } else {
    showNotice('Invalid license key', 'error');
  }
});

// Upgrade buttons (placeholder - connect to Stripe later)
$('upgrade-pro-btn').addEventListener('click', () => { showNotice('Stripe billing coming soon! Use a license key.'); });
$('upgrade-team-btn').addEventListener('click', () => { showNotice('Team billing coming soon!'); });

// ── IPC LISTENERS ─────────────────────────────
window.clipAPI.onState(newState => {
  state = newState;
  updateTabCounts();
  updatePlanUI();
  updatePauseBtn();
  applyTheme(state.settings?.theme || 'system');
  if (state.settings?.excludedApps) renderExcludedList(state.settings.excludedApps);
  renderFeedCurrent();
});

window.clipAPI.onSelection(sel => {
  selectedKey = sel?.key || null;
  renderFeedCurrent();
});

// ── INIT ──────────────────────────────────────
async function init() {
  state = await window.clipAPI.getState();
  applyTheme(state.settings?.theme || 'system');
  updateTabCounts();
  updatePlanUI();
  updatePauseBtn();
  renderFeed();
  checkOnboarding();
  switchTab('history');
}

init();
