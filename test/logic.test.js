const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../public/logic.js");

function lesson(id, extra) {
  return Object.assign({ id, title: id, studied: false, cards: false, lastReview: null, doubt: "", doubtResolved: false, u: 1 }, extra);
}
function subject(id, lessons, extra) {
  return Object.assign({ id, name: id, examDate: "", deckLink: "", u: 1, lessons }, extra);
}

test("progresso por matéria", () => {
  const s = subject("s", [lesson("a", { studied: true, cards: true, cardsStudied: true }), lesson("b", { studied: true, cards: true }), lesson("c"), lesson("d")]);
  assert.deepEqual(L.progress(s), { n: 4, studied: 2, cards: 2, cardsStudied: 1, pctStudied: 50, pctCards: 50, pctCardsStudied: 25 });
  assert.equal(L.progress(subject("v", [])).pctStudied, 0);
});

test("linhas da aba Hoje: próximas aulas + flashcards pendentes das já estudadas", () => {
  const s = subject("s", [
    lesson("l1", { studied: true, cards: true, cardsStudied: true }), // completa: some
    lesson("l2", { studied: true, cards: true }), // falta estudar os cards
    lesson("l3", { studied: true }), // faltam criar e estudar os cards
    lesson("l4"), lesson("l5"), lesson("l6"),
  ]);
  assert.deepEqual(L.todayLessons(s, "2026-11-07", 2).map((l) => l.id), ["l2", "l3", "l4", "l5"]);
  assert.deepEqual(L.todayLessons(s, "2026-11-07", 0).map((l) => l.id), ["l2", "l3"]);
  // no máximo 5 antigas com cards pendentes, mas as estudadas hoje nunca somem enquanto você marca
  const many = subject("m", [1, 2, 3, 4, 5, 6, 7].map((i) => lesson("p" + i, { studied: true, lastReview: i === 7 ? "2026-11-07" : "2026-10-01" })));
  assert.deepEqual(L.todayLessons(many, "2026-11-07", 0).map((l) => l.id), ["p1", "p2", "p3", "p4", "p5", "p7"]);
});

test("ritmo até a prova", () => {
  const s = subject("s", [lesson("a"), lesson("b"), lesson("c"), lesson("d", { studied: true })], { examDate: "2026-11-10" });
  const e = L.examInfo(s, "2026-11-07");
  assert.equal(e.days, 3);
  assert.equal(e.remaining, 3);
  assert.equal(e.perDay, 1);
  assert.equal(L.examInfo(s, "2026-11-10").perDay, 3); // dia da prova: janela mínima de 1
  assert.equal(L.examInfo(s, "2026-11-12").perDay, null); // prova passou
  assert.equal(L.examInfo(subject("x", []), "2026-11-07"), null);
});

test("importar aulas colando texto", () => {
  assert.deepEqual(L.parseLessons("Aula 1\n\n - Aula 2\r\n• Aula 3  \n* Aula 4"), ["Aula 1", "Aula 2", "Aula 3", "Aula 4"]);
});

test("aulas esfriando", () => {
  const st = L.normalize({
    subjects: [
      subject("s", [
        lesson("velha", { studied: true, lastReview: "2026-10-25" }),
        lesson("recente", { studied: true, lastReview: "2026-11-05" }),
        lesson("nao-estudada", { lastReview: "2026-10-01" }),
      ]),
      subject("passada", [lesson("p", { studied: true, lastReview: "2026-10-01" })], { examDate: "2026-11-01" }),
    ],
  });
  assert.deepEqual(L.coldLessons(st, "2026-11-07").map((c) => [c.lesson.id, c.days]), [["velha", 13]]);
});

test("mesclagem: edição mais recente vence, por aula", () => {
  const a = { subjects: [subject("s", [lesson("x", { studied: true, u: 5 }), lesson("y", { u: 1 })])] };
  const b = { subjects: [subject("s", [lesson("x", { u: 3 }), lesson("y", { cards: true, u: 9 }), lesson("z", { u: 2 })], { name: "Novo", u: 7 })] };
  const m = L.mergeStates(a, b);
  const s = m.subjects[0];
  assert.equal(s.name, "Novo");
  assert.deepEqual(s.lessons.map((l) => l.id), ["x", "y", "z"]);
  assert.equal(s.lessons[0].studied, true);
  assert.equal(s.lessons[1].cards, true);
  const rev = L.mergeStates(b, a).subjects[0]; // ordem dos argumentos não muda o resultado
  assert.equal(rev.name, "Novo");
  assert.equal(rev.lessons.find((l) => l.id === "x").studied, true);
  assert.equal(rev.lessons.find((l) => l.id === "y").cards, true);
});

test("mesclagem: exclusões não ressuscitam", () => {
  const a = { subjects: [subject("s", [lesson("y", { u: 2 })])], deleted: { x: 10, gone: 10 } };
  const b = { subjects: [subject("s", [lesson("x", { u: 5 }), lesson("y", { u: 2 })]), subject("gone", [], { u: 3 })] };
  const m = L.mergeStates(a, b);
  assert.deepEqual(m.subjects.map((s) => s.id), ["s"]);
  assert.deepEqual(m.subjects[0].lessons.map((l) => l.id), ["y"]);
  // editado depois da exclusão: volta
  const m2 = L.mergeStates(a, { subjects: [subject("s", [lesson("x", { u: 20 })])] });
  assert.deepEqual(m2.subjects[0].lessons.map((l) => l.id).sort(), ["x", "y"]);
});

test("normalize descarta lixo", () => {
  const n = L.normalize({ subjects: [null, { id: "a", examDate: "amanhã", lessons: [{ id: "l", lastReview: "x" }, {}] }], deleted: { q: "abc" } });
  assert.equal(n.subjects[0].examDate, "");
  assert.equal(n.subjects[0].lessons.length, 1);
  assert.equal(n.subjects[0].lessons[0].lastReview, null);
  assert.equal(n.subjects[0].lessons[0].cardsStudied, false); // dados antigos sem o campo continuam válidos
  assert.deepEqual(n.deleted, {});
});
