// 태스크·프로젝트 검색. 브라우저와 node(tests/search.mjs) 양쪽에서 쓴다.
// 띄어쓰기로 나눈 낱말이 모두 들어 있으면 찾은 것으로 본다 (대소문자 무시).

const norm = s => String(s || "").normalize("NFC").toLowerCase();

export function terms(query) {
  return norm(query).split(/\s+/).filter(Boolean);
}

export function matches(ws, ...fields) {
  if (!ws.length) return false;
  const hay = norm(fields.join("\n"));
  return ws.every(w => hay.includes(w));
}

/** { projects, open, done } — 프로젝트는 제목·파일 경로·상태, 태스크는 원문 줄·프로젝트 제목·파일 경로로 찾는다 */
export function search(query, { areas, todos, titleOf }) {
  const ws = terms(query);
  const projects = areas.filter(a => matches(ws, a.title, a.file, a.status));
  const hits = todos.filter(t => matches(ws, t.raw, titleOf(t), t.file));
  return { projects, open: hits.filter(t => !t.done), done: hits.filter(t => t.done) };
}
