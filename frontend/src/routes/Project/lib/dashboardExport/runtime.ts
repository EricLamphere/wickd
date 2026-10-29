// Hover readouts for exported dashboards: each chart's wrapper carries its data in
// `data-export-series` ({kind, labels, series: [{label, color, values}]}); the plot's
// left/right edges come from the chart's horizontal grid lines.
export const TOOLTIP_RUNTIME = `(function () {
  var tip = document.createElement('div');
  tip.className = 'wickd-tip';
  tip.style.display = 'none';
  document.body.appendChild(tip);
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(v) { return v == null ? '–' : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : esc(v); }
  document.querySelectorAll('[data-export-series]').forEach(function (el) {
    var data;
    try { data = JSON.parse(el.getAttribute('data-export-series')); } catch (e) { return; }
    var svg = el.querySelector('svg.recharts-surface');
    var line = el.querySelector('.recharts-cartesian-grid-horizontal line');
    if (!svg || !line || !data.labels || !data.labels.length) return;
    var x1 = parseFloat(line.getAttribute('x1')), x2 = parseFloat(line.getAttribute('x2'));
    svg.addEventListener('mousemove', function (ev) {
      var box = svg.getBoundingClientRect();
      var frac = (ev.clientX - box.left - x1) / Math.max(1, x2 - x1);
      if (frac < 0 || frac > 1) { tip.style.display = 'none'; return; }
      var n = data.labels.length;
      var i = data.kind === 'time' ? Math.round(frac * (n - 1)) : Math.min(n - 1, Math.floor(frac * n));
      var html = '<b>' + esc(data.labels[i]) + '</b>';
      data.series.forEach(function (s) {
        html += '<span><i style="background:' + esc(s.color) + '"></i>' + esc(s.label) + '<em>' + fmt(s.values[i]) + '</em></span>';
      });
      tip.innerHTML = html;
      tip.style.display = 'block';
      tip.style.left = (ev.clientX + 14) + 'px';
      tip.style.top = (ev.clientY + 14) + 'px';
    });
    svg.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  });
})();`;
