




var NIIS_FAVICON_BLINK_TIMER = null;
var NIIS_FAVICON_LAST_FILL = null;
var NIIS_FAVICON_SPIN_ANGLE = 0;

function niisFaviconColorFor(status, queueState) {
  var s = (status || "").toUpperCase();
  var q = (queueState || "").toLowerCase();
  if (s === "DONE" || q === "accepted") return "#16a34a";
  if (s === "REJECTED" || s === "BLOCKED" || q === "rejected") return "#dc2626";
  if (s === "PLANNING") return "#a855f7";
  if (s === "IN_PROGRESS" || q === "in_progress") return "#eab308";
  if (s === "IN_REVIEW" || q === "in_review") return "#0ea5e9";
  if (s === "PENDING" || s === "UNPLANNED" || q === "pending") return "#a3a3a3";
  return "#a3a3a3";
}

function niisIsActiveStatus(status, queueState) {
  var s = (status || "").toUpperCase();
  var q = (queueState || "").toLowerCase();
  return s === "PLANNING" || s === "IN_PROGRESS" || q === "in_progress";
}

var NIIS_FAVICON_BRAND_STROKE = "#5D32D3";
var NIIS_FAVICON_TRIANGLE_PATH = "M2.39019 18.0983L10.6151 3.89171C11.0696 3.10655 11.2969 2.71396 11.5935 2.58211C11.8521 2.4671 12.1474 2.4671 12.4061 2.58211C12.7026 2.71396 12.9299 3.10654 13.3844 3.89171L21.6093 18.0983C22.0655 18.8863 22.2936 19.2803 22.2599 19.6037C22.2305 19.8857 22.0827 20.142 21.8534 20.3088C21.5904 20.5 21.1352 20.5 20.2246 20.5H3.77487C2.86435 20.5 2.40908 20.5 2.14613 20.3088C1.91677 20.142 1.769 19.8857 1.73959 19.6037C1.70588 19.2803 1.93398 18.8863 2.39019 18.0983Z";

function niisPaintFavicon(fill, angle) {
  var link = document.getElementById("niis-favicon");
  if (!link) return;




  var stroke = fill === null ? NIIS_FAVICON_BRAND_STROKE : fill;
  var rotation = angle ? ' transform="rotate(' + angle + ' 12 12)"' : "";
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">'
    + '<path d="' + NIIS_FAVICON_TRIANGLE_PATH + '" stroke="' + stroke + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' + rotation + '/>'
    + "</svg>";
  link.href = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function niisUpdateFavicon(status, queueState) {
  var fill = niisFaviconColorFor(status, queueState);
  NIIS_FAVICON_LAST_FILL = fill;
  if (NIIS_FAVICON_BLINK_TIMER !== null) {
    window.clearInterval(NIIS_FAVICON_BLINK_TIMER);
    NIIS_FAVICON_BLINK_TIMER = null;
  }


  if (!status && !queueState) {
    NIIS_FAVICON_SPIN_ANGLE = 0;
    niisPaintFavicon(null, 0);
    return;
  }
  if (niisIsActiveStatus(status, queueState)) {


    NIIS_FAVICON_SPIN_ANGLE = 0;
    niisPaintFavicon(fill, 0);
    NIIS_FAVICON_BLINK_TIMER = window.setInterval(function () {
      NIIS_FAVICON_SPIN_ANGLE = (NIIS_FAVICON_SPIN_ANGLE + 45) % 360;
      niisPaintFavicon(fill, NIIS_FAVICON_SPIN_ANGLE);
    }, 125);
  } else {
    NIIS_FAVICON_SPIN_ANGLE = 0;
    niisPaintFavicon(fill, 0);
  }
}

function niisDeriveTaskSignalsFromDom() {
  var root = document.querySelector("[data-task-live-card-root][data-task-id]");
  if (!root) {

    var kind = document.body.className || "";
    if (/route-tasks|route-task-detail/.test(kind)) return { queueState: null, status: null };
    return { queueState: null, status: null };
  }
  var statusEl = root.querySelector("[data-task-status]");
  var status = statusEl ? statusEl.getAttribute("data-task-status") : null;
  var queueEl = root.querySelector("[data-queue-state]");
  var queueState = queueEl ? queueEl.getAttribute("data-queue-state") : null;
  return { queueState: queueState, status: status };
}

function syncStatusIndicators(taskId, newStatus) {
  if (!newStatus) return;
  var dropdown = document.querySelector('.niis-status-dropdown[data-task-id="' + taskId + '"]');
  if (!dropdown || dropdown.getAttribute('data-current-status') === newStatus) return;

  var statusLabels = {
    UNPLANNED: 'Unplanned', PLANNING: 'Planning', PENDING: 'Pending',
    IN_PROGRESS: 'In Progress', BLOCKED: 'Blocked', IN_REVIEW: 'In Review',
    DONE: 'Done', REJECTED: 'Rejected',
  };

  var triggerLabel = dropdown.querySelector('.niis-status-dropdown-trigger .niis-status-dropdown-label');
  var triggerIcon = dropdown.querySelector('.niis-status-dropdown-trigger .niis-task-status-icon');
  var menuItem = dropdown.querySelector('.niis-status-dropdown-item[data-status="' + newStatus + '"]');

  if (triggerLabel) {
    triggerLabel.textContent = statusLabels[newStatus] || newStatus;
  }
  if (triggerIcon && menuItem) {
    var sourceIcon = menuItem.querySelector('.niis-task-status-icon');
    if (sourceIcon) {
      triggerIcon.outerHTML = sourceIcon.outerHTML;
    }
  }

  dropdown.setAttribute('data-current-status', newStatus);
  dropdown.querySelectorAll('.niis-status-dropdown-item').forEach(function(item) {
    item.classList.toggle('niis-status-dropdown-item-active', item.getAttribute('data-status') === newStatus);
  });

  var sidebarIcon = document.querySelector('.niis-sidebar-link-active .niis-task-status-icon');
  if (sidebarIcon && menuItem) {
    var sidebarSourceIcon = menuItem.querySelector('.niis-task-status-icon');
    if (sidebarSourceIcon) {
      sidebarIcon.outerHTML = sidebarSourceIcon.outerHTML;
    }
  }

  syncTaskLifecycleMini(newStatus);
}





var NIIS_LIFECYCLE_MINI_STAGES = [
  "UNPLANNED", "PLANNING", "PENDING", "IN_PROGRESS", "IN_REVIEW", "DONE",
];
var NIIS_LIFECYCLE_MINI_RUNNER_SVG = '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M504.4 111.4l-1.3-1.3c-11.8-11.8-31-11.8-42.8 0l-46.1 46.6c-2.4 2.4-6.3 2.5-8.8.2l-64.6-59.7c-6.3-5.8-14.4-9-23-9h-96.1c-2.3 0-4.4.9-6.1 2.4l-81.5 77.4c-11.9 11.9-12.8 31.2-1.8 42.9 5.8 6.3 13.7 9.7 22.2 9.7h.2c8.4 0 16.5-3.6 22.1-9.7l57.5-60.9h20.6L120.6 300.2H37.8c-19.6 0-35.8 14.7-36.8 33.4-.5 9.8 2.9 19.1 9.6 26.2 6.6 7 16 11 25.6 11h123.6c2.4 0 4.8-1 6.4-2.8l63.3-67.6 53.3 55.7-16.1 102.7c-4.1 17 4.1 34.4 19.4 41.2 4.7 2.1 9.7 3.2 14.7 3.2 5.4 0 10.7-1.2 15.6-3.7 9.5-4.7 16.3-13.3 18.8-24l27.5-147.3c.5-2.9-.4-5.8-2.4-7.9l-73.3-73.2 58.2-58.1 40.6 40.6c11.3 11.3 31.1 11.3 42.4 0l76.2-76.1c5.6-5.6 8.7-13.1 8.7-21.1s-3.1-15.4-8.7-21zm-97.4 3.4c29.2 0 53-23.8 53-53s-23.8-53-53-53-53 23.8-53 53 23.8 53 53 53z"/></svg>';
var NIIS_LIFECYCLE_MINI_CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
var NIIS_LIFECYCLE_MINI_DOT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="3"/></svg>';

function syncTaskLifecycleMini(newStatus) {
  var card = document.querySelector('[data-lifecycle-mini]');
  if (!card) return;
  var status = String(newStatus || '').toUpperCase();
  if (card.getAttribute('data-current-status') === status) return;

  var isFailed = status === 'REJECTED';
  var isBlocked = status === 'BLOCKED';
  var activeIdx;
  if (isFailed) activeIdx = NIIS_LIFECYCLE_MINI_STAGES.indexOf('IN_REVIEW');
  else if (isBlocked) activeIdx = -1;
  else activeIdx = NIIS_LIFECYCLE_MINI_STAGES.indexOf(status);

  var items = card.querySelectorAll('.niis-lifecycle-mini-item');
  items.forEach(function (li, i) {
    var stageId = li.getAttribute('data-stage');
    var stateClass, icon;
    if (activeIdx === -1) {
      stateClass = 'upcoming';
      icon = NIIS_LIFECYCLE_MINI_DOT_SVG;
    } else if (i < activeIdx) {
      stateClass = 'passed';
      icon = NIIS_LIFECYCLE_MINI_CHECK_SVG;
    } else if (i === activeIdx) {
      stateClass = isFailed ? 'failed' : 'active';
      icon = NIIS_LIFECYCLE_MINI_DOT_SVG;
    } else {
      stateClass = 'upcoming';
      icon = NIIS_LIFECYCLE_MINI_DOT_SVG;
    }
    li.className = 'niis-lifecycle-mini-item niis-lifecycle-mini-' + stateClass;
    var iconEl = li.querySelector('.niis-lifecycle-mini-icon');
    if (iconEl) iconEl.innerHTML = icon;


    var existingRunner = li.querySelector('.niis-lifecycle-mini-runner');
    var shouldHaveRunner = i === activeIdx && stageId === 'IN_PROGRESS' && !isFailed;
    if (shouldHaveRunner && !existingRunner) {
      var runner = document.createElement('span');
      runner.className = 'niis-lifecycle-mini-runner';
      runner.setAttribute('aria-hidden', 'true');
      runner.innerHTML = NIIS_LIFECYCLE_MINI_RUNNER_SVG;
      li.appendChild(runner);
    } else if (!shouldHaveRunner && existingRunner) {
      existingRunner.remove();
    }
  });


  var existingBanner = card.querySelector('.niis-lifecycle-mini-banner');
  if (existingBanner) existingBanner.remove();
  if (isBlocked || isFailed) {
    var banner = document.createElement('div');
    banner.className = 'niis-lifecycle-mini-banner niis-lifecycle-mini-banner-' + (isBlocked ? 'blocked' : 'failed');
    banner.textContent = isBlocked ? 'Blocked' : 'Rejected';
    card.appendChild(banner);
  }

  card.setAttribute('data-current-status', status);
}

function createTaskCardRefresh(root, taskId) {
  return async function refreshTaskCard() {
    try {
      var response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/card?format=html', {
        cache: 'no-store',
      });

      if (!response.ok) {
        return;
      }

      root.innerHTML = await response.text();

      var statusEl = root.querySelector('[data-task-status]');
      if (statusEl) {
        syncStatusIndicators(taskId, statusEl.getAttribute('data-task-status'));
      }



      var headerCostTemplate = root.querySelector('template[data-live-header-cost]');
      var headerCostSlot = document.querySelector('[data-task-header-cost-slot]');
      if (headerCostTemplate && headerCostSlot) {
        headerCostSlot.innerHTML = headerCostTemplate.innerHTML;
      }
      var signals = niisDeriveTaskSignalsFromDom();
      niisUpdateFavicon(signals.status, signals.queueState);
    } catch {

    }
  };
}

function mountLiveTaskCard(root) {
  const taskId = root?.dataset?.taskId ?? null;
  if (!taskId) {
    return;
  }

  const refreshTaskCard = createTaskCardRefresh(root, taskId);
  let pollTimer = null;
  let socket = null;

  const stopPolling = () => {
    if (pollTimer === null) {
      return;
    }
    window.clearInterval(pollTimer);
    pollTimer = null;
  };

  const startPolling = () => {
    if (pollTimer !== null) {
      return;
    }
    pollTimer = window.setInterval(refreshTaskCard, 3000);
  };

  const connect = () => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${protocol}://${window.location.host}/__niis/live/ws?task_id=${encodeURIComponent(taskId)}`);

    socket.addEventListener("open", () => {
      stopPolling();
      refreshTaskCard();
    });

    socket.addEventListener("message", () => {
      refreshTaskCard();
    });

    socket.addEventListener("close", () => {
      startPolling();
    });

    socket.addEventListener("error", () => {
      socket?.close();
    });
  };

  refreshTaskCard();
  connect();
}

document.querySelectorAll("[data-task-live-card-root][data-task-id]").forEach((root) => {
  mountLiveTaskCard(root);
});










function mountLiveLogStream(panelEl) {
  var streamEl = panelEl.querySelector("[data-live-log-stream]");
  var statusEl = panelEl.querySelector("[data-live-log-status]");
  if (!streamEl) return;
  var taskId = streamEl.getAttribute("data-task-id");
  if (!taskId) return;
  var mode = streamEl.getAttribute("data-live-log-mode") || "live";
  var lastTs = null;
  var pollTimer = null;
  var socket = null;

  var setStatus = function (text) {
    if (statusEl) statusEl.textContent = text;
  };

  var appendEvent = function (event) {
    if (!event || !event.payload) return;
    var chunk = event.payload.chunk || "";
    var stream = event.payload.stream || "stdout";
    var marker = stream === "stderr" ? "[err] " : "";
    var line = document.createElement("span");
    line.setAttribute("data-stream", stream);
    line.textContent = marker + chunk;
    streamEl.appendChild(line);
    lastTs = event.ts || lastTs;
  };

  var trim = function () {

    var excess = streamEl.childNodes.length - 1000;
    for (var i = 0; i < excess; i += 1) {
      streamEl.removeChild(streamEl.firstChild);
    }
  };

  var fetchDelta = function () {
    var url = "/api/tasks/" + encodeURIComponent(taskId) + "/log/events"
      + (lastTs ? "?after=" + encodeURIComponent(lastTs) : "");
    fetch(url, { cache: "no-store" }).then(function (resp) {
      if (!resp.ok) { setStatus("(fetch failed " + resp.status + ")"); return; }
      return resp.json();
    }).then(function (body) {
      if (!body || !Array.isArray(body.events)) return;
      if (body.events.length === 0) {
        if (mode === "history" && streamEl.childNodes.length === 0) {
          setStatus("(no log events recorded)");
        }
        return;
      }
      for (var i = 0; i < body.events.length; i += 1) {
        appendEvent(body.events[i]);
      }
      trim();
      streamEl.scrollTop = streamEl.scrollHeight;
      setStatus(mode === "live"
        ? "(live, " + body.events.length + "+)"
        : "(" + streamEl.childNodes.length + " events)");
    }).catch(function () {
      setStatus("(fetch errored)");
    });
  };

  var connect = function () {
    var protocol = window.location.protocol === "https:" ? "wss" : "ws";
    try {
      socket = new WebSocket(protocol + "://" + window.location.host
        + "/__niis/live/ws?task_id=" + encodeURIComponent(taskId));
      socket.addEventListener("open", function () {
        setStatus("(live)");
        fetchDelta();
      });
      socket.addEventListener("message", function (ev) {
        try {
          var payload = JSON.parse(ev.data);


          if (payload && (payload.type === "task.run.log" || payload.type === "task.card.updated")) {
            fetchDelta();
          }
        } catch (_err) {  }
      });
      socket.addEventListener("close", function () {
        setStatus("(reconnecting)");
        if (pollTimer === null) {
          pollTimer = window.setInterval(fetchDelta, 1000);
        }
      });
      socket.addEventListener("error", function () {
        try { socket.close(); } catch (_err) {  }
      });
    } catch (_err) {
      setStatus("(polling)");
      pollTimer = window.setInterval(fetchDelta, 1000);
    }
  };

  if (mode === "history") {
    setStatus("(loading history…)");
    fetchDelta();
    return;
  }

  setStatus("(connecting…)");
  fetchDelta();
  connect();
}

document.querySelectorAll("[data-live-log-panel]").forEach(mountLiveLogStream);









var NIIS_SOUND_STORAGE_KEY = "niis.sound_notifications";
var NIIS_LAST_STATUS = new Map();
var NIIS_AUDIO_CTX = null;
var NIIS_TERMINAL_STATUSES = { DONE: "success", REJECTED: "failure", BLOCKED: "failure" };

function niisReadSoundSetting() {
  try {
    var stored = window.localStorage.getItem(NIIS_SOUND_STORAGE_KEY);
    return stored !== "off";
  } catch (_err) {
    return true;
  }
}

function niisWriteSoundSetting(enabled) {
  try {
    window.localStorage.setItem(NIIS_SOUND_STORAGE_KEY, enabled ? "on" : "off");
  } catch (_err) {  }
}

function niisEnsureAudioContext() {
  if (NIIS_AUDIO_CTX) return NIIS_AUDIO_CTX;
  var Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    NIIS_AUDIO_CTX = new Ctor();
    return NIIS_AUDIO_CTX;
  } catch (_err) {
    return null;
  }
}

function niisPlayNotificationTone(kind) {
  if (!niisReadSoundSetting()) return;
  var ctx = niisEnsureAudioContext();
  if (!ctx || ctx.state === "closed") return;
  if (ctx.state === "suspended") {


    try { ctx.resume().catch(function () {}); } catch (_err) {  }
    return;
  }
  var now = ctx.currentTime;
  var freqs = kind === "success" ? [659.25, 880.00] : [440.00, 349.23];
  for (var i = 0; i < freqs.length; i += 1) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freqs[i];
    var start = now + i * 0.18;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.15, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.18);
  }
}

function niisHandleTaskStatusChange(taskId, nextStatus) {
  if (!taskId || typeof nextStatus !== "string") return;
  var prev = NIIS_LAST_STATUS.get(taskId);
  NIIS_LAST_STATUS.set(taskId, nextStatus);
  if (prev === undefined || prev === nextStatus) return;



  if (typeof niisMarkTabStatus === "function") {
    try { niisMarkTabStatus(taskId, nextStatus); } catch (_err) {  }
  }
  var kind = NIIS_TERMINAL_STATUSES[nextStatus];
  if (kind) niisPlayNotificationTone(kind);
}

function niisSeedKnownTaskStatuses() {


  document.querySelectorAll("[data-task-id][data-task-status]").forEach(function (el) {
    var id = el.getAttribute("data-task-id");
    var status = el.getAttribute("data-task-status");
    if (id && status && !NIIS_LAST_STATUS.has(id)) {
      NIIS_LAST_STATUS.set(id, status);
    }
  });
}

function niisMountGlobalStatusWatcher() {
  niisSeedKnownTaskStatuses();
  if (typeof WebSocket === "undefined") return;
  var protocol = window.location.protocol === "https:" ? "wss" : "ws";
  var socket = null;
  var reconnectTimer = null;
  var connect = function () {
    try {
      socket = new WebSocket(protocol + "://" + window.location.host + "/__niis/live/ws");
    } catch (_err) {

      reconnectTimer = window.setTimeout(connect, 5000);
      return;
    }
    socket.addEventListener("message", function (ev) {
      var payload = null;
      try { payload = JSON.parse(ev.data); } catch (_err) { return; }
      if (!payload || !payload.task_id) return;
      if (payload.type !== "task.card.updated" && payload.type !== "connected") return;
      fetch("/api/tasks/" + encodeURIComponent(payload.task_id) + "/card", { cache: "no-store" })
        .then(function (resp) { return resp.ok ? resp.json() : null; })
        .then(function (body) {
          if (body && body.task && typeof body.task.status === "string") {
            niisHandleTaskStatusChange(payload.task_id, body.task.status);
          }
        })
        .catch(function () {  });
    });
    socket.addEventListener("close", function () {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, 5000);
    });
    socket.addEventListener("error", function () { try { socket.close(); } catch (_e) {} });
  };
  connect();
}

function niisMountSoundToggle() {
  var button = document.querySelector("[data-sound-toggle]");
  if (!button) return;
  var update = function () {
    var enabled = niisReadSoundSetting();
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.setAttribute("data-sound-enabled", enabled ? "true" : "false");
    button.setAttribute("title", enabled ? "Sound notifications on (click to mute)" : "Sound notifications muted (click to enable)");
  };
  update();
  button.addEventListener("click", function () {
    var next = !niisReadSoundSetting();
    niisWriteSoundSetting(next);
    update();
    if (next) {



      niisEnsureAudioContext();
      niisPlayNotificationTone("success");
    }
  });
}

niisMountGlobalStatusWatcher();
niisMountSoundToggle();















var NIIS_TABS_KEY = "niis.open_tabs";
var NIIS_CLOSED_TABS_KEY = "niis.closed_tabs";
var NIIS_TABS_MAX = 20;
var NIIS_CLOSED_TABS_MAX = 20;

function niisReadTabs() {
  try {
    var raw = window.localStorage.getItem(NIIS_TABS_KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(function (entry) {
        if (!entry || typeof entry.id !== "string" || typeof entry.href !== "string") return false;


        if (entry.id === "new" || entry.href === "/tasks/new") return false;
        return true;
      })
      .map(function (entry) {
        return {
          href: entry.href,
          id: entry.id,
          lastStatus: typeof entry.lastStatus === "string" ? entry.lastStatus : null,
          pinned: entry.pinned === true,
          title: entry.title || entry.id,
          unread: entry.unread === true,
        };
      });
  } catch (_err) { return []; }
}

function niisWriteTabs(tabs) {
  try {


    var ordered = tabs.slice().sort(function (a, b) {
      return (a.pinned === b.pinned) ? 0 : (a.pinned ? -1 : 1);
    });
    window.localStorage.setItem(NIIS_TABS_KEY, JSON.stringify(ordered.slice(0, NIIS_TABS_MAX)));
  } catch (_err) {  }
}

function niisReadClosedTabs() {
  try {
    var raw = window.localStorage.getItem(NIIS_CLOSED_TABS_KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) { return []; }
}

function niisPushClosedTab(tab) {
  if (!tab || !tab.id) return;
  var stack = niisReadClosedTabs();

  stack = stack.filter(function (entry) { return entry && entry.id !== tab.id; });
  stack.push({ href: tab.href, id: tab.id, pinned: tab.pinned === true, title: tab.title });
  if (stack.length > NIIS_CLOSED_TABS_MAX) stack = stack.slice(-NIIS_CLOSED_TABS_MAX);
  try { window.localStorage.setItem(NIIS_CLOSED_TABS_KEY, JSON.stringify(stack)); } catch (_err) {}
}

function niisPopClosedTab() {
  var stack = niisReadClosedTabs();
  if (stack.length === 0) return null;
  var tab = stack.pop();
  try { window.localStorage.setItem(NIIS_CLOSED_TABS_KEY, JSON.stringify(stack)); } catch (_err) {}
  return tab;
}

function niisParseCurrentTaskId() {
  var match = window.location.pathname.match(/^\/tasks\/([^/]+)\/?$/);
  if (!match) return null;
  var id = decodeURIComponent(match[1]);



  if (id === "new") return null;
  return id;
}

function niisDeriveTaskTitle(taskId) {
  var heading = document.querySelector(".niis-page-header-task h1, .niis-article header h1");
  var text = heading ? heading.textContent : "";
  text = text ? text.trim() : "";
  if (text) return text.length > 32 ? text.slice(0, 30) + "…" : text;
  return taskId.length > 16 ? taskId.slice(0, 14) + "…" : taskId;
}




function niisStatusBadgeColor(status) {
  if (!status) return null;
  var s = String(status).toUpperCase();
  if (s === "DONE") return "#16a34a";
  if (s === "REJECTED" || s === "BLOCKED" || s === "FAILED") return "#dc2626";
  if (s === "PLANNING") return "#a855f7";
  if (s === "IN_PROGRESS") return "#eab308";
  if (s === "IN_REVIEW") return "#0ea5e9";
  return null;
}






var NIIS_TAB_STATUS_ICON_SVGS = {
  UNPLANNED: '<svg class="niis-tab-status-icon" data-status="unplanned" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2.26946V6.4C14 6.96005 14 7.24008 14.109 7.45399C14.2049 7.64215 14.3578 7.79513 14.546 7.89101C14.7599 8 15.0399 8 15.6 8H19.7305M20 9.98822V17.2C20 18.8802 20 19.7202 19.673 20.362C19.3854 20.9265 18.9265 21.3854 18.362 21.673C17.7202 22 16.8802 22 15.2 22H8.8C7.11984 22 6.27976 22 5.63803 21.673C5.07354 21.3854 4.6146 20.9265 4.32698 20.362C4 19.7202 4 18.8802 4 17.2V6.8C4 5.11984 4 4.27976 4.32698 3.63803C4.6146 3.07354 5.07354 2.6146 5.63803 2.32698C6.27976 2 7.11984 2 8.8 2H12.0118C12.7455 2 13.1124 2 13.4577 2.08289C13.7638 2.15638 14.0564 2.27759 14.3249 2.44208C14.6276 2.6276 14.887 2.88703 15.4059 3.40589L18.5941 6.59411C19.113 7.11297 19.3724 7.3724 19.5579 7.67515C19.7224 7.94356 19.8436 8.2362 19.9171 8.5423C20 8.88757 20 9.25445 20 9.98822Z"/></svg>',
  PLANNING: '<svg class="niis-tab-status-icon" data-status="planning" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 18L19.9999 19.094C19.4695 19.6741 18.7502 20 18.0002 20C17.2501 20 16.5308 19.6741 16.0004 19.094C15.4693 18.5151 14.75 18.1901 14.0002 18.1901C13.2504 18.1901 12.5312 18.5151 12 19.094M3.00003 20H4.67457C5.16376 20 5.40835 20 5.63852 19.9447C5.84259 19.8957 6.03768 19.8149 6.21663 19.7053C6.41846 19.5816 6.59141 19.4086 6.93732 19.0627L19.5001 6.49998C20.3285 5.67156 20.3285 4.32841 19.5001 3.49998C18.6716 2.67156 17.3285 2.67156 16.5001 3.49998L3.93729 16.0627C3.59139 16.4086 3.41843 16.5816 3.29475 16.7834C3.18509 16.9624 3.10428 17.1574 3.05529 17.3615C3.00003 17.5917 3.00003 17.8363 3.00003 18.3255V20Z"/></svg>',
  PENDING: '<svg class="niis-tab-status-icon" data-status="pending" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg>',
  IN_PROGRESS: '<svg class="niis-tab-status-icon" data-status="in-progress" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6V12L16 14M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"/></svg>',
  BLOCKED: '<svg class="niis-tab-status-icon" data-status="blocked" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6 6l4 4"/><path d="M10 6l-4 4"/></svg>',
  IN_REVIEW: '<svg class="niis-tab-status-icon" data-status="in-review" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18.5708 20C19.8328 20 20.8568 18.977 20.8568 17.714V13.143L21.9998 12L20.8568 10.857V6.286C20.8568 5.023 19.8338 4 18.5708 4M5.429 4C4.166 4 3.143 5.023 3.143 6.286V10.857L2 12L3.143 13.143V17.714C3.143 18.977 4.166 20 5.429 20M7.5 12L9.93431 14.4343C10.1323 14.6323 10.2313 14.7313 10.3455 14.7684C10.4459 14.8011 10.5541 14.8011 10.6545 14.7684C10.7687 14.7313 10.8677 14.6323 11.0657 14.4343L16.5 9"/></svg>',
  DONE: '<svg class="niis-tab-status-icon" data-status="done" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 12L10.5 15L16.5 9M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"/></svg>',
  REJECTED: '<svg class="niis-tab-status-icon" data-status="rejected" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M5 8h6"/></svg>',
};

function niisStatusIconSvg(status) {
  if (!status) return NIIS_TAB_STATUS_ICON_SVGS.UNPLANNED;
  var key = String(status).toUpperCase();
  return NIIS_TAB_STATUS_ICON_SVGS[key] || NIIS_TAB_STATUS_ICON_SVGS.UNPLANNED;
}





function niisFindStatusInDom(taskId) {
  if (!taskId) return null;

  var live = document.querySelector('[data-task-live-card-root][data-task-id="' + taskId + '"] [data-task-status]');
  if (live && live.getAttribute("data-task-status")) return live.getAttribute("data-task-status");

  var card = document.querySelector('[data-task-id="' + taskId + '"][data-task-status]');
  if (card && card.getAttribute("data-task-status")) return card.getAttribute("data-task-status");

  var label = document.querySelector('[data-task-status-display="label"][data-task-status-value]');
  if (label && label.getAttribute("data-task-status-value")) return label.getAttribute("data-task-status-value");
  return null;
}

function niisEscapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function niisRenderTabs(barEl, tabs, currentTaskId) {
  if (tabs.length === 0) {
    barEl.style.display = "none";
    barEl.innerHTML = "";
    return;
  }
  barEl.style.display = "";
  barEl.innerHTML = tabs.map(function (tab) {
    var isActive = tab.id === currentTaskId;
    var classes = ["niis-tab"];
    if (isActive) classes.push("niis-tab-active");
    if (tab.pinned) classes.push("niis-tab-pinned");
    if (tab.unread) classes.push("niis-tab-unread");
    var titleAttr = niisEscapeHtml(tab.title || tab.id);
    var safeId = tab.id.replace(/"/g, "%22");
    var safeHref = tab.href.replace(/"/g, "%22");



    var statusIconHtml = '<span class="niis-tab-status">' + niisStatusIconSvg(tab.lastStatus);
    if (tab.unread) {
      var dotColor = niisStatusBadgeColor(tab.lastStatus) || "var(--niis-accent)";
      statusIconHtml += '<span class="niis-tab-unread-dot" style="background:' + dotColor + '" aria-label="Status changed"></span>';
    }
    statusIconHtml += '</span>';
    var pinIconHtml = tab.pinned
      ? '<svg class="niis-tab-pin-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.0004 15L12.0004 22M8.00043 7.30813V9.43875C8.00043 9.64677 8.00043 9.75078 7.98001 9.85026C7.9619 9.93852 7.93194 10.0239 7.89095 10.1042C7.84474 10.1946 7.77977 10.2758 7.64982 10.4383L6.08004 12.4005C5.4143 13.2327 5.08143 13.6487 5.08106 13.9989C5.08073 14.3035 5.21919 14.5916 5.4572 14.7815C5.73088 15 6.26373 15 7.32943 15H16.6714C17.7371 15 18.27 15 18.5437 14.7815C18.7817 14.5916 18.9201 14.3035 18.9198 13.9989C18.9194 13.6487 18.5866 13.2327 17.9208 12.4005L16.351 10.4383C16.2211 10.2758 16.1561 10.1946 16.1099 10.1042C16.0689 10.0239 16.039 9.93852 16.0208 9.85026C16.0004 9.75078 16.0004 9.64677 16.0004 9.43875V7.30813C16.0004 7.19301 16.0004 7.13544 16.0069 7.07868C16.0127 7.02825 16.0223 6.97833 16.0357 6.92937C16.0507 6.87424 16.0721 6.8208 16.1149 6.71391L17.1227 4.19423C17.4168 3.45914 17.5638 3.09159 17.5025 2.79655C17.4489 2.53853 17.2956 2.31211 17.0759 2.1665C16.8247 2 16.4289 2 15.6372 2H8.36368C7.57197 2 7.17611 2 6.92494 2.1665C6.70529 2.31211 6.55199 2.53853 6.49838 2.79655C6.43707 3.09159 6.58408 3.45914 6.87812 4.19423L7.88599 6.71391C7.92875 6.8208 7.95013 6.87424 7.96517 6.92937C7.97853 6.97833 7.98814 7.02825 7.99392 7.07868C8.00043 7.13544 8.00043 7.19301 8.00043 7.30813Z"/></svg>'
      : '';
    var closeBtnHtml = tab.pinned
      ? ''
      : '<button type="button" class="niis-tab-close" data-tab-close="' + safeId + '" aria-label="Close tab" title="Close tab (middle-click works too)"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>';
    return ''
      + '<div class="' + classes.join(' ') + '" data-tab-id="' + safeId + '" draggable="true">' + '<div class="tab-wrap">'
      + '<a class="niis-tab-link" href="' + safeHref + '" title="' + titleAttr + '">'
      + statusIconHtml + pinIconHtml
      + '<span class="niis-tab-title">' + titleAttr + '</span>'
      + '</a>'
      + closeBtnHtml
      + '</div>'
      + '</div>';
  }).join("");
}

function niisFindTabIndex(tabs, tabId) {
  for (var i = 0; i < tabs.length; i += 1) {
    if (tabs[i].id === tabId) return i;
  }
  return -1;
}

function niisCloseTab(tabId, tabs, currentTaskId) {
  var idx = niisFindTabIndex(tabs, tabId);
  if (idx < 0) return tabs;
  var closing = tabs[idx];
  if (closing.pinned) {

    return tabs;
  }
  var next = tabs.slice();
  next.splice(idx, 1);
  niisPushClosedTab(closing);
  niisWriteTabs(next);
  if (tabId === currentTaskId) {
    var fallback = next[idx] || next[idx - 1] || null;
    window.location.href = fallback ? fallback.href : "/tasks";
  }
  return next;
}

function niisTogglePin(tabId, tabs) {
  var next = tabs.map(function (tab) {
    if (tab.id !== tabId) return tab;
    return Object.assign({}, tab, { pinned: !tab.pinned });
  });
  niisWriteTabs(next);
  return niisReadTabs();
}

function niisReorderTabs(fromId, toId, position, tabs) {
  if (!fromId || fromId === toId) return tabs;
  var fromIdx = niisFindTabIndex(tabs, fromId);
  if (fromIdx < 0) return tabs;
  var moving = tabs[fromIdx];
  var without = tabs.slice();
  without.splice(fromIdx, 1);


  var toIdx = toId ? niisFindTabIndex(without, toId) : without.length;
  if (toIdx < 0) toIdx = without.length;
  var insertAt = position === "after" ? toIdx + 1 : toIdx;
  if (toId && without[toIdx]) {
    moving = Object.assign({}, moving, { pinned: without[toIdx].pinned });
  }
  without.splice(insertAt, 0, moving);
  niisWriteTabs(without);
  return niisReadTabs();
}




function niisMarkTabStatus(taskId, status) {
  var tabs = niisReadTabs();
  var idx = niisFindTabIndex(tabs, taskId);
  if (idx < 0) return;
  var prev = tabs[idx];
  var isCurrent = niisParseCurrentTaskId() === taskId;
  if (prev.lastStatus === status && (!isCurrent || prev.unread === false)) return;
  tabs[idx] = Object.assign({}, prev, {
    lastStatus: status,
    unread: isCurrent ? false : true,
  });
  niisWriteTabs(tabs);
  var barEl = document.querySelector("[data-tab-bar]");
  if (barEl) niisRenderTabs(barEl, niisReadTabs(), niisParseCurrentTaskId());
}

function niisMountTabBar() {
  var barEl = document.querySelector("[data-tab-bar]");
  if (!barEl) return;
  var currentTaskId = niisParseCurrentTaskId();

  var tabs = niisReadTabs();


  if (currentTaskId) {
    var domStatus = niisFindStatusInDom(currentTaskId);
    var idx = niisFindTabIndex(tabs, currentTaskId);
    if (idx < 0) {
      tabs.push({
        href: window.location.pathname + window.location.search,
        id: currentTaskId,
        lastStatus: domStatus,
        pinned: false,
        title: niisDeriveTaskTitle(currentTaskId),
        unread: false,
      });
      niisWriteTabs(tabs);
      tabs = niisReadTabs();
    } else {
      var fresh = niisDeriveTaskTitle(currentTaskId);
      var changed = false;
      if (tabs[idx].title !== fresh) { tabs[idx].title = fresh; changed = true; }
      if (domStatus && tabs[idx].lastStatus !== domStatus) { tabs[idx].lastStatus = domStatus; changed = true; }
      if (tabs[idx].unread) { tabs[idx].unread = false; changed = true; }
      if (changed) {
        niisWriteTabs(tabs);
        tabs = niisReadTabs();
      }
    }
  }

  niisRenderTabs(barEl, tabs, currentTaskId);


  barEl.addEventListener("click", function (ev) {
    var closeBtn = ev.target.closest && ev.target.closest("[data-tab-close]");
    if (closeBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      var tid = closeBtn.getAttribute("data-tab-close");
      var nextTabs = niisCloseTab(tid, niisReadTabs(), currentTaskId);
      niisRenderTabs(barEl, nextTabs, currentTaskId);
    }
  });
  barEl.addEventListener("mousedown", function (ev) {
    if (ev.button !== 1) return;
    var tabEl = ev.target.closest && ev.target.closest("[data-tab-id]");
    if (!tabEl) return;
    ev.preventDefault();
    var tid = tabEl.getAttribute("data-tab-id");
    var nextTabs = niisCloseTab(tid, niisReadTabs(), currentTaskId);
    niisRenderTabs(barEl, nextTabs, currentTaskId);
  });


  barEl.addEventListener("contextmenu", function (ev) {
    var tabEl = ev.target.closest && ev.target.closest("[data-tab-id]");
    if (!tabEl) return;
    ev.preventDefault();
    var tid = tabEl.getAttribute("data-tab-id");
    niisShowTabContextMenu(ev.clientX, ev.clientY, tid, currentTaskId, function () {
      niisRenderTabs(barEl, niisReadTabs(), currentTaskId);
    });
  });


  var draggedId = null;
  barEl.addEventListener("dragstart", function (ev) {
    var tabEl = ev.target.closest && ev.target.closest("[data-tab-id]");
    if (!tabEl) return;
    draggedId = tabEl.getAttribute("data-tab-id");
    tabEl.classList.add("niis-tab-dragging");
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      try { ev.dataTransfer.setData("text/plain", draggedId); } catch (_e) {  }
    }
  });
  barEl.addEventListener("dragend", function (ev) {
    var tabEl = ev.target.closest && ev.target.closest("[data-tab-id]");
    if (tabEl) tabEl.classList.remove("niis-tab-dragging");
    barEl.querySelectorAll(".niis-tab-drop-before, .niis-tab-drop-after").forEach(function (el) {
      el.classList.remove("niis-tab-drop-before", "niis-tab-drop-after");
    });
    draggedId = null;
  });
  barEl.addEventListener("dragover", function (ev) {
    if (!draggedId) return;
    var tabEl = ev.target.closest && ev.target.closest("[data-tab-id]");
    if (!tabEl) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    barEl.querySelectorAll(".niis-tab-drop-before, .niis-tab-drop-after").forEach(function (el) {
      el.classList.remove("niis-tab-drop-before", "niis-tab-drop-after");
    });
    var rect = tabEl.getBoundingClientRect();
    var midpoint = rect.left + rect.width / 2;
    tabEl.classList.add(ev.clientX < midpoint ? "niis-tab-drop-before" : "niis-tab-drop-after");
  });
  barEl.addEventListener("drop", function (ev) {
    if (!draggedId) return;
    var tabEl = ev.target.closest && ev.target.closest("[data-tab-id]");
    if (!tabEl) return;
    ev.preventDefault();
    var targetId = tabEl.getAttribute("data-tab-id");
    var rect = tabEl.getBoundingClientRect();
    var position = ev.clientX < rect.left + rect.width / 2 ? "before" : "after";
    var nextTabs = niisReorderTabs(draggedId, targetId, position, niisReadTabs());
    niisRenderTabs(barEl, nextTabs, currentTaskId);
    draggedId = null;
  });


  window.addEventListener("storage", function (ev) {
    if (ev.key !== NIIS_TABS_KEY) return;
    niisRenderTabs(barEl, niisReadTabs(), currentTaskId);
  });










  document.addEventListener("keydown", function (ev) {
    var meta = ev.metaKey || ev.ctrlKey;
    if (!meta || !ev.shiftKey) return;
    var key = (ev.key || "").toLowerCase();
    if (key === "w") {

      if (!currentTaskId) return;
      ev.preventDefault();
      var afterClose = niisCloseTab(currentTaskId, niisReadTabs(), currentTaskId);
      niisRenderTabs(barEl, afterClose, currentTaskId);
    } else if (key === "t") {
      ev.preventDefault();
      var restored = niisPopClosedTab();
      if (!restored) return;

      var tabsNow = niisReadTabs();
      if (niisFindTabIndex(tabsNow, restored.id) < 0) {
        tabsNow.push({
          href: restored.href,
          id: restored.id,
          lastStatus: null,
          pinned: restored.pinned === true,
          title: restored.title,
          unread: false,
        });
        niisWriteTabs(tabsNow);
      }
      window.location.href = restored.href;
    }
  });
}

function niisShowTabContextMenu(x, y, tabId, currentTaskId, onChange) {


  var existing = document.querySelector("[data-tab-context-menu]");
  if (existing) existing.remove();

  var tabs = niisReadTabs();
  var tab = tabs[niisFindTabIndex(tabs, tabId)];
  if (!tab) return;

  var menu = document.createElement("div");
  menu.className = "niis-tab-context-menu";
  menu.setAttribute("data-tab-context-menu", "true");
  menu.style.left = x + "px";
  menu.style.top = y + "px";

  var items = [
    {
      action: function () {
        niisTogglePin(tabId, niisReadTabs());
        onChange();
      },
      label: tab.pinned ? "Unpin tab" : "Pin tab",
    },
    {
      action: function () {
        if (tab.pinned) return;
        niisCloseTab(tabId, niisReadTabs(), currentTaskId);
        onChange();
      },
      disabled: tab.pinned,
      label: "Close tab",
    },
    {
      action: function () {
        var keep = niisReadTabs().filter(function (t) { return t.pinned || t.id === tabId; });
        var closed = niisReadTabs().filter(function (t) { return !t.pinned && t.id !== tabId; });
        for (var i = 0; i < closed.length; i += 1) niisPushClosedTab(closed[i]);
        niisWriteTabs(keep);
        onChange();
      },
      label: "Close other tabs",
    },
    {
      action: function () {
        var idx = niisFindTabIndex(niisReadTabs(), tabId);
        var keep = niisReadTabs().filter(function (t, i) { return t.pinned || i <= idx; });
        var closed = niisReadTabs().filter(function (t, i) { return !t.pinned && i > idx; });
        for (var i = 0; i < closed.length; i += 1) niisPushClosedTab(closed[i]);
        niisWriteTabs(keep);
        onChange();
      },
      label: "Close tabs to the right",
    },
  ];

  menu.innerHTML = items.map(function (item, idx) {
    return '<button type="button" class="niis-tab-context-item" data-context-idx="' + idx + '"'
      + (item.disabled ? ' disabled' : '') + '>' + niisEscapeHtml(item.label) + '</button>';
  }).join("");

  document.body.appendChild(menu);

  menu.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-context-idx]");
    if (!btn || btn.disabled) return;
    var idx = Number(btn.getAttribute("data-context-idx"));
    if (Number.isInteger(idx) && items[idx]) items[idx].action();
    menu.remove();
  });



  var dismiss = function (ev) {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener("mousedown", dismiss);
  };
  setTimeout(function () { document.addEventListener("mousedown", dismiss); }, 0);
}

niisMountTabBar();








function niisMountModeToggle() {
  var form = document.querySelector("[data-mode-toggle-form]");
  if (!form) return;
  var input = form.querySelector("[data-mode-toggle-input]");
  var hidden = form.querySelector("[data-mode-toggle-value]");
  var label = form.querySelector("[data-mode-toggle-label]");
  if (!input || !hidden) return;
  var inFlight = false;
  input.addEventListener("change", function () {
    if (inFlight) return;
    inFlight = true;
    form.setAttribute("data-busy", "true");
    var nextMode = input.checked ? "auto" : "semi";
    hidden.value = nextMode;
    if (label) label.textContent = nextMode === "auto" ? "Auto" : "Semi";
    var fd = new FormData(form);
    var done = function (failed) {
      inFlight = false;
      form.removeAttribute("data-busy");
      if (failed) {

        input.checked = !input.checked;
        hidden.value = input.checked ? "auto" : "semi";
        if (label) label.textContent = input.checked ? "Auto" : "Semi";
      }
    };
    fetch(form.getAttribute("action") || "/project/mode", {
      body: fd,



      redirect: "manual",
      method: "POST",
    }).then(function (resp) {



      var ok = resp.type === "opaqueredirect" || (resp.status >= 200 && resp.status < 400);
      done(!ok);
    }).catch(function () { done(true); });
  });
}

niisMountModeToggle();




function niisMountRoleToggles() {
  document.addEventListener("change", function (e) {
    if (!e.target.matches || !e.target.matches("[data-role-toggle-input]")) return;
    var input = e.target;
    var form = input.closest("form");
    if (!form || form.getAttribute("data-busy") === "true") return;
    var hidden = form.querySelector("[data-role-toggle-value]");
    var nextEnabled = input.checked ? "1" : "0";
    if (hidden) hidden.value = nextEnabled;
    form.setAttribute("data-busy", "true");
    var fd = new FormData(form);
    var body = new URLSearchParams();
    fd.forEach(function (value, key) { body.append(key, value); });
    var rollback = function () {
      input.checked = !input.checked;
      if (hidden) hidden.value = input.checked ? "1" : "0";
    };
    fetch(form.getAttribute("action"), {
      body: body,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    }).then(function (resp) {
      var ok = resp.type === "opaqueredirect" || (resp.status >= 200 && resp.status < 400);
      if (!ok) rollback();


      else window.location.reload();
    }).catch(function () { rollback(); }).finally(function () {
      form.removeAttribute("data-busy");
    });
  });
}

niisMountRoleToggles();





function niisMountSidebarGroups() {
  var STORAGE_KEY = "niis.sidebar_groups";
  var cache = {};
  try {
    var raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) cache = JSON.parse(raw) || {};
  } catch (_err) { cache = {}; }
  var groups = document.querySelectorAll("[data-sidebar-group]");
  groups.forEach(function (group) {
    var key = group.getAttribute("data-sidebar-group");
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      if (cache[key]) group.setAttribute("open", ""); else group.removeAttribute("open");
    }
    group.addEventListener("toggle", function () {
      cache[key] = group.hasAttribute("open");
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); } catch (_err) {  }
    });
  });
}

niisMountSidebarGroups();



(function () {
  var signals = niisDeriveTaskSignalsFromDom();
  niisUpdateFavicon(signals.status, signals.queueState);
})();
