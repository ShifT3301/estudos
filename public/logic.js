// Lógica pura do app (sem DOM): progresso, prazos, mesclagem entre dispositivos.
// Funciona no navegador (window.Logic) e no Node (module.exports) para os testes.
(function (root) {
  "use strict";

  var COLD_DAYS = 7;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function pad(n) { return String(n).padStart(2, "0"); }

  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function parseDate(s) {
    var p = String(s).split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function daysBetween(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
  }

  function uid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID().slice(0, 12);
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function newLesson(title) {
    return { id: uid(), title: title, studied: false, cards: false, cardsStudied: false, lastReview: null, doubt: "", doubtResolved: false, u: Date.now() };
  }

  // Garante o formato do estado e devolve uma cópia (nunca reaproveita objetos de entrada).
  function normalize(raw) {
    var out = { subjects: [], deleted: {} };
    if (!raw || typeof raw !== "object") return out;
    if (raw.deleted && typeof raw.deleted === "object") {
      Object.keys(raw.deleted).forEach(function (k) {
        var v = Number(raw.deleted[k]);
        if (isFinite(v)) out.deleted[k] = v;
      });
    }
    (Array.isArray(raw.subjects) ? raw.subjects : []).forEach(function (s) {
      if (!s || !s.id) return;
      out.subjects.push({
        id: String(s.id),
        name: String(s.name || "Sem nome"),
        examDate: DATE_RE.test(s.examDate || "") ? s.examDate : "",
        deckLink: String(s.deckLink || ""),
        u: Number(s.u) || 0,
        lessons: (Array.isArray(s.lessons) ? s.lessons : [])
          .filter(function (l) { return l && l.id; })
          .map(function (l) {
            return {
              id: String(l.id),
              title: String(l.title || ""),
              studied: !!l.studied,
              cards: !!l.cards,
              cardsStudied: !!l.cardsStudied,
              lastReview: DATE_RE.test(l.lastReview || "") ? l.lastReview : null,
              doubt: String(l.doubt || ""),
              doubtResolved: !!l.doubtResolved,
              u: Number(l.u) || 0,
            };
          }),
      });
    });
    return out;
  }

  function mergeLessons(x, y) {
    var map = new Map();
    x.concat(y).forEach(function (l) {
      var cur = map.get(l.id);
      if (!cur || l.u > cur.u) map.set(l.id, l);
    });
    return Array.from(map.values());
  }

  // Mescla dois estados: vence o item com `u` (timestamp de edição) maior.
  // Exclusões ficam em `deleted` (id -> quando) para não "ressuscitar" itens.
  function mergeStates(a, b) {
    a = normalize(a);
    b = normalize(b);
    var deleted = Object.assign({}, a.deleted);
    Object.keys(b.deleted).forEach(function (k) {
      deleted[k] = Math.max(deleted[k] || 0, b.deleted[k]);
    });
    var map = new Map();
    a.subjects.concat(b.subjects).forEach(function (s) {
      var cur = map.get(s.id);
      if (!cur) { map.set(s.id, s); return; }
      var newer = s.u > cur.u ? s : cur;
      map.set(s.id, Object.assign({}, newer, { lessons: mergeLessons(cur.lessons, s.lessons) }));
    });
    var subjects = Array.from(map.values())
      .filter(function (s) { return !(deleted[s.id] >= s.u); })
      .map(function (s) {
        return Object.assign({}, s, {
          lessons: s.lessons.filter(function (l) { return !(deleted[l.id] >= l.u); }),
        });
      });
    return { subjects: subjects, deleted: deleted };
  }

  function progress(subject) {
    var n = subject.lessons.length;
    var studied = subject.lessons.filter(function (l) { return l.studied; }).length;
    var cards = subject.lessons.filter(function (l) { return l.cards; }).length;
    var cardsStudied = subject.lessons.filter(function (l) { return l.cardsStudied; }).length;
    return {
      n: n,
      studied: studied,
      cards: cards,
      cardsStudied: cardsStudied,
      pctStudied: n ? Math.round((100 * studied) / n) : 0,
      pctCards: n ? Math.round((100 * cards) / n) : 0,
      pctCardsStudied: n ? Math.round((100 * cardsStudied) / n) : 0,
    };
  }

  // Dias até a prova e ritmo necessário. Estuda-se até a véspera; prova hoje/amanhã => janela de 1 dia.
  function examInfo(subject, today) {
    if (!subject.examDate) return null;
    var days = daysBetween(today, subject.examDate);
    var remaining = subject.lessons.filter(function (l) { return !l.studied; }).length;
    if (days < 0) return { days: days, remaining: remaining, perDay: null };
    return { days: days, remaining: remaining, perDay: remaining / Math.max(days, 1) };
  }

  function sortSubjects(subjects, today) {
    function rank(s) {
      if (!s.examDate) return 1;
      return daysBetween(today, s.examDate) < 0 ? 2 : 0;
    }
    return subjects.slice().sort(function (a, b) {
      var ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return a.examDate < b.examDate ? -1 : a.examDate > b.examDate ? 1 : 0;
      return a.name.localeCompare(b.name, "pt-BR");
    });
  }

  function nextLessons(subject, count) {
    return subject.lessons.filter(function (l) { return !l.studied; }).slice(0, count);
  }

  // Linhas da aba "Hoje": as próximas `count` aulas ainda não estudadas, mais as aulas já estudadas
  // com flashcards pendentes (até 5, além das estudadas hoje, para a linha não sumir enquanto você marca).
  function todayLessons(subject, today, count) {
    var unstudied = 0, pendingCards = 0, out = [];
    subject.lessons.forEach(function (l) {
      if (!l.studied) {
        if (unstudied < count) { out.push(l); unstudied++; }
      } else if (!l.cards || !l.cardsStudied) {
        if (pendingCards < 5 || l.lastReview === today) { out.push(l); pendingCards++; }
      }
    });
    return out;
  }

  // Aulas estudadas cuja última revisão tem COLD_DAYS dias ou mais (matérias com prova já passada ficam de fora).
  function coldLessons(state, today) {
    var out = [];
    state.subjects.forEach(function (s) {
      if (s.examDate && daysBetween(today, s.examDate) < 0) return;
      s.lessons.forEach(function (l) {
        if (!l.studied || !l.lastReview) return;
        var d = daysBetween(l.lastReview, today);
        if (d >= COLD_DAYS) out.push({ subject: s, lesson: l, days: d });
      });
    });
    return out.sort(function (a, b) { return b.days - a.days; });
  }

  function doubts(state, resolved) {
    var out = [];
    state.subjects.forEach(function (s) {
      s.lessons.forEach(function (l) {
        if (l.doubt.trim() && l.doubtResolved === !!resolved) out.push({ subject: s, lesson: l });
      });
    });
    return out;
  }

  // Uma aula por linha; ignora linhas vazias e remove marcadores de lista ("-", "*", "•").
  function parseLessons(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map(function (line) { return line.replace(/^\s*[-*•]\s+/, "").trim(); })
      .filter(Boolean);
  }

  var api = {
    COLD_DAYS: COLD_DAYS,
    todayStr: todayStr,
    daysBetween: daysBetween,
    uid: uid,
    newLesson: newLesson,
    normalize: normalize,
    mergeStates: mergeStates,
    progress: progress,
    examInfo: examInfo,
    sortSubjects: sortSubjects,
    nextLessons: nextLessons,
    todayLessons: todayLessons,
    coldLessons: coldLessons,
    doubts: doubts,
    parseLessons: parseLessons,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof window !== "undefined" ? window : globalThis);
