// Runtime for wickd's interactive HTML DAG export. Inlined verbatim into the exported file
// (imported with ?raw) after dagre's browser bundle and htmlFilter.js, so it may use the
// `dagre` and `wickdFilter` globals but nothing else: no modules, no frameworks, ES2018.
(function () {
  'use strict';

  var data = JSON.parse(document.getElementById('dag-data').textContent);
  var opts = data.options;
  var svg = document.getElementById('graph');
  var viewport = document.getElementById('viewport');
  var edgeLayer = document.getElementById('edges');
  var panel = document.getElementById('panel');
  var tooltip = document.getElementById('tooltip');
  var search = document.getElementById('search');
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var FILTER_KEYS = ['resourceTypes', 'materializations', 'tags', 'statuses'];
  var FILTER_LABELS = { resourceTypes: 'Type', materializations: 'Materialization', tags: 'Tag', statuses: 'Status' };

  var nodeEls = {};
  Array.prototype.forEach.call(document.querySelectorAll('.node'), function (el) {
    nodeEls[el.getAttribute('data-id')] = el;
  });
  var filterNodes = data.order.map(function (id) {
    var n = data.nodes[id];
    return { id: id, name: n.name, type: n.type, materialized: n.materialized, tags: n.tags, status: n.status };
  });

  // ── state ───────────────────────────────────────────────────────────────
  var filter = copyFilter(data.initialFilter);
  var visible = {};
  var pos = {};
  var edgeEls = [];
  var down = {};
  var up = {};
  var bounds = { x: 0, y: 0, width: 1, height: 1 };

  function copyFilter(f) {
    var out = { selector: f.selector };
    FILTER_KEYS.forEach(function (k) { out[k] = f[k].slice(); });
    return out;
  }
  function filterKey(f) {
    return JSON.stringify([f.selector.trim()].concat(FILTER_KEYS.map(function (k) { return f[k].slice().sort(); })));
  }
  var initialKey = filterKey(data.initialFilter);

  // ── layout ──────────────────────────────────────────────────────────────
  function visibleEdges() {
    return data.edges.filter(function (e) { return visible[e[0]] && visible[e[1]]; });
  }

  // Same settings as the app's computeLayout(); the on-screen positions are reused while the
  // filters are the ones the DAG was exported with.
  function layout(ids, edges) {
    var placed = {};
    var useInitial = filterKey(filter) === initialKey && ids.every(function (id) { return data.nodes[id].x !== undefined; });
    if (useInitial) {
      ids.forEach(function (id) { placed[id] = { x: data.nodes[id].x, y: data.nodes[id].y }; });
      return placed;
    }
    var g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(function () { return {}; });
    g.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 40 });
    ids.forEach(function (id) { g.setNode(id, { width: data.nodeWidth, height: data.nodes[id].h }); });
    edges.forEach(function (e) { g.setEdge(e[0], e[1]); });
    dagre.layout(g);
    ids.forEach(function (id) {
      var p = g.node(id);
      placed[id] = { x: p.x - data.nodeWidth / 2, y: p.y - data.nodes[id].h / 2 };
    });
    return placed;
  }

  function edgePath(s, t) {
    var sx = pos[s].x + data.nodeWidth;
    var sy = pos[s].y + data.nodes[s].h / 2;
    var tx = pos[t].x;
    var ty = pos[t].y + data.nodes[t].h / 2;
    var dx = Math.max(40, Math.abs(tx - sx) / 2);
    return 'M' + sx + ',' + sy + ' C' + (sx + dx) + ',' + sy + ' ' + (tx - dx) + ',' + ty + ' ' + tx + ',' + ty;
  }

  function render() {
    visible = wickdFilter.apply(filterNodes, data.edges, filter);
    var ids = data.order.filter(function (id) { return visible[id]; });
    var edges = visibleEdges();
    pos = layout(ids, edges);

    Object.keys(nodeEls).forEach(function (id) {
      var el = nodeEls[id];
      if (!visible[id]) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.setAttribute('transform', 'translate(' + pos[id].x + ',' + pos[id].y + ')');
    });

    edgeLayer.textContent = '';
    down = {};
    up = {};
    edgeEls = edges.map(function (e) {
      (down[e[0]] = down[e[0]] || []).push(e[1]);
      (up[e[1]] = up[e[1]] || []).push(e[0]);
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('class', 'edge');
      p.setAttribute('data-source', e[0]);
      p.setAttribute('data-target', e[1]);
      p.setAttribute('d', edgePath(e[0], e[1]));
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', data.edgeColor || '');
      p.setAttribute('stroke-width', '1.5');
      p.setAttribute('marker-end', 'url(#arrow)');
      edgeLayer.appendChild(p);
      return p;
    });

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach(function (id) {
      minX = Math.min(minX, pos[id].x);
      minY = Math.min(minY, pos[id].y);
      maxX = Math.max(maxX, pos[id].x + data.nodeWidth);
      maxY = Math.max(maxY, pos[id].y + data.nodes[id].h);
    });
    bounds = ids.length
      ? { x: minX - 40, y: minY - 40, width: maxX - minX + 80, height: maxY - minY + 80 }
      : { x: 0, y: 0, width: 1, height: 1 };

    document.getElementById('empty').hidden = ids.length > 0;
    document.getElementById('count').textContent = ids.length + ' of ' + data.order.length + ' nodes';
    document.getElementById('clear').hidden = !wickdFilter.isActive(filter);
    document.getElementById('reset').hidden = !opts.wholeProject || filterKey(filter) === initialKey;
    clearSelection();
    if (search.value.trim()) applySearch();
    fit();
  }

  // ── adjacency walks ─────────────────────────────────────────────────────
  function walk(start, adj) {
    var seen = {};
    var queue = [start];
    while (queue.length) {
      var id = queue.shift();
      (adj[id] || []).forEach(function (next) {
        if (!seen[next]) { seen[next] = true; queue.push(next); }
      });
    }
    return seen;
  }

  // Column lineage: downstream "node::col" → upstream refs, plus the reverse index
  var colUp = {};
  var colDown = {};
  if (data.lineage) {
    Object.keys(data.lineage).forEach(function (node) {
      var cols = data.lineage[node];
      Object.keys(cols).forEach(function (col) {
        colUp[node + '::' + col] = cols[col];
        cols[col].forEach(function (ref) {
          var refKey = ref[0] + '::' + ref[1];
          (colDown[refKey] = colDown[refKey] || []).push([node, col]);
        });
      });
    });
  }

  function traceColumn(node, col) {
    var seen = {};
    var result = [[node, col]];
    seen[node + '::' + col] = true;
    function visit(index, n, c) {
      (index[n + '::' + c] || []).forEach(function (ref) {
        var k = ref[0] + '::' + ref[1];
        if (seen[k]) return;
        seen[k] = true;
        result.push(ref);
        visit(index, ref[0], ref[1]);
      });
    }
    visit(colUp, node, col);
    visit(colDown, node, col);
    return result;
  }

  // ── pan / zoom ──────────────────────────────────────────────────────────
  var view = { x: 0, y: 0, k: 1 };
  function apply() {
    viewport.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
  }
  // Fits below the floating toolbar so the top row of nodes isn't hidden behind it
  var TOOLBAR_INSET = 52;
  function fit() {
    var w = svg.clientWidth;
    var h = Math.max(svg.clientHeight - TOOLBAR_INSET, 1);
    var k = Math.min(w / bounds.width, h / bounds.height, 1.5) * 0.95;
    view.k = k;
    view.x = (w - bounds.width * k) / 2 - bounds.x * k;
    view.y = TOOLBAR_INSET + (h - bounds.height * k) / 2 - bounds.y * k;
    apply();
  }
  function zoomAt(px, py, factor) {
    var k = Math.min(4, Math.max(0.05, view.k * factor));
    view.x = px - (px - view.x) * (k / view.k);
    view.y = py - (py - view.y) * (k / view.k);
    view.k = k;
    apply();
  }
  function centerOn(id) {
    if (!visible[id]) return;
    var cx = pos[id].x + data.nodeWidth / 2;
    var cy = pos[id].y + data.nodes[id].h / 2;
    view.k = Math.max(view.k, 0.8);
    view.x = svg.clientWidth / 2 - cx * view.k;
    view.y = svg.clientHeight / 2 - cy * view.k;
    apply();
  }

  svg.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = svg.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  var drag = null;
  svg.addEventListener('pointerdown', function (e) {
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved) {
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      apply();
      svg.classList.add('panning');
    }
  });
  svg.addEventListener('pointerup', function (e) {
    var wasDrag = drag && drag.moved;
    drag = null;
    svg.classList.remove('panning');
    if (wasDrag) return;
    var target = document.elementFromPoint(e.clientX, e.clientY);
    var nodeEl = target && target.closest ? target.closest('.node') : null;
    if (!nodeEl) { clearSelection(); return; }
    var colEl = target.closest('.col');
    selectNode(nodeEl.getAttribute('data-id'));
    if (colEl && opts.columnLineage) selectColumn(nodeEl.getAttribute('data-id'), colEl.getAttribute('data-col'));
  });

  document.getElementById('fit').addEventListener('click', fit);
  document.getElementById('zoom-in').addEventListener('click', function () {
    zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1.25);
  });
  document.getElementById('zoom-out').addEventListener('click', function () {
    zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 0.8);
  });

  // ── highlighting ────────────────────────────────────────────────────────
  function highlight(keep, selected) {
    Object.keys(nodeEls).forEach(function (id) {
      nodeEls[id].classList.toggle('dim', keep !== null && !keep[id]);
      nodeEls[id].classList.toggle('sel', id === selected);
    });
    edgeEls.forEach(function (el) {
      var on = keep !== null && keep[el.getAttribute('data-source')] && keep[el.getAttribute('data-target')];
      el.classList.toggle('dim', keep !== null && !on);
      el.classList.toggle('hl', !!on);
    });
  }
  function clearColumnMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('.col.hit, .col.active'), function (el) {
      el.classList.remove('hit', 'active');
    });
  }
  function markColumn(node, col, cls) {
    var el = nodeEls[node];
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('.col'), function (c) {
      if (c.getAttribute('data-col') === col) c.classList.add(cls);
    });
  }
  function clearSelection() {
    highlight(null, null);
    clearColumnMarks();
    panel.hidden = true;
  }

  // ── side panel ──────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function metaRow(list, label, value) {
    if (!value) return;
    var row = el('div', 'meta-row');
    row.appendChild(el('span', 'meta-label', label));
    row.appendChild(el('span', 'meta-value', value));
    list.appendChild(row);
  }

  function renderPanel(id, activeCol, trace) {
    var n = data.nodes[id];
    panel.innerHTML = '';
    panel.hidden = false;
    var close = el('button', 'close', '×');
    close.title = 'Close';
    close.addEventListener('click', clearSelection);
    panel.appendChild(close);
    panel.appendChild(el('div', 'panel-type', n.type));
    panel.appendChild(el('h2', null, n.name));
    var meta = el('div', 'meta');
    metaRow(meta, 'Materialization', n.materialized);
    metaRow(meta, 'Status', n.status !== 'idle' ? n.status : '');
    metaRow(meta, 'Relation', [n.database, n.schema].filter(Boolean).join('.'));
    metaRow(meta, 'Tags', n.tags.join(', '));
    panel.appendChild(meta);
    if (n.description) panel.appendChild(el('p', 'desc', n.description));

    if (opts.modelLineage) {
      panel.appendChild(el('p', 'counts', Object.keys(walk(id, up)).length + ' upstream · '
        + Object.keys(walk(id, down)).length + ' downstream (shown)'));
    }

    if (n.columns.length) {
      panel.appendChild(el('h3', null, 'Columns (' + n.columns.length + ')'));
      if (opts.columnLineage) panel.appendChild(el('p', 'hint', 'Click a column to trace its lineage.'));
      var list = el('ul', 'cols');
      n.columns.forEach(function (col) {
        var li = el('li', col === activeCol ? 'active' : '', col);
        if (opts.columnLineage) {
          li.classList.add('clickable');
          li.addEventListener('click', function () { selectColumn(id, col); });
        }
        list.appendChild(li);
      });
      panel.appendChild(list);
    }

    if (trace) {
      panel.appendChild(el('h3', null, 'Lineage of ' + activeCol));
      var byNode = {};
      trace.forEach(function (ref) {
        if (ref[0] === id && ref[1] === activeCol) return;
        (byNode[ref[0]] = byNode[ref[0]] || []).push(ref[1]);
      });
      var ids = Object.keys(byNode);
      if (!ids.length) panel.appendChild(el('p', 'hint', 'No traced upstream or downstream columns.'));
      ids.forEach(function (nid) {
        var group = el('div', 'trace');
        var shown = !!visible[nid];
        var name = el('button', shown ? 'trace-node' : 'trace-node hidden-node',
          (data.nodes[nid] ? data.nodes[nid].name : nid) + (shown ? '' : ' (filtered out)'));
        if (shown) name.addEventListener('click', function () { centerOn(nid); });
        group.appendChild(name);
        group.appendChild(el('div', 'trace-cols', byNode[nid].join(', ')));
        panel.appendChild(group);
      });
    }
  }

  function selectNode(id) {
    clearColumnMarks();
    if (opts.modelLineage) {
      var keep = walk(id, up);
      var downstream = walk(id, down);
      Object.keys(downstream).forEach(function (k) { keep[k] = true; });
      keep[id] = true;
      highlight(keep, id);
    } else {
      highlight(null, id);
    }
    renderPanel(id, null, null);
  }

  function selectColumn(id, col) {
    var trace = traceColumn(id, col);
    var keep = {};
    clearColumnMarks();
    trace.forEach(function (ref) {
      keep[ref[0]] = true;
      markColumn(ref[0], ref[1], ref[0] === id && ref[1] === col ? 'active' : 'hit');
    });
    highlight(keep, id);
    renderPanel(id, col, trace);
  }

  // ── search (highlights within what's shown) ─────────────────────────────
  function matches(q) {
    return data.order.filter(function (id) {
      return visible[id] && data.nodes[id].name.toLowerCase().indexOf(q) >= 0;
    });
  }
  function applySearch() {
    var q = search.value.trim().toLowerCase();
    if (!q) { highlight(null, null); return; }
    var keep = {};
    matches(q).forEach(function (id) { keep[id] = true; });
    highlight(keep, null);
  }
  search.addEventListener('input', applySearch);
  search.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var hits = matches(search.value.trim().toLowerCase());
    if (hits.length) { centerOn(hits[0]); selectNode(hits[0]); }
  });

  // ── filter bar ──────────────────────────────────────────────────────────
  var selectorInput = document.getElementById('selector');
  var dropdownHost = document.getElementById('dropdowns');
  var available = wickdFilter.available(filterNodes);
  var openMenu = null;
  var selectorTimer = null;

  function closeMenu() {
    if (openMenu) openMenu.remove();
    openMenu = null;
  }

  function renderDropdowns() {
    dropdownHost.textContent = '';
    FILTER_KEYS.forEach(function (key) {
      // Offer what the project has, plus anything the export was filtered on
      var options = available[key].slice();
      filter[key].forEach(function (v) { if (options.indexOf(v) < 0) options.push(v); });
      if (!options.length) return;
      var wrap = el('span', 'fd');
      var btn = el('button', filter[key].length ? 'fd-btn on' : 'fd-btn');
      btn.type = 'button';
      btn.appendChild(document.createTextNode(FILTER_LABELS[key]));
      if (filter[key].length) btn.appendChild(el('span', 'fd-badge', String(filter[key].length)));
      btn.appendChild(el('span', 'fd-chev', '▾'));
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasOpen = openMenu && openMenu.parentNode === wrap;
        closeMenu();
        if (!wasOpen) openDropdown(wrap, key, options);
      });
      wrap.appendChild(btn);
      dropdownHost.appendChild(wrap);
    });
  }

  function openDropdown(wrap, key, options) {
    var menu = el('div', 'fd-menu');
    menu.addEventListener('click', function (e) { e.stopPropagation(); });
    options.forEach(function (opt) {
      var label = el('label');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = filter[key].indexOf(opt) >= 0;
      box.addEventListener('change', function () {
        filter[key] = box.checked
          ? filter[key].concat([opt])
          : filter[key].filter(function (v) { return v !== opt; });
        refreshFilterBar(key);
        render();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(opt));
      menu.appendChild(label);
    });
    wrap.appendChild(menu);
    openMenu = menu;
  }

  // Re-draws the buttons (badge counts) while keeping the open menu where it is
  function refreshFilterBar(keepOpenKey) {
    var menu = openMenu;
    openMenu = null;
    renderDropdowns();
    if (menu && keepOpenKey) {
      var idx = FILTER_KEYS.filter(function (k) {
        return available[k].length || filter[k].length;
      }).indexOf(keepOpenKey);
      var wrap = dropdownHost.children[idx];
      if (wrap) { wrap.appendChild(menu); openMenu = menu; }
    }
  }

  function setFilter(f) {
    filter = copyFilter(f);
    selectorInput.value = filter.selector;
    closeMenu();
    renderDropdowns();
    render();
  }

  selectorInput.value = filter.selector;
  selectorInput.addEventListener('input', function () {
    clearTimeout(selectorTimer);
    selectorTimer = setTimeout(function () {
      filter.selector = selectorInput.value;
      render();
    }, 200);
  });
  document.getElementById('clear').addEventListener('click', function () {
    setFilter({ selector: '', resourceTypes: [], materializations: [], tags: [], statuses: [] });
  });
  document.getElementById('reset').addEventListener('click', function () { setFilter(data.initialFilter); });
  document.addEventListener('click', closeMenu);

  // ── tooltip ─────────────────────────────────────────────────────────────
  svg.addEventListener('mousemove', function (e) {
    var nodeEl = e.target.closest ? e.target.closest('.node') : null;
    if (!nodeEl || drag) { tooltip.hidden = true; return; }
    var n = data.nodes[nodeEl.getAttribute('data-id')];
    tooltip.textContent = '';
    tooltip.appendChild(el('strong', null, n.name));
    tooltip.appendChild(el('div', null, [n.type, n.materialized].filter(Boolean).join(' · ')));
    if (n.description) tooltip.appendChild(el('div', 'tip-desc', n.description));
    tooltip.hidden = false;
    var stage = svg.getBoundingClientRect();
    tooltip.style.left = (e.clientX - stage.left + 14) + 'px';
    tooltip.style.top = (e.clientY - stage.top + 14) + 'px';
  });
  svg.addEventListener('mouseleave', function () { tooltip.hidden = true; });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (openMenu) { closeMenu(); return; }
    search.value = '';
    clearSelection();
  });
  window.addEventListener('resize', fit);

  // The SVG's <title> elements would show native tooltips on top of ours
  Array.prototype.forEach.call(document.querySelectorAll('.node > title'), function (t) { t.remove(); });
  renderDropdowns();
  render();
})();
