// DAG filter for wickd's interactive HTML export: a dependency-free port of ../dagFilter.ts
// (selector tokens + dropdown filters). Inlined into the export with ?raw; dagExport.test.ts
// checks it against applyFilter() so the two can't drift apart.
// Nodes are { id, name, type, materialized, tags, status }; edges are [source, target] pairs;
// a filter is { selector, resourceTypes, materializations, tags, statuses } with string arrays.
var wickdFilter = (function () {
  'use strict';

  var BARE_TYPES = ['model', 'seed', 'snapshot', 'test', 'source', 'exposure', 'analysis'];

  function isActive(f) {
    return f.selector.trim() !== '' || f.resourceTypes.length > 0 || f.materializations.length > 0
      || f.tags.length > 0 || f.statuses.length > 0;
  }

  function parseToken(raw) {
    var s = raw;
    var upstream = s.charAt(0) === '+';
    if (upstream) s = s.slice(1);
    var downstream = s.charAt(s.length - 1) === '+';
    if (downstream) s = s.slice(0, -1);
    if (s.indexOf('tag:') === 0) return { up: upstream, down: downstream, kind: 'tag', value: s.slice(4).toLowerCase() };
    if (s.indexOf('source:') === 0) return { up: upstream, down: downstream, kind: 'source', value: s.slice(7).toLowerCase() };
    if (s.indexOf('resource_type:') === 0) {
      return { up: upstream, down: downstream, kind: 'resource_type', value: s.slice(14).toLowerCase() };
    }
    if (BARE_TYPES.indexOf(s.toLowerCase()) >= 0) {
      return { up: upstream, down: downstream, kind: 'resource_type', value: s.toLowerCase() };
    }
    return { up: upstream, down: downstream, kind: 'name', value: s.toLowerCase() };
  }

  function tokenMatches(token, n) {
    if (token.kind === 'tag') {
      return n.tags.some(function (t) { return t.toLowerCase().indexOf(token.value) >= 0; });
    }
    if (token.kind === 'source') return n.type === 'source' && n.name.toLowerCase().indexOf(token.value) >= 0;
    if (token.kind === 'resource_type') return n.type.toLowerCase() === token.value;
    return n.name.toLowerCase().indexOf(token.value) >= 0;
  }

  function expand(seeds, adjacency) {
    var visited = {};
    var queue = Object.keys(seeds);
    queue.forEach(function (id) { visited[id] = true; });
    while (queue.length) {
      var id = queue.shift();
      (adjacency[id] || []).forEach(function (next) {
        if (!visited[next]) { visited[next] = true; queue.push(next); }
      });
    }
    return visited;
  }

  function matchesDropdowns(n, f) {
    if (f.resourceTypes.length && f.resourceTypes.indexOf(n.type) < 0) return false;
    if (f.materializations.length && (!n.materialized || f.materializations.indexOf(n.materialized) < 0)) return false;
    if (f.tags.length && !n.tags.some(function (t) { return f.tags.indexOf(t) >= 0; })) return false;
    if (f.statuses.length && f.statuses.indexOf(n.status) < 0) return false;
    return true;
  }

  /** Ids of the nodes the filter keeps, as a { id: true } map. */
  function apply(nodes, edges, f) {
    var keep = {};
    if (!isActive(f)) {
      nodes.forEach(function (n) { keep[n.id] = true; });
      return keep;
    }
    var down = {};
    var up = {};
    edges.forEach(function (e) {
      (down[e[0]] = down[e[0]] || []).push(e[1]);
      (up[e[1]] = up[e[1]] || []).push(e[0]);
    });

    var candidates = {};
    var selector = f.selector.trim();
    if (selector) {
      selector.split(/\s+/).forEach(function (raw) {
        if (!raw) return;
        var token = parseToken(raw);
        var seeds = {};
        nodes.forEach(function (n) { if (tokenMatches(token, n)) seeds[n.id] = true; });
        Object.keys(seeds).forEach(function (id) { candidates[id] = true; });
        if (token.up) Object.keys(expand(seeds, up)).forEach(function (id) { candidates[id] = true; });
        if (token.down) Object.keys(expand(seeds, down)).forEach(function (id) { candidates[id] = true; });
      });
    } else {
      nodes.forEach(function (n) { candidates[n.id] = true; });
    }

    nodes.forEach(function (n) {
      if (candidates[n.id] && matchesDropdowns(n, f)) keep[n.id] = true;
    });
    return keep;
  }

  /** Sorted option lists for the dropdowns ("idle" isn't offered as a status, as in the app). */
  function available(nodes) {
    var sets = { resourceTypes: {}, materializations: {}, tags: {}, statuses: {} };
    nodes.forEach(function (n) {
      sets.resourceTypes[n.type] = true;
      if (n.materialized) sets.materializations[n.materialized] = true;
      n.tags.forEach(function (t) { sets.tags[t] = true; });
      if (n.status && n.status !== 'idle') sets.statuses[n.status] = true;
    });
    var out = {};
    Object.keys(sets).forEach(function (k) { out[k] = Object.keys(sets[k]).sort(); });
    return out;
  }

  return { apply: apply, available: available, isActive: isActive };
})();
