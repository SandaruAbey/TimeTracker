// ============================================================
// TimeTracker — Popup Controller v2.0
// ============================================================

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ─── State ──────────────────────────────────────────────
let config = {};
let cachedTasks = [];
let selectedTab = '';
let statusOptions = { morning: [], evening: [] };
let dropdownOptions = {}; // Fetched from Google Sheets data validations
const DEFAULT_ALLOCATED_TIMES = ['15', '30', '45', '60', '90', '120', '180', '240', '300', '360', '480'];
let timerTick = null;       // local setInterval id
let currentTimer = null;    // last known timer state
let currentTask = null;     // task open in detail view
let recentTotalSpent = 0;   // recent total spent time (excluding today)
let settingsOriginView = 'sheets';
let adminDashboardOriginView = 'sheets';

// Column indices (must match background.js COL)
const C = {
  PROJECT: 0, AUTO: 1, NAME: 2, TYPE: 3, JIRA: 4,
  PRIORITY: 5, MORNING: 6, EVENING: 7, TARGET: 8, START: 9,
  DUE_TIME: 10, ALLOC: 11, SPENT: 12, TOTAL: 13, WEEK: 14,
  EXTRA: 15, COMPLETION_PCT: 16
};

// Robust time parser for minutes (e.g. '2 hr & 30 min' -> 150)
function parseTimeMins(val) {
  if (val === undefined || val === null) return 0;
  const str = String(val).trim().toLowerCase();
  if (!str) return 0;

  const num = Number(str);
  if (!isNaN(num)) {
    return Math.round(num);
  }

  let mins = 0;
  const hMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hour)s?/);
  if (hMatch) {
    mins += parseFloat(hMatch[1]) * 60;
  }
  let remainingStr = str;
  if (hMatch) {
    remainingStr = str.replace(hMatch[0], '');
  }
  const mMatch = remainingStr.match(/(\d+(?:\.\d+)?)\s*(?:m|min|minute)s?/);
  if (mMatch) {
    mins += parseFloat(mMatch[1]);
  }
  return Math.round(mins);
}

function matchMinsToDropdownOption(mins, options) {
  if (!options || options.length === 0) {
    if (mins === 0) return '';
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    if (rem === 0) return `${hrs} hr`;
    return `${hrs} hr & ${rem} min`;
  }
  
  let bestOption = options[0];
  let minDiff = Infinity;
  for (const opt of options) {
    const optMins = parseTimeMins(opt);
    const diff = Math.abs(optMins - mins);
    if (diff < minDiff) {
      minDiff = diff;
      bestOption = opt;
    }
  }
  return bestOption;
}

// ─── Helpers ────────────────────────────────────────────
const sendMsg = (m) => new Promise(r => chrome.runtime.sendMessage(m, r));

function showView(id) {
  $$('.view').forEach(v => { v.classList.add('hidden'); v.classList.remove('active'); });
  const el = $(`#view-${id}`);
  if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
  if (id === 'settings') updateSettings();
}

function fmtTime(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function showLoading(on) { $('#loading-overlay').classList.toggle('hidden', !on); }

function toast(msg, type = 'info') {
  const t = $('#toast');
  $('#toast-message').textContent = msg;
  t.className = `toast toast-${type} show`;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3200);
}

function extractId(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : url.trim();
}

function statusClass(s) {
  const l = (s || '').toLowerCase();
  if (l.includes('complete')) return 'complete';
  if (l.includes('progress')) return 'progress';
  if (l.includes('block'))    return 'blocked';
  if (l.includes('hold'))     return 'hold';
  return 'default';
}

function colLetter(n) {
  let s = '';
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();

  const stored = await chrome.storage.local.get('config');
  config = stored.config || {};

  // Silent auth check
  const auth = await sendMsg({ type: 'CHECK_AUTH' });
  if (!auth?.authenticated) { showView('login'); return; }
  if (!config.sheetId) { showView('setup'); return; }
  if (!config.userName) { showView('name'); loadNames(); return; }

  let redirected = false;
  const redirectTarget = await chrome.storage.local.get(['openTaskRowIndex', 'openTaskTab']);
  if (redirectTarget.openTaskRowIndex && redirectTarget.openTaskTab) {
    const targetRowIndex = parseInt(redirectTarget.openTaskRowIndex);
    const targetTab = redirectTarget.openTaskTab;
    await chrome.storage.local.remove(['openTaskRowIndex', 'openTaskTab']);

    if (config.adminMode) {
      $('#btn-admin-dashboard')?.classList.remove('hidden');
      $('#btn-tasks-admin-dashboard')?.classList.remove('hidden');
    } else {
      $('#btn-admin-dashboard')?.classList.add('hidden');
      $('#btn-tasks-admin-dashboard')?.classList.add('hidden');
    }

    selectedTab = targetTab;
    await chrome.storage.session.set({ selectedTab: targetTab });

    showLoading(true);
    const r = await sendMsg({ type: 'GET_SHEET_DATA', sheetId: config.sheetId, range: targetTab });
    showLoading(false);

    if (r && !r.error && r.rows) {
      const rows = r.rows;
      const tasks = rows.slice(1)
        .map((row, i) => ({ row, rowIndex: i + 2 }))
        .filter(({ row }) => row[C.NAME] === config.userName);
      
      cachedTasks = tasks;
      statusOptions.morning = [...new Set(rows.slice(1).map(r => r[C.MORNING]).filter(Boolean))].sort();
      statusOptions.evening = [...new Set(rows.slice(1).map(r => r[C.EVENING]).filter(Boolean))].sort();

      renderTasks(tasks, targetTab);
      
      const targetTask = cachedTasks.find(t => t.rowIndex === targetRowIndex);
      if (targetTask) {
        // Load dropdown options first to populate fields properly
        await loadDropdownOptions();
        await openDetail(targetTask);
        pollTimer();
        redirected = true;
      }
    }
  }

  if (!redirected) {
    if (config.adminMode) {
      $('#btn-admin-dashboard')?.classList.remove('hidden');
      $('#btn-tasks-admin-dashboard')?.classList.remove('hidden');
    } else {
      $('#btn-admin-dashboard')?.classList.add('hidden');
      $('#btn-tasks-admin-dashboard')?.classList.add('hidden');
    }

    showView('sheets');
    loadSheets();
    pollTimer();
    loadDropdownOptions();
  }
});

// ─── Event Binding ──────────────────────────────────────
function bindEvents() {
  // Auth
  $('#btn-login').onclick = doLogin;

  // Setup
  $('#btn-connect').onclick = doConnect;
  $('#sheet-url').addEventListener('keydown', e => { if (e.key === 'Enter') doConnect(); });

  // Name
  $('#btn-name-continue').onclick = doNameSelect;

  // Sheets
  $('#btn-settings-open').onclick = () => {
    settingsOriginView = 'sheets';
    showView('settings');
  };
  $('#btn-open-sheet').onclick = doOpenSheet;

  // Tasks
  $('#btn-back-sheets').onclick  = () => { showView('sheets'); loadSheets(); };
  $('#btn-tasks-open-sheet').onclick = doOpenSheet;
  $('#btn-tasks-settings-open').onclick = () => {
    settingsOriginView = 'tasks';
    showView('settings');
  };
  $('#btn-refresh').onclick      = refreshTasks;
  $('#btn-show-add-task').onclick = () => { showView('add-task'); prepareAddTaskForm(); };
  $('#btn-back-add-task').onclick = () => showView('tasks');
  $('#btn-save-new-task').onclick = doAddTask;

  // Detail
  $('#btn-back-tasks').onclick   = () => showView('tasks');
  $('#btn-save-status').onclick  = doSaveStatus;
  $('#btn-save-url').onclick     = doSaveUrl;

  // Timer
  $('#btn-timer-start').onclick  = doTimerStart;
  $('#btn-timer-pause').onclick  = doTimerPause;
  $('#btn-timer-resume').onclick = doTimerResume;
  $('#btn-timer-stop').onclick   = doTimerStop;
  $('#btn-timer-add').onclick    = doTimerAdd;

  // Settings
  $('#btn-back-settings').onclick = () => {
    if (settingsOriginView === 'tasks') {
      showView('tasks');
    } else {
      showView('sheets');
      loadSheets();
    }
  };
  $('#btn-change-sheet').onclick  = () => { config.sheetId = ''; chrome.storage.local.set({ config }); showView('setup'); };
  $('#btn-change-name').onclick   = () => { config.userName = ''; chrome.storage.local.set({ config }); showView('name'); loadNames(); };
  $('#btn-sign-out').onclick      = doSignOut;
  $('#btn-open-sheet-settings').onclick = doOpenSheet;

  // Pet toggle
  $('#settings-pet-enabled').onchange = async (e) => {
    await sendMsg({ type: 'SET_PET_SETTINGS', settings: { enabled: e.target.checked } });
    toast(e.target.checked ? 'Pet widget enabled' : 'Pet widget disabled', 'info');
  };

  // Admin toggle
  $('#settings-admin-enabled').onchange = async (e) => {
    if (e.target.checked) {
      const pwd = prompt("Enter Admin Password:");
      if (pwd === "admin123") {
        config.adminMode = true;
        await chrome.storage.local.set({ config });
        toast('Admin Mode enabled!', 'success');
        $('#btn-admin-dashboard')?.classList.remove('hidden');
        $('#btn-tasks-admin-dashboard')?.classList.remove('hidden');
      } else {
        toast('Incorrect password!', 'error');
        e.target.checked = false;
        config.adminMode = false;
        await chrome.storage.local.set({ config });
        $('#btn-admin-dashboard')?.classList.add('hidden');
        $('#btn-tasks-admin-dashboard')?.classList.add('hidden');
      }
    } else {
      config.adminMode = false;
      await chrome.storage.local.set({ config });
      toast('Admin Mode disabled', 'info');
      $('#btn-admin-dashboard')?.classList.add('hidden');
      $('#btn-tasks-admin-dashboard')?.classList.add('hidden');
    }
  };

  // Admin Dashboard click
  $('#btn-admin-dashboard').onclick = openAdminDashboard;
  $('#btn-tasks-admin-dashboard').onclick = openAdminDashboard;
  $('#btn-back-admin').onclick = closeAdminDashboard;
  $('#admin-dashboard-sheet-select').onchange = (e) => {
    loadAdminDashboardData(e.target.value);
  };

  // Global reminders
  $('#btn-add-global-reminder').onclick = doAddGlobalReminder;

  // Background → popup messages
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TIMER_STATE_UPDATE') onTimerUpdate(msg.timerState, msg.elapsed);
  });
}

// ═══════════════════════════════════════════════════════
//  Dropdown Options (from Sheet Data Validations)
// ═══════════════════════════════════════════════════════
async function loadDropdownOptions() {
  if (!config.sheetId) return;
  const r = await sendMsg({ type: 'GET_DROPDOWN_OPTIONS', sheetId: config.sheetId });
  if (r?.success && r.dropdowns) {
    dropdownOptions = r.dropdowns;
  }
}

function getDropdownsForTab(tabName) {
  // Try exact tab match first, then fall back to first available
  if (dropdownOptions[tabName]) return dropdownOptions[tabName];
  const keys = Object.keys(dropdownOptions);
  return keys.length > 0 ? dropdownOptions[keys[0]] : {};
}

// ═══════════════════════════════════════════════════════
//  Auth
// ═══════════════════════════════════════════════════════
async function doLogin() {
  showLoading(true);
  const r = await sendMsg({ type: 'LOGIN' });
  showLoading(false);
  if (r?.success) {
    toast('Signed in!', 'success');
    if (!config.sheetId) showView('setup');
    else if (!config.userName) { showView('name'); loadNames(); }
    else { showView('sheets'); loadSheets(); }
  } else {
    toast('Sign-in failed — try again', 'error');
  }
}

async function doSignOut() {
  showLoading(true);
  await sendMsg({ type: 'SIGN_OUT' });
  showLoading(false);
  config = {};
  showView('login');
  toast('Signed out', 'info');
}

// ═══════════════════════════════════════════════════════
//  Sheet Setup
// ═══════════════════════════════════════════════════════
async function doConnect() {
  const raw = $('#sheet-url').value.trim();
  if (!raw) { toast('Enter a Google Sheet URL', 'error'); return; }
  const id = extractId(raw);
  if (!id) { toast('Invalid URL', 'error'); return; }

  showLoading(true);
  const r = await sendMsg({ type: 'GET_SHEET_TABS', sheetId: id });
  showLoading(false);
  if (r?.error) { toast(`Can't access sheet: ${r.error}`, 'error'); return; }

  config.sheetId = id;
  await chrome.storage.local.set({ config });
  toast('Sheet connected!', 'success');
  showView('name');
  loadNames();
  loadDropdownOptions();
}

// ═══════════════════════════════════════════════════════
//  Name Selection
// ═══════════════════════════════════════════════════════
async function loadNames() {
  showLoading(true);
  const tabs = await sendMsg({ type: 'GET_SHEET_TABS', sheetId: config.sheetId });
  if (tabs?.error) { showLoading(false); toast(tabs.error, 'error'); return; }

  const data = await sendMsg({ type: 'GET_SHEET_DATA', sheetId: config.sheetId, range: `'${tabs.tabs[0]}'!C:C` });
  showLoading(false);
  if (data?.error) { toast(data.error, 'error'); return; }

  const names = [...new Set((data.rows || []).slice(1).map(r => r[0]).filter(Boolean))].sort();
  const sel = $('#name-select');
  sel.innerHTML = '<option value="">— Select Your Name —</option>';
  names.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
}

async function doNameSelect() {
  const n = $('#name-select').value;
  if (!n) { toast('Please select your name', 'error'); return; }
  config.userName = n;
  await chrome.storage.local.set({ config });
  toast(`Welcome, ${n}!`, 'success');
  showView('sheets');
  loadSheets();
}

// ═══════════════════════════════════════════════════════
//  Sheet Tab Selection
// ═══════════════════════════════════════════════════════
async function loadSheets() {
  showLoading(true);
  const r = await sendMsg({ type: 'GET_SHEET_TABS', sheetId: config.sheetId });
  showLoading(false);
  if (r?.error) { toast(r.error, 'error'); return; }

  // If only 1 sheet exists and user is not admin, go directly inside
  if (!config.adminMode && r.tabs && r.tabs.length === 1) {
    $('#btn-back-sheets').classList.add('hidden');
    openSheet(r.tabs[0]);
    return;
  } else {
    $('#btn-back-sheets').classList.remove('hidden');
  }

  const today = new Date().toISOString().split('T')[0];
  const box = $('#sheets-list');
  box.innerHTML = '';

  r.tabs.forEach(name => {
    const isToday = name === today;
    const card = document.createElement('div');
    card.className = `sheet-card${isToday ? ' sheet-card-today' : ''}`;
    
    let duplicateButtonHtml = '';
    if (config.adminMode) {
      duplicateButtonHtml = `
        <button class="btn-duplicate-sheet btn-icon sm" data-sheet="${name}" title="Duplicate Sheet" style="position: relative; z-index: 10; margin-right: 8px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      `;
    }

    card.innerHTML = `
      <div class="sheet-card-content">
        <svg class="sheet-icon" width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="2" y="1" width="14" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/>
          <line x1="2" y1="6" x2="16" y2="6" stroke="currentColor" stroke-width="1.5"/>
          <line x1="7" y1="6" x2="7" y2="17" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        <span class="sheet-name">${name}</span>
        ${isToday ? '<span class="badge-today">Today</span>' : ''}
      </div>
      <div style="display: flex; align-items: center;">
        ${duplicateButtonHtml}
        <svg class="sheet-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>`;

    card.addEventListener('click', () => openSheet(name));

    if (config.adminMode) {
      const btn = card.querySelector('.btn-duplicate-sheet');
      btn.onclick = async (e) => {
        e.stopPropagation(); // prevent opening sheet tab
        
        const newName = prompt(`Enter duplicate sheet name for "${name}":`, name + "_copy");
        if (!newName) return;
        
        const excludeCompleted = confirm("Duplicate WITHOUT completed tasks?");
        
        showLoading(true);
        const dupResult = await sendMsg({
          type: 'DUPLICATE_SHEET',
          sheetId: config.sheetId,
          sourceTab: name,
          newTabName: newName,
          excludeCompleted: excludeCompleted
        });
        showLoading(false);
        
        if (dupResult?.success) {
          toast(`Successfully duplicated sheet!`, 'success');
          loadSheets(); // refresh list
        } else {
          toast(dupResult?.error || 'Failed to duplicate sheet', 'error');
        }
      };
    }

    box.appendChild(card);
  });
}

async function openSheet(tab) {
  showLoading(true);
  selectedTab = tab;
  await chrome.storage.session.set({ selectedTab: tab });

  const r = await sendMsg({ type: 'GET_SHEET_DATA', sheetId: config.sheetId, range: tab });
  showLoading(false);
  if (r?.error) { toast(r.error, 'error'); return; }

  const rows = r.rows || [];
  if (rows.length < 2) { toast('No data on this sheet', 'error'); return; }

  // Filter by user name
  const tasks = rows.slice(1)
    .map((row, i) => ({ row, rowIndex: i + 2 }))   // sheet row 2 = first data
    .filter(({ row }) => row[C.NAME] === config.userName);

  cachedTasks = tasks;

  // Collect unique status values for dropdowns (fallback if no data validation)
  statusOptions.morning = [...new Set(rows.slice(1).map(r => r[C.MORNING]).filter(Boolean))].sort();
  statusOptions.evening = [...new Set(rows.slice(1).map(r => r[C.EVENING]).filter(Boolean))].sort();

  if (currentTask) {
    const updated = cachedTasks.find(t => t.rowIndex === currentTask.rowIndex);
    if (updated) {
      if ($('#view-detail').classList.contains('active')) {
        await openDetail(updated);
      } else {
        currentTask = { row: [...updated.row], rowIndex: updated.rowIndex };
      }
    }
  }

  renderTasks(tasks, tab);
  if ($('#view-sheets').classList.contains('active')) {
    showView('tasks');
  }
  
  // Load dropdown options if not loaded
  if (Object.keys(dropdownOptions).length === 0) {
    loadDropdownOptions();
  }
}

async function refreshTasks() {
  if (!selectedTab) return;
  await openSheet(selectedTab);
  toast('Refreshed', 'success');
}

// ═══════════════════════════════════════════════════════
//  Task Dashboard
// ═══════════════════════════════════════════════════════
function renderTasks(tasks, tab) {
  $('#tasks-header-name').textContent = config.userName;
  $('#tasks-header-date').textContent = tab;
  const box = $('#tasks-list');
  box.innerHTML = '';

  if (!tasks.length) {
    box.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2"/>
        <path d="M16 30c2 3 5 5 8 5s6-2 8-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <circle cx="18" cy="20" r="2" fill="currentColor"/><circle cx="30" cy="20" r="2" fill="currentColor"/>
      </svg><p>No tasks found for you on this sheet.</p></div>`;
    return;
  }

  tasks.forEach(({ row, rowIndex }) => {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.ri = rowIndex;
    if (currentTimer?.status !== 'idle' && currentTimer?.taskRow === rowIndex) card.classList.add('active-task');

    const isThisActive = currentTimer?.status !== 'idle' && currentTimer?.taskRow === rowIndex;
    const isRunning = isThisActive && currentTimer?.status === 'running';
    const isPaused = isThisActive && currentTimer?.status === 'paused';

    let actionButtonsHtml = '';
    if (isThisActive) {
      if (isRunning) {
        actionButtonsHtml = `
          <button class="btn-card-action pause" data-action="pause" title="Pause Timer">
            <svg width="10" height="10" viewBox="0 0 24 24"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          </button>
          <button class="btn-card-action add" data-action="add" title="Submit Time">
            <svg width="10" height="10" viewBox="0 0 24 24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          </button>
        `;
      } else if (isPaused) {
        actionButtonsHtml = `
          <button class="btn-card-action resume" data-action="resume" title="Resume Timer">
            <svg width="10" height="10" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
          </button>
          <button class="btn-card-action stop" data-action="stop" title="Discard Timer">
            <svg width="10" height="10" viewBox="0 0 24 24"><path fill="currentColor" d="M6 19h12V5H6v14z"/></svg>
          </button>
          <button class="btn-card-action add" data-action="add" title="Submit Time">
            <svg width="10" height="10" viewBox="0 0 24 24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          </button>
        `;
      }
    } else {
      actionButtonsHtml = `
        <button class="btn-card-action start" data-action="start" title="Start Timer">
          <svg width="10" height="10" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
        </button>
      `;
    }

    card.innerHTML = `
      <div class="task-card-top">
        <span class="project-badge">${row[C.PROJECT] || '—'}</span>
        <div class="card-controls-wrap">
          <span class="task-spent">${parseTimeMins(row[C.SPENT])}m</span>
          <div class="card-actions">
            ${actionButtonsHtml}
          </div>
        </div>
      </div>
      <div class="task-card-title">${row[C.JIRA] || 'Untitled Task'}</div>
      <div class="task-card-bottom">
        <span class="task-type">${row[C.TYPE] || ''}</span>
        <div class="task-statuses">
          ${row[C.MORNING] ? `<span class="status-chip status-${statusClass(row[C.MORNING])}">${row[C.MORNING]}</span>` : ''}
          ${row[C.EVENING] ? `<span class="status-chip status-${statusClass(row[C.EVENING])}">${row[C.EVENING]}</span>` : ''}
        </div>
      </div>`;
      
    card.onclick = () => openDetail({ row, rowIndex });
    
    // Bind inline action events
    const actionsWrap = card.querySelector('.card-actions');
    if (actionsWrap) {
      actionsWrap.onclick = async (e) => {
        const btn = e.target.closest('.btn-card-action');
        if (!btn) return;
        e.stopPropagation();
        
        const action = btn.dataset.action;
        if (action === 'start') {
          showLoading(true);
          await sendMsg({
            type: 'START_TIMER',
            taskInfo: {
              rowIndex:     rowIndex,
              sheetTab:     selectedTab,
              projectCode:  row[C.PROJECT] || '',
              taskType:     row[C.TYPE]    || '',
              jiraTitle:    row[C.JIRA]    || '',
              allocatedTime:row[C.ALLOC]   || '0',
              todaysSpent:  row[C.SPENT]   || '0',
              morningStatus:row[C.MORNING] || '',
              eveningStatus:row[C.EVENING] || '',
            },
          });
          showLoading(false);
        } else if (action === 'pause') {
          await sendMsg({ type: 'PAUSE_TIMER' });
        } else if (action === 'resume') {
          await sendMsg({ type: 'RESUME_TIMER' });
        } else if (action === 'stop') {
          if (confirm('Stop timer? Un-submitted time will be lost.')) {
            await sendMsg({ type: 'STOP_TIMER' });
          }
        } else if (action === 'add') {
          showLoading(true);
          const r = await sendMsg({ type: 'ADD_TIME_DATA' });
          showLoading(false);
          if (r?.success) {
            toast(`Added ${r.trackedMinutes} min → Total: ${r.newTotal} min`, 'success');
            await refreshTasks();
          } else {
            toast(r?.error || 'Failed', 'error');
          }
        }
        pollTimer();
      };
    }
    
    box.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════
//  Task Detail (All Columns)
// ═══════════════════════════════════════════════════════
async function openDetail({ row, rowIndex }) {
  currentTask = { row: [...row], rowIndex };
  const tabDropdowns = getDropdownsForTab(selectedTab);

  $('#detail-project').textContent    = row[C.PROJECT]  || '—';
  $('#detail-jira').textContent       = row[C.JIRA]     || 'Untitled';
  $('#detail-task-type').textContent  = row[C.TYPE]     || '—';
  $('#detail-priority').textContent   = row[C.PRIORITY] || '—';
  $('#detail-target-date').textContent= row[C.TARGET]   || '—';
  $('#detail-date-start').textContent = row[C.START]    || '—';
  $('#detail-due-time').textContent   = row[C.DUE_TIME] || '—';

  const currentAlloc = row[C.ALLOC] || '';
  populateSelectWithOptions('#detail-allocated-input', tabDropdowns[C.ALLOC] || DEFAULT_ALLOCATED_TIMES, '— None —', currentAlloc);

  $('#detail-spent-input').value      = parseTimeMins(row[C.SPENT]) || '';
  $('#detail-week-total').textContent = row[C.WEEK]     || '—';
  $('#detail-extra-mins').textContent = row[C.EXTRA]    || '—';
  $('#detail-completion-pct').textContent = row[C.COMPLETION_PCT] || '—';
  $('#detail-auto-code').textContent  = row[C.AUTO]     || '—';
  // Populate status & total selects from data validations or fallback to collected values
  const morningOpts = tabDropdowns[C.MORNING] || statusOptions.morning;
  const eveningOpts = tabDropdowns[C.EVENING] || statusOptions.evening;
  const totalOpts = tabDropdowns[C.TOTAL] || ['30 min', '1 hr', '1 hr & 30 min', '2 hr', '2 hr & 30 min', '3 hrs', '3 hr & 30 min', '4 hr', '10 min', '45 min', '5h', '15 min', '6 hr 30 min', '7 hr 30 min', '40 min', '20 min'];
  
  const initialTodaySpent = parseTimeMins(row[C.SPENT]) || 0;
  const initialTotalSpent = parseTimeMins(row[C.TOTAL]) || 0;
  recentTotalSpent = Math.max(0, initialTotalSpent - initialTodaySpent);

  fillSelect('#detail-morning-status', morningOpts, row[C.MORNING] || '');
  fillSelect('#detail-evening-status', eveningOpts, row[C.EVENING] || '');
  fillSelect('#detail-total-select', totalOpts, row[C.TOTAL] || '');

  // Load web URL for this task
  const taskKey = `${selectedTab}::${config.userName}::${row[C.PROJECT]}::${row[C.JIRA]}`;
  const urlResult = await sendMsg({ type: 'GET_TASK_URL', rowIndex, taskKey });
  if (urlResult?.taskUrl) {
    $('#detail-web-url').value = urlResult.taskUrl.url || '';
    $('#detail-url-enabled').checked = urlResult.taskUrl.enabled !== false;
  } else {
    $('#detail-web-url').value = '';
    $('#detail-url-enabled').checked = true;
  }

  await updateTimerUI();
  showView('detail');
}

function fillSelect(sel, opts, cur) {
  const el = $(sel);
  const all = [...new Set([...opts, cur].filter(Boolean))].sort();
  el.innerHTML = '<option value="">—</option>';
  all.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    if (v === cur) o.selected = true;
    el.appendChild(o);
  });
}

// ═══════════════════════════════════════════════════════
//  Save Status
// ═══════════════════════════════════════════════════════
async function doSaveStatus() {
  if (!currentTask) return;
  const morn = $('#detail-morning-status').value;
  const eve  = $('#detail-evening-status').value;
  const alloc = $('#detail-allocated-input').value || '';
  const spent = parseInt($('#detail-spent-input').value) || 0;

  showLoading(true);
  try {
    const tab = `'${selectedTab}'`;
    if (morn !== (currentTask.row[C.MORNING] || '')) {
      await sendMsg({ type: 'UPDATE_CELL', sheetId: config.sheetId, cellRef: `${tab}!${colLetter(C.MORNING)}${currentTask.rowIndex}`, value: morn });
      currentTask.row[C.MORNING] = morn;
    }
    if (eve !== (currentTask.row[C.EVENING] || '')) {
      await sendMsg({ type: 'UPDATE_CELL', sheetId: config.sheetId, cellRef: `${tab}!${colLetter(C.EVENING)}${currentTask.rowIndex}`, value: eve });
      currentTask.row[C.EVENING] = eve;
    }
    const prevAlloc = currentTask.row[C.ALLOC] || '';
    if (alloc !== prevAlloc) {
      await sendMsg({ type: 'UPDATE_CELL', sheetId: config.sheetId, cellRef: `${tab}!${colLetter(C.ALLOC)}${currentTask.rowIndex}`, value: alloc });
      currentTask.row[C.ALLOC] = String(alloc);
    }
    if (spent !== parseTimeMins(currentTask.row[C.SPENT])) {
      await sendMsg({ type: 'UPDATE_CELL', sheetId: config.sheetId, cellRef: `${tab}!${colLetter(C.SPENT)}${currentTask.rowIndex}`, value: spent });
      currentTask.row[C.SPENT] = String(spent);
      
      // If the edited task is currently active, sync the spent time to the background timer
      if (currentTimer && currentTimer.status !== 'idle' && currentTimer.taskRow === currentTask.rowIndex) {
        currentTimer.taskInfo.alreadySpentMins = spent;
        currentTimer.startTs = Date.now();
        currentTimer.accMs = 0;
        await sendMsg({
          type: 'UPDATE_TIMER_STATE_INFO',
          taskInfo: currentTimer.taskInfo,
          startTs: currentTimer.startTs,
          accMs: currentTimer.accMs
        });
      }
    }
    const totalVal = $('#detail-total-select').value;
    if (totalVal !== (currentTask.row[C.TOTAL] || '')) {
      await sendMsg({ type: 'UPDATE_CELL', sheetId: config.sheetId, cellRef: `${tab}!${colLetter(C.TOTAL)}${currentTask.rowIndex}`, value: totalVal });
      currentTask.row[C.TOTAL] = totalVal;
    }
    toast('Changes saved!', 'success');
  } catch (e) { toast(e.message, 'error'); }
  showLoading(false);
}

// ═══════════════════════════════════════════════════════
//  Save Web URL
// ═══════════════════════════════════════════════════════
async function doSaveUrl() {
  if (!currentTask) return;
  const url = $('#detail-web-url').value.trim();
  const enabled = $('#detail-url-enabled').checked;
  
  showLoading(true);
  const taskKey = `${selectedTab}::${config.userName}::${currentTask.row[C.PROJECT]}::${currentTask.row[C.JIRA]}`;
  const r = await sendMsg({
    type: 'SET_TASK_URL',
    rowIndex: currentTask.rowIndex,
    taskKey: taskKey,
    url: url,
    enabled: enabled,
    taskInfo: {
      userName: config.userName,
      sheetTab: selectedTab,
      projectCode: currentTask.row[C.PROJECT] || '',
      taskType: currentTask.row[C.TYPE] || '',
      jiraTitle: currentTask.row[C.JIRA] || '',
      allocatedTime: currentTask.row[C.ALLOC] || '0',
      todaysSpent: currentTask.row[C.SPENT] || '0',
      morningStatus: currentTask.row[C.MORNING] || '',
      eveningStatus: currentTask.row[C.EVENING] || '',
    }
  });
  showLoading(false);
  
  if (r?.success) {
    toast(url ? 'URL saved! Auto-track active.' : 'URL removed.', 'success');
  } else {
    toast(r?.error || 'Failed', 'error');
  }
}

// ═══════════════════════════════════════════════════════
//  Timer Controls
// ═══════════════════════════════════════════════════════
async function doTimerStart() {
  if (!currentTask) return;
  const r = await sendMsg({
    type: 'START_TIMER',
    taskInfo: {
      rowIndex:     currentTask.rowIndex,
      sheetTab:     selectedTab,
      projectCode:  currentTask.row[C.PROJECT] || '',
      taskType:     currentTask.row[C.TYPE]    || '',
      jiraTitle:    currentTask.row[C.JIRA]    || '',
      allocatedTime:currentTask.row[C.ALLOC]   || '0',
      todaysSpent:  currentTask.row[C.SPENT]   || '0',
      morningStatus:currentTask.row[C.MORNING] || '',
      eveningStatus:currentTask.row[C.EVENING] || '',
    },
  });
  if (r?.success) { toast('Timer started!', 'success'); pollTimer(); }
  else toast('Failed to start', 'error');
}

async function doTimerPause()  { await sendMsg({ type: 'PAUSE_TIMER' });  pollTimer(); }
async function doTimerResume() {
  if (currentTimer && currentTimer.taskRow === currentTask.rowIndex) {
    await sendMsg({ type: 'RESUME_TIMER' });
  } else {
    // Treat as starting the task anew (which will auto-resume in startTimer using prevAccMs)
    await doTimerStart();
  }
  pollTimer();
}

async function doTimerStop() {
  if (!confirm('Stop timer? Un-added time will be lost.')) return;
  if (currentTimer && currentTimer.taskRow === currentTask.rowIndex) {
    await sendMsg({ type: 'STOP_TIMER' });
  } else {
    // Clear this specific task's accumulated paused time
    await sendMsg({ type: 'CLEAR_TASK_ACC_TIME', sheetTab: selectedTab, rowIndex: currentTask.rowIndex });
  }
  pollTimer();
  toast('Timer stopped', 'info');
}

async function doTimerAdd() {
  showLoading(true);
  let r;
  if (currentTimer && currentTimer.taskRow === currentTask.rowIndex) {
    r = await sendMsg({ type: 'ADD_TIME_DATA' });
  } else {
    // Read the task's accumulated paused time from local storage
    const d = await chrome.storage.local.get('taskAccumulatedTimes');
    const map = d.taskAccumulatedTimes || {};
    const taskKey = `${selectedTab}::${currentTask.rowIndex}`;
    const pausedMs = map[taskKey] || 0;
    
    r = await sendMsg({
      type: 'ADD_TIME_DATA',
      specificTask: {
        status: 'paused',
        taskRow: currentTask.rowIndex,
        sheetTab: selectedTab,
        taskInfo: {
          projectCode: currentTask.row[C.PROJECT] || '',
          taskType: currentTask.row[C.TYPE] || '',
          jiraTitle: currentTask.row[C.JIRA] || '',
          allocatedTime: currentTask.row[C.ALLOC] || '0',
          todaysSpent: currentTask.row[C.SPENT] || '0',
          morningStatus: currentTask.row[C.MORNING] || '',
          eveningStatus: currentTask.row[C.EVENING] || '',
        },
        accMs: pausedMs
      }
    });
  }
  showLoading(false);
  if (r?.success) {
    toast(`Added ${r.trackedMinutes} min → Total: ${r.newTotal} min`, 'success');
    pollTimer();
    if (selectedTab) await refreshTasks();
  } else toast(r?.error || 'Failed', 'error');
}

// ═══════════════════════════════════════════════════════
//  Timer Display
// ═══════════════════════════════════════════════════════
async function pollTimer() {
  const r = await sendMsg({ type: 'GET_TIMER_STATE' });
  if (r) onTimerUpdate(r.timerState, r.elapsed);
}

function onTimerUpdate(state, elapsedMs) {
  const prevStatus = currentTimer?.status;
  currentTimer = state;
  if (timerTick) { clearInterval(timerTick); timerTick = null; }

  // If timer transitioned to idle, refresh tasks to sync sheet values (e.g. total spent)
  if (state.status === 'idle' && prevStatus && prevStatus !== 'idle') {
    if (selectedTab) {
      refreshTasks();
    }
  }

  // Sync statuses with cache and UI if active
  if (state.status !== 'idle' && state.taskInfo) {
    const task = cachedTasks.find(t => t.rowIndex === state.taskRow);
    let changed = false;
    if (task) {
      const stateAllocStr = String(state.taskInfo.allocatedMins);
      const stateSpentStr = String(state.taskInfo.alreadySpentMins);
      if (task.row[C.MORNING] !== state.taskInfo.morningStatus || task.row[C.EVENING] !== state.taskInfo.eveningStatus ||
          task.row[C.ALLOC] !== stateAllocStr || task.row[C.SPENT] !== stateSpentStr) {
        task.row[C.MORNING] = state.taskInfo.morningStatus;
        task.row[C.EVENING] = state.taskInfo.eveningStatus;
        task.row[C.ALLOC] = stateAllocStr;
        task.row[C.SPENT] = stateSpentStr;
        changed = true;
      }
    }
    if (currentTask && currentTask.rowIndex === state.taskRow) {
      currentTask.row[C.MORNING] = state.taskInfo.morningStatus;
      currentTask.row[C.EVENING] = state.taskInfo.eveningStatus;
      currentTask.row[C.ALLOC] = String(state.taskInfo.allocatedMins);
      currentTask.row[C.SPENT] = String(state.taskInfo.alreadySpentMins);
      
      const mornSel = $('#detail-morning-status');
      const eveSel = $('#detail-evening-status');
      if (mornSel) mornSel.value = state.taskInfo.morningStatus || '';
      if (eveSel) eveSel.value = state.taskInfo.eveningStatus || '';

      const allocInput = $('#detail-allocated-input');
      const spentInput = $('#detail-spent-input');
      if (allocInput && document.activeElement !== allocInput) allocInput.value = state.taskInfo.allocatedMins || '';
      if (spentInput && document.activeElement !== spentInput) spentInput.value = state.taskInfo.alreadySpentMins || '';
    }
    if (changed && $('#view-tasks').classList.contains('active')) {
      renderTasks(cachedTasks, selectedTab);
    }
  }

  // ── Banner ──
  const banner = $('#timer-banner');
  if (state.status !== 'idle') {
    banner.classList.remove('hidden');
    $('#tb-task').textContent = `${state.taskInfo?.projectCode || ''} — ${state.taskInfo?.jiraTitle || 'Task'}`;

    if (state.status === 'running') {
      banner.classList.add('timer-running');
      banner.classList.remove('timer-paused');
      const st = state.startTs || Date.now(), acc = state.accMs || 0;
      const tick = () => {
        const e = acc + (Date.now() - st);
        $('#tb-time').textContent = fmtTime(e);
        if (currentTask && state.taskRow === currentTask.rowIndex) {
          $('#detail-timer-display').textContent = fmtTime(e);
        }
      };
      tick();
      timerTick = setInterval(tick, 1000);
    } else {
      banner.classList.remove('timer-running');
      banner.classList.add('timer-paused');
      const t = fmtTime(state.accMs || 0);
      $('#tb-time').textContent = t;
      if (currentTask && state.taskRow === currentTask.rowIndex) {
        $('#detail-timer-display').textContent = t;
      }
    }
  } else {
    banner.classList.add('hidden');
    banner.classList.remove('timer-running', 'timer-paused');
  }

  updateTimerUI();

  // Highlight active task card
  $$('.task-card').forEach(c => {
    c.classList.toggle('active-task', state.status !== 'idle' && Number(c.dataset.ri) === state.taskRow);
  });
}

async function updateTimerUI() {
  if (!currentTask) { showBtns('start'); return; }
  
  // Read the task's accumulated paused time from local storage
  const d = await chrome.storage.local.get('taskAccumulatedTimes');
  const map = d.taskAccumulatedTimes || {};
  const taskKey = `${selectedTab}::${currentTask.rowIndex}`;
  const pausedMs = map[taskKey] || 0;

  if (!currentTimer || currentTimer.status === 'idle') {
    if (pausedMs > 0) {
      showBtns('paused');
      $('#detail-timer-display').textContent = fmtTime(pausedMs);
      $('#detail-timer-display').className = 'timer-display mono paused';
    } else {
      showBtns('start');
      $('#detail-timer-display').textContent = '00:00:00';
      $('#detail-timer-display').className = 'timer-display mono';
    }
    return;
  }
  
  const mine = currentTimer.taskRow === currentTask.rowIndex;
  if (!mine) { 
    if (pausedMs > 0) {
      showBtns('paused');
      $('#detail-timer-display').textContent = fmtTime(pausedMs);
      $('#detail-timer-display').className = 'timer-display mono paused';
    } else {
      showBtns('start');
      $('#detail-timer-display').textContent = '00:00:00';
      $('#detail-timer-display').className = 'timer-display mono';
    }
    return;
  }

  if (currentTimer.status === 'running') {
    showBtns('running');
    $('#detail-timer-display').className = 'timer-display mono running';
  } else {
    showBtns('paused');
    $('#detail-timer-display').className = 'timer-display mono paused';
  }
}

function showBtns(mode) {
  const ids = ['start','pause','resume','stop','add'];
  ids.forEach(id => $(`#btn-timer-${id}`).classList.add('hidden'));
  switch (mode) {
    case 'start':   $('#btn-timer-start').classList.remove('hidden'); break;
    case 'running': ['pause','stop','add'].forEach(id => $(`#btn-timer-${id}`).classList.remove('hidden')); break;
    case 'paused':  ['resume','stop','add'].forEach(id => $(`#btn-timer-${id}`).classList.remove('hidden')); break;
  }
}

// ═══════════════════════════════════════════════════════
//  Settings
// ═══════════════════════════════════════════════════════
async function updateSettings() {
  $('#settings-sheet-id').textContent = config.sheetId || '—';
  $('#settings-user-name').textContent = config.userName || '—';
  sendMsg({ type: 'CHECK_AUTH' }).then(r => {
    $('#settings-email').textContent = r?.email || '—';
  });
  
  // Pet settings
  const petResult = await sendMsg({ type: 'GET_PET_SETTINGS' });
  if (petResult?.petSettings) {
    $('#settings-pet-enabled').checked = petResult.petSettings.enabled !== false;
  }
  
  // Admin settings
  $('#settings-admin-enabled').checked = config.adminMode === true;
  
  // Load global reminders
  loadGlobalReminders();
}

// ═══════════════════════════════════════════════════════
//  Global Reminders
// ═══════════════════════════════════════════════════════
async function loadGlobalReminders() {
  const container = $('#global-reminder-list');
  container.innerHTML = '<div style="color:var(--text-3); font-size:11px; text-align:center;">Loading...</div>';
  
  const r = await sendMsg({ type: 'GET_REMINDERS', scope: 'global' });
  if (r?.error) {
    container.innerHTML = '<div style="color:var(--red); font-size:11px; text-align:center;">Failed to load.</div>';
    return;
  }

  const list = (r.reminders || []).filter(rem => !rem.isFired);
  container.innerHTML = '';
  if (list.length === 0) {
    container.innerHTML = '<div style="color:var(--text-3); font-size:11px; text-align:center; padding: 4px;">No active reminders.</div>';
    return;
  }

  list.forEach(rem => {
    const remainingMs = rem.triggerTs - Date.now();
    const remainingMins = Math.max(0, Math.round(remainingMs / 60000));
    
    const item = document.createElement('div');
    item.className = 'reminder-item';
    item.innerHTML = `
      <span class="reminder-item-text" title="${rem.text}">${rem.text}</span>
      <span class="reminder-item-time">${remainingMins}m left</span>
      <button class="btn-delete-reminder" data-id="${rem.id}" title="Delete Reminder">
        <svg width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
      </button>
    `;
    item.querySelector('.btn-delete-reminder').onclick = async () => {
      showLoading(true);
      await sendMsg({ type: 'DELETE_REMINDER', id: rem.id });
      showLoading(false);
      loadGlobalReminders();
    };
    container.appendChild(item);
  });
}

function parseReminderTimeToTs(val) {
  const cleaned = val.trim().toLowerCase();
  const relativeMins = parseInt(cleaned);
  if (!isNaN(relativeMins) && String(relativeMins) === cleaned) {
    return { relative: true, minutes: relativeMins };
  }
  const match = cleaned.match(/^(\d+)(?::(\d+))?\s*(am|pm)?$/);
  if (match) {
    let hours = parseInt(match[1]);
    let minutes = match[2] ? parseInt(match[2]) : 0;
    const ampm = match[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }
    return { relative: false, triggerTs: target.getTime(), targetTimeStr: target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
  }
  return null;
}

async function doAddGlobalReminder() {
  const text = $('#global-reminder-text').value.trim();
  const rawTime = $('#global-reminder-time').value.trim();
  
  if (!text) {
    toast('Please enter reminder text', 'error');
    return;
  }
  if (!rawTime) {
    toast('Please enter reminder time', 'error');
    return;
  }

  const parsed = parseReminderTimeToTs(rawTime);
  if (!parsed) {
    toast('Invalid time format. Use relative mins (e.g. 15) or exact time (e.g. 5pm)', 'error');
    return;
  }

  showLoading(true);
  const r = await sendMsg({
    type: 'ADD_REMINDER',
    scope: 'global',
    text: text,
    minutes: parsed.relative ? parsed.minutes : null,
    triggerTs: parsed.relative ? null : parsed.triggerTs
  });
  showLoading(false);

  if (r?.success) {
    toast('Reminder set!', 'success');
    $('#global-reminder-text').value = '';
    $('#global-reminder-time').value = '15';
    loadGlobalReminders();
  } else {
    toast(r?.error || 'Failed to set reminder', 'error');
  }
}

// ═══════════════════════════════════════════════════════
//  Open Google Sheet
// ═══════════════════════════════════════════════════════
async function doOpenSheet() {
  if (!config.sheetId) { toast('No sheet configured', 'error'); return; }
  await sendMsg({ type: 'OPEN_SHEET', sheetId: config.sheetId });
}

// ═══════════════════════════════════════════════════════
//  Add Task (with Dynamic Dropdowns)
// ═══════════════════════════════════════════════════════
function prepareAddTaskForm() {
  // Clear form
  $('#add-task-title').value = '';
  $('#add-task-url').value = '';
  
  const tabDropdowns = getDropdownsForTab(selectedTab);
  
  // Project Code dropdown
  populateSelect('#add-task-project', tabDropdowns[C.PROJECT] || [], '— Select —');
  
  // Task Type dropdown
  populateSelect('#add-task-type', tabDropdowns[C.TYPE] || ['Development', 'UI Design', 'QA / Testing', 'Meeting', 'Research', 'Documentation'], '— Select —');
  
  // Priority dropdown
  populateSelect('#add-task-priority', tabDropdowns[C.PRIORITY] || ['High', 'Medium', 'Low'], '— Select —');
  
  // Allocated Time dropdown (Optional)
  populateSelectWithOptions('#add-task-allocated', tabDropdowns[C.ALLOC] || DEFAULT_ALLOCATED_TIMES, '— Select (Optional) —', '');
}

function populateSelect(selector, options, placeholder) {
  const el = $(selector);
  el.innerHTML = `<option value="">${placeholder}</option>`;
  options.forEach(v => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    el.appendChild(o);
  });
}

function populateSelectWithOptions(selector, options, placeholder, currentValue) {
  const el = $(selector);
  if (!el) return;
  el.innerHTML = `<option value="">${placeholder}</option>`;
  
  const uniqueOpts = new Set(options.map(String));
  if (currentValue && currentValue !== '0') {
    uniqueOpts.add(String(currentValue));
  }
  
  const sortedOpts = Array.from(uniqueOpts).sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  sortedOpts.forEach(v => {
    const o = document.createElement('option');
    o.value = v;
    let label = v;
    if (!isNaN(parseInt(v)) && !String(v).toLowerCase().includes('min')) {
      label = `${v} mins`;
    }
    o.textContent = label;
    if (String(currentValue) === v) {
      o.selected = true;
    }
    el.appendChild(o);
  });
}

async function doAddTask() {
  const proj = $('#add-task-project').value.trim();
  const title = $('#add-task-title').value.trim();
  const type = $('#add-task-type').value;
  const prio = $('#add-task-priority').value;
  const alloc = $('#add-task-allocated').value || '';
  const url = $('#add-task-url').value.trim();

  if (!proj) { toast('Please select Project Code', 'error'); return; }
  if (!title) { toast('Please enter Task Title', 'error'); return; }

  showLoading(true);
  const r = await sendMsg({
    type: 'ADD_TASK',
    sheetId: config.sheetId,
    tabName: selectedTab,
    taskData: {
      project: proj,
      title: title,
      type: type,
      priority: prio,
      allocated: alloc
    }
  });
  showLoading(false);

  if (r?.success) {
    toast('Task created!', 'success');
    
    // If URL provided, save it for auto-tracking
    if (url) {
      // We need to find the new row index by refreshing
      await refreshTasks();
      // Find the newly added task
      const newTask = cachedTasks.find(t => t.row[C.JIRA] === title);
      if (newTask) {
        const taskKey = `${selectedTab}::${config.userName}::${proj}::${title}`;
        await sendMsg({
          type: 'SET_TASK_URL',
          rowIndex: newTask.rowIndex,
          taskKey: taskKey,
          url: url,
          enabled: true,
          taskInfo: {
            userName: config.userName,
            sheetTab: selectedTab,
            projectCode: proj,
            taskType: type,
            jiraTitle: title,
            allocatedTime: String(alloc),
            todaysSpent: '0',
            morningStatus: '',
            eveningStatus: '',
          }
        });
      }
    }
    
    showView('tasks');
    await refreshTasks();
  } else {
    toast(r?.error || 'Failed to create task', 'error');
  }
}

// Periodic sync (every 30 s while popup is open)
setInterval(pollTimer, 30000);

// ═══════════════════════════════════════════════════════
//  Admin Dashboard
// ═══════════════════════════════════════════════════════
async function openAdminDashboard() {
  const activeView = Array.from($$('.view')).find(v => v.classList.contains('active'));
  if (activeView) {
    adminDashboardOriginView = activeView.id.replace('view-', '');
  } else {
    adminDashboardOriginView = 'sheets';
  }

  document.body.style.width = '760px';
  showView('admin-dashboard');
  
  showLoading(true);
  const r = await sendMsg({ type: 'GET_SHEET_TABS', sheetId: config.sheetId });
  showLoading(false);
  if (r?.error) { toast(r.error, 'error'); return; }

  const sel = $('#admin-dashboard-sheet-select');
  sel.innerHTML = '';
  r.tabs.forEach(name => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    if (name === (selectedTab || r.tabs[0])) o.selected = true;
    sel.appendChild(o);
  });

  const activeTab = sel.value || r.tabs[0];
  loadAdminDashboardData(activeTab);
}

function closeAdminDashboard() {
  document.body.style.width = '380px';
  if (adminDashboardOriginView === 'tasks') {
    showView('tasks');
  } else {
    showView('sheets');
    loadSheets();
  }
}

async function loadAdminDashboardData(tabName) {
  showLoading(true);
  const r = await sendMsg({ type: 'GET_SHEET_DATA', sheetId: config.sheetId, range: tabName });
  showLoading(false);
  if (r?.error) { toast(r.error, 'error'); return; }

  const rows = r.rows || [];
  if (rows.length < 2) {
    $('#chart-progress').innerHTML = '<div style="color:var(--text-3); font-size:11px;">No data</div>';
    $('#chart-time-spent').innerHTML = '<div style="color:var(--text-3); font-size:11px;">No data</div>';
    $('#missing-time-table-body').innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-3);">No data found</td></tr>';
    return;
  }

  const userStats = {}; // name -> { completedTasks, totalTasks, spentMins, allocatedMins }
  const missingSpentRows = []; // { name, jira, project, morn, eve }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = row[C.NAME];
    if (!name) continue;

    if (!userStats[name]) {
      userStats[name] = { completedTasks: 0, totalTasks: 0, spentMins: 0, allocatedMins: 0 };
    }

    const totalSpent = parseTimeMins(row[C.SPENT]) || 0;
    const allocated = parseTimeMins(row[C.ALLOC]) || 0;
    const eveStatus = (row[C.EVENING] || '').trim().toLowerCase();

    userStats[name].totalTasks += 1;
    if (eveStatus === 'completed') {
      userStats[name].completedTasks += 1;
    }
    userStats[name].spentMins += totalSpent;
    userStats[name].allocatedMins += allocated;

    // Check if missing time spent (Column M is empty or 0)
    const todaySpentVal = row[C.SPENT];
    const isMissingSpent = todaySpentVal === undefined || todaySpentVal === null || String(todaySpentVal).trim() === '' || parseFloat(todaySpentVal) === 0;

    if (isMissingSpent) {
      missingSpentRows.push({
        name: name,
        jira: row[C.JIRA] || 'Untitled Task',
        project: row[C.PROJECT] || '—',
        morn: row[C.MORNING] || '—',
        eve: row[C.EVENING] || '—'
      });
    }
  }

  // 1. Render Progress Chart (Time Spent against 480 mins)
  const progressContainer = $('#chart-progress');
  progressContainer.innerHTML = '';
  Object.entries(userStats).forEach(([name, stats]) => {
    const pct = Math.min(100, Math.round((stats.spentMins / 480) * 100));
    const rowDiv = document.createElement('div');
    rowDiv.className = 'chart-row';
    rowDiv.innerHTML = `
      <div class="chart-label" title="${name}">${name}</div>
      <div class="chart-bar-wrap">
        <div class="chart-bar progress-bar" style="width: ${pct}%;"></div>
      </div>
      <div class="chart-val">${stats.spentMins}m/480m (${pct}%)</div>
    `;
    progressContainer.appendChild(rowDiv);
  });

  // 2. Render Time Spent Chart
  const timeContainer = $('#chart-time-spent');
  timeContainer.innerHTML = '';
  const maxSpent = Math.max(...Object.values(userStats).map(s => s.spentMins), 1);
  Object.entries(userStats).forEach(([name, stats]) => {
    const barPct = Math.min(100, Math.round((stats.spentMins / maxSpent) * 100));
    const rowDiv = document.createElement('div');
    rowDiv.className = 'chart-row';
    rowDiv.innerHTML = `
      <div class="chart-label" title="${name}">${name}</div>
      <div class="chart-bar-wrap">
        <div class="chart-bar" style="width: ${barPct}%;"></div>
      </div>
      <div class="chart-val">${stats.spentMins}m</div>
    `;
    timeContainer.appendChild(rowDiv);
  });

  // 3. Render Missing Spent Rows Table
  const tableBody = $('#missing-time-table-body');
  tableBody.innerHTML = '';
  if (missingSpentRows.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--green);font-weight:600;padding:12px 0;">All users have added time spent!</td></tr>';
  } else {
    missingSpentRows.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight: 600; color: #f87171;">${row.name}</td>
        <td><span style="font-size:9px;font-weight:700;background:rgba(59,130,246,0.15);color:#60a5fa;padding:1px 4px;border-radius:3px;margin-right:4px;">${row.project}</span>${row.jira}</td>
        <td><span class="status-chip status-${statusClass(row.morn)}">${row.morn}</span></td>
        <td><span class="status-chip status-${statusClass(row.eve)}">${row.eve}</span></td>
      `;
      tableBody.appendChild(tr);
    });
  }
}
