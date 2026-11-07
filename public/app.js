(function () {
  "use strict";
  var L = window.Logic;
  var K = { state: "estudos.state", meta: "estudos.meta", cfg: "estudos.cfg", tab: "estudos.tab" };

  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* armazenamento indisponível */ } }

  var state = L.normalize(load(K.state, null));
  var meta = Object.assign({ base: 0, dirty: false, owner: "" }, load(K.meta, {}));
  var cfg = Object.assign({ token: "", username: "" }, load(K.cfg, {}));
  var ui = { tab: load(K.tab, "hoje"), subjectId: null, doubtFilter: "pending", open: {} };
  var editVer = 0;

  var $ = function (s) { return document.querySelector(s); };
  var main = $("#main");

  // ---------- utilidades ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(s) { var p = s.split("-"); return p[2] + "/" + p[1]; }
  function plural(n, a, b) { return n + " " + (n === 1 ? a : b); }
  function subj(id) { return state.subjects.find(function (s) { return s.id === id; }); }
  function findLesson(id) {
    for (var i = 0; i < state.subjects.length; i++) {
      var l = state.subjects[i].lessons.find(function (x) { return x.id === id; });
      if (l) return { s: state.subjects[i], l: l };
    }
    return null;
  }
  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function persist() { save(K.state, state); save(K.meta, meta); }
  function changed(skipRender) {
    editVer++; meta.dirty = true; persist();
    if (!skipRender) render();
    schedulePush();
  }

  // ---------- sincronização ----------
  var sync = { status: "local", msg: "", busy: false, again: false, timer: null };

  function setSync(status, msg) {
    sync.status = status; sync.msg = msg || "";
    var labels = { local: "Só neste aparelho", ok: "Sincronizado", syncing: "Sincronizando…", offline: "Sem conexão", error: "Erro de sync" };
    $("#sync").className = "sync " + status;
    $("#syncText").textContent = labels[status];
    $("#syncDetail").textContent = sync.msg;
  }

  async function api(method, body, path) {
    var r = await fetch(path || "/api/state", {
      method: method,
      cache: "no-store",
      headers: { Authorization: "Bearer " + cfg.token, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    var j = null;
    try { j = await r.json(); } catch (e) { /* sem corpo */ }
    return { status: r.status, body: j };
  }

  function adopt(remote) {
    state = L.mergeStates(state, remote.data || { subjects: [] });
    meta.base = remote.updatedAt || 0;
    var remoteNorm = JSON.stringify(L.normalize(remote.data || {}));
    if (JSON.stringify(state) !== remoteNorm) meta.dirty = true;
    persist();
    render();
  }

  async function runSync() {
    if (!cfg.token) { setSync("local"); return; }
    if (sync.busy) { sync.again = true; return; }
    sync.busy = true; setSync("syncing");
    try {
      for (var i = 0; i < 4; i++) {
        if (!meta.dirty) {
          var g = await api("GET");
          if (g.status === 401) throw new Error("auth");
          if (g.status !== 200) throw new Error("http " + g.status);
          if ((g.body.updatedAt || 0) !== meta.base) adopt(g.body);
          if (!meta.dirty) break;
        }
        var sent = editVer;
        var p = await api("PUT", { data: state, base: meta.base });
        if (p.status === 200) {
          meta.base = p.body.updatedAt;
          meta.dirty = editVer !== sent;
          persist();
          if (!meta.dirty) break;
        } else if (p.status === 409) {
          adopt(p.body);
          meta.dirty = true;
        } else if (p.status === 401) {
          throw new Error("auth");
        } else {
          throw new Error("http " + p.status);
        }
      }
      setSync("ok", "Última sincronização: " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
    } catch (e) {
      if (e.message === "auth") {
        cfg.token = ""; save(K.cfg, cfg);
        setSync("local");
        openSettings("Sua sessão expirou. Entre de novo.");
      } else if (!navigator.onLine || e instanceof TypeError) setSync("offline", "Sem conexão. As mudanças ficam salvas aqui e sobem quando voltar.");
      else setSync("error", "Falha ao sincronizar (" + e.message + "). Tente de novo.");
    } finally {
      sync.busy = false;
      if (sync.again) { sync.again = false; runSync(); }
    }
  }

  function schedulePush() {
    if (!cfg.token) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(runSync, 1200);
  }

  // ---------- renderização ----------
  function bars(s) {
    var p = L.progress(s);
    return '<div class="bars">' +
      '<div class="barline">Estudadas<div class="track"><div class="fill" style="width:' + p.pctStudied + '%"></div></div><b>' + p.pctStudied + '%</b></div>' +
      '<div class="barline">Flashcards<div class="track"><div class="fill cards" style="width:' + p.pctCards + '%"></div></div><b>' + p.pctCards + '%</b></div>' +
      "</div>";
  }

  function examChip(s, today) {
    var e = L.examInfo(s, today);
    if (!e) return '<span class="chip gray">sem data de prova</span>';
    if (e.days < 0) return '<span class="chip gray">prova em ' + fmtDate(s.examDate) + " (passou)</span>";
    if (e.days === 0) return '<span class="chip warn">prova hoje</span>';
    if (e.days === 1) return '<span class="chip warn">prova amanhã</span>';
    return '<span class="chip' + (e.days <= 7 ? " warn" : "") + '">' + e.days + " dias · " + fmtDate(s.examDate) + "</span>";
  }

  function renderTabs() {
    var pending = L.doubts(state, false).length;
    var tabs = [["hoje", "Hoje"], ["materias", "Matérias"], ["duvidas", "Dúvidas" + (pending ? '<span class="badge">' + pending + "</span>" : "")]];
    $("#tabs").innerHTML = tabs.map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (ui.tab === t[0] ? "on" : "") + '">' + t[1] + "</button>";
    }).join("");
  }

  function loginBanner() {
    if (cfg.token) return "";
    return '<div class="card"><div class="row"><div class="grow muted">Seus dados estão só neste aparelho.</div>' +
      '<button class="btn small primary" data-act="settings">Entrar ou criar conta</button></div></div>';
  }

  function viewToday() {
    var today = L.todayStr();
    if (!state.subjects.length) {
      return '<div class="empty"><p>Nenhuma matéria ainda.</p><button class="btn primary" data-tab="materias">Adicionar matéria</button></div>';
    }
    var sorted = L.sortSubjects(state.subjects, today);
    var upcoming = sorted.filter(function (s) { var e = L.examInfo(s, today); return e && e.days >= 0; });
    var noDate = sorted.filter(function (s) { return !s.examDate; });
    var h = "";

    if (upcoming.length) {
      h += "<h2>Próximas provas</h2>";
      upcoming.forEach(function (s) {
        var e = L.examInfo(s, today);
        h += '<div class="card"><div class="row"><div class="grow title">' + esc(s.name) + "</div>" + examChip(s, today) + "</div>";
        if (!s.lessons.length) {
          h += '<p class="muted">Nenhuma aula cadastrada. <button class="linkbtn" data-act="open-subject" data-sid="' + s.id + '">Adicionar aulas</button></p>';
        } else if (!e.remaining) {
          h += '<p class="pace">Tudo estudado ✓</p><p class="muted">Agora é revisar e fazer flashcards.</p>';
        } else {
          var per = Math.ceil(e.perDay);
          var window_ = Math.max(e.days, 1);
          h += '<div class="row" style="margin-top:8px"><span class="pace">' + plural(per, "aula", "aulas") + '/dia</span><span class="muted">' +
            plural(e.remaining, "aula restante", "aulas restantes") + " em " + plural(window_, "dia", "dias") + "</span></div>";
          var next = L.nextLessons(s, Math.min(Math.max(per, 1), 5));
          h += next.map(function (l) {
            return '<label class="quick"><input type="checkbox" data-act="studied" data-lid="' + l.id + '"><span>' + esc(l.title) + "</span></label>";
          }).join("");
        }
        h += bars(s) + "</div>";
      });
    } else {
      h += '<div class="card muted">Nenhuma prova com data. Abra uma matéria e coloque a data para ver quantas aulas por dia você precisa.</div>';
    }

    var cold = L.coldLessons(state, today);
    if (cold.length) {
      h += "<h2>Esfriando (" + L.COLD_DAYS + "+ dias sem revisar)</h2><div class=\"card\">";
      h += cold.slice(0, 10).map(function (c) {
        return '<div class="row" style="padding:6px 0"><div class="grow"><div>' + esc(c.lesson.title) + '</div><div class="muted">' + esc(c.subject.name) + " · " + c.days + ' dias</div></div>' +
          '<button class="btn small" data-act="review" data-lid="' + c.lesson.id + '">Revisei</button></div>';
      }).join("");
      h += "</div>";
    }

    if (noDate.length) {
      h += "<h2>Sem data de prova</h2>";
      noDate.forEach(function (s) {
        var p = L.progress(s);
        h += '<div class="card click" data-act="open-subject" data-sid="' + s.id + '"><div class="row"><div class="grow title">' + esc(s.name) +
          '</div><span class="muted">' + p.studied + "/" + p.n + "</span></div></div>";
      });
    }
    return h;
  }

  function viewSubjects() {
    var today = L.todayStr();
    var h = '<div class="card"><div class="row"><input type="text" id="newSubject" placeholder="Nova matéria (ex.: Farmacologia)" class="grow" style="flex:1">' +
      '<button class="btn primary" data-act="add-subject">Adicionar</button></div></div>';
    if (!state.subjects.length) return h + '<div class="empty">Crie sua primeira matéria acima.</div>';
    L.sortSubjects(state.subjects, today).forEach(function (s) {
      var p = L.progress(s);
      h += '<div class="card click" data-act="open-subject" data-sid="' + s.id + '"><div class="row"><div class="grow title">' + esc(s.name) + "</div>" +
        examChip(s, today) + '</div><div class="muted" style="margin-top:4px">' + plural(p.n, "aula", "aulas") + " · " + p.studied + " estudadas · " + p.cards + " com flashcards</div>" + bars(s) + "</div>";
    });
    return h;
  }

  function lessonItem(l, today) {
    var isOpen = !!ui.open[l.id];
    var hasDoubt = !!l.doubt.trim();
    var qClass = hasDoubt && !l.doubtResolved ? " pending" : hasDoubt ? " on" : "";
    var rev = "";
    if (l.lastReview) {
      var d = L.daysBetween(l.lastReview, today);
      rev = d === 0 ? "Revisada hoje" : "Revisada há " + plural(d, "dia", "dias");
    }
    var h = '<li class="lesson' + (l.studied ? " done" : "") + '"><div class="row">' +
      '<span class="lt">' + esc(l.title || "(sem título)") + "</span>" +
      '<button class="tog' + (l.studied ? " on" : "") + '" data-act="studied" data-lid="' + l.id + '">Estudei</button>' +
      '<button class="tog cards' + (l.cards ? " on" : "") + '" data-act="cards" data-lid="' + l.id + '">Flashcards</button>' +
      '<button class="tog q' + qClass + '" data-act="expand" data-lid="' + l.id + '" aria-label="Dúvida e detalhes">' + (isOpen ? "▴" : "?") + "</button>" +
      "</div>";
    if (l.studied) {
      var revBtn = l.lastReview === today ? "" : ' · <button class="linkbtn" data-act="review" data-lid="' + l.id + '">Revisei hoje</button>';
      h += '<div class="lmeta">' + (rev || "Sem revisão registrada") + revBtn + "</div>";
    }
    if (isOpen) {
      h += '<div class="expand">' +
        '<label class="f">Dúvida desta aula<textarea data-field="doubt" data-lid="' + l.id + '" data-k="doubt:' + l.id + '" placeholder="Escreva aqui o que ficou confuso…">' + esc(l.doubt) + "</textarea></label>" +
        '<label class="check"><input type="checkbox" data-field="doubtResolved" data-lid="' + l.id + '"' + (l.doubtResolved ? " checked" : "") + "> Dúvida resolvida</label>" +
        '<label class="f">Título da aula<input type="text" data-field="title" data-lid="' + l.id + '" data-k="title:' + l.id + '" value="' + esc(l.title) + '"></label>' +
        '<div><button class="btn small danger" data-act="del-lesson" data-lid="' + l.id + '">Excluir aula</button></div>' +
        "</div>";
    }
    return h + "</li>";
  }

  function viewSubject(s) {
    var today = L.todayStr();
    var p = L.progress(s);
    var deck = /^https?:\/\//i.test(s.deckLink) ? '<a href="' + esc(s.deckLink) + '" target="_blank" rel="noopener">Abrir deck ↗</a>' : "";
    var h = '<div class="row" style="margin-bottom:10px"><button class="btn small" data-act="back">← Matérias</button><div class="grow"></div>' + examChip(s, today) + "</div>";
    h += '<div class="card stack">' +
      '<label class="f">Matéria<input type="text" data-field="name" data-sid="' + s.id + '" data-k="name:' + s.id + '" value="' + esc(s.name) + '"></label>' +
      '<div class="grid2"><label class="f">Data da prova<input type="date" data-field="examDate" data-sid="' + s.id + '" value="' + esc(s.examDate) + '"></label>' +
      '<label class="f">Deck de flashcards (link ou nome)<input type="text" data-field="deckLink" data-sid="' + s.id + '" data-k="deck:' + s.id + '" value="' + esc(s.deckLink) + '" placeholder="Anki: Farmaco P2"></label></div>' +
      (deck ? "<div>" + deck + "</div>" : "") + bars(s) + "</div>";

    h += "<h2>Adicionar aulas</h2><div class=\"card stack\">" +
      '<textarea id="paste" data-k="paste" placeholder="Cole a lista de aulas, uma por linha:&#10;Aula 1 – Farmacocinética&#10;Aula 2 – Farmacodinâmica"></textarea>' +
      '<div><button class="btn primary" data-act="add-lessons" data-sid="' + s.id + '">Adicionar aulas</button></div></div>';

    h += "<h2>Aulas (" + p.studied + "/" + p.n + ")</h2>";
    if (s.lessons.length) h += '<div class="card"><ul class="lessons">' + s.lessons.map(function (l) { return lessonItem(l, today); }).join("") + "</ul></div>";
    else h += '<div class="card muted">Nenhuma aula ainda.</div>';

    h += '<div style="margin-top:24px"><button class="btn danger" data-act="del-subject" data-sid="' + s.id + '">Excluir matéria</button></div>';
    return h;
  }

  function viewDoubts() {
    var resolved = ui.doubtFilter === "resolved";
    var list = L.doubts(state, resolved);
    var h = '<div class="seg"><button data-act="doubt-filter" data-f="pending" class="' + (!resolved ? "on" : "") + '">Pendentes</button>' +
      '<button data-act="doubt-filter" data-f="resolved" class="' + (resolved ? "on" : "") + '">Resolvidas</button></div>';
    if (!list.length) {
      return h + '<div class="empty">' + (resolved ? "Nenhuma dúvida resolvida ainda." : "Nenhuma dúvida pendente. Para anotar uma, toque no ? de uma aula.") + "</div>";
    }
    list.forEach(function (d) {
      h += '<div class="card"><div class="muted">' + esc(d.subject.name) + " · " + esc(d.lesson.title) + '</div><div class="doubt">' + esc(d.lesson.doubt) + "</div>" +
        '<div class="row"><button class="btn small" data-act="toggle-resolved" data-lid="' + d.lesson.id + '">' + (resolved ? "Reabrir" : "Marcar resolvida") + "</button>" +
        '<button class="btn small ghost" data-act="goto-lesson" data-sid="' + d.subject.id + '" data-lid="' + d.lesson.id + '">Abrir aula</button></div></div>';
    });
    return h;
  }

  function render() {
    // Preserva foco/cursor em campos de texto quando a tela é redesenhada (ex.: chegou sync).
    var a = document.activeElement, key = a && a.dataset && a.dataset.k, s0, s1, pasteVal;
    if (key) { s0 = a.selectionStart; s1 = a.selectionEnd; }
    var paste = $("#paste"); if (paste) pasteVal = paste.value;

    renderTabs();
    if (ui.subjectId && !subj(ui.subjectId)) ui.subjectId = null;
    var html;
    if (ui.tab === "materias" && ui.subjectId) html = viewSubject(subj(ui.subjectId));
    else if (ui.tab === "materias") html = viewSubjects();
    else if (ui.tab === "duvidas") html = viewDoubts();
    else html = loginBanner() + viewToday();
    main.innerHTML = html;

    var p2 = $("#paste"); if (p2 && pasteVal) p2.value = pasteVal;
    if (key) {
      var el = main.querySelector('[data-k="' + key + '"]');
      if (el) { el.focus(); try { el.setSelectionRange(s0, s1); } catch (e) { /* tipo sem seleção */ } }
    }
  }

  // ---------- conta ----------
  var authMode = "login";

  function renderAuth() {
    var logged = !!cfg.token, reg = authMode === "register";
    $("#authOut").hidden = logged;
    $("#authIn").hidden = !logged;
    $("#whoami").textContent = cfg.username;
    $("#mLogin").classList.toggle("on", !reg);
    $("#mRegister").classList.toggle("on", reg);
    $("#inviteRow").hidden = !reg;
    $("#authSubmit").textContent = reg ? "Criar conta" : "Entrar";
    $("#authPass").autocomplete = reg ? "new-password" : "current-password";
  }

  function openSettings(msg) {
    renderAuth();
    $("#authMsg").textContent = msg || "";
    $("#syncDetail").textContent = sync.msg;
    if (!$("#settings").open) $("#settings").showModal();
  }

  async function submitAuth() {
    var msg = $("#authMsg"), btn = $("#authSubmit");
    var reg = authMode === "register";
    var username = $("#authUser").value.trim();
    var password = $("#authPass").value;
    if (!username || !password) { msg.textContent = "Preencha usuário e senha."; return; }
    btn.disabled = true; msg.textContent = "Aguarde…";
    try {
      var r = await fetch("/api/" + (reg ? "register" : "login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username, password: password, invite: reg ? $("#authInvite").value.trim() : undefined }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) { msg.textContent = j.message || "Não foi possível entrar."; return; }
      onLoggedIn(j);
    } catch (e) {
      msg.textContent = "Sem conexão. Tente de novo.";
    } finally {
      btn.disabled = false;
    }
  }

  function onLoggedIn(j) {
    if (meta.owner && meta.owner !== j.username) {
      // Os dados deste aparelho são de outra conta: não podem vazar para a nova.
      state = L.normalize(null);
      meta = { base: 0, dirty: false, owner: j.username };
    } else {
      meta.owner = j.username;
      meta.base = 0;
      meta.dirty = state.subjects.length > 0; // dados criados sem conta sobem para a conta
    }
    cfg.token = j.token; cfg.username = j.username;
    save(K.cfg, cfg); persist();
    $("#authPass").value = ""; $("#authInvite").value = ""; $("#authMsg").textContent = "";
    authMode = "login";
    renderAuth(); render();
    $("#settings").close();
    runSync();
  }

  // ---------- ações ----------
  function setTab(t) { ui.tab = t; ui.subjectId = null; save(K.tab, t); render(); window.scrollTo(0, 0); }

  function toggleStudied(l) {
    l.studied = !l.studied;
    if (l.studied && !l.lastReview) l.lastReview = L.todayStr();
    l.u = Date.now();
  }

  var actions = {
    settings: function () { openSettings(); },
    "close-settings": function () { $("#settings").close(); },
    "auth-mode": function (el) { authMode = el.dataset.m; $("#authMsg").textContent = ""; renderAuth(); },
    "auth-submit": function () { submitAuth(); },
    logout: async function () {
      if (meta.dirty && !confirm("Há mudanças ainda não sincronizadas que serão perdidas se você sair. Sair mesmo?")) return;
      clearTimeout(sync.timer);
      try { await api("POST", null, "/api/logout"); } catch (e) { /* sem conexão: a sessão expira sozinha */ }
      // O progresso fica guardado na conta; limpa este aparelho para o próximo usuário não ver nada.
      state = L.normalize(null);
      meta = { base: 0, dirty: false, owner: "" };
      cfg = { token: "", username: "" };
      ui.subjectId = null;
      save(K.cfg, cfg); persist();
      setSync("local");
      renderAuth(); render();
    },
    "sync-now": function () { runSync(); },
    export: function () {
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "estudos-backup-" + L.todayStr() + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    },
    import: function () { $("#importFile").click(); },
    "add-subject": function () {
      var inp = $("#newSubject"), name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      var s = { id: L.uid(), name: name, examDate: "", deckLink: "", u: Date.now(), lessons: [] };
      state.subjects.push(s);
      ui.subjectId = s.id;
      changed();
    },
    "open-subject": function (el) { ui.tab = "materias"; save(K.tab, "materias"); ui.subjectId = el.dataset.sid; render(); window.scrollTo(0, 0); },
    back: function () { ui.subjectId = null; render(); },
    "add-lessons": function (el) {
      var s = subj(el.dataset.sid), box = $("#paste");
      var titles = L.parseLessons(box.value);
      if (!titles.length) { box.focus(); return; }
      titles.forEach(function (t) { s.lessons.push(L.newLesson(t)); });
      box.value = "";
      changed();
      toast(plural(titles.length, "aula adicionada", "aulas adicionadas"));
    },
    studied: function (el) { var r = findLesson(el.dataset.lid); if (!r) return; toggleStudied(r.l); changed(); },
    cards: function (el) { var r = findLesson(el.dataset.lid); if (!r) return; r.l.cards = !r.l.cards; r.l.u = Date.now(); changed(); },
    review: function (el) {
      var r = findLesson(el.dataset.lid); if (!r) return;
      r.l.lastReview = L.todayStr(); r.l.studied = true; r.l.u = Date.now(); changed(); toast("Revisão registrada");
    },
    expand: function (el) { var id = el.dataset.lid; ui.open[id] = !ui.open[id]; render(); },
    "toggle-resolved": function (el) { var r = findLesson(el.dataset.lid); if (!r) return; r.l.doubtResolved = !r.l.doubtResolved; r.l.u = Date.now(); changed(); },
    "goto-lesson": function (el) { ui.tab = "materias"; save(K.tab, "materias"); ui.subjectId = el.dataset.sid; ui.open[el.dataset.lid] = true; render(); },
    "doubt-filter": function (el) { ui.doubtFilter = el.dataset.f; render(); },
    "del-lesson": function (el) {
      var r = findLesson(el.dataset.lid); if (!r) return;
      if (!confirm('Excluir a aula "' + r.l.title + '"?')) return;
      r.s.lessons = r.s.lessons.filter(function (x) { return x.id !== r.l.id; });
      state.deleted[r.l.id] = Date.now();
      changed();
    },
    "del-subject": function (el) {
      var s = subj(el.dataset.sid); if (!s) return;
      if (!confirm('Excluir a matéria "' + s.name + '" e todas as suas aulas?')) return;
      state.subjects = state.subjects.filter(function (x) { return x.id !== s.id; });
      state.deleted[s.id] = Date.now();
      ui.subjectId = null;
      changed();
    },
  };

  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-tab],[data-act]");
    if (!t) return;
    if (t.dataset.tab) { setTab(t.dataset.tab); return; }
    var fn = actions[t.dataset.act];
    if (!fn) return;
    if (t.tagName === "INPUT" && t.type === "checkbox" && t.dataset.act) ev.preventDefault();
    fn(t, ev);
  });

  function onField(el, final) {
    var f = el.dataset.field; if (!f) return;
    if (el.dataset.sid) {
      var s = subj(el.dataset.sid); if (!s) return;
      s[f] = f === "name" && final && !el.value.trim() ? s.name : el.value;
      s.u = Date.now();
    } else if (el.dataset.lid) {
      var r = findLesson(el.dataset.lid); if (!r) return;
      r.l[f] = el.type === "checkbox" ? el.checked : el.value;
      r.l.u = Date.now();
    }
    changed(!final);
  }
  main.addEventListener("input", function (ev) { if (ev.target.dataset.field && ev.target.type !== "checkbox" && ev.target.type !== "date") onField(ev.target, false); });
  main.addEventListener("change", function (ev) { if (ev.target.dataset.field) onField(ev.target, true); });
  main.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target.id === "newSubject") actions["add-subject"]();
  });
  $("#settings").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && /^auth(User|Pass|Invite)$/.test(ev.target.id)) { ev.preventDefault(); submitAuth(); }
  });

  $("#importFile").addEventListener("change", function (ev) {
    var file = ev.target.files[0]; if (!file) return;
    file.text().then(function (txt) {
      var raw = JSON.parse(txt);
      var incoming = raw && raw.data && raw.data.subjects ? raw.data : raw;
      if (!incoming || !Array.isArray(incoming.subjects)) throw new Error("formato");
      state = L.mergeStates(state, incoming);
      changed();
      toast("Backup importado");
    }).catch(function () { toast("Arquivo de backup inválido"); });
    ev.target.value = "";
  });

  // ---------- início ----------
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") runSync(); });
  window.addEventListener("online", runSync);
  setInterval(function () { if (document.visibilityState === "visible") runSync(); }, 60000);

  render();
  setSync(cfg.token ? "syncing" : "local");
  runSync();
})();
