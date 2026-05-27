// ============================================================
// TimeTracker — Background Service Worker  (Manifest V3) v2.0
// ============================================================
// Central hub: timer engine · Sheets API · message router
// All state persisted in chrome.storage (service workers sleep!)
// ============================================================

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

// ─── Column Mapping (0-indexed) ─────────────────────────────
// Adjust if your sheet layout differs.
const COL = {
  PROJECT_CODE:   0,   // A
  TASK_AUTO_CODE: 1,   // B
  NAME:           2,   // C
  TASK_TYPE:      3,   // D
  JIRA_TITLE:     4,   // E
  PRIORITY:       5,   // F
  MORNING_STATUS: 6,   // G
  EVENING_STATUS: 7,   // H
  TARGET_DATE:    8,   // I
  DATE_START:     9,   // J
  DUE_TIME:      10,   // K
  ALLOCATED_TIME:11,   // L
  TODAYS_SPENT:  12,   // M
  TOTAL_MINS:    13,   // N
  TOTAL_WEEK:    14,   // O
  EXTRA_MINS:    15,   // P
  COMPLETION_PCT:16,   // Q
};

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const TIMER_ALARM = 'tt-timer-tick';
const REMINDER_ALARM = 'tt-reminder-check';
const DAILY_5PM_ALARM = 'tt-daily-5pm';

// ═══════════════════════════════════════════════════════════
//  Authentication
// ═══════════════════════════════════════════════════════════
async function getAuthToken(interactive = false) {
  // Check if we have a valid cached token in storage
  const cached = await chrome.storage.local.get(['oauthToken', 'oauthTokenExpiry']);
  if (cached.oauthToken && cached.oauthTokenExpiry && cached.oauthTokenExpiry > Date.now() + 300000) {
    return cached.oauthToken;
  }

  // Helper to save token to local cache
  const cacheToken = async (token) => {
    const expiry = Date.now() + 3600 * 1000; // Access tokens expire in 1 hour
    await chrome.storage.local.set({ oauthToken: token, oauthTokenExpiry: expiry });
    return token;
  };

  // Try native chrome.identity.getAuthToken first (seamless in Google Chrome)
  try {
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (t) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(t);
        }
      });
    });
    if (token) {
      return await cacheToken(token);
    }
  } catch (e) {
    console.log("Native getAuthToken failed, trying launchWebAuthFlow fallback:", e.message);
  }

  // Fallback to launchWebAuthFlow (works on Edge, Brave, other profiles)
  try {
    const manifest = chrome.runtime.getManifest();
    const clientId = manifest.oauth2.client_id;
    const scopes = manifest.oauth2.scopes;
    const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
    
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth` +
                    `?client_id=${clientId}` +
                    `&response_type=token` +
                    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                    `&scope=${encodeURIComponent(scopes.join(' '))}`;
                    
    const redirectUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: interactive
      }, (url) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(url);
        }
      });
    });

    if (redirectUrl) {
      const params = new URLSearchParams(new URL(redirectUrl).hash.substring(1));
      const token = params.get('access_token');
      if (token) {
        return await cacheToken(token);
      }
    }
  } catch (e) {
    console.error("launchWebAuthFlow failed:", e.message);
    throw e;
  }

  throw new Error("Authorization failed");
}

function getUserEmail() {
  return new Promise((resolve) => {
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
      resolve(info?.email || '');
    });
  });
}

async function signOut() {
  try {
    const token = await getAuthToken(false).catch(() => null);
    if (token) {
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
      await new Promise(r => chrome.identity.removeCachedAuthToken({ token }, r));
    }
  } catch (_) { /* ignore */ }
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
}

// ═══════════════════════════════════════════════════════════
//  Google Sheets API
// ═══════════════════════════════════════════════════════════
async function sheetsApi(url, opts = {}) {
  const token = await getAuthToken(true);
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchSheetTabs(sheetId) {
  const data = await sheetsApi(`${SHEETS_BASE}/${sheetId}?fields=sheets.properties.title`);
  return data.sheets.map(s => s.properties.title);
}

async function fetchSheetData(sheetId, range) {
  const data = await sheetsApi(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}`
  );
  return data.values || [];
}

async function writeCell(sheetId, cellRef, value) {
  return sheetsApi(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(cellRef)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      body: JSON.stringify({ range: cellRef, majorDimension: 'ROWS', values: [[value]] }),
    }
  );
}

/** 0-indexed column number → letter (0=A, 25=Z, 26=AA …) */
function colLetter(n) {
  let s = '';
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

// ═══════════════════════════════════════════════════════════
//  Data Validations (Dropdown Fetcher)
// ═══════════════════════════════════════════════════════════
async function fetchDataValidations(sheetId) {
  try {
    const data = await sheetsApi(
      `${SHEETS_BASE}/${sheetId}?fields=sheets(properties(sheetId,title),data(rowData(values(dataValidation))))`
    );

    const result = {};

    for (const sheet of (data.sheets || [])) {
      const title = sheet.properties?.title || '';
      const sheetDropdowns = {};

      const gridData = sheet.data || [];
      for (const grid of gridData) {
        const rows = grid.rowData || [];
        for (const row of rows) {
          const cells = row.values || [];
          for (let colIdx = 0; colIdx < cells.length; colIdx++) {
            const dv = cells[colIdx]?.dataValidation;
            if (!dv || !dv.condition) continue;

            const condType = dv.condition.type;
            if (condType === 'ONE_OF_LIST') {
              const vals = (dv.condition.values || []).map(v => v.userEnteredValue).filter(Boolean);
              if (vals.length > 0 && !sheetDropdowns[colIdx]) {
                sheetDropdowns[colIdx] = vals;
              }
            } else if (condType === 'ONE_OF_RANGE') {
              // Range-based dropdown, e.g. "='Sheet2'!$A$1:$A$10"
              const rangeFormula = dv.condition.values?.[0]?.userEnteredValue;
              if (rangeFormula && !sheetDropdowns[colIdx]) {
                try {
                  // Clean formula: remove leading = sign
                  const cleanRange = rangeFormula.replace(/^=/, '');
                  const rangeData = await fetchSheetData(sheetId, cleanRange);
                  const vals = rangeData.map(r => r[0]).filter(Boolean);
                  if (vals.length > 0) {
                    sheetDropdowns[colIdx] = vals;
                  }
                } catch (e) {
                  console.warn('Failed to resolve range dropdown:', e.message);
                }
              }
            }
          }
        }
      }

      result[title] = sheetDropdowns;
    }

    return result;
  } catch (e) {
    console.error('fetchDataValidations error:', e.message);
    return {};
  }
}

// ═══════════════════════════════════════════════════════════
//  Smart Row Insertion (Below User's Last Row)
// ═══════════════════════════════════════════════════════════
async function getSheetNumericId(spreadsheetId, tabName) {
  const data = await sheetsApi(
    `${SHEETS_BASE}/${spreadsheetId}?fields=sheets(properties(sheetId,title))`
  );
  const sheet = data.sheets.find(s => s.properties.title === tabName);
  return sheet ? sheet.properties.sheetId : 0;
}

async function insertTaskRow(sheetId, tabName, userName, values) {
  // 1. Fetch all rows to find user's last row
  const allRows = await fetchSheetData(sheetId, tabName);
  
  let lastUserRowIdx = -1; // 0-indexed in allRows array
  for (let i = 1; i < allRows.length; i++) { // Skip header row
    if (allRows[i][COL.NAME] === userName) {
      lastUserRowIdx = i;
    }
  }

  // If user has no rows, append at the end
  if (lastUserRowIdx === -1) {
    return appendSheetRow(sheetId, tabName, values);
  }

  // 2. Get numeric sheet ID for batchUpdate
  const numericSheetId = await getSheetNumericId(sheetId, tabName);
  
  // 3. Insert a row below user's last row (0-indexed for API)
  const insertIdx = lastUserRowIdx + 1; // 0-indexed position in sheet
  
  await sheetsApi(`${SHEETS_BASE}/${sheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        insertDimension: {
          range: {
            sheetId: numericSheetId,
            dimension: 'ROWS',
            startIndex: insertIdx,
            endIndex: insertIdx + 1
          },
          inheritFromBefore: true // Copy formatting & data validation from row above
        }
      }]
    })
  });

  // 4. Write values to the newly inserted row
  const sheetRow = insertIdx + 1; // Convert to 1-indexed for A1 notation
  const range = `'${tabName}'!A${sheetRow}:${colLetter(values.length - 1)}${sheetRow}`;
  
  await sheetsApi(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      body: JSON.stringify({
        range: range,
        majorDimension: 'ROWS',
        values: [values]
      })
    }
  );

  return { success: true };
}

async function appendSheetRow(sheetId, tabName, values) {
  return sheetsApi(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(tabName + '!A:A')}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      body: JSON.stringify({
        majorDimension: 'ROWS',
        range: `${tabName}!A:A`,
        values: [values]
      })
    }
  );
}

// ═══════════════════════════════════════════════════════════
//  Timer Engine
// ═══════════════════════════════════════════════════════════
async function getTimerState() {
  const d = await chrome.storage.session.get('timerState');
  return d.timerState || { status: 'idle' };
}
async function saveTimer(state) {
  await chrome.storage.session.set({ timerState: state });
}

async function getTaskAccumulatedTime(sheetTab, rowIndex) {
  const key = `${sheetTab}::${rowIndex}`;
  const d = await chrome.storage.local.get('taskAccumulatedTimes');
  const map = d.taskAccumulatedTimes || {};
  return map[key] || 0;
}

async function saveTaskAccumulatedTime(sheetTab, rowIndex, ms) {
  const key = `${sheetTab}::${rowIndex}`;
  const d = await chrome.storage.local.get('taskAccumulatedTimes');
  const map = d.taskAccumulatedTimes || {};
  map[key] = ms;
  await chrome.storage.local.set({ taskAccumulatedTimes: map });
}

async function clearTaskAccumulatedTime(sheetTab, rowIndex) {
  const key = `${sheetTab}::${rowIndex}`;
  const d = await chrome.storage.local.get('taskAccumulatedTimes');
  const map = d.taskAccumulatedTimes || {};
  delete map[key];
  await chrome.storage.local.set({ taskAccumulatedTimes: map });
}

function elapsed(s) {
  if (!s || s.status === 'idle') return 0;
  if (s.status === 'running') return (s.accMs || 0) + (Date.now() - (s.startTs || Date.now()));
  return s.accMs || 0;
}

async function startTimer(info) {
  // Enforce single-task: auto-pause running timer
  const cur = await getTimerState();
  if (cur.status === 'running') {
    if (cur.taskRow === info.rowIndex && cur.sheetTab === info.sheetTab) {
      // Already running correct task
      return { success: true };
    }
    cur.accMs = elapsed(cur);
    cur.startTs = null;
    cur.status = 'paused';
    await saveTaskAccumulatedTime(cur.sheetTab, cur.taskRow, cur.accMs);
    await saveTimer(cur);
  } else if (cur.status === 'paused') {
    await saveTaskAccumulatedTime(cur.sheetTab, cur.taskRow, cur.accMs);
  }

  // Load the matched task's previously accumulated time (if any)
  const prevAccMs = await getTaskAccumulatedTime(info.sheetTab, info.rowIndex);

  const state = {
    status: 'running',
    taskRow: info.rowIndex,
    sheetTab: info.sheetTab,
    taskInfo: { 
      projectCode: info.projectCode || '', 
      taskType: info.taskType || '', 
      jiraTitle: info.jiraTitle || '',
      allocatedMins: parseTimeMins(info.allocatedTime) || 0,
      alreadySpentMins: parseTimeMins(info.todaysSpent) || 0,
      morningStatus: info.morningStatus || '',
      eveningStatus: info.eveningStatus || ''
    },
    startTs: Date.now(),
    accMs: prevAccMs || 0,
  };
  await saveTimer(state);
  await chrome.alarms.create(TIMER_ALARM, { periodInMinutes: 0.5 });
  await broadcast(state);
  
  return { success: true };
}

async function pauseTimer() {
  const s = await getTimerState();
  if (s.status !== 'running') return { success: false };
  s.accMs = elapsed(s);
  s.startTs = null;
  s.status = 'paused';
  await saveTimer(s);
  await saveTaskAccumulatedTime(s.sheetTab, s.taskRow, s.accMs); // Ensure session map is synchronized
  await chrome.alarms.clear(TIMER_ALARM);
  await broadcast(s);
  return { success: true };
}

async function resumeTimer() {
  const s = await getTimerState();
  if (s.status !== 'paused') return { success: false };
  s.startTs = Date.now();
  s.status = 'running';
  await saveTimer(s);
  await chrome.alarms.create(TIMER_ALARM, { periodInMinutes: 0.5 });
  await broadcast(s);
  return { success: true };
}

async function stopTimer() {
  const s = await getTimerState();
  if (s && s.status !== 'idle') {
    await clearTaskAccumulatedTime(s.sheetTab, s.taskRow); // Clear accumulated time upon stop (discard)
  }
  await saveTimer({ status: 'idle' });
  await chrome.alarms.clear(TIMER_ALARM);
  await broadcast({ status: 'idle' });
  return { success: true };
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

async function addTimeData(specificTask = null) {
  const s = specificTask || await getTimerState();
  if (!s || s.status === 'idle') return { error: 'No active timer' };

  const ms = elapsed(s);
  const mins = Math.round(ms / 60000);
  if (mins < 1) return { error: 'Less than 1 minute tracked — keep going!' };

  try {
    const { config } = await chrome.storage.local.get('config');
    if (!config?.sheetId) return { error: 'Sheet not configured' };

    // Resolve row index dynamically in case rows shifted
    const resolvedRow = await findTaskRowIndex(
      config.sheetId,
      s.sheetTab,
      config.userName,
      s.taskInfo.projectCode,
      s.taskInfo.jiraTitle
    ) || s.taskRow;

    const todayLetter = colLetter(COL.TODAYS_SPENT);               // "M"
    const todayCell   = `'${s.sheetTab}'!${todayLetter}${resolvedRow}`;

    const totalLetter = colLetter(COL.TOTAL_MINS);                 // "N"
    const totalCell   = `'${s.sheetTab}'!${totalLetter}${resolvedRow}`;

    // Read both cells
    const todayVal = await fetchSheetData(config.sheetId, todayCell).then(r => r?.[0]?.[0]).catch(() => '0');
    const totalVal = await fetchSheetData(config.sheetId, totalCell).then(r => r?.[0]?.[0]).catch(() => '');

    const existingToday = parseTimeMins(todayVal) || 0;
    const existingTotal = parseTimeMins(totalVal) || 0;
    const recentTotal = Math.max(0, existingTotal - existingToday);

    const newToday = existingToday + mins;
    const newTotalMins = newToday + recentTotal;

    // Cumulative write-back to today's spent cell only
    await writeCell(config.sheetId, todayCell, newToday);

    // Clear the task-specific accumulated time since it has been pushed to Excel
    await clearTaskAccumulatedTime(s.sheetTab, s.taskRow);

    // Reset active timer only if we submitted the active timer
    if (!specificTask) {
      await saveTimer({ status: 'idle' });
      await chrome.alarms.clear(TIMER_ALARM);
      await broadcast({ status: 'idle' });
    }

    return { success: true, trackedMinutes: mins, existingMinutes: existingToday, newTotal: newToday, newTotalSpentStr: totalVal };
  } catch (e) {
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
//  Broadcasting to content scripts
// ═══════════════════════════════════════════════════════════
async function broadcast(state) {
  const { petSettings } = await chrome.storage.local.get('petSettings');
  const petEnabled = petSettings?.enabled !== false; // default true
  const msg = { type: 'TIMER_STATE_UPDATE', timerState: state, elapsed: elapsed(state), petEnabled };
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, msg).catch(() => {});
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
//  Reminders Storage & Check Engine (Global + Task)
// ═══════════════════════════════════════════════════════════
async function getReminders() {
  const d = await chrome.storage.local.get('reminders');
  return d.reminders || [];
}

async function saveReminders(list) {
  await chrome.storage.local.set({ reminders: list });
}

async function addReminder(text, minutes, scope = 'global', rowIndex = null, triggerTs = null) {
  const list = await getReminders();
  const computedTriggerTs = triggerTs || (Date.now() + (minutes * 60 * 1000));
  const newRem = {
    id: 'rem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    scope,        // 'global' or 'task'
    rowIndex,     // null for global reminders
    text,
    triggerTs: computedTriggerTs,
    isFired: false
  };
  list.push(newRem);
  await saveReminders(list);
  return { success: true, reminder: newRem };
}

async function deleteReminder(id) {
  const list = await getReminders();
  const filtered = list.filter(r => r.id !== id);
  await saveReminders(filtered);
  return { success: true };
}

async function checkReminders() {
  const list = await getReminders();
  const now = Date.now();
  let updated = false;

  for (const rem of list) {
    if (!rem.isFired && now >= rem.triggerTs) {
      rem.isFired = true;
      updated = true;
      await broadcastReminder(rem);
    }
  }

  if (updated) {
    const active = list.filter(r => !r.isFired);
    await saveReminders(active);
  }
}

async function broadcastReminder(rem) {
  try {
    const tabs = await chrome.tabs.query({});
    let sent = false;
    for (const t of tabs) {
      try {
        await chrome.tabs.sendMessage(t.id, {
          type: 'TRIGGER_REMINDER',
          reminder: rem
        });
        sent = true;
      } catch (_) {}
    }
    // Fallback: Chrome notification if no tab received
    if (!sent) {
      chrome.notifications.create(rem.id, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'TimeTracker Reminder',
        message: rem.text,
        priority: 2
      });
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
//  5 PM Daily Reminder
// ═══════════════════════════════════════════════════════════
function schedule5pmAlarm() {
  const now = new Date();
  let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0, 0, 0);
  
  // If 5 PM already passed today, schedule for tomorrow
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }
  
  const delayMs = target.getTime() - now.getTime();
  const delayMins = delayMs / 60000;
  
  chrome.alarms.create(DAILY_5PM_ALARM, {
    delayInMinutes: delayMins,
    periodInMinutes: 24 * 60 // Repeat every 24 hours
  });
}

async function handle5pmReminder() {
  const { petSettings } = await chrome.storage.local.get('petSettings');
  if (petSettings?.enabled === false) return; // Skip if pet is disabled
  
  const reminder = {
    id: 'daily_5pm_' + Date.now(),
    scope: 'global',
    rowIndex: null,
    text: '🔔 It\'s 5:00 PM — Have you updated your tasks today?',
    triggerTs: Date.now(),
    isFired: true
  };
  await broadcastReminder(reminder);
}

// ═══════════════════════════════════════════════════════════
//  Pet Settings
// ═══════════════════════════════════════════════════════════
async function getPetSettings() {
  const { petSettings } = await chrome.storage.local.get('petSettings');
  return petSettings || { enabled: true };
}

async function setPetSettings(settings) {
  const current = await getPetSettings();
  const updated = { ...current, ...settings };
  await chrome.storage.local.set({ petSettings: updated });
  
  // Broadcast setting change to all tabs
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, {
        type: 'PET_SETTINGS_CHANGED',
        petSettings: updated
      }).catch(() => {});
    }
  } catch (_) {}
  
  return updated;
}

// ═══════════════════════════════════════════════════════════
//  URL-based Auto Tracking
// ═══════════════════════════════════════════════════════════
async function getTaskUrls() {
  const { taskUrls } = await chrome.storage.local.get('taskUrls');
  return taskUrls || {};
}

async function setTaskUrl(key, url, enabled, taskInfo) {
  const all = await getTaskUrls();
  if (!url) {
    delete all[key];
  } else {
    all[key] = { url, enabled: enabled !== false, taskInfo };
  }
  await chrome.storage.local.set({ taskUrls: all });
  return { success: true };
}

// Find actual row index of a task by matching details, in case rows shifted
async function findTaskRowIndex(sheetId, tabName, userName, projectCode, jiraTitle) {
  try {
    const rows = await fetchSheetData(sheetId, tabName);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][COL.NAME] === userName &&
          rows[i][COL.PROJECT_CODE] === projectCode &&
          rows[i][COL.JIRA_TITLE] === jiraTitle) {
        return i + 1; // 1-based row index
      }
    }
  } catch (e) {
    console.warn('findTaskRowIndex failed:', e.message);
  }
  return null;
}

// Tab URL change listener for auto-tracking
async function syncAutoTracking() {
  try {
    const { config } = await chrome.storage.local.get('config');
    if (!config?.sheetId || !config?.userName) return;

    const taskUrls = await getTaskUrls();
    const currentTimer = await getTimerState();
    
    // Find active tab in last focused window
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url) return;

    let matchedKey = null;
    let matchedEntry = null;
    
    for (const [key, entry] of Object.entries(taskUrls)) {
      if (!entry.enabled || !entry.url) continue;
      const parts = key.split('::');
      const entryUser = entry.taskInfo?.userName || parts[1];
      if (entryUser && entryUser !== config.userName) continue; // Skip if URL belongs to another user
      if (tab.url.startsWith(entry.url)) {
        matchedKey = key;
        matchedEntry = entry;
        break;
      }
    }
    
    if (matchedKey !== null) {
      // Current tab matches a task URL!
      const resolvedRowIdx = await findTaskRowIndex(
        config.sheetId,
        matchedEntry.taskInfo.sheetTab,
        config.userName,
        matchedEntry.taskInfo.projectCode,
        matchedEntry.taskInfo.jiraTitle
      ) || parseInt(matchedKey.split('::')[3]) || currentTimer.taskRow; // fallback

      if (currentTimer.taskRow === resolvedRowIdx && currentTimer.sheetTab === matchedEntry.taskInfo.sheetTab) {
        if (currentTimer.status === 'running') {
          // Already running correct task
          return;
        } else if (currentTimer.status === 'paused') {
          // Resume paused task
          await resumeTimer();
          try {
            chrome.tabs.sendMessage(tab.id, {
              type: 'AUTO_TRACK_STARTED',
              taskName: matchedEntry.taskInfo.jiraTitle || 'Task'
            }).catch(() => {});
          } catch (_) {}
          return;
        }
      }

      if (currentTimer.status === 'running') {
        // Running a different task, pause current and start matched one
        await pauseTimer();
      }
      
      // Start the matched task
      if (matchedEntry.taskInfo) {
        await startTimer({
          rowIndex: resolvedRowIdx,
          sheetTab: matchedEntry.taskInfo.sheetTab,
          projectCode: matchedEntry.taskInfo.projectCode || '',
          taskType: matchedEntry.taskInfo.taskType || '',
          jiraTitle: matchedEntry.taskInfo.jiraTitle || '',
          allocatedTime: matchedEntry.taskInfo.allocatedTime || '0',
          todaysSpent: matchedEntry.taskInfo.todaysSpent || '0',
          morningStatus: matchedEntry.taskInfo.morningStatus || '',
          eveningStatus: matchedEntry.taskInfo.eveningStatus || '',
        });
        
        // Notify via pet bubble
        try {
          chrome.tabs.sendMessage(tab.id, {
            type: 'AUTO_TRACK_STARTED',
            taskName: matchedEntry.taskInfo.jiraTitle || 'Task'
          }).catch(() => {});
        } catch (_) {}
      }
    } else {
      // Active tab does NOT match any task URL.
      // If the currently running task has a URL configured and enabled, we must pause it because the user "went out".
      if (currentTimer.status === 'running') {
        let runningEntry = null;
        for (const [key, entry] of Object.entries(taskUrls)) {
          const parts = key.split('::');
          const entryUser = entry.taskInfo?.userName || parts[1];
          if (entryUser && entryUser !== config.userName) continue; // Skip other users
          if (entry.enabled && entry.url && entry.taskInfo && 
              entry.taskInfo.sheetTab === currentTimer.sheetTab &&
              entry.taskInfo.jiraTitle === currentTimer.taskInfo?.jiraTitle) {
            runningEntry = entry;
            break;
          }
        }
        
        if (runningEntry) {
          await pauseTimer();
          // Notify the tab that auto-tracking is paused
          try {
            chrome.tabs.sendMessage(tab.id, {
              type: 'AUTO_TRACK_PAUSED',
              taskName: runningEntry.taskInfo?.jiraTitle || 'Task'
            }).catch(() => {});
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    console.error('syncAutoTracking error:', e.message);
  }
}

chrome.tabs.onActivated.addListener(syncAutoTracking);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    syncAutoTracking();
  }
});
chrome.tabs.onRemoved.addListener(syncAutoTracking);
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    syncAutoTracking();
  }
});

// ═══════════════════════════════════════════════════════════
//  Add Task (Smart insertion)
// ═══════════════════════════════════════════════════════════
async function addTask(sheetId, tabName, taskData) {
  try {
    const { config } = await chrome.storage.local.get('config');
    const userName = config?.userName || 'Unknown';
    const dateStart = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    const row = [];
    row[COL.PROJECT_CODE] = taskData.project;
    row[COL.TASK_AUTO_CODE] = '';
    row[COL.NAME] = userName;
    row[COL.TASK_TYPE] = taskData.type;
    row[COL.JIRA_TITLE] = taskData.title;
    row[COL.PRIORITY] = taskData.priority;
    row[COL.MORNING_STATUS] = '';
    row[COL.EVENING_STATUS] = '';
    row[COL.TARGET_DATE] = taskData.targetDate || '';
    row[COL.DATE_START] = dateStart;
    row[COL.DUE_TIME] = taskData.dueTime || '';
    row[COL.ALLOCATED_TIME] = taskData.allocated;
    row[COL.TODAYS_SPENT] = '0';
    row[COL.TOTAL_MINS] = '0';
    row[COL.TOTAL_WEEK] = '0';
    row[COL.EXTRA_MINS] = '';
    row[COL.COMPLETION_PCT] = '';

    for (let i = 0; i < 17; i++) {
      if (row[i] === undefined) row[i] = '';
    }

    // Use smart insertion instead of append
    await insertTaskRow(sheetId, tabName, userName, row);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
//  Event Listeners  (must be top-level & synchronous)
// ═══════════════════════════════════════════════════════════

// Alarm listeners
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TIMER_ALARM) {
    const s = await getTimerState();
    if (s.status === 'running') await broadcast(s);
    else await chrome.alarms.clear(TIMER_ALARM);
  } else if (alarm.name === REMINDER_ALARM) {
    await checkReminders();
  } else if (alarm.name === DAILY_5PM_ALARM) {
    await handle5pmReminder();
  }
});

// Central message handler
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      switch (msg.type) {

        /* ── Auth ────────────────────────── */
        case 'LOGIN': {
          const token = await getAuthToken(true);
          const email = await getUserEmail();
          reply({ success: true, token, email });
          break;
        }
        case 'CHECK_AUTH': {
          try { const token = await getAuthToken(false); const email = await getUserEmail(); reply({ authenticated: true, token, email }); }
          catch { reply({ authenticated: false }); }
          break;
        }
        case 'SIGN_OUT':
          await signOut();
          reply({ success: true });
          break;

        /* ── Sheets ─────────────────────── */
        case 'GET_SHEET_TABS': {
          const tabs = await fetchSheetTabs(msg.sheetId);
          reply({ success: true, tabs });
          break;
        }
        case 'GET_SHEET_DATA': {
          const rows = await fetchSheetData(msg.sheetId, msg.range || msg.tabName);
          reply({ success: true, rows });
          break;
        }
        case 'UPDATE_CELL':
          await writeCell(msg.sheetId, msg.cellRef, msg.value);
          reply({ success: true });
          break;
        case 'ADD_TASK': {
          addTask(msg.sheetId, msg.tabName, msg.taskData).then(reply);
          break;
        }
        case 'DUPLICATE_SHEET': {
          const sheetId = msg.sheetId;
          const sourceTab = msg.sourceTab;
          const newTabName = msg.newTabName;
          const excludeCompleted = msg.excludeCompleted;

          const metadata = await sheetsApi(`${SHEETS_BASE}/${sheetId}?fields=sheets(properties(sheetId,title))`);
          const sourceSheet = metadata.sheets.find(s => s.properties.title === sourceTab);
          if (!sourceSheet) {
            reply({ error: "Source tab not found in spreadsheet" });
            break;
          }
          const sourceSheetId = sourceSheet.properties.sheetId;

          const dupRes = await sheetsApi(`${SHEETS_BASE}/${sheetId}:batchUpdate`, {
            method: 'POST',
            body: JSON.stringify({
              requests: [{
                duplicateSheet: {
                  sourceSheetId: sourceSheetId,
                  newSheetName: newTabName,
                  insertSheetIndex: 0
                }
              }]
            })
          });

          const newSheetId = dupRes.replies[0].duplicateSheet.properties.sheetId;

          if (excludeCompleted) {
            const rows = await fetchSheetData(sheetId, newTabName);
            const deleteRequests = [];
            for (let i = rows.length - 1; i >= 1; i--) {
              const row = rows[i];
              if (!row) continue;
              const eveStatus = (row[COL.EVENING_STATUS] || '').toString().trim().toLowerCase();
              const mornStatus = (row[COL.MORNING_STATUS] || '').toString().trim().toLowerCase();
              if (eveStatus === 'completed' || mornStatus === 'completed') {
                deleteRequests.push({
                  deleteDimension: {
                    range: {
                      sheetId: newSheetId,
                      dimension: 'ROWS',
                      startIndex: i,
                      endIndex: i + 1
                    }
                  }
                });
              }
            }

            if (deleteRequests.length > 0) {
              await sheetsApi(`${SHEETS_BASE}/${sheetId}:batchUpdate`, {
                method: 'POST',
                body: JSON.stringify({ requests: deleteRequests })
              });
            }
          }

          reply({ success: true });
          break;
        }
        case 'OPEN_POPUP': {
          chrome.action.openPopup()
            .then(() => reply({ success: true }))
            .catch(err => reply({ error: err.message }));
          break;
        }

        /* ── Data Validations (Dropdowns) ── */
        case 'GET_DROPDOWN_OPTIONS': {
          // Check session cache first
          const cached = await chrome.storage.session.get('dropdownCache');
          if (cached.dropdownCache && cached.dropdownCache.sheetId === msg.sheetId) {
            reply({ success: true, dropdowns: cached.dropdownCache.data });
            break;
          }
          const dropdowns = await fetchDataValidations(msg.sheetId);
          await chrome.storage.session.set({ dropdownCache: { sheetId: msg.sheetId, data: dropdowns } });
          reply({ success: true, dropdowns });
          break;
        }

        /* ── Timer ──────────────────────── */
        case 'GET_TIMER_STATE': {
          const st = await getTimerState();
          reply({ timerState: st, elapsed: elapsed(st) });
          break;
        }
        case 'START_TIMER':  reply(await startTimer(msg.taskInfo));  break;
        case 'PAUSE_TIMER':  reply(await pauseTimer());              break;
        case 'RESUME_TIMER': reply(await resumeTimer());             break;
        case 'STOP_TIMER':   reply(await stopTimer());               break;
        case 'ADD_TIME_DATA':reply(await addTimeData(msg.specificTask)); break;
        case 'CLEAR_TASK_ACC_TIME': {
          await clearTaskAccumulatedTime(msg.sheetTab, msg.rowIndex);
          reply({ success: true });
          break;
        }
        case 'UPDATE_TIMER_STATE_INFO': {
          const s = await getTimerState();
          if (s.status !== 'idle') {
            s.taskInfo = { ...s.taskInfo, ...msg.taskInfo };
            if (msg.startTs !== undefined) s.startTs = msg.startTs;
            if (msg.accMs !== undefined) s.accMs = msg.accMs;
            await saveTimer(s);
            await broadcast(s);
          }
          reply({ success: true });
          break;
        }

        /* ── Reminders (Global + Task) ──── */
        case 'GET_REMINDERS': {
          const list = await getReminders();
          if (msg.scope === 'global') {
            reply({ success: true, reminders: list.filter(r => r.scope === 'global' || !r.scope) });
          } else if (msg.rowIndex !== undefined) {
            reply({ success: true, reminders: list.filter(r => r.rowIndex === msg.rowIndex) });
          } else {
            reply({ success: true, reminders: list });
          }
          break;
        }
        case 'ADD_REMINDER': {
          const scope = msg.scope || 'global';
          const rowIdx = msg.rowIndex || null;
          const result = await addReminder(msg.text, msg.minutes, scope, rowIdx, msg.triggerTs);
          reply(result);
          break;
        }
        case 'DELETE_REMINDER': {
          await deleteReminder(msg.id);
          reply({ success: true });
          break;
        }

        /* ── Pet Settings ────────────────── */
        case 'GET_PET_SETTINGS': {
          const settings = await getPetSettings();
          reply({ success: true, petSettings: settings });
          break;
        }
        case 'SET_PET_SETTINGS': {
          const updated = await setPetSettings(msg.settings);
          reply({ success: true, petSettings: updated });
          break;
        }

        /* ── Task URLs (Auto-tracking) ──── */
        case 'GET_TASK_URL': {
          const all = await getTaskUrls();
          const key = msg.taskKey || msg.rowIndex;
          reply({ success: true, taskUrl: all[key] || all[msg.rowIndex] || null });
          break;
        }
        case 'SET_TASK_URL': {
          const key = msg.taskKey || msg.rowIndex;
          await setTaskUrl(key, msg.url, msg.enabled, msg.taskInfo);
          reply({ success: true });
          break;
        }
        case 'GET_ALL_TASK_URLS': {
          const urls = await getTaskUrls();
          reply({ success: true, taskUrls: urls });
          break;
        }

        /* ── Navigation ─────────────────── */
        case 'OPEN_SHEET': {
          const url = `https://docs.google.com/spreadsheets/d/${msg.sheetId}`;
          chrome.tabs.create({ url });
          reply({ success: true });
          break;
        }

        /* ── User Tasks for Pet Widget ──── */
        case 'GET_USER_TASKS': {
          try {
            const { config } = await chrome.storage.local.get('config');
            const { selectedTab } = await chrome.storage.session.get('selectedTab');
            if (!config?.sheetId || !selectedTab || !config.userName) {
              reply({ success: true, tasks: [], sheetName: selectedTab || '' });
              break;
            }
            const rows = await fetchSheetData(config.sheetId, selectedTab);
            const tasks = [];
            for (let i = 1; i < rows.length; i++) {
              if (rows[i][COL.NAME] === config.userName) {
                tasks.push({
                  rowIndex: i + 1,
                  projectCode: rows[i][COL.PROJECT_CODE] || '',
                  jiraTitle: rows[i][COL.JIRA_TITLE] || '',
                  taskType: rows[i][COL.TASK_TYPE] || '',
                  morningStatus: rows[i][COL.MORNING_STATUS] || '',
                  eveningStatus: rows[i][COL.EVENING_STATUS] || '',
                  allocatedTime: rows[i][COL.ALLOCATED_TIME] || '0',
                  todaysSpent: rows[i][COL.TODAYS_SPENT] || '0',
                  sheetTab: selectedTab
                });
              }
            }
            reply({ success: true, tasks, sheetName: selectedTab });
          } catch (e) {
            reply({ success: false, tasks: [], error: e.message });
          }
          break;
        }

        default:
          reply({ error: `Unknown: ${msg.type}` });
      }
    } catch (e) {
      reply({ error: e.message });
    }
  })();
  return true; // keep channel open for async reply
});

// Install / update
chrome.runtime.onInstalled.addListener(async (d) => {
  console.log(`TimeTracker ${d.reason}: v${chrome.runtime.getManifest().version}`);
  await chrome.alarms.create(REMINDER_ALARM, { periodInMinutes: 0.5 });
  schedule5pmAlarm();
});

// Browser start — resume alarms
chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(REMINDER_ALARM, { periodInMinutes: 0.5 });
  schedule5pmAlarm();
  const s = await getTimerState();
  if (s.status === 'running') {
    await chrome.alarms.create(TIMER_ALARM, { periodInMinutes: 0.5 });
    await broadcast(s);
  }
});
