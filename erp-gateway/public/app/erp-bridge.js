/* ALTAKA-ALWATANIYAH — جسر منظومة ERP (تحقنه البوابة في صفحة ERP المخدومة من /erp/).
   ERP هو البرنامج الوحيد: يدخل الموظف باسم المستخدم وكلمة المرور، ويجد داخله:
   - قسم «العمل الميداني» (الحضور بالباركود والسيلفي، الكشف، التنفيذ، المعوقات، التقارير، الإشعارات)
     حسب صفته وصلاحياته المحددة على الحاسبة الأم — بلا دخول ثانٍ.
   - واجهة مناسبة للهاتف (قائمة جانبية منزلقة) — مع erp-mobile.css.
   - أندرويد: حفظ وفتح الملفات المنزّلة عبر جسر التطبيق، وزر الرجوع.
   - الدخول الواحد من التطبيق القديم (رمز sso لمرة واحدة) ما زال مدعوماً. */
(function () {
  'use strict';
  var NE = window.__NE = window.__NE || {};
  if (!document.querySelector('link[href^="/app/erp-mobile.css"]')) {
    var me_ = document.currentScript && document.currentScript.src || '', v_ = (/[?&]v=([\w]+)/.exec(me_) || [])[1] || String(Date.now());
    var lk = document.createElement('link'); lk.rel = 'stylesheet'; lk.href = '/app/erp-mobile.css?v=' + v_; (document.head || document.documentElement).appendChild(lk);
  }
  var parentWin = null;
  try { if (window.parent !== window && window.parent.location.origin === location.origin) parentWin = window.parent; } catch (e) {}

  /* ---------- 1) الدخول الواحد برمز sso (للتوافق) ---------- */
  var code = null;
  try { if (parentWin && parentWin.__takeErpSso) code = parentWin.__takeErpSso(); } catch (e) {}
  if (!code) {
    var m = /[#&]sso=([a-f0-9]{20,})/.exec(location.hash || '');
    if (m) { code = m[1]; try { history.replaceState(null, '', location.pathname + location.search + '#/'); } catch (e) {} }
  }
  function setVal(el, v) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function veil(on) {
    var v = document.getElementById('ne-sso-veil');
    if (on && !v) { v = document.createElement('div'); v.id = 'ne-sso-veil'; v.textContent = 'جارٍ فتح منظومة ERP…'; (document.body || document.documentElement).appendChild(v); }
    else if (!on && v) v.remove();
  }
  function trySso(n) {
    var u = document.querySelector('input[autocomplete="username"]'), p = document.querySelector('input[type="password"]');
    if (!u || !p) { if (n < 200) return setTimeout(function () { trySso(n + 1); }, 100); return veil(false); }
    setVal(u, '__sso__'); setVal(p, code); code = null;
    var f = u.closest('form');
    setTimeout(function () {
      if (f && f.requestSubmit) f.requestSubmit(); else { var b = f && f.querySelector('button[type=submit]'); if (b) b.click(); }
      setTimeout(function () { setVal(u, ''); setVal(p, ''); veil(false); }, 1500);
    }, 50);
  }
  if (code) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { veil(true); trySso(0); }); else { veil(true); trySso(0); } }

  /* ---------- 2) جلسة ERP ← جلسة العمل الميداني ---------- */
  var origPrefs = window.neLoadPrefs;
  window.neLoadPrefs = function (me, getToken) {
    NE.me = me; NE.getToken = getToken;
    try { fieldLogin(); } catch (e) {}
    return typeof origPrefs === 'function' ? origPrefs.apply(this, arguments) : undefined;
  };
  function deviceId() {
    try { var d = localStorage.getItem('ne.field.device'); if (!d) { d = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('ne.field.device', d); } return d; } catch (e) { return null; }
  }
  var loginBusy = null;
  function fieldLogin(force) {
    if (NE.field && !force) return Promise.resolve(NE.field);
    if (loginBusy) return loginBusy;
    var tok = NE.getToken && NE.getToken();
    if (!tok) return Promise.reject(new Error('سجّل الدخول إلى منظومة ERP أولاً'));
    loginBusy = fetch('/api/mobile/login-erp-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ erpToken: tok, deviceId: deviceId(), device: navigator.userAgent.slice(0, 120) }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'تعذّر فتح العمل الميداني'); return j; }); })
      .then(function (j) { NE.field = j; loginBusy = null; render(); return j; }, function (e) { loginBusy = null; NE.fieldError = e.message; render(); throw e; });
    return loginBusy;
  }
  // للإطار الداخلي (تطبيق العمل الميداني /app/?embed=1)
  window.__neFieldSession = function (force) { return fieldLogin(force); };
  window.__neFieldClose = function () { closeField(); };

  /* ---------- 3) قسم «العمل الميداني» داخل ERP (القائمة الجانبية + بطاقات الشاشة الرئيسية) ---------- */
  var SV = function (d) { return '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'; };
  var TOOLS = [
    { k: 'attendance', h: 'tasks', t: 'الحضور والمهام الميدانية', i: SV('<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M11 8v8M15 8v8M18 8v8"/>') },
    { k: 'survey', h: 'survey', t: 'تطبيق الكشف', i: SV('<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 14 2 2 4-4"/>') },
    { k: 'execution', h: 'execution', t: 'تطبيق التنفيذ', i: SV('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>') },
    { k: 'obstacles', h: 'obstacles', t: 'الإبلاغ عن معوّق', i: SV('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>') },
    { k: 'attadmin', h: 'attadm', t: 'إدارة رموز الحضور', i: SV('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><path d="M9 15v2M12 15v2M15 15v2"/>') },
    { k: 'reports', h: 'reports', t: 'رفع تقرير / استمارة', i: SV('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>') }
  ];
  var FIELD_PERMS = TOOLS.map(function (x) { return x.k; });
  function myTools() { var p = (NE.field && NE.field.perms) || []; return TOOLS.filter(function (x) { return p.indexOf(x.k) >= 0; }); }
  function hasField() { return myTools().length > 0; }
  function signedIn() { return !!document.querySelector('#root') && !document.querySelector('input[autocomplete="current-password"]') && !!document.querySelector('#root button, #root aside'); }
  function navGroup() {
    var nav = document.querySelector('#root aside nav'); var mine = document.getElementById('ne-field-nav');
    if (!nav || !hasField()) { if (mine) mine.remove(); return; }
    if (mine && nav.contains(mine)) { [].forEach.call(mine.querySelectorAll('a'), function (a) { a.classList.toggle('ne-on', isOpen() && curTool === a.getAttribute('data-h')); }); return; }
    var groups = nav.querySelectorAll(':scope > div'); if (!groups.length) return;
    var tpl = [].slice.call(nav.querySelectorAll('a[href^="#/"]')).filter(function (a) { return !/shadow-lift/.test(a.className); })[0] || nav.querySelector('a[href^="#/"]');
    var titleTpl = groups[0].firstElementChild;
    if (!tpl || !titleTpl) return;
    var g = document.createElement('div'); g.id = 'ne-field-nav';
    var title = titleTpl.cloneNode(false); title.textContent = 'العمل الميداني'; g.appendChild(title);
    var list = document.createElement('div'); list.className = (groups[0].children[1] && groups[0].children[1].className) || 'space-y-1'; g.appendChild(list);
    myTools().forEach(function (x) {
      var a = tpl.cloneNode(true); a.removeAttribute('aria-current'); a.setAttribute('href', '#/'); a.setAttribute('data-h', x.h); a.title = x.t;
      var bar = a.querySelector('.absolute'); if (bar) bar.remove();
      var spans = a.querySelectorAll(':scope > span');
      if (spans[0]) spans[0].innerHTML = x.i; if (spans[1]) spans[1].textContent = x.t; else a.appendChild(document.createTextNode(x.t));
      a.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); openField(x.h); }, true);
      list.appendChild(a);
    });
    groups[0].parentNode.insertBefore(g, groups[0].nextSibling);
  }
  // بطاقات الشاشة الرئيسية (شبكة البطاقات بعد الدخول)
  function homeTiles() {
    var grid = [].slice.call(document.querySelectorAll('#root .grid')).filter(function (x) { return x.children.length >= 2 && [].every.call(x.children, function (c) { return c.tagName === 'BUTTON' || c.classList.contains('ne-ftile'); }); })[0];
    var old = document.querySelectorAll('.ne-ftile');
    if (!grid || !hasField()) { [].forEach.call(old, function (t) { t.remove(); }); return; }
    if (grid.querySelector('.ne-ftile')) return;
    var tpl = [].slice.call(grid.children).filter(function (c) { return c.tagName === 'BUTTON'; })[0]; if (!tpl) return;
    myTools().forEach(function (x, n) {
      var b = tpl.cloneNode(true); b.classList.add('ne-ftile'); b.style.animationDelay = (80 + n * 40) + 'ms';
      var sp = b.querySelectorAll(':scope > span');
      if (sp[0]) sp[0].innerHTML = x.i.replace(/width="19" height="19"/, 'width="42" height="42"').replace('stroke-width="2"', 'stroke-width="1.6"');
      if (sp[1]) sp[1].textContent = x.t;
      b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); openField(x.h); }, true);
      grid.appendChild(b);
    });
    grid.classList.add('ne-grid');
  }
  function navLink() { navGroup(); homeTiles(); }
  var curTool = null;
  var wrap = null;
  function isOpen() { return !!(wrap && !wrap.classList.contains('ne-hide')); }
  function openField(hash) {
    curTool = hash || 'tasks'; hash = curTool;
    if (!wrap) {
      wrap = document.createElement('div'); wrap.id = 'ne-field';
      wrap.innerHTML = '<div class="ne-fbar"><button type="button" id="ne-fback">→ رجوع</button><b id="ne-ftitle">العمل الميداني</b></div><iframe id="ne-fframe" allow="camera; microphone; geolocation; clipboard-write; fullscreen; web-share"></iframe>';
      document.body.appendChild(wrap);
      wrap.querySelector('#ne-fback').onclick = closeField;
      wrap.querySelector('#ne-fframe').src = '/app/?embed=1' + (hash ? '#' + hash : '');
    } else if (hash) { try { wrap.querySelector('#ne-fframe').contentWindow.location.hash = hash; } catch (e) {} }
    var t = TOOLS.filter(function (x) { return x.h === hash; })[0]; wrap.querySelector('#ne-ftitle').textContent = t ? t.t : 'العمل الميداني';
    wrap.classList.remove('ne-hide'); place(); closeNav(); navLink();
  }
  function closeField() { if (wrap) wrap.classList.add('ne-hide'); navLink(); }
  function place() {
    if (!wrap) return;
    var aside = document.querySelector('#root aside');
    var w = aside && window.innerWidth > 900 ? aside.getBoundingClientRect().width : 0;
    wrap.style.insetInlineStart = w + 'px';
  }
  window.addEventListener('resize', place);

  /* ---------- 4) الهاتف: قائمة جانبية منزلقة ---------- */
  function closeNav() { document.documentElement.classList.remove('ne-nav-open'); }
  function menuBtn() {
    var ex = document.getElementById('ne-menu'); if (ex && document.contains(ex) && ex.parentNode && ex.parentNode.tagName === 'HEADER') return; if (ex) ex.remove();
    var hdr = document.querySelector('#root header'); if (!hdr) return;
    var b = document.createElement('button'); b.id = 'ne-menu'; b.type = 'button'; b.setAttribute('aria-label', 'القائمة'); b.innerHTML = '☰';
    b.onclick = function () { document.documentElement.classList.toggle('ne-nav-open'); };
    if (!document.getElementById('ne-shade')) { var sh = document.createElement('div'); sh.id = 'ne-shade'; sh.onclick = closeNav; document.body.appendChild(sh); }
    hdr.insertBefore(b, hdr.firstChild);
  }
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest('#root aside nav a, #root .grid > button');
    if (a && !a.hasAttribute('data-h') && !a.classList.contains('ne-ftile')) { closeNav(); closeField(); }
  }, true);

  /* ---------- مراقبة الواجهة ---------- */
  var tick = null;
  function render() {
    var on = signedIn();
    document.documentElement.classList.toggle('ne-in', on);
    if (on) { menuBtn(); navLink(); place(); if (!NE.field && NE.getToken && !loginBusy && !NE.fieldError) fieldLogin().catch(function () {}); }
    else {
      // خرج من ERP ← إنهاء جلسة العمل الميداني
      if (NE.field || wrap) { NE.field = null; NE.fieldError = null; if (wrap) { wrap.remove(); wrap = null; } }
      closeNav();
    }
  }
  function schedule() { if (tick) return; tick = setTimeout(function () { tick = null; render(); }, 120); }
  function boot() { new MutationObserver(schedule).observe(document.getElementById('root') || document.body, { childList: true, subtree: true }); render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  /* ---------- زر الرجوع (أندرويد) ---------- */
  window.appBack = function () {
    if (isOpen()) {
      try { var w = wrap.querySelector('#ne-fframe').contentWindow; if (w.appBack && w.appBack()) return true; } catch (e) {}
      closeField(); return true;
    }
    if (document.documentElement.classList.contains('ne-nav-open')) { closeNav(); return true; }
    var o = document.querySelector('.fixed.inset-0'); // نافذة منبثقة في ERP
    if (o) { var c = o.querySelector('button'); if (c) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } }
    if ((location.hash || '#/') !== '#/' && location.hash !== '#/dashboard') { history.back(); return true; }
    return false;
  };

  /* ---------- 5) أندرويد: حفظ وفتح الملفات ---------- */
  var AB = window.AndroidBridge;
  function nameOf(opts, fb) { try { return decodeURIComponent(opts.headers['x-name']); } catch (e) { return fb; } }
  function mimeOf(n) { return /\.pdf$/i.test(n) ? 'application/pdf' : /\.csv$/i.test(n) ? 'text/csv' : /\.xlsx?$/i.test(n) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : /\.docx?$/i.test(n) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /\.pptx?$/i.test(n) ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : /\.(png|jpe?g)$/i.test(n) ? 'image/' + n.split('.').pop().toLowerCase().replace('jpg', 'jpeg') : 'application/octet-stream'; }
  function b64(bytes, cb) { var r = new FileReader(); r.onload = function () { cb(String(r.result).split(',')[1] || ''); }; r.readAsDataURL(bytes instanceof Blob ? bytes : new Blob([bytes])); }
  function nativeSave(bytes, name, open) {
    return new Promise(function (res, rej) {
      b64(bytes, function (d) {
        var out = open && AB.shareFile ? AB.shareFile(d, name, mimeOf(name)) : AB.saveFile ? AB.saveFile(d, name, mimeOf(name)) : AB.savePdf(d, name);
        if (out && String(out).indexOf('ok') === 0) res(name); else rej(new Error(out || 'تعذّر الحفظ'));
      });
    });
  }
  if (AB && (AB.saveFile || AB.savePdf)) {
    var wrapT = function () {
      var T = window.__TAURI_INTERNALS__; if (!T || T.__neWrapped) return;
      var orig = T.invoke;
      T.invoke = function (cmd, args, opts) {
        if (cmd === 'save_download') return nativeSave(args, nameOf(opts, 'file'), false);
        if (cmd === 'open_file') return nativeSave(args, nameOf(opts, 'file'), true).then(function () { return null; });
        return orig.apply(this, arguments);
      };
      T.__neWrapped = true;
    };
    wrapT(); document.addEventListener('DOMContentLoaded', wrapT);
    document.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest && ev.target.closest('a[download]');
      if (!a || !/^blob:/.test(a.href)) return;
      ev.preventDefault();
      fetch(a.href).then(function (r) { return r.blob(); }).then(function (b) { nativeSave(b, a.getAttribute('download') || 'file', false); });
    }, true);
  }

  /* ---------- 6) الطباعة: زر «طباعة» في كل صفحة + معاينة طباعة داخل البرنامج ----------
     - برنامج ويندوز/ماك كان يرفض النافذة الفارغة التي تفتحها منظومة ERP للطباعة (window.open('')) ← لا تظهر نافذة الطباعة.
       الآن تُعرض الكتب والمستندات في «معاينة الطباعة» داخل البرنامج نفسه، ومنها الطباعة أو الحفظ PDF.
     - زر «طباعة» عائم في كل صفحات ERP (وCtrl+P): يطبع الصفحة الحالية (أو النافذة المنبثقة المفتوحة) على ورق الشركة الرسمي.
     - أندرويد: نظام التطبيق لا يدعم الطباعة ← يُفتح المستند في المتصفح/التطبيق المناسب للطباعة أو الحفظ PDF. */
  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var ANDROID = !!(AB && (AB.shareFile || AB.saveFile));
  var pv = null;
  function pvOpen() { return !!(pv && !pv.classList.contains('ne-hide')); }
  function prev() {
    if (pv) return pv;
    pv = document.createElement('div'); pv.id = 'ne-pv'; pv.className = 'ne-hide';
    pv.innerHTML = '<div class="ne-pvbar"><button type="button" data-a="close">→ رجوع</button><b id="ne-pvt">معاينة الطباعة</b><span class="ne-pvsp"></span>' +
      '<button type="button" data-a="land" title="تبديل اتجاه الورقة">⇄ <span>أفقي / عمودي</span></button>' +
      '<button type="button" class="pri" data-a="print" title="لحفظ المستند PDF اختر «حفظ بصيغة PDF» في نافذة الطباعة">🖨 <span>' + (ANDROID ? 'فتح للطباعة / PDF' : 'طباعة / PDF') + '</span></button></div>' +
      '<iframe id="ne-pvf" title="معاينة الطباعة"></iframe>';
    document.body.appendChild(pv);
    pv.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('button[data-a]'); if (!b) return;
      var a = b.getAttribute('data-a');
      if (a === 'close') closePv(); else if (a === 'print') doPrint(); else if (a === 'land') toggleLand();
    });
    return pv;
  }
  function frame() { return prev().querySelector('#ne-pvf'); }
  function openPv(title) {
    prev(); pv.querySelector('#ne-pvt').textContent = title || 'معاينة الطباعة';
    pv.classList.remove('ne-hide'); document.documentElement.classList.add('ne-pv-open');
  }
  function closePv() { if (pv) { pv.classList.add('ne-hide'); document.documentElement.classList.remove('ne-pv-open'); } }
  function freshFrame() {
    prev(); var old = frame(), f = document.createElement('iframe'); f.id = 'ne-pvf'; f.title = 'معاينة الطباعة';
    old.parentNode.replaceChild(f, old);
    var w = f.contentWindow; f.__nativePrint = w.print.bind(w); arm(w);
    return w;
  }
  // window.close() داخل المستند يغلق المعاينة، وwindow.print() على أندرويد يفتحه للطباعة
  function arm(w) { try { w.close = closePv; if (ANDROID) w.print = doPrint; } catch (e) {} }
  function polish(w) {
    try {
      arm(w); var d = w.document;
      if (d && d.documentElement && !d.getElementById('ne-pvcss')) {
        var s = d.createElement('style'); s.id = 'ne-pvcss'; s.textContent = '@media screen{.toolbar{display:none!important}}';
        (d.head || d.documentElement).appendChild(s);
      }
      if (d && d.title && pv) pv.querySelector('#ne-pvt').textContent = d.title;
    } catch (e) {}
  }
  var AUTO_PRINT = /<script>window\.onload=function\(\)\{setTimeout\(function\(\)\{window\.print\(\)\},\d+\)\}<\/script>/;
  function showHtml(html, title, auto) {
    var w = freshFrame(); openPv(title);
    html = String(html || '');
    if (AUTO_PRINT.test(html)) { html = html.replace(AUTO_PRINT, ''); auto = true; }
    w.document.open(); w.document.write(html); w.document.close(); polish(w);
    if (auto) setTimeout(doPrint, 700);
    return w;
  }
  function fileName(t) { return String(t || 'مستند').replace(/[\\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'مستند'; }
  function shareHtml(html, title) {
    b64(new Blob([html], { type: 'text/html' }), function (x) {
      var n = fileName(title) + '.html';
      var out = AB.shareFile ? AB.shareFile(x, n, 'text/html') : AB.saveFile(x, n, 'text/html');
      if (String(out).indexOf('ok') !== 0) alert(out || 'تعذّر فتح المستند للطباعة');
    });
  }
  function doPrint() {
    var f = frame(), w = f.contentWindow, d = w.document;
    if (ANDROID || IOS) {
      var html = '<!doctype html>' + d.documentElement.outerHTML;
      if (ANDROID) return shareHtml(html.replace('</body>', '<script>setTimeout(function(){print()},700)<\/script></body>'), d.title);
      var u = URL.createObjectURL(new Blob([html.replace('</body>', '<script>setTimeout(function(){print()},600)<\/script></body>')], { type: 'text/html' }));
      if (window.open(u, '_blank')) return;
    }
    try { w.focus(); (f.__nativePrint || w.print).call(w); } catch (e) { alert('تعذّرت الطباعة: ' + e.message); }
  }
  function toggleLand() {
    try {
      var d = frame().contentWindow.document, sh = d.querySelector('.sheet'), old = d.getElementById('ne-land');
      var land = old ? old.getAttribute('data-l') === '1' : !!(sh && sh.classList.contains('land'));
      if (old) old.remove();
      var s = d.createElement('style'); s.id = 'ne-land'; s.setAttribute('data-l', land ? '0' : '1');
      s.textContent = '@page{size:A4 ' + (land ? 'portrait' : 'landscape') + '}'; d.head.appendChild(s);
      if (sh) sh.classList.toggle('land', !land);
    } catch (e) {}
  }

  // نوافذ الطباعة الفارغة (window.open('')) ← معاينة الطباعة داخل البرنامج
  function shimWin(win) {
    try {
      if (!win || win.__nePrintShim) return;
      var orig = win.open;
      win.open = function (u) {
        if (!u || u === 'about:blank') {
          var w = freshFrame(); openPv('معاينة الطباعة');
          [250, 900, 2000].forEach(function (t) { setTimeout(function () { polish(w); }, t); });
          return w;
        }
        return orig.apply(win, arguments);
      };
      if (ANDROID) win.print = function () { snapshotPrint(win); };
      win.__nePrintShim = true;
    } catch (e) {}
  }
  // أندرويد: الطباعة المدمجة في الصفحة (تقارير الحضور، السجلات…) ← نسخة من الصفحة تُفتح للطباعة
  function snapshotPrint(win) {
    try {
      var d = win.document, c = d.documentElement.cloneNode(true);
      [].forEach.call(c.querySelectorAll('script,#ne-pv,#ne-field,#ne-print,#ne-shade,#ne-menu'), function (x) { x.remove(); });
      var head = c.querySelector('head'); if (head) { var bs = d.createElement('base'); bs.href = win.location.origin + '/'; head.insertBefore(bs, head.firstChild); }
      shareHtml('<!doctype html>' + c.outerHTML.replace('</body>', '<script>setTimeout(function(){print()},700)<\/script></body>'), d.title);
    } catch (e) {}
    setTimeout(function () { try { win.dispatchEvent(new Event('afterprint')); } catch (e) {} }, 300);
  }
  shimWin(window);
  function shimFrames() {
    [].forEach.call(document.querySelectorAll('iframe'), function (f) {
      if (f.id === 'ne-pvf' || f.id === 'ne-fframe') return;
      if (!f.__neL) { f.__neL = 1; f.addEventListener('load', function () { try { shimWin(f.contentWindow); } catch (e) {} }); }
      try { if (f.contentWindow && f.contentWindow.location.origin === location.origin) shimWin(f.contentWindow); } catch (e) {}
    });
  }

  // الكتب الرسمية ومستندات ورق الشركة (brand.js)
  function hookBrand() {
    if (!window.NEPrint || window.NEPrint.__ne) return;
    window.NEPrint.open = function (html) { return showHtml(html); };
    window.nePrintLetter = function (L, opt) { return showHtml(window.NEPrint.letterHtml(L, opt), null, !!(opt && opt.official)); };
    window.NEPrint.__ne = true;
  }
  hookBrand();

  // طباعة الصفحة الحالية على ورق الشركة
  function visible(el) { var r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40 && getComputedStyle(el).visibility !== 'hidden'; }
  function printScope() {
    var docs = [document], hf = document.querySelector('iframe.ne-hr-frame, .ne-hr-frame iframe');
    try { if (hf && hf.contentDocument && hf.contentDocument.body) docs.unshift(hf.contentDocument); } catch (e) {}
    // نافذة منبثقة مفتوحة ← تُطبع هي
    var dlg = [].slice.call(document.querySelectorAll('#root [role="dialog"], #root .fixed.inset-0')).filter(visible).pop();
    if (dlg && dlg.textContent.trim().length > 20) return { el: dlg, doc: document };
    if (docs[0] !== document) {
      var hd = docs[0], d2 = [].slice.call(hd.querySelectorAll('[role="dialog"], .modal.show, .modal.open, .fixed.inset-0')).filter(function (x) { return x.offsetHeight > 40; }).pop();
      return { el: d2 || hd.querySelector('main') || hd.body, doc: hd };
    }
    return { el: document.querySelector('#root main') || document.getElementById('root') || document.body, doc: document };
  }
  function cleanClone(src) {
    var c = src.cloneNode(true);
    var si = src.querySelectorAll('input,select,textarea'), ci = c.querySelectorAll('input,select,textarea');
    for (var i = 0; i < ci.length; i++) {
      var s = si[i], el = ci[i], t = (el.type || '').toLowerCase(), v;
      if (t === 'hidden' || t === 'file' || t === 'password' || t === 'search') { el.remove(); continue; }
      if (el.tagName === 'SELECT') v = s.selectedIndex >= 0 && s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : '';
      else if (t === 'checkbox' || t === 'radio') v = s.checked ? '☑' : '☐';
      else v = s.value;
      var sp = document.createElement('span'); sp.className = 'ne-fv'; sp.textContent = v || '—'; el.parentNode.replaceChild(sp, el);
    }
    var sc = src.querySelectorAll('canvas'), cc = c.querySelectorAll('canvas');
    for (var k = 0; k < cc.length; k++) { try { var im = document.createElement('img'); im.src = sc[k].toDataURL('image/png'); cc[k].parentNode.replaceChild(im, cc[k]); } catch (e) { cc[k].remove(); } }
    [].forEach.call(c.querySelectorAll('.no-print,nav,aside,iframe,video,audio,script,style,link,#ne-print,[aria-hidden="true"]:not(svg)'), function (x) { x.remove(); });
    // أزرار الإجراءات تُحذف، والأزرار التي تحمل محتوى (صفوف، بطاقات) تتحول إلى نص
    [].forEach.call(c.querySelectorAll('button,[role="button"]'), function (b) {
      if (b.textContent.trim().length > 40 || b.querySelector('div,table,p')) { var d = document.createElement('div'); while (b.firstChild) d.appendChild(b.firstChild); b.parentNode.replaceChild(d, b); }
      else b.remove();
    });
    [].forEach.call(c.querySelectorAll('*'), function (x) { x.removeAttribute('class'); x.removeAttribute('style'); x.removeAttribute('id'); });
    return c;
  }
  var GEN_CSS = '.content{font-size:12.5px;line-height:1.8}.content h1{font-size:18px;margin:4px 0 10px}.content h2{font-size:15.5px;margin:12px 0 6px}.content h3{font-size:14px;margin:10px 0 4px}' +
    '.content table{width:100%;border-collapse:collapse;margin:8px 0;font-size:11.5px}.content th,.content td{border:1px solid #cfdad4;padding:5px 7px;text-align:right;vertical-align:top}' +
    '.content th{background:#eef4f0;font-weight:700}.content tr{page-break-inside:avoid}.content svg{width:15px;height:15px;vertical-align:middle}.content img{max-width:100%}' +
    '.content .ne-fv{font-weight:600}.content label{font-weight:600;color:#355a4f}.content p{margin:4px 0}';
  function printPage() {
    var sc = printScope(), el = sc.el; if (!el) return;
    var h = el.querySelector('h1, h2, h3'), title = (h && h.textContent.trim()) || document.title || 'صفحة';
    var body = cleanClone(el), wide = [].some.call(body.querySelectorAll('tr'), function (r) { return r.children.length > 7; });
    var html = window.NEPrint && window.NEPrint.report
      ? window.NEPrint.report({ title: title, eyebrow: 'منظومة ERP', by: NE.me && (NE.me.fullName || NE.me.name || NE.me.username) || '', body: body.innerHTML, css: GEN_CSS, landscape: wide })
      : '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>' + title + '</title><style>body{font-family:system-ui,sans-serif;padding:24px}' + GEN_CSS + '</style></head><body><div class="content">' + body.innerHTML + '</div></body></html>';
    showHtml(html, title);
  }
  window.nePrintPage = printPage;
  window.nePrintPreview = function (html, title) { return showHtml(html, title); };

  function printBtn() {
    var b = document.getElementById('ne-print');
    if (!b) {
      b = document.createElement('button'); b.id = 'ne-print'; b.type = 'button'; b.title = 'طباعة هذه الصفحة (Ctrl+P)';
      b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg><span>طباعة</span>';
      b.onclick = printPage; document.body.appendChild(b);
    }
    b.classList.toggle('ne-hide', isOpen());
  }
  document.addEventListener('keydown', function (ev) {
    if (pvOpen() && ev.key === 'Escape') { ev.preventDefault(); closePv(); return; }
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'p' || ev.key === 'P' || ev.key === 'ح')) {
      if (pvOpen()) { ev.preventDefault(); doPrint(); }
      else if (signedIn() && !isOpen()) { ev.preventDefault(); printPage(); }
    }
  }, true);
  var backPrev = window.appBack;
  window.appBack = function () { if (pvOpen()) { closePv(); return true; } return backPrev(); };

  var renderPrev = render;
  render = function () {
    renderPrev(); hookBrand(); shimFrames();
    var on = signedIn(), b = document.getElementById('ne-print');
    if (on) printBtn(); else { if (b) b.remove(); closePv(); }
  };
  render();
})();
