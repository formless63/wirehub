// Docs behaviour: theme toggle, the narrow-screen menu, and search over search-index.json.
// No dependencies; the index is the only request, and the docs read fine without any of this.
(function () {
  'use strict';
  var script = document.currentScript;
  var root = (script && script.getAttribute('data-root')) || './';
  var html = document.documentElement;

  function currentTheme() {
    var t = html.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  var themeButton = document.querySelector('.theme-toggle');
  if (themeButton) {
    themeButton.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      try { localStorage.setItem('wirehub-docs-theme', next); } catch (e) { /* private mode: not remembered */ }
    });
  }

  var navButton = document.querySelector('.nav-toggle');
  var nav = document.getElementById('docs-nav');
  if (navButton && nav) {
    navButton.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      navButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var input = document.getElementById('docs-search');
  var list = document.getElementById('docs-results');
  if (!input || !list) return;
  var index = null;
  var loading = null;
  var shown = [];
  var active = -1;

  function load() {
    if (index) return Promise.resolve(index);
    if (!loading) {
      loading = fetch(root + 'search-index.json').then(function (r) { return r.json(); }).then(function (data) { index = data; return data; }).catch(function () { index = []; return index; });
    }
    return loading;
  }

  function terms(q) { return q.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean); }

  function score(entry, ts) {
    var title = (entry.t + ' ' + entry.h).toLowerCase();
    var text = entry.x.toLowerCase();
    var total = 0;
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      var inHead = entry.h.toLowerCase().indexOf(t) >= 0;
      var inTitle = title.indexOf(t) >= 0;
      var inText = text.indexOf(t) >= 0;
      if (!inTitle && !inText) return 0;
      total += (inHead ? 6 : 0) + (inTitle ? 3 : 0) + (inText ? 1 : 0) + (entry.h === '' && entry.t.toLowerCase().indexOf(t) >= 0 ? 5 : 0);
    }
    return total + (entry.h === '' ? 1 : 0);
  }

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function mark(s, ts) {
    var out = esc(s);
    ts.forEach(function (t) { out = out.replace(new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>'); });
    return out;
  }

  function snippet(entry, ts) {
    var lower = entry.x.toLowerCase();
    var at = -1;
    for (var i = 0; i < ts.length && at < 0; i++) at = lower.indexOf(ts[i]);
    var start = Math.max(0, at - 30);
    return (start > 0 ? '…' : '') + entry.x.slice(start, start + 110);
  }

  function render(q) {
    var ts = terms(q);
    if (ts.length === 0) { close(); return; }
    shown = (index || []).map(function (e) { return { e: e, s: score(e, ts) }; }).filter(function (r) { return r.s > 0; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 8);
    active = -1;
    if (shown.length === 0) {
      list.innerHTML = '<li class="none" role="option" aria-selected="false">Nothing found.</li>';
    } else {
      list.innerHTML = shown.map(function (r, i) {
        var e = r.e;
        return '<li role="presentation"><a role="option" id="docs-res-' + i + '" aria-selected="false" href="' + root + e.u + '">' +
          '<span class="what">' + mark(e.h || e.t, ts) + '</span>' +
          (e.h ? '<span class="where">' + esc(e.t) + '</span>' : '') +
          '<span class="snip">' + mark(snippet(e, ts), ts) + '</span></a></li>';
      }).join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function move(delta) {
    if (shown.length === 0) return;
    var links = list.querySelectorAll('a');
    if (active >= 0) links[active].setAttribute('aria-selected', 'false');
    active = (active + delta + shown.length) % shown.length;
    links[active].setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', links[active].id);
    links[active].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', function () { load().then(function () { render(input.value); }); });
  input.addEventListener('focus', function () { load(); if (input.value) render(input.value); });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (ev.key === 'Enter') {
      var links = list.querySelectorAll('a');
      var pick = active >= 0 ? links[active] : links[0];
      if (pick) { ev.preventDefault(); window.location.href = pick.getAttribute('href'); }
    } else if (ev.key === 'Escape') { close(); }
  });
  document.addEventListener('click', function (ev) { if (!ev.target.closest || !ev.target.closest('.search')) close(); });
  document.addEventListener('keydown', function (ev) {
    var tag = (ev.target && ev.target.tagName) || '';
    if ((ev.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(tag)) || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k')) {
      ev.preventDefault();
      input.focus();
      input.select();
    }
  });
})();
