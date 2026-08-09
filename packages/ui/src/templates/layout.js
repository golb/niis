import { escapeHtml } from "../render-utils.js";

function renderNiisSidebar({ sections = [], renderStatusIcon = null } = {}) {






  return `
    <aside class="niis-sidebar">
      ${sections.map((section) => {
        const groupKey = section.key || section.title.toLowerCase().replace(/\s+/g, "-");
        const openAttr = section.defaultOpen === false ? "" : " open";
        const badgeHtml = typeof section.badge === "number" && section.badge > 0
          ? `<span class="niis-sidebar-group-badge">${escapeHtml(section.badge)}</span>`
          : "";
        const titleHtml = section.headerHref
          ? `<a class="niis-sidebar-group-title niis-sidebar-group-title-link" href="${escapeHtml(section.headerHref)}" data-niis-stop-propagation>${escapeHtml(section.title)}</a>`
          : `<span class="niis-sidebar-group-title">${escapeHtml(section.title)}</span>`;
        const defaultChevronSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8L12 17L21 8"/></svg>`;
        const iconClass = section.iconSvg
          ? "niis-sidebar-group-chevron niis-sidebar-group-chevron-static"
          : "niis-sidebar-group-chevron";
        const iconInner = section.iconSvg || defaultChevronSvg;




        const iconHtml = section.headerHref
          ? `<a class="${iconClass}" href="${escapeHtml(section.headerHref)}" data-niis-stop-propagation aria-hidden="true" tabindex="-1">${iconInner}</a>`
          : `<span class="${iconClass}" aria-hidden="true">${iconInner}</span>`;
        return `
        <details class="niis-sidebar-group" data-sidebar-group="${escapeHtml(groupKey)}"${openAttr}>
          <summary class="niis-sidebar-group-summary">
            ${iconHtml}
            ${titleHtml}
            ${badgeHtml}
          </summary>
          <nav class="niis-sidebar-nav">
            ${section.items.length === 0
              ? ""
              : section.items.map((item) => `
                <a href="${escapeHtml(item.href)}" class="niis-sidebar-link${item.active ? " niis-sidebar-link-active" : ""}${item.status ? " niis-sidebar-link-with-status" : ""}">
                  ${item.status && renderStatusIcon ? renderStatusIcon(item.status) : ""}
                  <span class="niis-sidebar-link-label">${escapeHtml(item.label)}</span>
                </a>`).join("")}
          </nav>
        </details>`;
      }).join("")}
    </aside>`;
}





function buildNiisSidebarTree({
  approvalCount = 0,
  approvalEntries = [],
  currentRoute = "",
  currentTaskId = null,
  tasks = [],
} = {}) {
  const tasksItems = tasks.length === 0
    ? []
    : tasks.map((task) => ({
      active: task.task_id === currentTaskId,
      href: `/tasks/${encodeURIComponent(task.task_id)}`,
      label: task.task_title || task.task_id,
      status: task.status,
    }));
  const approvalItems = approvalEntries.length === 0
    ? []
    : approvalEntries.slice(0, 12).map((entry) => ({
      active: false,
      href: entry.task_id ? `/tasks/${encodeURIComponent(entry.task_id)}` : "/approvals",
      label: entry.task_title || entry.summary || entry.id || "approval",
      status: entry.task_status,
    }));
  const projectItems = [];
  return [
    {
      defaultOpen: true,
      items: tasksItems,
      key: "tasks",
      title: "Tasks",
    },
    {
      badge: approvalCount,
      defaultOpen: approvalCount > 0 || currentRoute === "approvals",
      headerHref: "/approvals",
      iconSvg: `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 8V5.2C16 4.0799 16 3.51984 15.782 3.09202C15.5903 2.71569 15.2843 2.40973 14.908 2.21799C14.4802 2 13.9201 2 12.8 2H5.2C4.0799 2 3.51984 2 3.09202 2.21799C2.71569 2.40973 2.40973 2.71569 2.21799 3.09202C2 3.51984 2 4.0799 2 5.2V12.8C2 13.9201 2 14.4802 2.21799 14.908C2.40973 15.2843 2.71569 15.5903 3.09202 15.782C3.51984 16 4.0799 16 5.2 16H8M12 15L14 17L18.5 12.5M11.2 22H18.8C19.9201 22 20.4802 22 20.908 21.782C21.2843 21.5903 21.5903 21.2843 21.782 20.908C22 20.4802 22 19.9201 22 18.8V11.2C22 10.0799 22 9.51984 21.782 9.09202C21.5903 8.71569 21.2843 8.40973 20.908 8.21799C20.4802 8 19.9201 8 18.8 8H11.2C10.0799 8 9.51984 8 9.09202 8.21799C8.71569 8.40973 8.40973 8.71569 8.21799 9.09202C8 9.51984 8 10.0799 8 11.2V18.8C8 19.9201 8 20.4802 8.21799 20.908C8.40973 21.2843 8.71569 21.5903 9.09202 21.782C9.51984 22 10.0799 22 11.2 22Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      items: approvalItems,
      key: "approvals",
      title: "Approvals",
    },
    {
      defaultOpen: currentRoute === "project",
      headerHref: "/project",
      iconSvg: `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8H16M16 8V20.5M16 8L20.5 3.5M21 15.3373V3.8C21 3.51997 21 3.37996 20.9455 3.273C20.8976 3.17892 20.8211 3.10243 20.727 3.0545C20.62 3 20.48 3 20.2 3H8.66274C8.41815 3 8.29586 3 8.18077 3.02763C8.07873 3.05213 7.98119 3.09253 7.89172 3.14736C7.7908 3.2092 7.70432 3.29568 7.53137 3.46863L3.46863 7.53137C3.29568 7.70432 3.2092 7.7908 3.14736 7.89172C3.09253 7.98119 3.05213 8.07873 3.02763 8.18077C3 8.29586 3 8.41815 3 8.66274V20.2C3 20.48 3 20.62 3.0545 20.727C3.10243 20.8211 3.17892 20.8976 3.273 20.9455C3.37996 21 3.51997 21 3.8 21H15.3373C15.5818 21 15.7041 21 15.8192 20.9724C15.9213 20.9479 16.0188 20.9075 16.1083 20.8526C16.2092 20.7908 16.2957 20.7043 16.4686 20.5314L20.5314 16.4686C20.7043 16.2957 20.7908 16.2092 20.8526 16.1083C20.9075 16.0188 20.9479 15.9213 20.9724 15.8192C21 15.7041 21 15.5818 21 15.3373Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      items: projectItems,
      key: "project",
      title: "Project",
    },
    {
      defaultOpen: currentRoute === "agents",
      headerHref: "/agents",
      iconSvg: `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      items: [],
      key: "agents",
      title: "Agents",
    },
    {
      defaultOpen: currentRoute === "insights",
      headerHref: "/insights",
      iconSvg: `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3v18h18M7 14l4-4 4 4 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      items: [],
      key: "insights",
      title: "Insights",
    },
  ];
}

function renderNiisModeToggle({ mode = "semi", returnTo = "" } = {}) {







  const escapedReturn = escapeHtml(returnTo || "");
  const isAuto = mode === "auto";
  return `
    <form method="post" action="/project/mode" class="niis-mode-toggle-form" data-mode-toggle-form title="Autonomous worker mode: AUTO picks up new tasks automatically; SEMI waits for operator to press Start.">
      <input type="hidden" name="return_to" value="${escapedReturn}" />
      <input type="hidden" name="mode" value="${isAuto ? "auto" : "semi"}" data-mode-toggle-value />
      <span class="niis-mode-toggle-label" data-mode-toggle-label>${isAuto ? "Auto" : "Semi"}</span>
      <label class="niis-mode-toggle-switch">
        <input type="checkbox" class="niis-mode-toggle-input" data-mode-toggle-input ${isAuto ? "checked" : ""} aria-label="Toggle autonomous worker mode" />
        <span class="niis-mode-toggle-track" aria-hidden="true"></span>
      </label>
    </form>`;
}




const TOPBAR_BREADCRUMB_SEGMENTS = {
  tasks: "tasks",
  "task-detail": "tasks",
  "task-new": "tasks/new",
  approvals: "approvals",
  project: "project",
  agents: "agents",
  insights: "insights",
  pipeline: "pipeline",
};

function renderNiisTopbar({ currentRoute = "", rightTabs = false, workerMode = "semi", returnTo = "" } = {}) {
  const tocIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;

  const rightTabsHtml = rightTabs ? `
        <div class="niis-topbar-subnav-right">
          <button type="button" class="niis-topbar-tab niis-topbar-tab-active" data-toc-tab="page">${tocIcon} On this page</button>
          <button type="button" class="niis-topbar-tab" data-toc-tab="state">State</button>
        </div>` : "";

  const breadcrumbSegment = TOPBAR_BREADCRUMB_SEGMENTS[currentRoute] ?? "";
  const breadcrumbSuffix = breadcrumbSegment
    ? `<span class="niis-topbar-logo-suffix">/${escapeHtml(breadcrumbSegment)}</span>`
    : "";

  return `
    <header class="niis-topbar">
      <div class="niis-topbar-main">
        <a href="/" class="niis-topbar-logo">niis${breadcrumbSuffix}</a>
        <div class="niis-topbar-center">
          <div class="niis-topbar-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <span class="niis-topbar-search-text">Search...</span>
            <span class="niis-topbar-search-shortcut">⌘K</span>
            <span class="niis-topbar-search-ai">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
              Ask AI
            </span>
          </div>
        </div>
        <nav class="niis-topbar-actions">
          ${renderNiisModeToggle({ mode: workerMode, returnTo })}
          <button type="button" class="niis-sound-toggle" data-sound-toggle aria-label="Toggle sound notifications" title="Sound notifications">
            <svg class="niis-sound-toggle-on" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
            <svg class="niis-sound-toggle-off" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>
          </button>
          <a href="/pipeline#new-task" class="niis-topbar-new-task">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            New task
          </a>
          <button type="button" class="niis-theme-toggle" aria-label="Toggle theme" data-niis-theme-toggle>
            <svg class="niis-theme-toggle-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
            <svg class="niis-theme-toggle-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
          </button>
        </nav>
      </div>
      ${rightTabsHtml ? `<div class="niis-topbar-subnav"><div class="niis-topbar-subnav-inner"></div>${rightTabsHtml}</div>` : ""}
    </header>`;
}

function renderNiisToc(items = [], { title = "On this page", extra = "", lifecycle = "", statePanel = "" } = {}) {
  const tocIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
  const hasTabs = statePanel !== "";
  if (hasTabs) {
    return `
      <aside class="niis-toc">
        <div class="niis-toc-panel" data-panel="page">
          ${lifecycle}
          <nav class="niis-toc-card">
            <ul>
              ${items.map((item, index) => `<li><a class="${index === 0 ? "niis-toc-link-active" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`).join("")}
            </ul>
          </nav>
          ${extra}
        </div>
        <div class="niis-toc-panel niis-toc-panel-hidden" data-panel="state">
          ${statePanel}
        </div>
      </aside>`;
  }
  return `
    <aside class="niis-toc">
      ${lifecycle}
      <nav class="niis-toc-card">
        <h4>
          ${tocIcon}
          ${escapeHtml(title)}
        </h4>
        <ul>
          ${items.map((item, index) => `<li><a class="${index === 0 ? "niis-toc-link-active" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`).join("")}
        </ul>
      </nav>
      ${extra}
    </aside>`;
}

function renderNiisLayout({
  header,
  leftSidebar,
  main,
  rightSidebar,
} = {}) {
  return `
    <div class="niis-shell">
      ${header}
      <div class="niis-body">
        ${leftSidebar}
        <div class="niis-content-with-tabs">
          <nav class="niis-tab-bar" data-tab-bar aria-label="Open task tabs"></nav>
          <div class="niis-content">
            <main class="niis-main">
              ${main}
            </main>
            ${rightSidebar}
          </div>
        </div>
      </div>
    </div>`;
}

function renderControlPlaneDocumentHead({ assetUrls, refreshSeconds = null, scriptNonce = null, title }) {
  const nonceAttribute = scriptNonce ? ` nonce="${escapeHtml(scriptNonce)}"` : "";
  return `
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${refreshSeconds ? `<meta http-equiv="refresh" content="${escapeHtml(refreshSeconds)}" />` : ""}
    <link rel="stylesheet" href="${escapeHtml(assetUrls.css)}" />
    <script${nonceAttribute}>
      (function() {
        var theme = localStorage.getItem('niis-theme');
        if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
          document.documentElement.classList.add('dark');
        }
        window.niisToggleTheme = function() {
          var isDark = document.documentElement.classList.toggle('dark');
          localStorage.setItem('niis-theme', isDark ? 'dark' : 'light');
        };
      })();
      document.addEventListener('DOMContentLoaded', function() {
        document.querySelectorAll('[data-niis-stop-propagation]').forEach(function(element) {
          element.addEventListener('click', function(event) { event.stopPropagation(); });
        });
        document.querySelectorAll('[data-niis-theme-toggle]').forEach(function(element) {
          element.addEventListener('click', function() { window.niisToggleTheme(); });
        });
        document.querySelectorAll('[data-niis-confirm]').forEach(function(form) {
          form.addEventListener('submit', function(event) {
            if (!window.confirm(form.getAttribute('data-niis-confirm'))) event.preventDefault();
          });
        });
        var sidebarLinks = document.querySelectorAll('.niis-sidebar-link');
        var currentPath = window.location.pathname;
        sidebarLinks.forEach(function(link) {
          link.classList.remove('niis-sidebar-link-active');
          var href = link.getAttribute('href');
          if (href === currentPath || (currentPath.startsWith(href) && href !== '/')) {
            link.classList.add('niis-sidebar-link-active');
          }
        });
        var tocLinks = document.querySelectorAll('.niis-toc-card a');
        if (tocLinks.length) {
          var ACTIVE_OFFSET_PX = 96;
          var tocEntries = [];
          tocLinks.forEach(function(link) {
            var href = link.getAttribute('href');
            if (href && href.charAt(0) === '#') {
              tocEntries.push({ id: href.slice(1), link: link });
            }
          });
          if (tocEntries.length) {
            var rafScheduled = false;
            var setActive = function(target) {
              tocLinks.forEach(function(link) { link.classList.remove('niis-toc-link-active'); });
              if (target) target.link.classList.add('niis-toc-link-active');
            };
            var updateActive = function() {
              rafScheduled = false;
              var resolved = [];
              for (var i = 0; i < tocEntries.length; i++) {
                var el = document.getElementById(tocEntries[i].id);
                if (!el) continue;
                resolved.push({
                  link: tocEntries[i].link,
                  top: el.getBoundingClientRect().top,
                });
              }
              if (!resolved.length) return;
              resolved.sort(function(a, b) { return a.top - b.top; });
              var active = resolved[0];
              for (var j = 0; j < resolved.length; j++) {
                if (resolved[j].top - ACTIVE_OFFSET_PX <= 0) active = resolved[j];
                else break;
              }
              setActive(active);
            };
            var schedule = function() {
              if (rafScheduled) return;
              rafScheduled = true;
              window.requestAnimationFrame(updateActive);
            };
            window.addEventListener('scroll', schedule, { capture: true, passive: true });
            window.addEventListener('resize', schedule, { passive: true });
            var liveCardRoot = document.getElementById('task-live-card-root');
            if (liveCardRoot && typeof MutationObserver === 'function') {
              new MutationObserver(schedule).observe(liveCardRoot, { childList: true, subtree: true });
            }
            tocLinks.forEach(function(link) {
              link.addEventListener('click', function() {
                var idx = -1;
                for (var k = 0; k < tocEntries.length; k++) {
                  if (tocEntries[k].link === link) { idx = k; break; }
                }
                if (idx >= 0) setActive({ link: link });
              });
            });
            updateActive();
          }
        }
        document.querySelectorAll('.niis-status-dropdown').forEach(function(dropdown) {
          var trigger = dropdown.querySelector('.niis-status-dropdown-trigger');
          var menu = dropdown.querySelector('.niis-status-dropdown-menu');
          if (!trigger || !menu) return;
          trigger.addEventListener('click', function(e) {
            e.stopPropagation();
            var isOpen = dropdown.getAttribute('data-open') === 'true';
            document.querySelectorAll('.niis-status-dropdown').forEach(function(d) {
              d.setAttribute('data-open', 'false');
            });
            dropdown.setAttribute('data-open', isOpen ? 'false' : 'true');
          });
          menu.querySelectorAll('.niis-status-dropdown-item').forEach(function(item) {
            item.addEventListener('click', function(e) {
              e.stopPropagation();
              var action = item.getAttribute('data-action');
              var taskId = dropdown.getAttribute('data-task-id');
              dropdown.setAttribute('data-open', 'false');
              if (!taskId || !action) return;
              dropdown.setAttribute('data-saving', 'true');
              fetch('/tasks/' + encodeURIComponent(taskId) + '/actions/' + encodeURIComponent(action), {
                method: 'POST',
                redirect: 'manual',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: ''
              }).then(function() {
                window.location.href = '/tasks/' + encodeURIComponent(taskId);
              }).catch(function() {
                dropdown.setAttribute('data-saving', 'false');
              });
            });
          });
        });
        document.addEventListener('click', function() {
          document.querySelectorAll('.niis-status-dropdown').forEach(function(d) {
            d.setAttribute('data-open', 'false');
          });
        });
        document.querySelectorAll('[data-toc-tab]').forEach(function(tab) {
          tab.addEventListener('click', function() {
            var tabId = tab.getAttribute('data-toc-tab');
            var toc = document.querySelector('.niis-toc');
            if (!toc) return;
            document.querySelectorAll('[data-toc-tab]').forEach(function(t) {
              t.classList.remove('niis-topbar-tab-active');
            });
            tab.classList.add('niis-topbar-tab-active');
            toc.querySelectorAll('.niis-toc-panel').forEach(function(panel) {
              if (panel.getAttribute('data-panel') === tabId) {
                panel.classList.remove('niis-toc-panel-hidden');
              } else {
                panel.classList.add('niis-toc-panel-hidden');
              }
            });
          });
        });
      });
    </script>
  </head>`;
}

function renderControlPlaneDocumentFrame({
  bodyClass = "",
  bodyHtml = "",
  headHtml = "",
  scripts = "",
} = {}) {
  return `
<!doctype html>
<html lang="en">
  ${headHtml}
  <body class="${escapeHtml(bodyClass)}">
    ${bodyHtml}
    ${scripts}
  </body>
</html>`;
}

export {
  buildNiisSidebarTree,
  renderControlPlaneDocumentFrame,
  renderControlPlaneDocumentHead,
  renderNiisLayout,
  renderNiisSidebar,
  renderNiisToc,
  renderNiisTopbar,
};
