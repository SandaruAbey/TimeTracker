// ============================================================
// TimeTracker — Content Script (Draggable Pet Widget) v2.0
// ============================================================
// Injects a floating, draggable pixel-art pet character on the screen.
// Features: task list navigation, direct controls, pinned live timer,
// global reminders, pet enable/disable, URL auto-tracking notifications.
// ============================================================

(function () {
  // Prevent duplicate execution
  if (window.TimeTrackerToolbarInjected) return;
  window.TimeTrackerToolbarInjected = true;

  let host = null;
  let shadowRoot = null;
  let timerInterval = null;
  let currentTimerState = { status: 'idle' };
  let petEnabled = true;
  
  // Draggable State
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;
  
  // Default coordinate: bottom right corner
  let petCoords = { left: window.innerWidth - 90, top: window.innerHeight - 110 };

  const cssUrl = chrome.runtime.getURL('content/content.css');

  // Check pet settings on load
  chrome.storage.local.get(['petSettings', 'petCoords'], (res) => {
    if (res.petSettings?.enabled === false) {
      petEnabled = false;
    }
    if (res.petCoords) {
      petCoords = clampCoords(res.petCoords.left, res.petCoords.top);
    }
    applyCoords();
  });

  // Query background for initial timer state
  chrome.runtime.sendMessage({ type: 'GET_TIMER_STATE' }, (res) => {
    if (res && res.timerState) {
      if (res.petEnabled === false) petEnabled = false;
      if (petEnabled) {
        updateWidget(res.timerState, res.elapsed);
      }
    }
  });

  // Listen for broadcasts from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TIMER_STATE_UPDATE') {
      if (msg.petEnabled === false) {
        petEnabled = false;
        removeWidget();
        return;
      }
      petEnabled = true;
      updateWidget(msg.timerState, msg.elapsed);
    } else if (msg.type === 'TRIGGER_REMINDER') {
      if (petEnabled) {
        triggerReminderNotification(msg.reminder);
      }
    } else if (msg.type === 'PET_SETTINGS_CHANGED') {
      petEnabled = msg.petSettings?.enabled !== false;
      if (!petEnabled) {
        removeWidget();
      }
    } else if (msg.type === 'AUTO_TRACK_STARTED') {
      if (petEnabled) {
        triggerNotificationDirect(`🚀 Auto-tracking started: ${msg.taskName}`);
      }
    } else if (msg.type === 'AUTO_TRACK_PAUSED') {
      if (petEnabled) {
        triggerNotificationDirect(`⏸️ Auto-tracking paused: ${msg.taskName}`);
      }
    }
  });

  // Adjust coordinates on window resize to prevent pet getting lost
  window.addEventListener('resize', () => {
    if (host) {
      const clamped = clampCoords(petCoords.left, petCoords.top);
      petCoords.left = clamped.left;
      petCoords.top = clamped.top;
      applyCoords();
    }
  });

  function removeWidget() {
    if (host) {
      host.remove();
      host = null;
      shadowRoot = null;
      stopLocalTimer();
    }
  }

  function createWidget() {
    if (!petEnabled) return;
    
    host = document.createElement('div');
    host.id = 'timetracker-pet-host';
    
    // Style the host container
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.height = '0';
    host.style.width = '0';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';

    shadowRoot = host.attachShadow({ mode: 'closed' });

    // Inner stylesheet link
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssUrl;
    shadowRoot.appendChild(link);

    // HTML Structure
    const container = document.createElement('div');
    container.id = 'tt-pet-container';
    container.className = 'pet-widget-container';
    container.innerHTML = `
      <!-- Speech Bubble -->
      <div class="pet-bubble hidden" id="tt-pet-bubble">
        <div class="bubble-content" id="tt-bubble-text">Hello! Ready to track?</div>
        <div class="bubble-actions" id="tt-bubble-actions">
          <button class="btn-bubble" id="tt-bubble-btn-ok">OK</button>
        </div>
        <button class="bubble-close" id="tt-btn-close-bubble">&times;</button>
      </div>

      <!-- Character Wrapper -->
      <div class="pet-char-wrap" id="tt-pet-char">
        <!-- SVG Pixel Art Pet (Blocky Orange-brown) with Fire overhead space -->
        <svg class="pet-svg" viewBox="0 -4 16 16" shape-rendering="crispEdges">
          <!-- Flickering Flame Elements -->
          <g class="fire-group hidden" id="tt-pet-fire">
            <rect class="flame flame-outer" x="5" y="-4" width="6" height="5" fill="#ef4444"/>
            <rect class="flame flame-inner" x="6" y="-3" width="4" height="4" fill="#f59e0b"/>
            <rect class="flame flame-core" x="7" y="-2" width="2" height="3" fill="#fef08a"/>
          </g>
          <!-- Body -->
          <rect x="3" y="2" width="10" height="8" fill="#d16b49"/>
          <!-- Arms -->
          <rect x="0" y="5" width="3" height="2" fill="#d16b49"/>
          <rect x="13" y="5" width="3" height="2" fill="#d16b49"/>
          <!-- Legs -->
          <rect x="4" y="10" width="2" height="2" fill="#d16b49"/>
          <rect x="10" y="10" width="2" height="2" fill="#d16b49"/>
          <!-- Eyes -->
          <rect class="pet-eye" x="5" y="3" width="2" height="3" fill="#ffffff"/>
          <rect class="pet-eye" x="9" y="3" width="2" height="3" fill="#ffffff"/>
        </svg>
        
        <!-- Pinned Time Pill (Always visible above the pet when tracking) -->
        <div class="pet-time-pill hidden" id="tt-pinned-time">00:00:00</div>
      </div>

      <!-- Task List Menu (shows on triple click) -->
      <div class="pet-menu hidden" id="tt-pet-task-list">
        <div class="menu-header" style="border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 8px; margin-bottom: 4px;">
          <span id="tt-task-list-title" style="font-size: 11px; font-weight: 700; color: #60a5fa; text-transform: uppercase; letter-spacing: 0.5px;">My Tasks</span>
          <button class="menu-btn-close" id="tt-task-list-close" style="background: none; border: none; color: #64748b; cursor: pointer; font-size: 14px; padding: 0 2px;">&times;</button>
        </div>
        <div id="tt-task-items" class="task-list-items" style="max-height: 200px; overflow-y: auto;">
          <div style="color: #64748b; font-size: 11px; text-align: center; padding: 12px 0;">Loading tasks...</div>
        </div>
      </div>

      <!-- Quick Action Menu (shows on active task) -->
      <div class="pet-menu hidden" id="tt-pet-menu">
        <div class="menu-header">
          <span class="menu-project" id="tt-menu-project">PROJECT</span>
          <span class="menu-clock mono" id="tt-menu-clock">00:00:00</span>
        </div>
        <div class="menu-title" id="tt-menu-title">Task Title</div>
        
        <!-- Status selectors inside menu -->
        <div class="menu-status-row" style="display: flex; gap: 8px; margin-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 6px;">
          <div class="menu-status-group" style="display: flex; flex-direction: column; flex: 1; gap: 3px;">
            <label style="font-size: 9px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.5px;">Morning</label>
            <select id="tt-menu-morn-select" style="background: #1e293b; border: 1px solid rgba(255, 255, 255, 0.1); color: #fff; border-radius: 6px; padding: 3px 6px; font-size: 11px; outline: none; cursor: pointer;">
              <option value="">—</option>
              <option value="Started">Started</option>
              <option value="In Progress">In Progress</option>
              <option value="Completed">Completed</option>
              <option value="On Hold">On Hold</option>
              <option value="Blocked">Blocked</option>
            </select>
          </div>
          <div class="menu-status-group" style="display: flex; flex-direction: column; flex: 1; gap: 3px;">
            <label style="font-size: 9px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.5px;">Evening</label>
            <select id="tt-menu-eve-select" style="background: #1e293b; border: 1px solid rgba(255, 255, 255, 0.1); color: #fff; border-radius: 6px; padding: 3px 6px; font-size: 11px; outline: none; cursor: pointer;">
              <option value="">—</option>
              <option value="Started">Started</option>
              <option value="In Progress">In Progress</option>
              <option value="Completed">Completed</option>
              <option value="On Hold">On Hold</option>
              <option value="Blocked">Blocked</option>
            </select>
          </div>
        </div>

        <div class="menu-buttons">
          <button id="tt-menu-btn-toggle" class="menu-btn toggle" title="Pause/Resume">
            <svg class="icon-pause" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            <svg class="icon-play hidden" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
          </button>
          <button id="tt-menu-btn-stop" class="menu-btn stop" title="Stop & Discard">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 19h12V5H6v14z"/></svg>
          </button>
          <button id="tt-menu-btn-add" class="menu-btn add" title="Submit Time to Google Sheet">
            Submit Time
          </button>
        </div>
        
        <!-- Inline reminder button and form -->
        <button id="tt-menu-btn-rem-trigger" class="menu-btn rem-trigger">Set Reminder</button>
        
        <div class="menu-reminder-form hidden" id="tt-menu-rem-form">
          <div class="rem-form-title">Set Reminder</div>
          <input type="text" id="tt-menu-rem-input" placeholder="Remind me to..." autocomplete="off">
          <div class="menu-reminder-row">
            <input type="text" id="tt-menu-rem-time" placeholder="e.g. 15 or 5pm" value="15" style="background:#1e293b; border:1px solid rgba(255,255,255,0.15); color:#fff; border-radius:4px; padding:2px 6px; font-size:10px; width:75px; outline:none; font-family:inherit; margin-right:4px;">
            <div class="menu-reminder-form-btns">
              <button id="tt-menu-btn-rem-set" class="menu-btn set">Set</button>
              <button id="tt-menu-btn-rem-cancel" class="menu-btn cancel">Back</button>
            </div>
          </div>
        </div>
      </div>
    `;

    shadowRoot.appendChild(container);
    document.body.appendChild(host);

    bindPetEvents();
    applyCoords();
  }

  function bindPetEvents() {
    const charEl = shadowRoot.querySelector('#tt-pet-char');
    const container = shadowRoot.querySelector('#tt-pet-container');
    const closeBubbleBtn = shadowRoot.querySelector('#tt-btn-close-bubble');
    const okBubbleBtn = shadowRoot.querySelector('#tt-bubble-btn-ok');

    // Controls Menu Actions
    shadowRoot.querySelector('#tt-menu-btn-toggle').onclick = handleToggle;
    shadowRoot.querySelector('#tt-menu-btn-stop').onclick = handleStop;
    shadowRoot.querySelector('#tt-menu-btn-add').onclick = handleAdd;

    // Status sync actions
    shadowRoot.querySelector('#tt-menu-morn-select').onchange = (e) => handleStatusUpdate('morn', e.target.value);
    shadowRoot.querySelector('#tt-menu-eve-select').onchange = (e) => handleStatusUpdate('eve', e.target.value);

    // Reminder Form Toggles & Actions
    shadowRoot.querySelector('#tt-menu-btn-rem-trigger').onclick = showReminderForm;
    shadowRoot.querySelector('#tt-menu-btn-rem-cancel').onclick = hideReminderForm;
    shadowRoot.querySelector('#tt-menu-btn-rem-set').onclick = handleSetReminder;

    // Bubble closers
    closeBubbleBtn.onclick = () => hideSpeechBubble();
    okBubbleBtn.onclick = () => hideSpeechBubble();

    // Task list close
    shadowRoot.querySelector('#tt-task-list-close').onclick = () => hideTaskList();

    // Make running task details card clickable to open popup
    const menuEl = shadowRoot.querySelector('#tt-pet-menu');
    if (menuEl) {
      menuEl.onclick = (e) => {
        // Ignore clicks on buttons/selects/options to let them handle their own events
        if (e.target.closest('button') || e.target.closest('select') || e.target.closest('option') || e.target.closest('input')) {
          return;
        }
        
        // Open that specific task page
        if (currentTimerState && currentTimerState.status !== 'idle' && currentTimerState.taskRow) {
          chrome.storage.local.set({
            openTaskRowIndex: currentTimerState.taskRow,
            openTaskTab: currentTimerState.sheetTab
          }, () => {
            chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }, (res) => {
              if (chrome.runtime.lastError || (res && res.error)) {
                triggerNotificationDirect(`Please click the extension icon in your toolbar to view this task.`);
              }
            });
          });
        }
      };
    }

    // Mouse/Touch Dragging using Pointer Events
    let clickCount = 0;
    let clickTimeout = null;

    charEl.onpointerdown = (e) => {
      if (e.target.closest('#tt-pinned-time') || e.target.closest('select')) return;
      if (e.button !== 0) return;
      
      isDragging = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      
      const rect = container.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      
      container.classList.add('dragging');
      charEl.setPointerCapture(e.pointerId);

      charEl.onpointermove = (moveEvt) => {
        const dx = moveEvt.clientX - dragStartX;
        const dy = moveEvt.clientY - dragStartY;
        
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          isDragging = true;
          hideAllMenus();
        }
        
        if (isDragging) {
          const clamped = clampCoords(initialLeft + dx, initialTop + dy);
          petCoords.left = clamped.left;
          petCoords.top = clamped.top;
          applyCoords();
        }
      };

      charEl.onpointerup = (upEvt) => {
        charEl.releasePointerCapture(upEvt.pointerId);
        charEl.onpointermove = null;
        charEl.onpointerup = null;
        container.classList.remove('dragging');

        if (isDragging) {
          chrome.storage.local.set({ petCoords });
        } else {
          // Click count checker - 1 click = menus, 3 clicks = open extension popup
          clickCount++;
          clearTimeout(clickTimeout);
          
          clickTimeout = setTimeout(() => {
            if (clickCount === 1) {
              handlePetClick();
            } else if (clickCount >= 3) {
              toggleTaskList();
            }
            clickCount = 0;
          }, 300);
        }
      };
    };
  }

  // Pet click: show controls if tracking, show idle bubble if not
  function handlePetClick() {
    if (currentTimerState.status !== 'idle') {
      toggleControlsMenu();
    } else {
      triggerNotificationDirect("No task is running. Triple click to see your task list.");
    }
  }

  function toggleTaskList() {
    const taskListMenu = shadowRoot.querySelector('#tt-pet-task-list');
    const isOpen = !taskListMenu.classList.contains('hidden');
    
    hideAllMenus();
    
    if (!isOpen) {
      loadTaskListInPet();
      taskListMenu.classList.remove('hidden');
      updateAlignmentClasses();
    }
  }

  function hideTaskList() {
    if (shadowRoot) {
      shadowRoot.querySelector('#tt-pet-task-list').classList.add('hidden');
    }
  }

  function loadTaskListInPet() {
    const container = shadowRoot.querySelector('#tt-task-items');
    container.innerHTML = '<div style="color: #64748b; font-size: 11px; text-align: center; padding: 12px 0;">Loading tasks...</div>';
    
    chrome.runtime.sendMessage({ type: 'GET_USER_TASKS' }, (res) => {
      // Update sheet name in header
      const titleSpan = shadowRoot.querySelector('#tt-task-list-title');
      if (titleSpan && res?.sheetName) {
        titleSpan.textContent = res.sheetName;
        titleSpan.title = res.sheetName;
      }

      if (!res || !res.success || !res.tasks || res.tasks.length === 0) {
        container.innerHTML = '<div style="color: #64748b; font-size: 11px; text-align: center; padding: 12px 0;">No tasks found. Open extension to set up.</div>';
        return;
      }
      
      container.innerHTML = '';
      res.tasks.forEach(task => {
        const item = document.createElement('div');
        item.className = 'task-list-item';
        item.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; cursor: pointer; transition: background 0.15s; border-bottom: 1px solid rgba(255,255,255,0.04);';
        
        const isActive = currentTimerState.status !== 'idle' && currentTimerState.taskRow === task.rowIndex;
        if (isActive) {
          item.style.background = 'rgba(16, 185, 129, 0.1)';
          item.style.borderColor = 'rgba(16, 185, 129, 0.2)';
        }
        
        item.innerHTML = `
          <span style="font-size: 9px; font-weight: 700; background: rgba(59,130,246,0.15); color: #60a5fa; padding: 1px 5px; border-radius: 4px; flex-shrink: 0;">${task.projectCode || '—'}</span>
          <span style="font-size: 11px; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">${task.jiraTitle || 'Untitled'}</span>
          ${isActive ? '<span style="width:6px;height:6px;border-radius:50%;background:#10b981;flex-shrink:0;"></span>' : ''}
        `;
        
        item.onmouseenter = () => { if (!isActive) item.style.background = 'rgba(255,255,255,0.05)'; };
        item.onmouseleave = () => { if (!isActive) item.style.background = 'transparent'; };
        
        item.onclick = () => {
          hideTaskList();
          
          chrome.storage.local.set({
            openTaskRowIndex: task.rowIndex,
            openTaskTab: task.sheetTab
          }, () => {
            // Open extension popup
            chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }, (res) => {
              if (chrome.runtime.lastError || (res && res.error)) {
                triggerNotificationDirect(`Please open the TimeTracker extension from your toolbar to view: ${task.jiraTitle}`);
              }
            });
          });
        };
        
        container.appendChild(item);
      });
    });
  }

  function toggleControlsMenu() {
    const menu = shadowRoot.querySelector('#tt-pet-menu');
    const isOpen = !menu.classList.contains('hidden');
    
    hideAllMenus();
    
    if (!isOpen) {
      menu.classList.remove('hidden');
      updateAlignmentClasses();
    }
  }

  function hideAllMenus() {
    if (shadowRoot) {
      shadowRoot.querySelector('#tt-pet-menu').classList.add('hidden');
      shadowRoot.querySelector('#tt-pet-task-list').classList.add('hidden');
      hideSpeechBubble(true); // silent = don't remove widget
      hideReminderForm();
    }
  }

  function clampCoords(left, top) {
    const minLeft = 10;
    const maxLeft = window.innerWidth - 80;
    const minTop = 30;
    const maxTop = window.innerHeight - 80;
    return {
      left: Math.max(minLeft, Math.min(maxLeft, left)),
      top: Math.max(minTop, Math.min(maxTop, top))
    };
  }

  function applyCoords() {
    const container = shadowRoot?.querySelector('#tt-pet-container');
    if (container) {
      container.style.left = `${petCoords.left}px`;
      container.style.top = `${petCoords.top}px`;
      updateAlignmentClasses();
    }
  }

  function updateAlignmentClasses() {
    if (!shadowRoot) return;
    const bubble = shadowRoot.querySelector('#tt-pet-bubble');
    const menu = shadowRoot.querySelector('#tt-pet-menu');
    const taskList = shadowRoot.querySelector('#tt-pet-task-list');
    const container = shadowRoot.querySelector('#tt-pet-container');
    const isLeftHalf = petCoords.left < window.innerWidth / 2;

    if (isLeftHalf) {
      bubble.className = bubble.className.replace(/\bbubble-(left|right)\b/g, '') + ' bubble-right';
      menu.className = menu.className.replace(/\bmenu-(left|right)\b/g, '') + ' menu-right';
      taskList.className = taskList.className.replace(/\bmenu-(left|right)\b/g, '') + ' menu-right';
      container.className = container.className.replace(/\bmenu-\S+/g, '') + ' menu-right';
    } else {
      bubble.className = bubble.className.replace(/\bbubble-(left|right)\b/g, '') + ' bubble-left';
      menu.className = menu.className.replace(/\bmenu-(left|right)\b/g, '') + ' menu-left';
      taskList.className = taskList.className.replace(/\bmenu-(left|right)\b/g, '') + ' menu-left';
      container.className = container.className.replace(/\bmenu-\S+/g, '') + ' menu-left';
    }
  }

  function formatTime(ms) {
    const s = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function updateWidget(state, elapsedMs) {
    if (!petEnabled) return;
    currentTimerState = state;

    if (state.status === 'idle') {
      // Only hide widget if no bubble is visible
      const bubble = shadowRoot?.querySelector('#tt-pet-bubble');
      const isBubbleVisible = bubble && !bubble.classList.contains('hidden');
      
      if (!isBubbleVisible && host) {
        hideAllMenus();
        const container = shadowRoot.querySelector('#tt-pet-container');
        container.style.opacity = '0';
        container.style.transform = 'scale(0.8)';
        container.style.transition = 'all 0.3s ease';
        setTimeout(() => {
          if (host && currentTimerState.status === 'idle') {
            const b = shadowRoot?.querySelector('#tt-pet-bubble');
            if (!b || b.classList.contains('hidden')) {
              host.remove();
              host = null;
              shadowRoot = null;
            }
          }
        }, 300);
      }
      stopLocalTimer();
      return;
    }

    // Ensure widget is injected
    if (!host) {
      createWidget();
    }
    if (!host) return; // Pet disabled

    const container = shadowRoot.querySelector('#tt-pet-container');
    const timePill = shadowRoot.querySelector('#tt-pinned-time');
    const projectEl = shadowRoot.querySelector('#tt-menu-project');
    const titleEl = shadowRoot.querySelector('#tt-menu-title');
    const clockEl = shadowRoot.querySelector('#tt-menu-clock');
    
    const toggleBtn = shadowRoot.querySelector('#tt-menu-btn-toggle');
    const playIcon = toggleBtn.querySelector('.icon-play');
    const pauseIcon = toggleBtn.querySelector('.icon-pause');

    // Make container visible
    container.style.opacity = '1';
    container.style.transform = 'scale(1)';
    container.style.transition = 'all 0.3s ease';

    // Fill details
    projectEl.textContent = state.taskInfo?.projectCode || 'TASK';
    titleEl.textContent = state.taskInfo?.jiraTitle || 'Untitled Task';
    titleEl.title = state.taskInfo?.jiraTitle || 'Untitled Task';

    const mornSelect = shadowRoot.querySelector('#tt-menu-morn-select');
    const eveSelect = shadowRoot.querySelector('#tt-menu-eve-select');
    setSelectValueWithDefault(mornSelect, state.taskInfo?.morningStatus);
    setSelectValueWithDefault(eveSelect, state.taskInfo?.eveningStatus);

    stopLocalTimer();
    timePill.classList.remove('hidden');

    if (state.status === 'running') {
      // Remove old classes and set tracking
      container.className = container.className.replace(/\b(tracking|paused|warning-limit|exceeded-limit)\b/g, '').trim();
      container.classList.add('tracking');
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');

      const startTs = state.startTs || Date.now();
      const acc = state.accMs || 0;

      const tick = () => {
        const curElapsed = acc + (Date.now() - startTs);
        const text = formatTime(curElapsed);
        clockEl.textContent = text;
        timePill.textContent = text;
        updatePetBudgetStatus(curElapsed);
      };
      tick();
      timerInterval = setInterval(tick, 1000);
    } else if (state.status === 'paused') {
      container.className = container.className.replace(/\b(tracking|paused|warning-limit|exceeded-limit)\b/g, '').trim();
      container.classList.add('paused');
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
      
      const t = formatTime(state.accMs || 0);
      clockEl.textContent = t;
      timePill.textContent = t;
      updatePetBudgetStatus(state.accMs || 0);
    }

    updateAlignmentClasses();
  }

  function stopLocalTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // Speech Bubble Notification Handler
  function triggerReminderNotification(reminder) {
    if (!petEnabled) return;
    if (!host) {
      createWidget();
    }
    if (!host) return;

    const container = shadowRoot.querySelector('#tt-pet-container');
    const bubble = shadowRoot.querySelector('#tt-pet-bubble');
    const textEl = shadowRoot.querySelector('#tt-bubble-text');

    // Make sure container is visible
    container.style.opacity = '1';
    container.style.transform = 'scale(1)';

    // Shake Pet
    container.classList.add('wobble');
    setTimeout(() => container.classList.remove('wobble'), 1200);

    // Show bubble
    textEl.textContent = `Hey! ${reminder.text}`;
    bubble.classList.remove('hidden');
    updateAlignmentClasses();
  }

  function hideSpeechBubble(silent) {
    if (shadowRoot) {
      shadowRoot.querySelector('#tt-pet-bubble').classList.add('hidden');
      
      // If timer is idle and not silent, remove the pet widget since the notification is closed
      if (!silent && currentTimerState.status === 'idle') {
        const container = shadowRoot.querySelector('#tt-pet-container');
        container.style.opacity = '0';
        container.style.transform = 'scale(0.8)';
        container.style.transition = 'all 0.3s ease';
        setTimeout(() => {
          if (host && currentTimerState.status === 'idle') {
            const b = shadowRoot?.querySelector('#tt-pet-bubble');
            if (!b || b.classList.contains('hidden')) {
              host.remove();
              host = null;
              shadowRoot = null;
            }
          }
        }, 300);
      }
    }
  }

  // Inline Reminders Form Handlers
  function showReminderForm() {
    shadowRoot.querySelector('#tt-menu-rem-form').classList.remove('hidden');
    shadowRoot.querySelector('#tt-menu-btn-rem-trigger').classList.add('hidden');
    shadowRoot.querySelector('#tt-menu-rem-input').value = '';
    shadowRoot.querySelector('#tt-menu-rem-input').focus();
  }

  function hideReminderForm() {
    if (!shadowRoot) return;
    const form = shadowRoot.querySelector('#tt-menu-rem-form');
    const trigger = shadowRoot.querySelector('#tt-menu-btn-rem-trigger');
    if (form) form.classList.add('hidden');
    if (trigger) trigger.classList.remove('hidden');
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

  async function handleSetReminder() {
    const text = shadowRoot.querySelector('#tt-menu-rem-input').value.trim();
    const rawTime = shadowRoot.querySelector('#tt-menu-rem-time').value.trim();
    
    if (!text) {
      alert('Please enter reminder text');
      return;
    }
    
    const parsed = parseReminderTimeToTs(rawTime);
    if (!parsed) {
      alert('Invalid time format. Use relative mins (e.g. 15) or exact time (e.g. 5pm)');
      return;
    }

    const setBtn = shadowRoot.querySelector('#tt-menu-btn-rem-set');
    setBtn.disabled = true;
    setBtn.textContent = '...';

    chrome.runtime.sendMessage({
      type: 'ADD_REMINDER',
      scope: 'global',
      text: text,
      minutes: parsed.relative ? parsed.minutes : null,
      triggerTs: parsed.relative ? null : parsed.triggerTs
    }, (res) => {
      setBtn.disabled = false;
      setBtn.textContent = 'Set';
      
      if (res && res.success) {
        hideReminderForm();
        hideAllMenus();
        
        // Show immediate dialog in bubble to confirm
        const bubble = shadowRoot.querySelector('#tt-pet-bubble');
        const textEl = shadowRoot.querySelector('#tt-bubble-text');
        const displayTimeText = parsed.relative ? `${parsed.minutes} min` : parsed.targetTimeStr;
        textEl.textContent = `Got it! I will remind you to "${text}" at ${displayTimeText}.`;
        bubble.classList.remove('hidden');
        updateAlignmentClasses();
      } else {
        alert('Failed to set reminder');
      }
    });
  }

  function setSelectValueWithDefault(selectEl, value) {
    if (!selectEl) return;
    if (!value) {
      selectEl.value = '';
      return;
    }
    let exists = false;
    for (let i = 0; i < selectEl.options.length; i++) {
      if (selectEl.options[i].value === value) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      selectEl.appendChild(opt);
    }
    selectEl.value = value;
  }

  function updatePetBudgetStatus(curElapsedMs) {
    const container = shadowRoot?.querySelector('#tt-pet-container');
    const fireEl = shadowRoot?.querySelector('#tt-pet-fire');
    if (!container || !fireEl) return;

    const taskInfo = currentTimerState.taskInfo;
    if (!taskInfo || !taskInfo.allocatedMins) {
      container.classList.remove('warning-limit', 'exceeded-limit');
      fireEl.classList.add('hidden');
      return;
    }

    const allocatedMins = taskInfo.allocatedMins;
    const alreadySpentMins = taskInfo.alreadySpentMins || 0;
    const curSpentMins = curElapsedMs / 60000;
    const totalSpentMins = alreadySpentMins + curSpentMins;
    const ratio = totalSpentMins / allocatedMins;

    if (ratio > 1.0) {
      container.classList.remove('warning-limit');
      container.classList.add('exceeded-limit');
      fireEl.classList.remove('hidden');
    } else if (ratio >= 0.8) {
      container.classList.remove('exceeded-limit');
      container.classList.add('warning-limit');
      fireEl.classList.add('hidden');
    } else {
      container.classList.remove('warning-limit', 'exceeded-limit');
      fireEl.classList.add('hidden');
    }
  }

  function handleStatusUpdate(type, value) {
    if (!currentTimerState || currentTimerState.status === 'idle') return;

    const rowIndex = currentTimerState.taskRow;
    const tab = currentTimerState.sheetTab;
    if (!rowIndex || !tab) return;

    chrome.storage.local.get(['config'], (res) => {
      const config = res.config || {};
      if (!config.sheetId) {
        alert('Google Sheet is not configured. Please open extension popup to configure.');
        return;
      }

      const colLetter = (type === 'morn') ? 'G' : 'H';
      const cellRef = `'${tab}'!${colLetter}${rowIndex}`;

      const selectEl = shadowRoot.querySelector(type === 'morn' ? '#tt-menu-morn-select' : '#tt-menu-eve-select');
      const origBackground = selectEl ? selectEl.style.background : '';
      if (selectEl) {
        selectEl.style.background = '#334155';
        selectEl.disabled = true;
      }

      chrome.runtime.sendMessage({
        type: 'UPDATE_CELL',
        sheetId: config.sheetId,
        cellRef: cellRef,
        value: value
      }, (reply) => {
        if (selectEl) {
          selectEl.disabled = false;
          selectEl.style.background = origBackground;
        }

        if (chrome.runtime.lastError || (reply && reply.error)) {
          alert('Failed to update status in Google Sheet: ' + (reply?.error || chrome.runtime.lastError?.message));
        } else {
          if (type === 'morn') {
            currentTimerState.taskInfo.morningStatus = value;
          } else {
            currentTimerState.taskInfo.eveningStatus = value;
          }
          chrome.runtime.sendMessage({
            type: 'UPDATE_TIMER_STATE_INFO',
            taskInfo: currentTimerState.taskInfo
          });
        }
      });
    });
  }

  function triggerNotificationDirect(text) {
    if (!petEnabled) return;
    if (!host) {
      createWidget();
    }
    if (!host) return;

    const container = shadowRoot.querySelector('#tt-pet-container');
    const bubble = shadowRoot.querySelector('#tt-pet-bubble');
    const textEl = shadowRoot.querySelector('#tt-bubble-text');

    container.style.opacity = '1';
    container.style.transform = 'scale(1)';

    container.classList.add('wobble');
    setTimeout(() => container.classList.remove('wobble'), 1200);

    textEl.textContent = text;
    bubble.classList.remove('hidden');
    updateAlignmentClasses();
  }

  // Actions
  function handleToggle() {
    if (currentTimerState.status === 'running') {
      chrome.runtime.sendMessage({ type: 'PAUSE_TIMER' });
    } else if (currentTimerState.status === 'paused') {
      chrome.runtime.sendMessage({ type: 'RESUME_TIMER' });
    }
  }

  function handleStop() {
    if (confirm('Stop timer? Tracked time since last submit will be lost.')) {
      chrome.runtime.sendMessage({ type: 'STOP_TIMER' });
      hideAllMenus();
    }
  }

  function handleAdd() {
    const addBtn = shadowRoot.querySelector('#tt-menu-btn-add');
    const origText = addBtn.textContent;
    addBtn.disabled = true;
    addBtn.textContent = 'Adding...';

    chrome.runtime.sendMessage({ type: 'ADD_TIME_DATA' }, (res) => {
      addBtn.disabled = false;
      addBtn.textContent = origText;
      hideAllMenus();

      if (res && res.success) {
        triggerNotificationDirect(`✅ Added ${res.trackedMinutes} mins!\nToday total: ${res.newTotal} mins.`);
      } else {
        alert(`Failed to submit time: ${res?.error || 'Unknown error'}`);
      }
    });
  }
})();
