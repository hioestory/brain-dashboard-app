// 오늘 탭 칸 나누기 (2026-10-20 결정). 브라우저와 node(tests/today.mjs) 양쪽에서 쓴다.
// 열린 할 일은 네 칸 중 정확히 한 칸에만 들어간다.

export const INACTIVE = new Set(["보류", "종료"]);
export const SOON_DAYS = 7; // 기한 임박 칸에서 강조하는 범위 (그 뒤는 구분선 아래 흐리게)
export const COLUMNS = [
  { key: "late", label: "기한 지남" },
  { key: "soon", label: "기한 임박" },
  { key: "nodue", label: "기한 없음" },
  { key: "tidy", label: "정리 필요" },
];

/** 오늘 탭 대상: 열린 할 일. 보류·종료 프로젝트 것은 빼되 #확인 줄은 남긴다 */
export function todayTargets(todos, statusOf) {
  return todos.filter(t => !t.done && (t.check || !INACTIVE.has(statusOf.get(`${t.repo}:${t.file}`))));
}

/** 할 일 한 줄이 들어갈 칸. 기한이 있으면 #확인이 붙어도 기한 칸으로 간다 */
export function columnOf(t, today) {
  if (t.due) return t.due < today ? "late" : "soon";
  return t.check ? "tidy" : "nodue";
}
