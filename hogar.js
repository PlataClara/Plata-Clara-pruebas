/* Plata Clara · Hogar V1.0
   Cuentas compartidas: gastos del hogar, reparto igual/proporcional, fotos de recibos,
   "netting" (quién le paga a quién) y compartir por WhatsApp.
   Necesita cloud.js (Supabase) y el SQL hogar_v1.sql. Sin eso, la pestaña solo avisa. */
(function () {
  'use strict';
  var P = (window.PC_CONFIG && window.PC_CONFIG.PREFIX) || '';
  var CURKEY = P + 'plataclara.hogar.cur';
  var CATS = ['Alimentación', 'Servicios', 'Alquiler', 'Transporte', 'Salud', 'Hogar', 'Ocio', 'Otros'];
  var CURS = ['PEN', 'USD', 'EUR', 'MXN', 'COP', 'CLP', 'ARS', 'BRL', 'BOB', 'UYU', 'PYG', 'GTQ', 'CRC', 'DOP'];

  var H = { state: 'idle', err: '', me: null, houses: {}, cur: null, exp: [], sets: [], bal: [], busy: false };

  /* ====================== utilidades ====================== */
  function T(s, v) { try { return window.__pc && window.__pc.t ? window.__pc.t(s, v) : fmtv(s, v); } catch (e) { return fmtv(s, v); } }
  function fmtv(s, v) { return v ? String(s).replace(/\{(\w+)\}/g, function (m, n) { return v[n] !== undefined ? v[n] : m; }) : s; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sb() { return typeof window.PCSb === 'function' ? window.PCSb() : null; }
  function curHouse() { return H.cur && H.houses[H.cur] ? H.houses[H.cur] : null; }
  function lang() { return (document.documentElement.lang || 'es').slice(0, 2); }
  function money(n, code) {
    n = Number(n) || 0;
    try { return new Intl.NumberFormat(lang(), { style: 'currency', currency: code || 'PEN' }).format(n); }
    catch (e) { return (code || '') + ' ' + n.toFixed(2); }
  }
  function dmy(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] : ''; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var s = '', i; for (i = 0; i < 16; i++) s += ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2);
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-4' + s.slice(13, 16) + '-a' + s.slice(17, 20) + '-' + s.slice(20, 32);
  }
  function toast(m) { var el = document.getElementById('toast'); if (!el) return; el.textContent = m; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.remove('on'); }, 2600); }
  function memberName(h, id) { var m = h && h.members.filter(function (x) { return x.user_id === id; })[0]; return m ? m.display_name : T('Ex miembro'); }

  var ERR = {
    no_autorizado: 'No tienes permiso para hacer eso.', codigo_invalido: 'Ese código no existe. Revísalo e inténtalo de nuevo.',
    hogar_lleno: 'Ese hogar ya tiene el máximo de personas (12).', demasiados_hogares: 'Ya estás en el máximo de hogares (5).',
    saldo_pendiente: 'No puedes salir mientras tengas saldo pendiente. Primero liquiden las cuentas.',
    solo_quien_lo_creo: 'Solo quien registró o pagó el gasto puede borrarlo.', datos_invalidos: 'Revisa los datos e inténtalo de nuevo.',
    sin_participantes: 'Elige al menos una persona para repartir el gasto.', participante_invalido: 'Alguien del reparto ya no está en el hogar.',
    pagador_invalido: 'Quien pagó ya no está en el hogar.', recibo_invalido: 'No se pudo guardar la foto del recibo.',
    nosession: 'Inicia sesión para usar el Hogar.', foto: 'No pude leer esa foto. Prueba con otra.'
  };
  function errMsg(e) {
    var m = String((e && (e.message || e.details)) || e || '').toLowerCase(), k;
    for (k in ERR) if (m.indexOf(k) > -1) return T(ERR[k]);
    if (m.indexOf('fetch') > -1 || m.indexOf('network') > -1) return T('Sin conexión. Revisa tu internet.');
    if (m.indexOf('relation') > -1 || m.indexOf('does not exist') > -1 || m.indexOf('could not find') > -1 || m.indexOf('schema cache') > -1)
      return T('Falta instalar la base de datos del Hogar (hogar_v1.sql).');
    return T('No se pudo completar. Intenta de nuevo.');
  }

  /* ====================== cálculo (puro, en céntimos) ====================== */
  /* Reparte `cents` entre `ids`. mode: 'igual' | 'proporcional'. incomes: {id: ingreso}.
     Es el mismo algoritmo de la función SQL hogar_add_expense: el servidor es quien manda,
     esto solo sirve para la vista previa. Los céntimos sobrantes van, uno a uno, empezando por quien pagó. */
  function splitCents(cents, ids, mode, incomes, payer) {
    var parts = ids.filter(function (x, i) { return ids.indexOf(x) === i; }).sort();
    var n = parts.length, i, w = [], wsum = 0, out = [], assigned = 0;
    if (!n) return {};
    for (i = 0; i < n; i++) { var inc = mode === 'proporcional' ? Math.round((Number(incomes[parts[i]]) || 0) * 100) : 1; w.push(inc); wsum += inc; }
    if (wsum <= 0) { w = parts.map(function () { return 1; }); wsum = n; }
    for (i = 0; i < n; i++) {
      var q = typeof BigInt === 'function' ? Number((BigInt(cents) * BigInt(w[i])) / BigInt(wsum)) : Math.floor(cents * w[i] / wsum + 1e-9);
      out.push(q); assigned += q;
    }
    var start = Math.max(0, parts.indexOf(payer)), k = 0;
    while (assigned < cents) { out[(start + k) % n] += 1; assigned += 1; k += 1; }
    var res = {}; for (i = 0; i < n; i++) res[parts[i]] = out[i];
    return res;
  }
  /* "Netting": de los saldos de cada persona saca el mínimo de pagos entre ellas.
     bal: [{user_id, name, net}] con net > 0 = le deben, net < 0 = debe. */
  function settle(bal) {
    var cr = [], dr = [], out = [];
    bal.forEach(function (b) {
      var c = Math.round((Number(b.net) || 0) * 100);
      if (c > 0) cr.push({ id: b.user_id, name: b.name, c: c }); else if (c < 0) dr.push({ id: b.user_id, name: b.name, c: -c });
    });
    while (dr.length && cr.length) {
      dr.sort(function (a, b) { return b.c - a.c; }); cr.sort(function (a, b) { return b.c - a.c; });
      var m = Math.min(dr[0].c, cr[0].c);
      out.push({ from: dr[0].id, fromName: dr[0].name, to: cr[0].id, toName: cr[0].name, cents: m });
      dr[0].c -= m; cr[0].c -= m;
      if (!dr[0].c) dr.shift(); if (!cr[0].c) cr.shift();
    }
    return out;
  }

  /* ====================== estilos ====================== */
  function css() {
    if (document.getElementById('hg-css')) return;
    var s = document.createElement('style'); s.id = 'hg-css';
    s.textContent =
      '#hogar-root{display:grid;gap:14px;padding-bottom:84px}' +
      '#hogar-root .hg-card,#hg-ov .hg-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}' +
      '#hogar-root h3{font-size:17px;margin:0 0 8px}#hogar-root .hg-muted,#hg-ov .hg-muted{color:var(--muted);font-size:13px}' +
      '#hogar-root .hg-top{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}' +
      '#hogar-root .hg-top select{max-width:100%}' +
      '#hogar-root .hg-code{font:700 22px/1 var(--f-display);letter-spacing:.12em;margin:6px 0}' +
      '.hg-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}' +
      '.hg-b{background:var(--accent);color:var(--accent-ink);border:0;border-radius:10px;padding:10px 16px;font-weight:600}' +
      '.hg-b.alt{background:var(--surface);color:var(--ink);border:1px solid var(--line)}.hg-b.danger{background:var(--surface);color:var(--exp);border:1px solid var(--exp)}' +
      '.hg-b.wa{background:#1FA855;color:#fff}.hg-b.sm{padding:6px 12px;font-size:14px}.hg-b[disabled]{opacity:.6}' +
      '#hogar-root .hg-row,#hg-ov .hg-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}' +
      '#hogar-root .hg-row:last-child,#hg-ov .hg-row:last-child{border-bottom:0}' +
      '#hogar-root .hg-row .t{min-width:0}#hogar-root .hg-row .t b{display:block;overflow-wrap:anywhere}#hogar-root .hg-row small{color:var(--muted)}' +
      '#hogar-root .hg-amt{font:600 16px var(--f-display);white-space:nowrap;text-align:right}' +
      '.hg-pos{color:var(--inc)}.hg-neg{color:var(--exp)}' +
      '#hogar-root button.hg-open{all:unset;display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;box-sizing:border-box;padding:10px 0;border-bottom:1px solid var(--line);cursor:pointer}' +
      '#hogar-root .hg-open .t{min-width:0;text-align:left}#hogar-root .hg-open .t b{display:block;overflow-wrap:anywhere;font-weight:600}#hogar-root .hg-open .t small{display:block;color:var(--muted);font-size:13px}' +
      '#hogar-root .hg-open .hg-amt small{display:block}' +
      '#hogar-root button.hg-open:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
      '.hg-fab{position:fixed;right:max(16px,env(safe-area-inset-right,0px));bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:15;box-shadow:var(--shadow);border-radius:999px;padding:13px 20px}' +
      '@media (min-width:821px){.hg-fab{bottom:28px}}' +
      '#hg-ov{position:fixed;inset:0;z-index:60;background:rgba(8,14,11,.55);display:flex;align-items:flex-end;justify-content:center}' +
      '#hg-ov .hg-sheet{background:var(--surface);color:var(--ink);width:100%;max-width:520px;max-height:92%;overflow:auto;border-radius:18px 18px 0 0;padding:20px;font-family:var(--f-body)}' +
      '@media (min-width:600px){#hg-ov{align-items:center}#hg-ov .hg-sheet{border-radius:18px}}' +
      '#hg-ov h2{font:700 21px var(--f-display);margin:0 0 12px}' +
      '#hg-ov label.f{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}' +
      '#hg-ov input:not([type=checkbox]):not([type=radio]),#hg-ov select{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--ink);font-size:16px}' +
      '#hg-ov .hg-chk{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:15px}#hg-ov .hg-chk input{width:auto}' +
      '#hg-ov .hg-seg{display:grid;grid-template-columns:1fr 1fr;gap:8px}#hg-ov .hg-seg label{display:flex;gap:8px;align-items:center;justify-content:flex-start;text-align:left;margin:0;font-weight:500;font-size:14px;line-height:1.25;border:1px solid var(--line);border-radius:10px;padding:10px 12px}#hg-ov .hg-seg input{flex:none;width:auto;margin:0}' +
      '#hg-ov .hg-prev{background:var(--surface2);border-radius:10px;padding:8px 12px;margin-top:8px;font-size:14px}' +
      '#hg-ov .hg-msg{min-height:18px;margin-top:10px;font-size:14px;color:var(--exp)}' +
      '#hg-ov img.hg-rec{width:100%;border-radius:10px;border:1px solid var(--line);margin-top:8px}';
    document.head.appendChild(s);
  }

  /* ====================== datos ====================== */
  function savedCur() { try { return localStorage.getItem(CURKEY); } catch (e) { return null; } }
  function saveCur(id) { try { localStorage.setItem(CURKEY, id); } catch (e) { } }
  function user() { return typeof window.PCUser === 'function' ? window.PCUser() : null; }

  function load(quiet) {
    var s = sb();
    if (!s) { H.state = 'nocloud'; paint(); return Promise.resolve(); }
    if (!quiet) { H.state = 'loading'; paint(); }
    return s.auth.getSession().then(function (r) {
      if (!r.data.session) throw new Error('nosession');
      H.me = r.data.session.user;
      return s.from('household_members').select('household_id,user_id,display_name,income,households(id,name,currency,invite_code)');
    }).then(function (r) {
      if (r.error) throw r.error;
      var map = {};
      (r.data || []).forEach(function (m) {
        var hh = m.households; if (!hh) return;
        if (!map[hh.id]) map[hh.id] = { id: hh.id, name: hh.name, currency: hh.currency, code: hh.invite_code, members: [] };
        map[hh.id].members.push({ user_id: m.user_id, display_name: m.display_name, income: Number(m.income) || 0 });
      });
      H.houses = map;
      var ids = Object.keys(map);
      if (!H.cur || !map[H.cur]) { var sv = savedCur(); H.cur = sv && map[sv] ? sv : (ids[0] || null); }
      if (!H.cur) { H.exp = []; H.sets = []; H.bal = []; return; }
      return loadHouse(s, H.cur);
    }).then(function () { H.state = 'ready'; H.err = ''; paint(); }, function (e) { H.state = 'error'; H.err = errMsg(e); paint(); });
  }
  function loadHouse(s, id) {
    return Promise.all([
      s.from('expenses').select('id,paid_by,amount,description,category,expense_date,split_mode,receipt_path,created_by,expense_shares(user_id,share)')
        .eq('household_id', id).order('expense_date', { ascending: false }).order('created_at', { ascending: false }).limit(100),
      s.from('settlements').select('id,from_user,to_user,amount,created_at').eq('household_id', id).order('created_at', { ascending: false }).limit(30),
      s.rpc('hogar_balances', { p_household: id })
    ]).then(function (a) {
      if (a[0].error) throw a[0].error; if (a[1].error) throw a[1].error; if (a[2].error) throw a[2].error;
      H.exp = a[0].data || []; H.sets = a[1].data || []; H.bal = a[2].data || [];
    });
  }
  function rpc(name, args) { return sb().rpc(name, args).then(function (r) { if (r.error) throw r.error; return r.data; }); }

  /* ====================== pantalla principal ====================== */
  function html() { return '<div id="hogar-root"></div>'; }

  function paint() {
    css();
    var root = document.getElementById('hogar-root');
    if (!root) return;
    var u = user();
    if (H.me && (!u || u.id !== H.me.id)) { H.state = 'idle'; H.me = null; H.houses = {}; H.cur = null; H.exp = []; H.sets = []; H.bal = []; }
    var old = document.querySelector('.hg-fab'); if (old) old.remove();
    if (H.state === 'idle') { load(); return; }
    if (H.state === 'nocloud') { root.innerHTML = '<div class="hg-card"><h3>' + T('Hogar') + '</h3><p class="hg-muted">' + T('El Hogar necesita tu cuenta en la nube. Inicia sesión para usarlo.') + '</p></div>'; return; }
    if (H.state === 'loading') { root.innerHTML = '<div class="hg-card"><p class="hg-muted">' + T('Cargando…') + '</p></div>'; return; }
    if (H.state === 'error') { root.innerHTML = '<div class="hg-card"><h3>' + T('No se pudo cargar el Hogar') + '</h3><p class="hg-muted">' + esc(H.err) + '</p><div class="hg-btns"><button class="hg-b" data-hg="refresh">' + T('Reintentar') + '</button></div></div>'; return; }
    var h = curHouse();
    if (!h) { root.innerHTML = welcomeHTML(); return; }
    root.innerHTML = houseHTML(h);
    var b = document.createElement('button'); b.className = 'hg-b hg-fab'; b.setAttribute('data-hg', 'add'); b.textContent = T('+ Gasto del hogar');
    document.body.appendChild(b);
  }

  function welcomeHTML() {
    return '<div class="hg-card"><h3>' + T('Cuentas del hogar') + '</h3>' +
      '<p class="hg-muted">' + T('Compartan los gastos de la casa: cada quien anota lo que paga, la app reparte y te dice quién le debe a quién.') + '</p>' +
      '<div class="hg-btns"><button class="hg-b" data-hg="new-house">' + T('Crear un hogar') + '</button><button class="hg-b alt" data-hg="join-house">' + T('Unirme con un código') + '</button></div></div>';
  }

  function houseHTML(h) {
    var me = H.me && H.me.id, cc = h.currency, i, out = [];
    var ids = Object.keys(H.houses);
    var sel = ids.length > 1 ? '<select id="hg-sel" aria-label="' + T('Hogar') + '">' + ids.map(function (id) { return '<option value="' + esc(id) + '"' + (id === h.id ? ' selected' : '') + '>' + esc(H.houses[id].name) + '</option>'; }).join('') + '</select>' : '<h3 style="margin:0">' + esc(h.name) + '</h3>';
    out.push('<div class="hg-card"><div class="hg-top">' + sel + '<span><button class="hg-b alt sm" data-hg="refresh">' + T('Actualizar') + '</button> <button class="hg-b alt sm" data-hg="me">' + T('Mis datos') + '</button></span></div>' +
      '<p class="hg-muted" style="margin:10px 0 0">' + T('Código para invitar') + '</p><div class="hg-code">' + esc(h.code) + '</div>' +
      '<div class="hg-btns" style="margin-top:2px"><button class="hg-b alt sm" data-hg="copy-code">' + T('Copiar') + '</button><button class="hg-b wa sm" data-hg="wa-code">' + T('Invitar por WhatsApp') + '</button>' +
      '<button class="hg-b alt sm" data-hg="new-house">' + T('Crear otro hogar') + '</button><button class="hg-b alt sm" data-hg="join-house">' + T('Unirme a otro') + '</button></div></div>');

    /* cuentas y netting */
    var transfers = settle(H.bal);
    var balRows = H.bal.map(function (b) {
      var n = Number(b.net) || 0, cls = n > 0.004 ? 'hg-pos' : n < -0.004 ? 'hg-neg' : '';
      var txt = n > 0.004 ? T('le deben') : n < -0.004 ? T('debe') : T('está al día');
      return '<div class="hg-row"><div class="t"><b>' + esc(b.name) + (b.user_id === me ? ' (' + T('tú') + ')' : '') + '</b><small>' + txt + '</small></div><div class="hg-amt ' + cls + '">' + (Math.abs(n) < 0.005 ? '' : money(Math.abs(n), cc)) + '</div></div>';
    }).join('');
    var trRows = transfers.map(function (t, k) {
      var mine = t.from === me || t.to === me;
      var who = (t.from === me ? T('Tú') : esc(t.fromName)) + ' → ' + (t.to === me ? T('ti') : esc(t.toName));
      return '<div class="hg-row"><div class="t"><b>' + who + '</b><small>' + (t.from === me ? T('Tú pagas') : t.to === me ? T('Te pagan') : T('Pago entre otros')) + '</small></div>' +
        '<div style="text-align:right"><div class="hg-amt">' + money(t.cents / 100, cc) + '</div>' + (mine ? '<button class="hg-b sm" style="margin-top:4px" data-hg="pay" data-k="' + k + '">' + T('Marcar pagado') + '</button>' : '') + '</div></div>';
    }).join('');
    out.push('<div class="hg-card"><h3>' + T('Cómo van las cuentas') + '</h3>' + (balRows || '<p class="hg-muted">' + T('Aún no hay gastos.') + '</p>') +
      (transfers.length ? '<h3 style="margin-top:14px">' + T('Para quedar a mano') + '</h3>' + trRows + '<div class="hg-btns"><button class="hg-b wa" data-hg="wa-summary">' + T('Compartir resumen por WhatsApp') + '</button></div>'
        : (H.bal.length && H.exp.length ? '<p class="hg-pos" style="margin:10px 0 0"><b>' + T('¡Todos están al día!') + '</b></p>' : '')) + '</div>');

    /* gastos */
    var month = today().slice(0, 7), tot = 0;
    H.exp.forEach(function (e) { if (String(e.expense_date).slice(0, 7) === month) tot += Number(e.amount) || 0; });
    var rows = H.exp.map(function (e) {
      var mine = (e.expense_shares || []).filter(function (s) { return s.user_id === me; })[0];
      return '<button class="hg-open" data-hg="open-exp" data-id="' + esc(e.id) + '"><span class="t"><b>' + esc(e.description) + (e.receipt_path ? ' 📎' : '') + '</b><small>' +
        T('Pagó {n}', { n: esc(memberName(h, e.paid_by)) }) + ' · ' + dmy(e.expense_date) + ' · ' + esc(T(e.category)) + '</small></span>' +
        '<span class="hg-amt">' + money(e.amount, cc) + '<br><small style="font-weight:400;color:var(--muted);font-family:var(--f-body)">' + (mine ? T('Tu parte') + ' ' + money(mine.share, cc) : '') + '</small></span></button>';
    }).join('');
    out.push('<div class="hg-card"><div class="hg-top"><h3 style="margin:0">' + T('Gastos') + '</h3><span class="hg-muted">' + T('Este mes') + ': <b>' + money(tot, cc) + '</b></span></div>' +
      (rows || '<p class="hg-muted">' + T('Todavía no hay gastos. Anota el primero con “+ Gasto del hogar”.') + '</p>') + '</div>');

    /* pagos registrados */
    if (H.sets.length) {
      out.push('<div class="hg-card"><h3>' + T('Pagos registrados') + '</h3>' + H.sets.slice(0, 8).map(function (s) {
        return '<div class="hg-row"><div class="t"><b>' + esc(memberName(h, s.from_user)) + ' → ' + esc(memberName(h, s.to_user)) + '</b><small>' + esc(String(s.created_at).slice(0, 10)) + '</small></div><div class="hg-amt">' + money(s.amount, cc) + '</div></div>';
      }).join('') + '</div>');
    }
    return out.join('');
  }

  /* ====================== hojas (modales) ====================== */
  var ov = null;
  function openSheet(inner, bind) {
    css(); closeSheet();
    ov = document.createElement('div'); ov.id = 'hg-ov';
    ov.innerHTML = '<div class="hg-sheet" role="dialog" aria-modal="true">' + inner + '</div>';
    ov.addEventListener('click', function (e) { if (e.target === ov) closeSheet(); });
    document.body.appendChild(ov);
    if (bind) bind(ov);
    var f = ov.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=file]),select'); if (f && window.innerWidth > 700) f.focus();
  }
  function closeSheet() { if (ov) { ov.remove(); ov = null; } }
  function msg(t) { var m = ov && ov.querySelector('.hg-msg'); if (m) m.textContent = t || ''; }
  function defName() { var u = user(); return (u && u.user_metadata && u.user_metadata.nombre) || ''; }
  function ccDefault() { try { return window.__pc.get().cc || 'PEN'; } catch (e) { return 'PEN'; } }
  function incomeVal(v) { v = String(v || '').replace(',', '.').trim(); var n = parseFloat(v); return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; }

  function sheetCreate() {
    var cc = ccDefault();
    openSheet('<h2>' + T('Crear un hogar') + '</h2><form id="hg-f">' +
      '<label class="f">' + T('Nombre del hogar') + '</label><input name="name" maxlength="60" required placeholder="' + T('Casa, Departamento…') + '">' +
      '<label class="f">' + T('Moneda') + '</label><select name="cur">' + CURS.map(function (c) { return '<option' + (c === cc ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select>' +
      '<label class="f">' + T('Tu nombre en el hogar') + '</label><input name="me" maxlength="40" required value="' + esc(defName()) + '">' +
      '<label class="f">' + T('Tu ingreso mensual (opcional)') + '</label><input name="inc" inputmode="decimal" placeholder="0.00">' +
      '<p class="hg-muted">' + T('Solo sirve para repartir “proporcional”. Lo verán las personas de este hogar.') + '</p>' +
      '<div class="hg-msg" role="status"></div><div class="hg-btns"><button class="hg-b" type="submit">' + T('Crear') + '</button><button class="hg-b alt" type="button" data-hg="close">' + T('Cancelar') + '</button></div></form>',
      function (o) {
        o.querySelector('#hg-f').onsubmit = function (e) {
          e.preventDefault(); var f = e.target, b = f.querySelector('[type=submit]'); b.disabled = true; msg('');
          rpc('hogar_create', { p_name: f.name.value, p_currency: f.cur.value, p_display_name: f.me.value, p_income: incomeVal(f.inc.value) })
            .then(function (r) { H.cur = r.id; saveCur(r.id); closeSheet(); toast(T('Hogar creado')); return load(true); })
            .catch(function (er) { msg(errMsg(er)); b.disabled = false; });
        };
      });
  }
  function sheetJoin() {
    openSheet('<h2>' + T('Unirme a un hogar') + '</h2><form id="hg-f">' +
      '<label class="f">' + T('Código de invitación') + '</label><input name="code" maxlength="8" required autocapitalize="characters" autocomplete="off" style="text-transform:uppercase;letter-spacing:.12em">' +
      '<label class="f">' + T('Tu nombre en el hogar') + '</label><input name="me" maxlength="40" required value="' + esc(defName()) + '">' +
      '<label class="f">' + T('Tu ingreso mensual (opcional)') + '</label><input name="inc" inputmode="decimal" placeholder="0.00">' +
      '<p class="hg-muted">' + T('Solo sirve para repartir “proporcional”. Lo verán las personas de este hogar.') + '</p>' +
      '<div class="hg-msg" role="status"></div><div class="hg-btns"><button class="hg-b" type="submit">' + T('Unirme') + '</button><button class="hg-b alt" type="button" data-hg="close">' + T('Cancelar') + '</button></div></form>',
      function (o) {
        o.querySelector('#hg-f').onsubmit = function (e) {
          e.preventDefault(); var f = e.target, b = f.querySelector('[type=submit]'); b.disabled = true; msg('');
          rpc('hogar_join', { p_code: f.code.value, p_display_name: f.me.value, p_income: incomeVal(f.inc.value) })
            .then(function (r) { H.cur = r.id; saveCur(r.id); closeSheet(); toast(T('Te uniste al hogar')); return load(true); })
            .catch(function (er) { msg(errMsg(er)); b.disabled = false; });
        };
      });
  }
  function sheetMe() {
    var h = curHouse(), me = H.me && H.me.id, m = h && h.members.filter(function (x) { return x.user_id === me; })[0];
    if (!m) return;
    openSheet('<h2>' + T('Mis datos en {n}', { n: esc(h.name) }) + '</h2><form id="hg-f">' +
      '<label class="f">' + T('Tu nombre en el hogar') + '</label><input name="me" maxlength="40" required value="' + esc(m.display_name) + '">' +
      '<label class="f">' + T('Tu ingreso mensual (opcional)') + '</label><input name="inc" inputmode="decimal" value="' + (m.income ? m.income : '') + '" placeholder="0.00">' +
      '<p class="hg-muted">' + T('Se usa para el reparto proporcional de los gastos nuevos.') + '</p>' +
      '<p class="hg-muted"><b>' + T('Personas') + ':</b> ' + h.members.map(function (x) { return esc(x.display_name); }).join(', ') + '</p>' +
      '<div class="hg-msg" role="status"></div><div class="hg-btns"><button class="hg-b" type="submit">' + T('Guardar') + '</button><button class="hg-b alt" type="button" data-hg="close">' + T('Cancelar') + '</button>' +
      '<button class="hg-b danger" type="button" data-hg="leave">' + T('Salir del hogar') + '</button></div></form>',
      function (o) {
        o.querySelector('#hg-f').onsubmit = function (e) {
          e.preventDefault(); var f = e.target, b = f.querySelector('[type=submit]'); b.disabled = true; msg('');
          rpc('hogar_update_me', { p_household: h.id, p_display_name: f.me.value, p_income: incomeVal(f.inc.value) })
            .then(function () { closeSheet(); toast(T('Guardado')); return load(true); })
            .catch(function (er) { msg(errMsg(er)); b.disabled = false; });
        };
      });
  }

  /* ----- gasto nuevo ----- */
  function sheetExpense() {
    var h = curHouse(), me = H.me && H.me.id; if (!h) return;
    var incomes = {}; h.members.forEach(function (m) { incomes[m.user_id] = m.income; });
    openSheet('<h2>' + T('Gasto del hogar') + '</h2><form id="hg-f">' +
      '<label class="f">' + T('Monto ({c})', { c: esc(h.currency) }) + '</label><input name="amount" inputmode="decimal" required placeholder="0.00">' +
      '<label class="f">' + T('¿En qué fue?') + '</label><input name="desc" maxlength="80" required placeholder="' + T('Luz, mercado, internet…') + '">' +
      '<label class="f">' + T('Categoría') + '</label><select name="cat">' + CATS.map(function (c) { return '<option value="' + c + '">' + T(c) + '</option>'; }).join('') + '</select>' +
      '<label class="f">' + T('Fecha') + '</label><input type="date" name="date" required value="' + today() + '">' +
      '<label class="f">' + T('¿Quién pagó?') + '</label><select name="payer">' + h.members.map(function (m) { return '<option value="' + esc(m.user_id) + '"' + (m.user_id === me ? ' selected' : '') + '>' + esc(m.display_name) + (m.user_id === me ? ' (' + T('tú') + ')' : '') + '</option>'; }).join('') + '</select>' +
      '<label class="f">' + T('¿Cómo se reparte?') + '</label><div class="hg-seg"><label><input type="radio" name="mode" value="igual" checked> ' + T('Igual') + '</label><label><input type="radio" name="mode" value="proporcional"> ' + T('Proporcional a ingresos') + '</label></div>' +
      '<label class="f">' + T('¿Entre quiénes?') + '</label>' + h.members.map(function (m) { return '<label class="hg-chk"><input type="checkbox" name="part" value="' + esc(m.user_id) + '" checked> ' + esc(m.display_name) + '</label>'; }).join('') +
      '<div class="hg-prev" id="hg-prev"></div>' +
      '<label class="f">' + T('Foto del recibo (opcional)') + '</label><input type="file" name="photo" accept="image/*" capture="environment">' +
      '<div class="hg-msg" role="status"></div><div class="hg-btns"><button class="hg-b" type="submit">' + T('Guardar') + '</button><button class="hg-b alt" type="button" data-hg="close">' + T('Cancelar') + '</button></div></form>',
      function (o) {
        var f = o.querySelector('#hg-f');
        function read() {
          var amt = parseFloat(String(f.amount.value).replace(',', '.')), mode = f.mode.value, parts = [];
          [].forEach.call(f.querySelectorAll('input[name=part]:checked'), function (c) { parts.push(c.value); });
          return { cents: isFinite(amt) && amt > 0 ? Math.round(amt * 100) : 0, mode: mode, parts: parts, payer: f.payer.value };
        }
        function preview() {
          var r = read(), el = o.querySelector('#hg-prev');
          if (!r.cents || !r.parts.length) { el.textContent = T('Escribe el monto y elige entre quiénes se reparte.'); return; }
          var sp = splitCents(r.cents, r.parts, r.mode, incomes, r.payer);
          el.innerHTML = Object.keys(sp).map(function (id) { return esc(memberName(h, id)) + ': <b>' + money(sp[id] / 100, h.currency) + '</b>'; }).join(' · ');
        }
        f.addEventListener('input', preview); f.addEventListener('change', preview); preview();
        f.onsubmit = function (e) {
          e.preventDefault(); var r = read(), b = f.querySelector('[type=submit]');
          if (!r.cents) { msg(T('Escribe un monto válido.')); return; }
          if (!r.parts.length) { msg(errMsg('sin_participantes')); return; }
          b.disabled = true; msg('');
          var eid = uuid(), file = f.photo.files && f.photo.files[0], path = null;
          (file ? compress(file).then(function (blob) {
            path = h.id + '/' + eid + '.jpg';
            return sb().storage.from('recibos').upload(path, blob, { contentType: 'image/jpeg', upsert: false }).then(function (u) { if (u.error) throw u.error; });
          }) : Promise.resolve()).then(function () {
            return rpc('hogar_add_expense', { p_household: h.id, p_id: eid, p_paid_by: r.payer, p_amount: r.cents / 100, p_description: f.desc.value, p_category: f.cat.value, p_date: f.date.value, p_mode: r.mode, p_participants: r.parts, p_receipt_path: path })
              .catch(function (er) { if (path) sb().storage.from('recibos').remove([path]); throw er; });
          }).then(function () { closeSheet(); toast(T('Gasto guardado')); return load(true); })
            .catch(function (er) { msg(er && er.message === 'foto' ? T(ERR.foto) : errMsg(er)); b.disabled = false; });
        };
      });
  }
  /* Reduce la foto (máx. 1280 px, JPEG) para que pese poco */
  function compress(file) {
    return new Promise(function (ok, fail) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 1280, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? ok(b) : fail(new Error('foto')); }, 'image/jpeg', 0.72);
      };
      img.onerror = function () { URL.revokeObjectURL(url); fail(new Error('foto')); };
      img.src = url;
    });
  }

  /* ----- detalle de un gasto ----- */
  function sheetDetail(id) {
    var h = curHouse(), me = H.me && H.me.id, e = H.exp.filter(function (x) { return x.id === id; })[0]; if (!h || !e) return;
    var can = e.created_by === me || e.paid_by === me;
    openSheet('<h2>' + esc(e.description) + '</h2>' +
      '<p class="hg-muted">' + T('Pagó {n}', { n: esc(memberName(h, e.paid_by)) }) + ' · ' + esc(String(e.expense_date)) + ' · ' + esc(T(e.category)) + ' · ' + (e.split_mode === 'igual' ? T('Reparto igual') : T('Reparto proporcional')) + '</p>' +
      '<div class="hg-amt" style="font-size:24px;text-align:left;margin:6px 0 10px">' + money(e.amount, h.currency) + '</div>' +
      (e.expense_shares || []).map(function (s) { return '<div class="hg-row"><span>' + esc(memberName(h, s.user_id)) + '</span><b>' + money(s.share, h.currency) + '</b></div>'; }).join('') +
      '<div id="hg-rec"></div><div class="hg-msg" role="status"></div><div class="hg-btns">' +
      (can ? '<button class="hg-b danger" data-hg="del-exp" data-id="' + esc(e.id) + '">' + T('Borrar gasto') + '</button>' : '') + '<button class="hg-b alt" data-hg="close">' + T('Cerrar') + '</button></div>',
      function (o) {
        if (!e.receipt_path) return;
        sb().storage.from('recibos').createSignedUrl(e.receipt_path, 300).then(function (r) {
          var box = o.querySelector('#hg-rec'); if (!box) return;
          if (r.error || !r.data) { box.innerHTML = '<p class="hg-muted">' + T('No se pudo cargar la foto del recibo.') + '</p>'; return; }
          var im = document.createElement('img'); im.className = 'hg-rec'; im.alt = T('Recibo'); im.src = r.data.signedUrl; box.appendChild(im);
        });
      });
  }

  /* ====================== acciones ====================== */
  function waOpen(text) { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener'); }
  function summaryText(h) {
    var tr = settle(H.bal), d = new Date(), lines = [];
    lines.push('🏠 *' + h.name + '* — ' + T('cuentas al {d}', { d: ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) }));
    if (!tr.length) lines.push(T('¡Todos están al día! ✅'));
    tr.forEach(function (t) { lines.push('• ' + t.fromName + ' → ' + t.toName + ': ' + money(t.cents / 100, h.currency)); });
    lines.push(''); lines.push(T('Hecho con Plata Clara'));
    return lines.join('\n');
  }
  function act(a, el) {
    var h = curHouse(), me = H.me && H.me.id;
    if (a === 'close') closeSheet();
    else if (a === 'refresh') load();
    else if (a === 'new-house') sheetCreate();
    else if (a === 'join-house') sheetJoin();
    else if (a === 'me') sheetMe();
    else if (a === 'add') sheetExpense();
    else if (a === 'open-exp') sheetDetail(el.getAttribute('data-id'));
    else if (a === 'copy-code' && h) {
      var done = function () { toast(T('Código copiado')); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(h.code).then(done, function () { toast(h.code); }); else toast(h.code);
    }
    else if (a === 'wa-code' && h) waOpen(T('Únete a nuestro hogar “{n}” en Plata Clara. Código: {c}', { n: h.name, c: h.code }));
    else if (a === 'wa-summary' && h) waOpen(summaryText(h));
    else if (a === 'pay' && h) {
      var t = settle(H.bal)[Number(el.getAttribute('data-k'))]; if (!t) return;
      var q = t.from === me ? T('¿Confirmas que pagaste {m} a {n}?', { m: money(t.cents / 100, h.currency), n: t.toName })
        : T('¿Confirmas que {n} te pagó {m}?', { m: money(t.cents / 100, h.currency), n: t.fromName });
      if (!window.confirm(q)) return;
      el.disabled = true;
      rpc('hogar_settle', { p_household: h.id, p_to: t.to, p_amount: t.cents / 100, p_from: t.from })
        .then(function () { toast(T('Pago registrado')); return load(true); }).catch(function (er) { toast(errMsg(er)); el.disabled = false; });
    }
    else if (a === 'del-exp') {
      if (!window.confirm(T('¿Borrar este gasto? Se recalculan las cuentas.'))) return;
      var id = el.getAttribute('data-id'); el.disabled = true;
      rpc('hogar_delete_expense', { p_expense: id }).then(function (r) {
        if (r && r.receipt_path) sb().storage.from('recibos').remove([r.receipt_path]);
        closeSheet(); toast(T('Gasto borrado')); return load(true);
      }).catch(function (er) { msg(errMsg(er)); el.disabled = false; });
    }
    else if (a === 'leave' && h) {
      if (!window.confirm(T('¿Salir de “{n}”? Tus gastos pasados se quedan en el hogar.', { n: h.name }))) return;
      rpc('hogar_leave', { p_household: h.id }).then(function () { closeSheet(); H.cur = null; toast(T('Saliste del hogar')); return load(true); })
        .catch(function (er) { msg(errMsg(er)); });
    }
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-hg]'); if (!el) return;
    e.preventDefault(); act(el.getAttribute('data-hg'), el);
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'hg-sel') { H.cur = e.target.value; saveCur(H.cur); load(); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov) closeSheet(); });
  document.addEventListener('pc-render', function () {
    var v = window.__pc && window.__pc.view && window.__pc.view();
    var fab = document.querySelector('.hg-fab'); if (v !== 'hogar') { if (fab) fab.remove(); closeSheet(); return; }
    paint();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && window.__pc && window.__pc.view && window.__pc.view() === 'hogar' && H.state === 'ready' && !ov) load(true);
  });

  window.PCHogar = { html: html, paint: paint, _calc: { splitCents: splitCents, settle: settle } };
  /* Si se abrió directo en #hogar, la vista aún no tenía el contenedor */
  setTimeout(function () {
    if (window.__pc && window.__pc.view && window.__pc.view() === 'hogar' && !document.getElementById('hogar-root')) {
      var v = document.getElementById('view'); if (v) { v.insertAdjacentHTML('beforeend', html()); paint(); }
    }
  }, 0);
})();
