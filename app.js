// 할 일 대시보드 — 브라우저가 GitHub API로 두 레포를 직접 읽고, 버튼을 누르면 그 줄을 바로 커밋한다.
import { isTarget, parseFile, editLine, editStatus, editDue, STATUSES } from "./parse.js";
import { GitHub, GitHubError, clearCache } from "./github.js";
import { SOON_DAYS, COLUMNS, todayTargets, columnOf } from "./today.js";

const CONFIG_KEY = "dash.config.v1";
const LABELS = { company: "회사", personal: "개인" };
const WEEK_DAYS = 7;
const STALE_DAYS = 30; // 이 기간 넘게 수정이 없으면 회색 타일

const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = ymd(new Date());
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000); // a - b (일)
const weekLimit = (() => { const d = new Date(); d.setDate(d.getDate() + WEEK_DAYS); return ymd(d); })();
const $ = id => document.getElementById(id);

// ── 설정 (토큰은 이 기기의 localStorage 에만) ──────────
function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch (e) { return {}; }
}
function saveConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); return true; } catch (e) { return false; }
}
let config = loadConfig();
const isLocalDev = ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocalDev ? location.origin + "/api" : "https://api.github.com";

function repoConfig(key) {
  const [owner, name] = (config.repos?.[key] || "").split("/");
  return { key, owner, name, branch: null };
}
let REPOS = {};
let gh = null;

// ── 상태 ──────────────────────────────────────────
const DATA = { todos: [], areas: [], files: new Map() }; // files: "repo:file" → { title }
let TODO_BY_ID = new Map();
let repoFilter = "all";
let triage = null;          // { items, index, picks: Map(id → "done"|"keep") }
let sheetArea = null;
const pending = new Set();  // 반영 중인 할 일 id
let lastUndo = null;        // { repo, file, before, after, label }

const fileKey = t => `${t.repo}:${t.file}`;
const titleOf = t => DATA.files.get(fileKey(t))?.title || t.file;
const rootOf = repo => `~/${REPOS[repo]?.name || repo}`;
const pathOf = t => `${rootOf(t.repo)}/${t.file}`;

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

// ── 불러오기 ───────────────────────────────────────
async function loadAll() {
  // 공개 페이지라 레포 이름도 코드에 두지 않는다. 설정에서 한 번 입력
  if (!config.token || !config.repos?.company || !config.repos?.personal) { showSettings(); return; }
  REPOS = { company: repoConfig("company"), personal: repoConfig("personal") };
  gh = new GitHub({ token: config.token, apiBase });
  setStatus("GitHub에서 읽는 중…");
  try {
    const todos = [], areas = [], files = new Map();
    for (const repo of Object.values(REPOS)) {
      const entries = (await gh.listFiles(repo)).filter(e => isTarget(repo.key, e.path));
      const texts = await gh.readBlobs(repo, entries,
        n => setStatus(`${LABELS[repo.key]} 레포 읽는 중… ${n}/${entries.length}`));
      const areaPaths = entries.map(e => e.path).filter(p => p.startsWith("areas/"));
      let dates = {};
      try { dates = await gh.lastCommitDates(repo, areaPaths); } catch (e) { console.warn("수정일을 못 읽었습니다", e); }
      entries.forEach((e, i) => {
        const r = parseFile(texts[i], e.path, repo.key);
        todos.push(...r.todos);
        files.set(`${repo.key}:${e.path}`, { title: r.title });
        if (e.path.startsWith("areas/")) areas.push(areaFrom(repo.key, e.path, r, dates[e.path] || null));
      });
    }
    DATA.todos = todos; DATA.areas = areas; DATA.files = files;
    reindex();
    const now = new Date();
    setStatus(`읽음 ${pad(now.getHours())}:${pad(now.getMinutes())} · 할 일 ${todos.filter(t => !t.done).length}줄 열림`);
    showTab(currentTab());
  } catch (e) {
    console.error(e);
    const msg = e instanceof GitHubError && e.status === 401 ? "토큰이 맞지 않거나 만료됐어요. 설정에서 다시 넣어 주세요."
      : e instanceof GitHubError && e.status === 404 ? "레포를 찾을 수 없어요. 레포 이름과 토큰 권한을 확인해 주세요."
      : `읽기 실패: ${e.message}`;
    setStatus(msg, true);
  }
}
function areaFrom(repoKey, file, parsed, modified) {
  return { repo: repoKey, file, title: parsed.title, status: parsed.meta.status || null,
           review: parsed.meta.review || null, due: parsed.meta.due || null, modified, unsorted: parsed.unsorted };
}
function reindex() {
  DATA.todos.forEach(t => { t.id = `${t.repo}:${t.file}:${t.line}`; });
  TODO_BY_ID = new Map(DATA.todos.map(t => [t.id, t]));
}
/** 커밋한 뒤 그 파일 하나만 다시 해석해 화면 데이터에 반영 */
function replaceFile(repoKey, file, text) {
  const r = parseFile(text, file, repoKey);
  DATA.todos = DATA.todos.filter(t => !(t.repo === repoKey && t.file === file)).concat(r.todos);
  DATA.files.set(`${repoKey}:${file}`, { title: r.title });
  const i = DATA.areas.findIndex(a => a.repo === repoKey && a.file === file);
  if (i >= 0) DATA.areas[i] = areaFrom(repoKey, file, r, TODAY);
  reindex();
}

// ── 반영 (커밋) ────────────────────────────────────
let queue = Promise.resolve();
/** 파일 최신본을 읽어 transform(text) 결과로 커밋. 같은 파일 충돌을 피하려고 하나씩 처리한다 */
function commitFile(repoKey, file, transform, message) {
  const job = queue.then(async () => {
    const repo = REPOS[repoKey];
    const { text, sha } = await gh.readFile(repo, file);
    const { next, result } = transform(text);
    await gh.writeFile(repo, file, next, sha, message);
    replaceFile(repoKey, file, next);
    return result;
  });
  queue = job.catch(() => {});
  return job;
}

/** 한 줄을 before → after 로 바꿔 커밋. 그 줄이 GitHub 최신본에 그대로 있을 때만 */
function commitLine(repoKey, file, lineNo, before, after, message) {
  return commitFile(repoKey, file, text => {
    const lines = text.split("\n");
    const bare = l => l.replace(/\r$/, "");
    let idx = lineNo - 1;
    if (bare(lines[idx] ?? "") !== before) {
      const hits = lines.map((l, i) => bare(l) === before ? i : -1).filter(i => i >= 0);
      if (hits.length !== 1) throw new Error("그 줄이 GitHub에서 바뀌었어요. 새로고침 후 다시 해 주세요.");
      idx = hits[0];
    }
    const cr = lines[idx].endsWith("\r") ? "\r" : "";
    lines[idx] = after + cr;
    return { next: lines.join("\n"), result: idx + 1 };
  }, message);
}

/** areas/ 프론트매터(status·due)를 before → after 로 바꿔 커밋. GitHub 최신본 값이 before 일 때만 */
const META_EDIT = { status: editStatus, due: editDue };
const META_LABEL = { status: "상태", due: "마감" };
function commitMeta(repoKey, file, key, before, after, message) {
  return commitFile(repoKey, file, text => {
    const next = META_EDIT[key](text, before, after);
    if (next === null) throw new Error(`${META_LABEL[key]}이 GitHub에서 바뀌었어요. 새로고침 후 다시 해 주세요.`);
    return { next, result: null };
  }, message);
}

async function applyChange(t, kind) {
  const after = editLine(t.raw, kind, TODAY);
  if (!after || pending.has(t.id)) return false;
  const label = kind === "done" ? "완료" : "#확인 해제";
  pending.add(t.id); render();
  try {
    const line = await commitLine(t.repo, t.file, t.line, t.raw, after, `대시보드: ${label} — ${t.file}:${t.line}`);
    lastUndo = { kind: "line", repo: t.repo, file: t.file, line, before: t.raw, after, label };
    toast(`${label} 반영했어요`, true);
    return true;
  } catch (e) {
    console.error(e);
    toast(e instanceof GitHubError ? `반영 실패: ${e.message}` : e.message, false, true);
    return false;
  } finally {
    pending.delete(t.id); render();
  }
}
async function undoLast() {
  const u = lastUndo;
  if (!u) return;
  lastUndo = null; hideToast();
  try {
    if (u.kind === "meta") await commitMeta(u.repo, u.file, u.key, u.after, u.before,
      `대시보드: ${META_LABEL[u.key]} 되돌림 ${u.after || "없음"} → ${u.before || "없음"} — ${u.file}`);
    else await commitLine(u.repo, u.file, u.line, u.after, u.before, `대시보드: ${u.label} 되돌림 — ${u.file}:${u.line}`);
    toast("되돌렸어요");
  } catch (e) {
    toast(`되돌리기 실패: ${e.message}`, false, true);
  }
  render();
}

let metaPending = false;
/** 프로젝트 프론트매터 한 값 바꾸기 (status·due) */
async function changeMeta(areaKey, key, next) {
  const a = DATA.areas.find(x => `${x.repo}:${x.file}` === areaKey);
  if (!a || a[key] === next || metaPending) return;
  const before = a[key];
  if (key === "status" && !before) { toast("상태가 없는 파일이에요. 레포 세션에서 먼저 넣어 주세요", false, true); return; }
  metaPending = true; renderSheet();
  try {
    await commitMeta(a.repo, a.file, key, before, next,
      `대시보드: ${META_LABEL[key]} ${before || "없음"} → ${next || "없음"} — ${a.file}`);
    lastUndo = { kind: "meta", key, repo: a.repo, file: a.file, before, after: next };
    toast(key === "status" ? `「${next}」로 바꿨어요` : next ? `마감을 ${next.slice(5)}로 정했어요` : "마감을 지웠어요", true);
  } catch (e) {
    console.error(e);
    toast(e instanceof GitHubError ? `반영 실패: ${e.message}` : e.message, false, true);
  } finally {
    metaPending = false; render();
  }
}
function changeStatus(areaKey, next) {
  const a = DATA.areas.find(x => `${x.repo}:${x.file}` === areaKey);
  if (!a) return;
  const s = areaStats(a);
  if (next === "종료" && (s.open.length || a.unsorted)) {
    const left = [s.open.length ? `열린 할 일 ${s.open.length}줄` : "", a.unsorted ? `미분류 ${a.unsorted}개` : ""].filter(Boolean).join(", ");
    if (!confirm(`${left}이 남아 있어요. 그래도 「종료」로 바꿀까요?`)) return;
  }
  changeMeta(areaKey, "status", next);
}

// ── 표시 도우미 ─────────────────────────────────────
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function md(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>")
    .replace(/~~([^~]+?)~~/g, "<s>$1</s>")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
}
const visible = x => repoFilter === "all" || x.repo === repoFilter;
const isOpen = t => !t.done;
const isLate = t => isOpen(t) && t.due && t.due < TODAY;
const byDue = (a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.file.localeCompare(b.file) || a.line - b.line;
const byFile = (a, b) => a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file) || a.line - b.line;

function dueBadge(t) {
  if (!t.due) return "";
  if (t.done) return `<span class="badge b-due">📅 ${t.due.slice(5)}</span>`;
  const d = dayDiff(t.due, TODAY);
  if (d < 0) return `<span class="badge b-late">D+${-d} · ${t.due.slice(5)}</span>`;
  if (d <= WEEK_DAYS) return `<span class="badge b-soon">${d === 0 ? "오늘" : "D-" + d} · ${t.due.slice(5)}</span>`;
  return `<span class="badge b-due">D-${d} · ${t.due.slice(5)}</span>`;
}
const badges = t => [
  t.priority ? `<span class="badge b-late">🔴 우선</span>` : "",
  dueBadge(t),
  t.check ? `<span class="badge b-check">#확인</span>` : "",
  t.done ? `<span class="badge b-done">완료${t.done_date ? " " + t.done_date.slice(5) : ""}</span>` : "",
].join("");

function todoLi(t, opts = {}) {
  const path = opts.hidePath ? `<span class="path ${t.repo}">:${t.line}</span>`
             : opts.proj ? `<span class="proj ${t.repo}" title="${esc(pathOf(t))}:${t.line}">${md(titleOf(t))}</span>`
                         : `<span class="path ${t.repo}">${esc(pathOf(t))}:${t.line}</span>`;
  const box = t.done ? "" : `<input type="checkbox" data-id="${esc(t.id)}" aria-label="완료로 반영">`;
  return `<li class="todo ${t.repo}${t.done ? " done" : ""}${pending.has(t.id) ? " pending" : ""}" data-id="${esc(t.id)}">
    ${box}<div class="body"><div class="text">${md(t.text)}</div><div class="meta">${badges(t)}${path}</div></div></li>`;
}
const list = (items, opts) => items.length ? `<ul class="todos">${items.map(t => todoLi(t, opts)).join("")}</ul>`
                                          : `<div class="empty">없음</div>`;

// ── 오늘 (4열 칸반: 기한 지남 / 기한 임박 / 기한 없음 / 정리 필요) ──────
let todayCol = null;            // 좁은 화면에서 보고 있는 칸
const openFolds = new Set();    // 「기한 없음」에서 펼친 프로젝트
const byPriority = (a, b) => Number(b.priority) - Number(a.priority) || byDue(a, b);
const soonOf = t => dayDiff(t.due, TODAY) <= SOON_DAYS;

function todayBuckets() {
  const statusOf = new Map(DATA.areas.map(a => [`${a.repo}:${a.file}`, a.status]));
  const open = todayTargets(DATA.todos.filter(visible), statusOf);
  const cols = { late: [], soon: [], nodue: [], tidy: [] };
  for (const t of open) cols[columnOf(t, TODAY)].push(t);
  Object.values(cols).forEach(c => c.sort(byPriority));
  // 프로젝트 카드: 마감 지남·7일 안 마감은 기한 칸, 다시 볼 날이 된 것은 정리 필요. due·review 없으면 안 나온다
  const cards = { late: [], soon: [], tidy: [] };
  for (const a of DATA.areas.filter(visible)) {
    if (a.status === "종료") continue;
    const s = areaStats(a);
    if (s.dueIn !== null && a.status !== "보류") {
      if (s.dueIn < 0) cards.late.push({ a, s });
      else if (s.dueIn <= SOON_DAYS) cards.soon.push({ a, s });
    }
    if (s.reviewDue) cards.tidy.push({ a, s });
  }
  cards.late.sort((x, y) => x.s.dueIn - y.s.dueIn);
  cards.soon.sort((x, y) => x.s.dueIn - y.s.dueIn);
  // 정리 모드는 #확인 줄 전부를 본다 (기한 칸에 있는 #확인 줄도 떼려면 여기서)
  return { cols, cards, check: open.filter(t => t.check).sort(byDue) };
}

function pcard({ a, s }, kind) {
  const sig = kind === "tidy" ? `다시 볼 날 ${a.review.slice(5)}`
    : s.dueIn < 0 ? `마감 지남 D+${-s.dueIn}` : s.dueIn === 0 ? "오늘 마감" : `마감 D-${s.dueIn} · ${a.due.slice(5)}`;
  return `<button class="pcard ${a.repo} k-${kind}" data-area="${esc(a.repo + ":" + a.file)}">
    <span class="tt">🏁 ${md(a.title)}</span><span class="sig">${sig} · 열린 ${s.open.length}</span></button>`;
}
const flat = items => items.length ? list(items, { proj: true }) : "";
const empty = (msg = "없음") => `<div class="empty">${msg}</div>`;

const COL_BODY = {
  late: b => b.cards.late.map(c => pcard(c, "late")).join("") + flat(b.cols.late)
    || empty(),
  soon: b => {
    const near = b.cols.soon.filter(soonOf), later = b.cols.soon.filter(t => !soonOf(t));
    const head = b.cards.soon.map(c => pcard(c, "soon")).join("") + flat(near);
    return (head || empty(`${SOON_DAYS}일 안 없음`))
      + (later.length ? `<div class="divider">${SOON_DAYS + 1}일 이후 ${later.length}</div><div class="later">${flat(later)}</div>` : "");
  },
  nodue: b => {
    const pri = b.cols.nodue.filter(t => t.priority), rest = b.cols.nodue.filter(t => !t.priority);
    const groups = new Map();
    for (const t of [...rest].sort(byFile)) {
      if (!groups.has(fileKey(t))) groups.set(fileKey(t), []);
      groups.get(fileKey(t)).push(t);
    }
    const folds = [...groups].map(([k, ts]) => `<details class="pgroup ${ts[0].repo}" data-fold="${esc(k)}"${openFolds.has(k) ? " open" : ""}>
      <summary><span class="gt">${md(titleOf(ts[0]))}</span><span class="gc">${ts.length}</span></summary>
      ${list(ts, { hidePath: true })}</details>`).join("");
    return (pri.length ? `<div class="sub">🔴 우선 ${pri.length}</div>${flat(pri)}` : "")
      + (folds ? `${pri.length ? `<div class="sub">프로젝트별</div>` : ""}<div class="folds">${folds}</div>` : "")
      || empty();
  },
  tidy: b => `<div class="tidy-entry"><div class="ts">#확인 ${b.check.length}줄을 한 장씩 보며 완료 / #확인 떼기 / 건너뛰기</div>
      <button class="btn primary" data-act="triage-start" ${b.check.length ? "" : "disabled"}>정리 시작</button></div>`
    + (b.cards.tidy.map(c => pcard(c, "tidy")).join("") + flat(b.cols.tidy) || empty()),
};

function renderToday() {
  const b = todayBuckets();
  const el = $("tab-today");
  const badge = b.cols.late.length + b.cols.soon.filter(soonOf).length + b.cols.nodue.filter(t => t.priority).length;
  if (triage) { renderTriage(el); return badge; }
  if (!todayCol && DATA.todos.length) todayCol = COLUMNS.find(c => b.cols[c.key].length || b.cards[c.key]?.length)?.key;
  const col = todayCol || "late";
  // 다시 그려도 칸마다 스크롤 위치를 지킨다
  const scrolls = new Map([...el.querySelectorAll(".col-body")].map(x => [x.dataset.col, x.scrollTop]));
  const cardN = k => b.cards[k]?.length ? `<span class="pc" title="프로젝트">🏁 ${b.cards[k].length}</span>` : "";
  el.innerHTML = `<div class="kanban" data-col="${col}">
    <div class="col-pick" role="tablist" aria-label="칸">${COLUMNS.map(c => `<button role="tab" data-act="col" data-col="${c.key}"
      aria-selected="${c.key === col}" class="cp-${c.key}">${c.label}<span class="n">${b.cols[c.key].length}${b.cards[c.key]?.length ? ` · 🏁${b.cards[c.key].length}` : ""}</span></button>`).join("")}</div>
    ${COLUMNS.map(c => `<section class="col col-${c.key}">
      <h2>${c.label} <span class="count">${b.cols[c.key].length}</span>${cardN(c.key)}</h2>
      <div class="col-body" data-col="${c.key}">${COL_BODY[c.key](b)}</div></section>`).join("")}
  </div>`;
  el.querySelectorAll(".col-body").forEach(x => { x.scrollTop = scrolls.get(x.dataset.col) || 0; });
  return badge;
}

// ── 정리 모드 ──────────────────────────────────────
function startTriage() {
  triage = { items: todayBuckets().check, index: 0, picks: new Map() };
  render(); window.scrollTo(0, 0);
}
function renderTriage(el) {
  const { items, index, picks } = triage;
  const count = k => [...picks.values()].filter(v => v === k).length;
  if (index >= items.length) {
    el.innerHTML = `<div class="triage">
      <div class="card done-card">
        <div class="done-title">끝까지 봤어요</div>
        <div>완료 <b>${count("done")}</b> · #확인 떼기 <b>${count("keep")}</b> · 건너뜀 <b>${items.length - picks.size}</b></div>
        <div class="hint left">고른 줄은 이미 GitHub에 반영됐어요.</div>
      </div>
      <div class="row"><button class="btn" data-act="prev">← 이전</button><button class="btn" data-act="exit">목록으로</button></div></div>`;
    return;
  }
  const t = TODO_BY_ID.get(items[index].id) || items[index];
  const picked = picks.get(t.id);
  el.innerHTML = `<div class="triage">
    <div class="row"><span>${index + 1} / ${items.length}</span><span>완료 ${count("done")} · 떼기 ${count("keep")}</span>
      <button class="btn" data-act="exit">그만하기</button></div>
    <progress class="bar-progress" max="${items.length}" value="${index}"></progress>
    <div class="card ${t.repo}">
      <div class="ft">${md(titleOf(t))}</div>
      <div class="card-text">${md(t.text)}</div>
      <div class="meta">${badges(t)}<span class="path ${t.repo}">${esc(pathOf(t))}:${t.line}</span></div>
    </div>
    <div class="choices">
      <button class="btn c-done" data-act="done" aria-pressed="${picked === "done"}" ${picked ? "disabled" : ""}>완료</button>
      <button class="btn c-keep" data-act="keep" aria-pressed="${picked === "keep"}" ${picked || !t.check ? "disabled" : ""}>#확인 떼기</button>
      <button class="btn" data-act="skip">${picked ? "다음" : "건너뛰기"}</button>
    </div>
    <div class="row"><button class="btn" data-act="prev" ${index ? "" : "disabled"}>← 이전</button>
      <span class="hint">키보드: X 완료 · K 떼기 · → 건너뛰기 · ← 이전</span></div></div>`;
}
function triageAct(act) {
  if (!triage) return;
  if (act === "exit") { triage = null; render(); return; }
  if (act === "prev") { triage.index = Math.max(0, triage.index - 1); render(); return; }
  const item = triage.items[triage.index];
  if (!item) return;
  if ((act === "done" || act === "keep") && !triage.picks.has(item.id)) {
    const t = TODO_BY_ID.get(item.id) || item;
    triage.picks.set(item.id, act);
    applyChange(t, act).then(ok => { if (!ok && triage) { triage.picks.delete(item.id); render(); } });
  }
  triage.index++;
  render();
}

// ── 현황판 ─────────────────────────────────────────
function areaStats(a) {
  const open = DATA.todos.filter(t => t.repo === a.repo && t.file === a.file && isOpen(t));
  const nextDue = open.filter(t => t.due && t.due >= TODAY).map(t => t.due).sort()[0] || null;
  const late = open.filter(t => isLate(t) && !t.check).length;
  const check = open.filter(t => t.check).length;
  const idle = a.modified ? dayDiff(TODAY, a.modified) : null;
  const reviewDue = !!(a.review && a.review <= TODAY);
  const dueIn = a.due ? dayDiff(a.due, TODAY) : null;          // 프로젝트 마감까지 남은 날
  const afterDue = a.due ? open.filter(t => t.due && t.due > a.due).length : 0; // 마감 뒤로 잡힌 태스크
  let health, signal;
  if (a.status === "종료") { health = "closed"; signal = "종료"; }
  else if (dueIn !== null && dueIn < 0) { health = "red"; signal = `마감 지남 D+${-dueIn}`; }
  else if (late) { health = "red"; signal = `지연 ${late}`; }
  else if (dueIn !== null && dueIn <= WEEK_DAYS) { health = "amber"; signal = dueIn === 0 ? "오늘 마감" : `마감 D-${dueIn}`; }
  else if (nextDue && dayDiff(nextDue, TODAY) <= WEEK_DAYS) { health = "amber"; signal = `기한 D-${dayDiff(nextDue, TODAY)}`; }
  else if (reviewDue) { health = "amber"; signal = "다시 볼 날"; }
  else if (!open.length && !a.unsorted) { health = "empty"; signal = "할 일 없음 · 종료할까요?"; }
  else if (!open.length) { health = "empty"; signal = `할 일 줄 없음 · 미분류 ${a.unsorted}`; }
  else if (idle !== null && idle > STALE_DAYS) { health = "gray"; signal = `${idle}일째 그대로`; }
  else { health = "green"; signal = "정상"; }
  return { open, late, check, nextDue, dueIn, reviewDue, afterDue, health, signal };
}
const HEALTH_ORDER = { red: 0, amber: 1, empty: 2, green: 3, gray: 4, closed: 5 };
function tile(a) {
  const s = a.s;
  return `<button class="tile ${a.repo} h-${s.health}" data-area="${esc(a.repo + ":" + a.file)}">
    <span class="tt">${md(a.title)}</span>
    <span class="sig">${s.signal}</span>
    <span class="ts">${a.due && a.status !== "종료" ? `마감 ${a.due.slice(5)} · ` : ""}열린 ${s.open.length}${s.check ? ` · #확인 ${s.check}` : ""}${a.unsorted ? ` · 미분류 ${a.unsorted}` : ""}</span></button>`;
}
const soonest = a => [a.due, a.s.nextDue].filter(Boolean).sort()[0] || "9999";
function renderBoard() {
  const areas = DATA.areas.filter(visible).map(a => ({ ...a, s: areaStats(a) }));
  const sortKey = (x, y) => HEALTH_ORDER[x.s.health] - HEALTH_ORDER[y.s.health] || y.s.late - x.s.late
    || soonest(x).localeCompare(soonest(y)) || y.s.open.length - x.s.open.length;
  let html = `<div class="legend">
    <span><i class="l-red"></i>지연·마감 지남</span><span><i class="l-amber"></i>7일 내 기한·마감·다시 볼 날</span>
    <span><i class="l-empty"></i>할 일 없음</span><span><i class="l-green"></i>정상</span><span><i class="l-gray"></i>${STALE_DAYS}일+ 수정 없음</span></div>`;
  for (const st of [...STATUSES, null]) {
    const items = areas.filter(a => st ? a.status === st : !STATUSES.includes(a.status)).sort(sortKey);
    if (st === null && !items.length) continue;
    const label = st || "상태 미지정";
    const body = items.length ? `<div class="tiles">${items.map(tile).join("")}</div>` : `<div class="empty">없음</div>`;
    html += st === "종료"
      ? `<details class="fold"><summary>${label} <span class="count">${items.length}</span></summary><div class="fold-body">${body}</div></details>`
      : `<h2>${label} <span class="count">${items.length}</span></h2>${body}`;
  }
  $("tab-board").innerHTML = html;
  return areas.filter(a => a.status !== "종료").length;
}

// ── 상세 시트 ──────────────────────────────────────
function closeSheet() {
  sheetArea = null;
  $("sheet-wrap").hidden = true;
  document.body.classList.remove("locked");
}
function renderSheet() {
  if (!sheetArea) return;
  const a = DATA.areas.find(x => `${x.repo}:${x.file}` === sheetArea);
  if (!a) { closeSheet(); return; }
  const s = areaStats(a);
  $("sheet").innerHTML = `
    <div class="sh"><div><div class="tt">${md(a.title)}</div>
      <div class="meta"><span class="path ${a.repo}">${esc(rootOf(a.repo) + "/" + a.file)}</span></div></div>
      <button class="close" data-act="close-sheet" aria-label="닫기">×</button></div>
    <div class="stats">
      <span>상태 <b>${esc(a.status || "미지정")}</b></span>
      <span>마감 <b>${a.due ? esc(a.due.slice(5)) + (s.dueIn >= 0 ? ` (D-${s.dueIn})` : ` (D+${-s.dueIn})`) : "—"}</b></span>
      <span>열린 <b>${s.open.length}</b></span>
      <span>지연 <b>${s.late}</b></span>
      <span>#확인 <b>${s.check}</b></span>
      <span>미분류 <b>${a.unsorted}</b></span>
      <span>다음 기한 <b>${s.nextDue ? s.nextDue.slice(5) + " (D-" + dayDiff(s.nextDue, TODAY) + ")" : "—"}</b></span>
      <span>수정 <b>${a.modified ? a.modified.slice(5) : "—"}</b></span>
      ${a.review ? `<span>다시 볼 날 <b>${esc(a.review.slice(5))}</b></span>` : ""}
    </div>
    <div class="status-pick" role="group" aria-label="상태 바꾸기">
      ${STATUSES.map(st => `<button class="btn" data-act="status" data-status="${st}"
        aria-pressed="${a.status === st}" ${a.status === st || metaPending ? "disabled" : ""}>${st}</button>`).join("")}
    </div>
    <div class="due-pick">
      <label for="due-input">프로젝트 마감</label>
      <input type="date" id="due-input" value="${esc(a.due || "")}" ${metaPending ? "disabled" : ""}>
      <button class="btn" data-act="due-save" ${metaPending ? "disabled" : ""}>저장</button>
      ${a.due ? `<button class="btn" data-act="due-clear" ${metaPending ? "disabled" : ""}>지우기</button>` : ""}
    </div>
    ${s.afterDue ? `<div class="warn-line">⚠️ 프로젝트 마감(${esc(a.due.slice(5))})보다 늦은 태스크가 ${s.afterDue}개 있어요</div>` : ""}
    ${list(s.open.sort(byDue), { hidePath: true })}`;
  $("sheet-wrap").hidden = false;
  document.body.classList.add("locked");
}

// ── 설정 ───────────────────────────────────────────
function showSettings() { showTab("settings"); }
function renderSettings() {
  const repos = config.repos || {};
  $("tab-settings").innerHTML = `<div class="settings">
    <h2>설정</h2>
    <div class="warn">토큰은 이 기기 브라우저에만 저장돼요. 기기를 잃어버리면 GitHub에서 토큰을 바로 폐기하세요.</div>
    <label>GitHub 토큰
      <input id="cfg-token" type="password" autocomplete="off" spellcheck="false" placeholder="${config.token ? "저장됨 — 바꿀 때만 입력" : "github_pat_…"}">
      <span class="help">Fine-grained 토큰을 쓰세요.</span></label>
    <ol>
      <li>GitHub → Settings → Developer settings → Fine-grained tokens → Generate</li>
      <li>Repository access: <b>Only select repositories</b> → 아래 두 레포만</li>
      <li>Permissions → Contents: <b>Read and write</b> (Metadata는 자동)</li>
      <li>Expiration: 90일 권장</li>
    </ol>
    <label>회사 레포 <input id="cfg-company" value="${esc(repos.company || "")}" placeholder="owner/name" autocapitalize="off" spellcheck="false"></label>
    <label>개인 레포 <input id="cfg-personal" value="${esc(repos.personal || "")}" placeholder="owner/name" autocapitalize="off" spellcheck="false"></label>
    <div class="row">
      <button class="btn primary" data-act="save-settings">저장하고 불러오기</button>
      ${config.token ? `<button class="btn" data-act="cancel-settings">닫기</button>` : ""}
      ${config.token ? `<button class="btn" data-act="forget-token">이 기기에서 토큰 지우기</button>` : ""}
    </div></div>`;
}
async function saveSettings() {
  const token = $("cfg-token").value.trim();
  const company = $("cfg-company").value.trim(), personal = $("cfg-personal").value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(company) || !/^[\w.-]+\/[\w.-]+$/.test(personal)) {
    toast("레포는 owner/name 형식으로 넣어 주세요", false, true); return;
  }
  if (!token && !config.token) { toast("토큰을 넣어 주세요", false, true); return; }
  config = { ...config, ...(token ? { token } : {}), repos: { company, personal } };
  if (!saveConfig(config)) { toast("이 브라우저에 저장할 수 없어요 (사생활 보호 모드?)", false, true); return; }
  showTab("today");
  await loadAll();
}
async function forgetToken() {
  config = { repos: config.repos };
  saveConfig(config);
  await clearCache();
  DATA.todos = []; DATA.areas = []; DATA.files = new Map(); reindex();
  setStatus("토큰을 지웠어요");
  showSettings();
}

// ── 공통 ───────────────────────────────────────────
function currentTab() {
  return document.querySelector("nav button[aria-selected='true']")?.dataset.tab || "today";
}
function showTab(tab) {
  document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
  document.querySelectorAll("section.tab").forEach(s => s.hidden = s.id !== "tab-" + tab);
  document.body.classList.toggle("on-today", tab === "today"); // PC에서 칸마다 따로 스크롤
  if (tab === "settings") renderSettings(); else render();
  window.scrollTo(0, 0);
}
function render() {
  $("n-today").textContent = renderToday();
  $("n-board").textContent = renderBoard();
  renderSheet();
}

let toastTimer = null;
function toast(msg, withUndo = false, isError = false) {
  const el = $("toast");
  $("toast-msg").textContent = msg;
  $("toast-undo").hidden = !withUndo;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, withUndo ? 6000 : isError ? 5000 : 2000);
}
function hideToast() { $("toast").classList.remove("show"); }

// ── 이벤트 ─────────────────────────────────────────
document.addEventListener("change", e => {
  const id = e.target.dataset?.id;
  if (!id || e.target.type !== "checkbox") return;
  const t = TODO_BY_ID.get(id);
  if (t && e.target.checked) applyChange(t, "done");
});
document.addEventListener("click", e => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act) {
    if (act === "close-sheet") closeSheet();
    else if (act === "status") changeStatus(sheetArea, e.target.closest("[data-act]").dataset.status);
    else if (act === "due-save") {
      const v = $("due-input").value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { toast("날짜를 골라 주세요", false, true); return; }
      changeMeta(sheetArea, "due", v);
    }
    else if (act === "due-clear") changeMeta(sheetArea, "due", null);
    else if (act === "triage-start") startTriage();
    else if (act === "col") { todayCol = e.target.closest("[data-act]").dataset.col; render(); }
    else if (act === "save-settings") saveSettings();
    else if (act === "cancel-settings") showTab("today");
    else if (act === "forget-token") forgetToken();
    else triageAct(act);
    return;
  }
  if (e.target.id === "sheet-wrap") { closeSheet(); return; }
  const tileEl = e.target.closest("[data-area]");
  if (tileEl) { sheetArea = tileEl.dataset.area; renderSheet(); return; }
  const text = e.target.closest(".text");
  if (text) text.classList.toggle("open");
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && sheetArea) { closeSheet(); return; }
  if (!triage || e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input, textarea")) return;
  const map = { x: "done", X: "done", k: "keep", K: "keep", ArrowRight: "skip", ArrowLeft: "prev" };
  if (map[e.key]) { e.preventDefault(); triageAct(map[e.key]); }
});
document.querySelectorAll("nav button").forEach(btn => btn.addEventListener("click", () => showTab(btn.dataset.tab)));
document.querySelectorAll(".chip").forEach(chip => chip.addEventListener("click", () => {
  repoFilter = chip.dataset.repo;
  document.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", c === chip));
  triage = null;
  render();
}));
// toggle 은 버블링하지 않아 캡처로 받는다
document.addEventListener("toggle", e => {
  const k = e.target.dataset?.fold;
  if (k) e.target.open ? openFolds.add(k) : openFolds.delete(k);
}, true);
$("toast-undo").addEventListener("click", undoLast);
$("reload").addEventListener("click", () => { triage = null; closeSheet(); loadAll(); });
$("open-settings").addEventListener("click", showSettings);

render();
loadAll();
