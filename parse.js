// 마크다운에서 할 일 줄·미분류·프론트매터를 읽는다. collect.py 와 같은 규칙.
// 브라우저와 node(대조 검사) 양쪽에서 쓴다.

export const EXCLUDE_DIRS = new Set([".git", ".claude", "log", "english", "node_modules"]);
export const EXCLUDE_FILES = new Set(["STATUS.md"]);
// 기록용 보관 폴더(레포 최상위) — 할 일을 수집하지 않는다
export const ARCHIVE_DIRS = { personal: new Set(["ideas", "learning", "parenting"]) };
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
  if (parts.slice(0, -1).some(p => EXCLUDE_DIRS.has(p))) return false;
  const archive = ARCHIVE_DIRS[repoKey];
  if (archive && parts.length > 1 && archive.has(parts[0])) return false;
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
