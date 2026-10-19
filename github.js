// GitHub API: 레포 파일 읽기(블롭 캐시 포함)·한 줄 고쳐 커밋하기.
// 토큰은 호출할 때만 헤더에 넣고, 이 파일 밖으로 내보내지 않는다.

const CONCURRENCY = 8;

export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── base64 ↔ UTF-8 ──────────────────────────────────
export function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
export function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ── 블롭 캐시 (IndexedDB). 블롭 sha 는 내용이 같으면 같으므로 그대로 재사용한다 ──
const DB_NAME = "brain-dashboard", STORE = "blobs";
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  return dbPromise;
}
async function cacheGet(sha) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise(resolve => {
    try {
      const req = db.transaction(STORE).objectStore(STORE).get(sha);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch (e) { resolve(undefined); }
  });
}
async function cachePut(sha, text) {
  const db = await openDb();
  if (!db) return;
  try { db.transaction(STORE, "readwrite").objectStore(STORE).put(text, sha); } catch (e) {}
}
export async function clearCache() {
  const db = await openDb();
  if (!db) return;
  try { db.transaction(STORE, "readwrite").objectStore(STORE).clear(); } catch (e) {}
}

// ── API 클라이언트 ─────────────────────────────────
export class GitHub {
  constructor({ token, apiBase = "https://api.github.com" }) {
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, "");
  }

  async request(path, { method = "GET", body } = {}) {
    const res = await fetch(this.apiBase + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch (e) {}
      throw new GitHubError(res.status, msg);
    }
    return res.status === 204 ? null : res.json();
  }

  repoPath(repo) { return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`; }
  contentsPath(repo, file) { return `${this.repoPath(repo)}/contents/${file.split("/").map(encodeURIComponent).join("/")}`; }

  /** 기본 브랜치의 전체 파일 목록 [{path, sha}] */
  async listFiles(repo) {
    const info = await this.request(this.repoPath(repo));
    repo.branch = info.default_branch;
    const tree = await this.request(`${this.repoPath(repo)}/git/trees/${encodeURIComponent(repo.branch)}?recursive=1`);
    if (tree.truncated) console.warn("파일 목록이 잘렸습니다", repo.name);
    return tree.tree.filter(e => e.type === "blob").map(e => ({ path: e.path, sha: e.sha }));
  }

  async readBlob(repo, sha) {
    const cached = await cacheGet(sha);
    if (cached !== undefined) return cached;
    const blob = await this.request(`${this.repoPath(repo)}/git/blobs/${sha}`);
    const text = decodeBase64(blob.content);
    cachePut(sha, text);
    return text;
  }

  /** 여러 블롭을 동시에 읽는다. onProgress(완료 수) */
  async readBlobs(repo, entries, onProgress) {
    const out = new Array(entries.length);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < entries.length) {
        const i = next++;
        out[i] = await this.readBlob(repo, entries[i].sha);
        onProgress && onProgress(++done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
    return out;
  }

  /** 파일별 마지막 커밋 날짜(YYYY-MM-DD). GraphQL 한 번으로 묻는다 */
  async lastCommitDates(repo, paths) {
    if (!paths.length) return {};
    const fields = paths.map((p, i) =>
      `f${i}: history(first: 1, path: ${JSON.stringify(p)}) { nodes { committedDate } }`).join("\n");
    const query = `query { repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) {
      ref(qualifiedName: ${JSON.stringify("refs/heads/" + repo.branch)}) { target { ... on Commit { ${fields} } } } } }`;
    const res = await this.request("/graphql", { method: "POST", body: { query } });
    if (res.errors) throw new GitHubError(400, res.errors[0].message);
    const target = res.data?.repository?.ref?.target || {};
    const out = {};
    paths.forEach((p, i) => {
      const d = target[`f${i}`]?.nodes?.[0]?.committedDate;
      if (d) out[p] = toLocalDate(d);
    });
    return out;
  }

  /** 파일 최신본 { text, sha } */
  async readFile(repo, file) {
    const res = await this.request(`${this.contentsPath(repo, file)}?ref=${encodeURIComponent(repo.branch)}`);
    return { text: decodeBase64(res.content), sha: res.sha };
  }

  /** 파일 전체를 바꿔 커밋. sha 가 다르면(그사이 바뀜) 409 */
  async writeFile(repo, file, text, sha, message) {
    const res = await this.request(this.contentsPath(repo, file), {
      method: "PUT",
      body: { message, content: encodeBase64(text), sha, branch: repo.branch },
    });
    return { sha: res.content.sha, commit: res.commit.sha };
  }
}

function toLocalDate(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
