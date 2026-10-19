// 마크다운에서 할 일 줄·미분류·프론트매터를 읽는다. collect.py 와 같은 규칙.
// 브라우저와 node(대조 검사) 양쪽에서 쓴다.

export const EXCLUDE_DIRS = new Set([".git", ".claude", "log", "english", "node_modules"]);
export const EXCLUDE_FILES = new Set(["STATUS.md"]);
// 프로젝트 = areas/ 파일, 태스크 = 그 안의 할 일 줄 (2026-10-19 결정). 다른 폴더는 기록이라 읽지 않는다
export const PROJECT_DIR = "areas";
const TODO_SECTIONS = ["다음 액션", "챙길 것"];
const UNSORTED_SECTION = "다음 액션";

const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_FENCE = /^\s*(```|~~~)/;
const RE_CHECKBOX = /^[-*] \[([ xX])\]\s?(.*)$/;
const RE_LIST_ITEM = /^([-*+]|\d+[.)])\s+(.*)$/;
const RE_DUE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const RE_DONE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const RE_CHECK_TAG = /#확인(?![\p{L}\p{N}_])/u;
const RE_CHECK_TAG_ALL = /#확인(?![\p{L}\p{N}_])/gu;
const RE_OWNER = /^\(담당\s*:/;

/** 레포 안 경로(rel)가 수집 대상인지 */
export function isTarget(repoKey, rel) {
  if (!rel.endsWith(".md") || rel.endsWith(".local.md")) return false;
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  if (EXCLUDE_FILES.has(name)) return false;
  if (parts.length < 2 || parts[0] !== PROJECT_DIR) return false;
  if (parts.slice(0, -1).some(p => EXCLUDE_DIRS.has(p))) return false;
  return true;
}

function parseFrontmatter(lines) {
  if (!lines.length || lines[0].trim() !== "---") return [{}, 0];
  const meta = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return [meta, i + 1];
    const m = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) meta[m[1]] = m[2].replace(/\s+#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
  }
  return [{}, 0]; // 닫히지 않은 블록은 프론트매터로 보지 않는다
}

/** 표시용 본문: 기한·완료·우선·#확인 표시를 뺀다 */
export function cleanText(body) {
  return body
    .replace(new RegExp(RE_DUE.source, "g"), "")
    .replace(new RegExp(RE_DONE.source, "g"), "")
    .replace(/🔴\s*/g, "")
    .replace(RE_CHECK_TAG_ALL, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 파일 하나를 읽어 { meta, title, todos, unsorted } */
export function parseFile(text, rel, repoKey) {
  // Python splitlines 와 맞추기 위해 \r\n·\r 도 줄 끝으로 본다
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const [meta, start] = parseFrontmatter(lines);

  let title = null, unsorted = 0, inFence = false, section = null;
  const todos = [];

  for (let idx = start; idx < lines.length; idx++) {
    const line = lines[idx];
    if (RE_FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const h = line.match(RE_HEADING);
    if (h) {
      const level = h[1].length, name = h[2];
      if (level === 1 && title === null) title = name;
      if (section && level <= section.level) section = null;
      const matched = TODO_SECTIONS.find(s => name.startsWith(s));
      if (matched && !section) section = { level, name: matched };
      continue;
    }
    if (!section) continue;

    const cb = line.match(RE_CHECKBOX);
    if (cb) {
      const body = cb[2];
      const due = body.match(RE_DUE), doneDate = body.match(RE_DONE);
      todos.push({
        repo: repoKey, file: rel, line: idx + 1, section: section.name,
        done: cb[1] !== " ",
        due: due ? due[1] : null,
        done_date: doneDate ? doneDate[1] : null,
        priority: body.includes("🔴"),
        check: RE_CHECK_TAG.test(body),
        text: cleanText(body),
        raw: line,
      });
      continue;
    }
    if (section.name === UNSORTED_SECTION) {
      const li = line.match(RE_LIST_ITEM);
      if (li && !RE_OWNER.test(li[2])) unsorted++;
    }
  }
  const stem = rel.split("/").pop().replace(/\.md$/, "");
  return { meta, title: title || stem, todos, unsorted };
}

export const STATUSES = ["진행", "대기", "보류", "종료"];

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * areas/ 파일 프론트매터의 key 값을 expected → next 로 바꾼다. next 가 null 이면 그 줄을 지운다.
 * 지금 값이 expected 와 다르면(그사이 바뀜) null. 주석(`# …`)과 다른 줄은 그대로 둔다.
 * 프론트매터가 없으면 맨 위에 만든다
 */
export function editFrontmatter(text, key, expected, next) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(nl);
  const keyRe = new RegExp(`^(${key}\\s*:\\s*)([^#\\s]*)(.*)$`);
  const norm = v => v || null;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) {
      const i = lines.findIndex((l, j) => j > 0 && j < end && keyRe.test(l));
      if (i < 0) {
        if (norm(expected) !== null) return null;
        if (next === null) return text;
        const st = lines.findIndex((l, j) => j > 0 && j < end && /^status\s*:/.test(l));
        lines.splice(st > 0 ? st + 1 : 1, 0, `${key}: ${next}`);
        return lines.join(nl);
      }
      const m = lines[i].match(keyRe);
      if (norm(m[2]) !== norm(expected)) return null;
      if (next === null) lines.splice(i, 1);
      else lines[i] = m[1] + next + m[3];
      return lines.join(nl);
    }
  }
  if (norm(expected) !== null) return null;
  if (next === null) return text;
  return `---${nl}${key}: ${next}${nl}---${nl}` + text;
}

/** 프로젝트 상태 바꾸기 */
export function editStatus(text, expected, next) {
  return STATUSES.includes(next) ? editFrontmatter(text, "status", expected, next) : null;
}

/** 프로젝트 마감일 바꾸기. next 가 null 이면 마감일을 지운다 */
export function editDue(text, expected, next) {
  return next === null || RE_DATE.test(next) ? editFrontmatter(text, "due", expected, next) : null;
}

/** 할 일 줄 고치기. kind: "done" | "keep"(#확인 떼기). 고칠 수 없으면 null */
export function editLine(raw, kind, today) {
  if (kind === "done") {
    if (!/^[-*] \[ \]/.test(raw)) return null;
    return raw.replace(/^([-*] )\[ \]/, "$1[x]").replace(/\s*$/, "") + ` ✅ ${today}`;
  }
  if (kind === "keep") {
    if (!RE_CHECK_TAG.test(raw)) return null;
    return raw.replace(/\s*#확인(?![\p{L}\p{N}_])/gu, "").replace(/\s+$/, "");
  }
  return null;
}
