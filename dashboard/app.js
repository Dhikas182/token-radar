// Token Radar dashboard — plain JavaScript, no framework, no network.
//
// The page is a static shell (index.html) with one empty <main>. The data
// file beside it (data.js, written by main.ts from the same board) sets
// window.TOKEN_RADAR, and this script renders everything from that object:
// the header and facts, the Top 5 spotlight, the sortable and filterable
// board, the Live tab, a detail view for every protocol, and a what-if
// sandbox that re-scores the board inside the page only.
//
// State lives in one object and every control re-renders the table from it,
// so the URL never changes and nothing is fetched after load.

'use strict';

(function () {
  var main = document.getElementById('board');
  var data = window.TOKEN_RADAR;

  if (!data || !Array.isArray(data.rows)) {
    if (main) {
      main.setAttribute('aria-busy', 'false');
      main.textContent = 'Token Radar could not load its data file. Open this page from the output folder, next to data.js.';
    }
    return;
  }

  var rows = data.rows;
  var liveRows = Array.isArray(data.live) ? data.live : [];
  var watchlist = new Set(Array.isArray(data.watchlist) ? data.watchlist : []);
  var topImplied = rows.length ? rows[0].implied_value_usd : 0;

  var state = {
    tab: 'pre',
    query: '',
    category: 'all',
    chain: 'all',
    watchOnly: false,
    growingOnly: false,
    sortKey: 'rank',
    sortDir: 1,
    rescored: false,
    sandbox: { tvl: 100000000, growth: 10, age: 365, chains: 3 },
  };

  var dialog = null;

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(value) {
    if (value === null || value === undefined) return '—';
    var abs = Math.abs(value);
    if (abs >= 1000000000) return '$' + (value / 1000000000).toFixed(2) + 'B';
    if (abs >= 1000000) return '$' + (value / 1000000).toFixed(2) + 'M';
    if (abs >= 1000) return '$' + (value / 1000).toFixed(1) + 'K';
    return '$' + Math.round(value).toLocaleString('en-US');
  }

  function whole(value) {
    if (value === null || value === undefined) return '—';
    return Math.round(value).toLocaleString('en-US');
  }

  function pct(value) {
    if (value === null || value === undefined) return '—';
    var sign = value > 0 ? '+' : '';
    return sign + value.toFixed(2) + '%';
  }

  function changeClass(value) {
    if (value === null || value === undefined) return '';
    return value > 0 ? 'pos' : value < 0 ? 'neg' : '';
  }

  function chainLabel(chains) {
    if (!chains || chains.length === 0) return '—';
    if (chains.length <= 3) return chains.join(', ');
    return chains.slice(0, 3).join(', ') + ' +' + (chains.length - 3);
  }

  // The radar-2 formula, repeated here so the sandbox can re-score live.
  function impliedFor(tvl, growthPct, ageDays, chainCount) {
    var growth = 1 + (Math.max(-60, Math.min(120, growthPct)) / 100) * 0.7;
    var age = ageDays === null || ageDays === undefined ? 365 : ageDays;
    var maturity = 0.55 + (Math.min(age, 1095) / 1095) * 0.75;
    var breadth = 1 + 0.02 * Math.min(Math.max(chainCount - 1, 0), 8);
    return Math.round(tvl * 0.25 * growth * maturity * breadth);
  }

  // -------------------------------------------------------------------------
  // Filtering and sorting
  // -------------------------------------------------------------------------

  function visibleRows() {
    var query = state.query.trim().toLowerCase();
    var list = rows.filter(function (row) {
      if (state.watchOnly && !watchlist.has(row.slug)) return false;
      if (state.growingOnly && !(row.change_7d !== null && row.change_7d > 0)) return false;
      if (state.category !== 'all' && row.category !== state.category) return false;
      if (state.chain !== 'all' && row.chains.indexOf(state.chain) === -1) return false;
      if (query) {
        var hay = (row.name + ' ' + row.slug + ' ' + row.category).toLowerCase();
        if (hay.indexOf(query) === -1) return false;
      }
      return true;
    });
    if (state.rescored) {
      list = list.map(function (row) {
        var copy = Object.assign({}, row);
        copy.implied_value_usd = impliedFor(
          row.tvl_usd,
          state.sandbox.growth,
          state.sandbox.age,
          state.sandbox.chains,
        );
        return copy;
      });
    }
    var key = state.sortKey;
    var dir = state.sortDir;
    list.sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av - bv);
    });
    return list;
  }

  // -------------------------------------------------------------------------
  // Small DOM helpers
  // -------------------------------------------------------------------------

  function el(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined && html !== null) node.innerHTML = html;
    return node;
  }

  function option(value, label, selected) {
    var node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    if (selected) node.selected = true;
    return node;
  }

  function badge(row) {
    if (watchlist.has(row.slug)) return '<span class="badge watch">Watchlist</span>';
    if (row.rank <= 5) return '<span class="badge top">Top 5</span>';
    return '<span class="badge early">Early</span>';
  }

  // -------------------------------------------------------------------------
  // Rendering: header, spotlight, controls
  // -------------------------------------------------------------------------

  function renderHeader(shell) {
    var top = el('header', 'top');
    top.appendChild(el('div', 'brand', '<span class="mark" aria-hidden="true"></span>Token Radar'));
    var meta = el('div', 'top-meta');
    meta.appendChild(el('span', '', 'Snapshot ' + escapeHtml(data.as_of)));
    meta.appendChild(el('span', '', rows.length + ' pre-token rows'));
    meta.appendChild(el('span', '', liveRows.length + ' live set aside'));
    meta.appendChild(el('span', '', 'Floor ' + money(data.floor_usd)));
    top.appendChild(meta);
    shell.appendChild(top);

    var lede = el('div', 'lede');
    var intro = el('div', '');
    intro.appendChild(el('h1', '', 'Pre-token protocols, ranked by implied value'));
    intro.appendChild(
      el(
        'p',
        '',
        'Radar-2 scores every protocol on the watchlist plus the largest pre-token protocols below the ' +
          money(data.floor_usd) +
          ' floor. Live-token protocols are set aside with their market caps shown, never mixed into the ranking. ' +
          'Implied value is a model of what a token could represent — not a prediction that one launches.',
      ),
    );
    lede.appendChild(intro);
    var facts = el('div', 'facts');
    var watchCount = rows.filter(function (r) { return watchlist.has(r.slug); }).length;
    facts.appendChild(
      el('div', 'fact', '<span>Total implied</span><b>' + money(data.total_implied_usd) + '</b><small>across ' + rows.length + ' rows</small>'),
    );
    facts.appendChild(
      el('div', 'fact', '<span>Top protocol</span><b>' + escapeHtml(rows[0].name) + '</b><small>' + money(rows[0].implied_value_usd) + ' implied</small>'),
    );
    facts.appendChild(
      el('div', 'fact', '<span>Watchlist</span><b>' + watchCount + ' of ' + data.watchlist_size + '</b><small>covered in full</small>'),
    );
    facts.appendChild(
      el('div', 'fact', '<span>Live set aside</span><b>' + liveRows.length + '</b><small>largest by market cap</small>'),
    );
    lede.appendChild(facts);
    shell.appendChild(lede);
  }

  function renderSpotlight(shell) {
    var section = el('section', 'spot');
    section.appendChild(el('h2', '', 'Top 5 spotlight'));
    section.appendChild(el('p', 'sub', 'The five largest implied values on the board. Select one to open its detail view.'));
    var grid = el('div', 'spot-grid');
    rows.slice(0, 5).forEach(function (row) {
      var card = el(
        'button',
        'spot-card',
        '<span class="rank">#' + row.rank + ' · ' + escapeHtml(row.category) + '</span>' +
          '<b>' + escapeHtml(row.name) + '</b>' +
          '<span class="sub">' + money(row.tvl_usd) + ' TVL · ' + escapeHtml(row.chains[0] || '—') + '</span>' +
          '<span class="val">' + money(row.implied_value_usd) + '</span>' +
          '<span class="bar"><i style="width:' + Math.round((row.implied_value_usd / topImplied) * 100) + '%"></i></span>',
      );
      card.type = 'button';
      card.addEventListener('click', function () { openDetail(row.slug); });
      grid.appendChild(card);
    });
    section.appendChild(grid);
    shell.appendChild(section);
  }

  function renderControls(shell) {
    var controls = el('div', 'controls');

    var searchField = el('div', 'field grow');
    searchField.appendChild(el('label', '', 'Search'));
    var search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Name, slug or category';
    search.setAttribute('aria-label', 'Search protocols');
    search.value = state.query;
    search.addEventListener('input', function () {
      state.query = search.value;
      renderTable();
      renderCount();
    });
    searchField.appendChild(search);
    controls.appendChild(searchField);

    var catField = el('div', 'field');
    catField.appendChild(el('label', '', 'Category'));
    var catSelect = document.createElement('select');
    catSelect.setAttribute('aria-label', 'Filter by category');
    catSelect.appendChild(option('all', 'All categories', state.category === 'all'));
    (data.categories || []).forEach(function (cat) {
      catSelect.appendChild(option(cat, cat, state.category === cat));
    });
    catSelect.addEventListener('change', function () {
      state.category = catSelect.value;
      renderTable();
      renderCount();
    });
    catField.appendChild(catSelect);
    controls.appendChild(catField);

    var chainField = el('div', 'field');
    chainField.appendChild(el('label', '', 'Chain'));
    var chainSelect = document.createElement('select');
    chainSelect.setAttribute('aria-label', 'Filter by chain');
    chainSelect.appendChild(option('all', 'All chains', state.chain === 'all'));
    (data.chains || []).forEach(function (chain) {
      chainSelect.appendChild(option(chain, chain, state.chain === chain));
    });
    chainSelect.addEventListener('change', function () {
      state.chain = chainSelect.value;
      renderTable();
      renderCount();
    });
    chainField.appendChild(chainSelect);
    controls.appendChild(chainField);

    var checks = el('div', 'checks');
    var watchLabel = el('label', '', '');
    var watchBox = document.createElement('input');
    watchBox.type = 'checkbox';
    watchBox.checked = state.watchOnly;
    watchBox.addEventListener('change', function () {
      state.watchOnly = watchBox.checked;
      renderTable();
      renderCount();
    });
    watchLabel.appendChild(watchBox);
    watchLabel.appendChild(document.createTextNode(' Watchlist only'));
    checks.appendChild(watchLabel);
    var growingLabel = el('label', '', '');
    var growingBox = document.createElement('input');
    growingBox.type = 'checkbox';
    growingBox.checked = state.growingOnly;
    growingBox.addEventListener('change', function () {
      state.growingOnly = growingBox.checked;
      renderTable();
      renderCount();
    });
    growingLabel.appendChild(growingBox);
    growingLabel.appendChild(document.createTextNode(' Growing only (7d up)'));
    checks.appendChild(growingLabel);
    controls.appendChild(checks);

    var tabs = el('div', 'tabs');
    var preTab = el('button', '', 'Pre-token board');
    preTab.type = 'button';
    preTab.setAttribute('aria-pressed', state.tab === 'pre' ? 'true' : 'false');
    preTab.addEventListener('click', function () {
      state.tab = 'pre';
      renderTable();
      renderTabs();
      renderCount();
    });
    var liveTab = el('button', '', 'Live tokens');
    liveTab.type = 'button';
    liveTab.setAttribute('aria-pressed', state.tab === 'live' ? 'true' : 'false');
    liveTab.addEventListener('click', function () {
      state.tab = 'live';
      renderTable();
      renderTabs();
      renderCount();
    });
    tabs.appendChild(preTab);
    tabs.appendChild(liveTab);
    controls.appendChild(tabs);

    var count = el('span', 'count');
    count.id = 'row-count';
    controls.appendChild(count);

    shell.appendChild(controls);
  }

  function renderTabs() {
    var tabs = main.querySelectorAll('.tabs button');
    if (tabs.length === 2) {
      tabs[0].setAttribute('aria-pressed', state.tab === 'pre' ? 'true' : 'false');
      tabs[1].setAttribute('aria-pressed', state.tab === 'live' ? 'true' : 'false');
    }
  }

  function renderCount() {
    var count = document.getElementById('row-count');
    if (!count) return;
    if (state.tab === 'live') {
      count.textContent = liveRows.length + ' live protocols';
    } else {
      count.textContent = visibleRows().length + ' of ' + rows.length + ' rows';
    }
  }

  // -------------------------------------------------------------------------
  // Rendering: the tables
  // -------------------------------------------------------------------------

  var tableHost = null;

  function sortButton(label, key) {
    var button = el('button', '', escapeHtml(label));
    button.type = 'button';
    if (state.sortKey === key) {
      button.textContent = label + (state.sortDir === 1 ? ' ▲' : ' ▼');
    }
    button.addEventListener('click', function () {
      if (state.sortKey === key) {
        state.sortDir = -state.sortDir;
      } else {
        state.sortKey = key;
        state.sortDir = key === 'name' || key === 'category' ? 1 : -1;
      }
      renderTable();
    });
    return button;
  }

  function renderTable() {
    if (!tableHost) return;
    tableHost.innerHTML = '';
    if (state.tab === 'live') {
      renderLiveTable();
    } else {
      renderBoardTable();
    }
  }

  function renderBoardTable() {
    var list = visibleRows();
    var panel = el('section', 'panel');
    panel.appendChild(el('h2', '', 'The board'));
    if (state.rescored) {
      panel.appendChild(
        el('p', 'sub', 'Re-scored in this page only, using the sandbox settings below. The saved board is unchanged.'),
      );
    }
    if (list.length === 0) {
      var empty = el('div', 'empty');
      empty.appendChild(el('h2', '', 'No protocols match'));
      empty.appendChild(el('p', '', 'Try a different search, or clear the filters.'));
      var clear = el('button', 'button primary', 'Clear filters');
      clear.type = 'button';
      clear.addEventListener('click', function () {
        state.query = '';
        state.category = 'all';
        state.chain = 'all';
        state.watchOnly = false;
        state.growingOnly = false;
        renderAll();
      });
      empty.appendChild(clear);
      panel.appendChild(empty);
      tableHost.appendChild(panel);
      return;
    }
    var wrap = el('div', 'table-wrap');
    var table = document.createElement('table');
    table.appendChild(
      el(
        'caption',
        '',
        'Pre-token protocols ranked by implied value. Select a row to open its detail view and farm plan.',
      ),
    );
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    var columns = [
      ['Rank', 'rank', ''],
      ['Protocol', 'name', ''],
      ['Category', 'category', ''],
      ['Chains', null, ''],
      ['TVL', 'tvl_usd', 'num'],
      ['7d', 'change_7d', 'num'],
      ['Implied value', 'implied_value_usd', 'num'],
    ];
    columns.forEach(function (col) {
      var th = document.createElement('th');
      if (col[2]) th.className = col[2];
      if (col[1]) {
        th.appendChild(sortButton(col[0], col[1]));
      } else {
        th.textContent = col[0];
      }
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    var body = document.createElement('tbody');
    list.forEach(function (row, index) {
      var tr = document.createElement('tr');
      tr.tabIndex = 0;
      tr.setAttribute('data-selected', 'false');
      tr.addEventListener('click', function () { openDetail(row.slug); });
      tr.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDetail(row.slug);
        }
      });
      var displayRank = state.rescored ? index + 1 : row.rank;
      tr.appendChild(el('td', 'num', String(displayRank)));
      tr.appendChild(
        el(
          'td',
          'name',
          '<b>' + escapeHtml(row.name) + '</b>' + badge(row) +
            '<span class="sub">' + escapeHtml(row.slug) + '</span>',
        ),
      );
      tr.appendChild(el('td', '', escapeHtml(row.category)));
      tr.appendChild(el('td', '', escapeHtml(chainLabel(row.chains))));
      tr.appendChild(el('td', 'num', money(row.tvl_usd)));
      tr.appendChild(el('td', 'num ' + changeClass(row.change_7d), pct(row.change_7d)));
      var share = Math.max(0, Math.min(100, Math.round((row.implied_value_usd / topImplied) * 100)));
      tr.appendChild(
        el(
          'td',
          'num implied',
          '<span class="bar"><i style="width:' + share + '%"></i></span>' + money(row.implied_value_usd),
        ),
      );
      body.appendChild(tr);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    panel.appendChild(wrap);
    tableHost.appendChild(panel);
  }

  function renderLiveTable() {
    var panel = el('section', 'panel');
    panel.appendChild(el('h2', '', 'Live tokens, set aside'));
    panel.appendChild(
      el(
        'p',
        'sub',
        'These protocols already have a token, so they are not ranked with the pre-token board. Shown largest by market cap first.',
      ),
    );
    var wrap = el('div', 'table-wrap');
    var table = document.createElement('table');
    table.appendChild(el('caption', '', 'Live-token protocols and their market caps.'));
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['Protocol', 'Category', 'Chains', 'TVL', 'Market cap'].forEach(function (label, i) {
      var th = document.createElement('th');
      if (i >= 3) th.className = 'num';
      th.textContent = label;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    var body = document.createElement('tbody');
    liveRows.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.appendChild(
        el(
          'td',
          'name',
          '<b>' + escapeHtml(row.name) + '</b><span class="badge live">Live</span>' +
            '<span class="sub">' + escapeHtml(row.slug) + (row.symbol ? ' · ' + escapeHtml(row.symbol) : '') + '</span>',
        ),
      );
      tr.appendChild(el('td', '', escapeHtml(row.category)));
      tr.appendChild(el('td', '', escapeHtml(chainLabel(row.chains))));
      tr.appendChild(el('td', 'num', money(row.tvl_usd)));
      tr.appendChild(el('td', 'num', money(row.mcap_usd)));
      body.appendChild(tr);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    panel.appendChild(wrap);
    tableHost.appendChild(panel);
  }

  // -------------------------------------------------------------------------
  // Rendering: the model panel and sandbox
  // -------------------------------------------------------------------------

  function renderModel(shell) {
    var section = el('section', 'panel model');
    section.appendChild(el('h2', '', 'How the model works'));
    section.appendChild(
      el(
        'div',
        'formula',
        'implied = round( TVL × 0.25 × growth × maturity × breadth )',
      ),
    );
    section.appendChild(
      el(
        'p',
        '',
        'Growth is the 7-day change clamped to −60%…+120%, weighted at 0.7. Maturity grows with age up to three years, ' +
          'from 0.55 to 1.30. Breadth adds 2% per extra chain, up to eight. A protocol with no listing date is treated as a year old.',
      ),
    );
    var list = el('ul', '');
    list.appendChild(el('li', '', 'TVL is the size of the business a token would represent.'));
    list.appendChild(el('li', '', 'Seven-day growth is momentum: a fast-growing protocol is worth more than a stagnant one of the same size.'));
    list.appendChild(el('li', '', 'Age with no token on record is pent-up launch value.'));
    list.appendChild(el('li', '', 'Breadth is distribution: each extra chain adds 2%.'));
    section.appendChild(list);

    var sandbox = el('div', 'sandbox');
    sandbox.appendChild(el('h3', '', 'What-if sandbox'));
    var fields = [
      { key: 'tvl', label: 'TVL ($)', min: 1000000, max: 3000000000, step: 1000000, format: money },
      { key: 'growth', label: '7-day change (%)', min: -60, max: 120, step: 1, format: function (v) { return v + '%'; } },
      { key: 'age', label: 'Age (days)', min: 0, max: 1095, step: 1, format: function (v) { return v + ' days'; } },
      { key: 'chains', label: 'Chains', min: 1, max: 20, step: 1, format: function (v) { return String(v); } },
    ];
    fields.forEach(function (field) {
      var wrap = el('div', 'field');
      wrap.appendChild(el('label', '', field.label));
      var input = document.createElement('input');
      input.type = 'range';
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = String(field.step);
      input.value = String(state.sandbox[field.key]);
      input.setAttribute('aria-label', field.label);
      var output = el('output', '', field.format(state.sandbox[field.key]));
      input.addEventListener('input', function () {
        state.sandbox[field.key] = Number(input.value);
        output.textContent = field.format(state.sandbox[field.key]);
        updateSandboxResult();
      });
      wrap.appendChild(input);
      wrap.appendChild(output);
      sandbox.appendChild(wrap);
    });
    var result = el('p', '', '');
    result.id = 'sandbox-result';
    sandbox.appendChild(result);
    var rescore = el('button', 'button', 'Re-score the board with these settings');
    rescore.type = 'button';
    rescore.addEventListener('click', function () {
      state.rescored = true;
      state.sortKey = 'implied_value_usd';
      state.sortDir = -1;
      renderTable();
      renderCount();
    });
    sandbox.appendChild(rescore);
    var reset = el('button', 'button', 'Reset the board');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      state.rescored = false;
      state.sortKey = 'rank';
      state.sortDir = 1;
      renderTable();
      renderCount();
    });
    sandbox.appendChild(reset);
    sandbox.appendChild(
      el('p', 'sandbox-note', 'The sandbox only changes this page. The saved board is never touched.'),
    );
    section.appendChild(sandbox);
    shell.appendChild(section);
    updateSandboxResult();
  }

  function updateSandboxResult() {
    var result = document.getElementById('sandbox-result');
    if (!result) return;
    var s = state.sandbox;
    result.textContent =
      'Implied value for these settings: ' + money(impliedFor(s.tvl, s.growth, s.age, s.chains)) + '.';
  }

  // -------------------------------------------------------------------------
  // Detail view
  // -------------------------------------------------------------------------

  function findRow(slug) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].slug === slug) return rows[i];
    }
    return null;
  }

  function openDetail(slug) {
    var row = findRow(slug);
    if (!row || !dialog) return;
    var model = row.model;
    var head = el('div', 'detail-head');
    head.appendChild(
      el(
        'div',
        '',
        '<span class="brand-name">' + escapeHtml(row.category) + ' · Pre-token</span>' +
          '<h2>' + escapeHtml(row.name) + '</h2>' +
          '<span class="sub">' + escapeHtml(row.slug) + ' · ' + escapeHtml(chainLabel(row.chains)) +
          ' · listed ' + escapeHtml(row.listed_at || 'date unknown') + ' · snapshot ' + escapeHtml(data.as_of) + '</span>',
      ),
    );
    var close = el('button', 'close', 'Close');
    close.type = 'button';
    close.addEventListener('click', function () { dialog.close(); });
    head.appendChild(close);
    dialog.innerHTML = '';
    dialog.appendChild(head);

    var equation = el('div', 'detail-section');
    equation.appendChild(el('h3', '', 'Model breakdown — implied ' + money(row.implied_value_usd)));
    var grid = el('div', 'equation');
    grid.appendChild(el('div', '', '<span>Total value locked</span><b>' + money(row.tvl_usd) + '</b>'));
    grid.appendChild(el('div', '', '<span>Base multiple</span><b>× ' + model.base_multiple + '</b>'));
    grid.appendChild(
      el('div', '', '<span>7-day change ' + pct(model.growth_pct) + '</span><b>× ' + model.growth_multiplier + '</b>'),
    );
    grid.appendChild(
      el('div', '', '<span>Age ' + (model.age_days === null ? 'unknown' : model.age_days + ' days') + '</span><b>× ' + model.maturity_multiplier + '</b>'),
    );
    grid.appendChild(
      el('div', '', '<span>Chains (' + row.chains.length + ')</span><b>× ' + model.breadth_multiplier + '</b>'),
    );
    grid.appendChild(
      el('div', '', '<span>Implied value</span><b>' + money(row.implied_value_usd) + '</b>'),
    );
    equation.appendChild(grid);
    var notes = el('ul', 'notes');
    notes.appendChild(el('li', '', 'No token on record in the snapshot: the protocol may still have a token its record does not carry.'));
    notes.appendChild(el('li', '', 'Implied value is a model of what a token could represent, never a prediction that a token launches.'));
    notes.appendChild(el('li', '', 'TVL and weekly change are from the snapshot dated ' + escapeHtml(data.as_of) + '.'));
    equation.appendChild(notes);
    dialog.appendChild(equation);

    var farm = el('div', 'detail-section');
    farm.appendChild(el('h3', '', 'Farm plan — six steps'));
    var steps = el('ol', 'steps');
    row.farm_steps.forEach(function (step) {
      var parts = step.split(' Cost: ');
      var li = document.createElement('li');
      var title = document.createElement('b');
      title.textContent = parts[0];
      li.appendChild(title);
      if (parts.length > 1) {
        var cost = el('span', 'cost', 'Cost: ' + escapeHtml(parts.slice(1).join(' Cost: ')));
        li.appendChild(cost);
      }
      steps.appendChild(li);
    });
    farm.appendChild(steps);
    dialog.appendChild(farm);

    if (!dialog.open) dialog.showModal();
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  function renderAll() {
    main.innerHTML = '';
    var shell = el('div', 'shell');
    main.appendChild(shell);
    renderHeader(shell);
    renderSpotlight(shell);
    renderControls(shell);
    tableHost = el('div', '');
    shell.appendChild(tableHost);
    renderTable();
    renderModel(shell);
    renderCount();
    dialog = document.createElement('dialog');
    dialog.className = 'detail';
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
    });
    shell.appendChild(dialog);
    main.setAttribute('aria-busy', 'false');
  }

  renderAll();
})();
