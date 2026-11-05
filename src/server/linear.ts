// A small Linear GraphQL client: find a project, and list its issues with one label. The key goes in one header and
// nowhere else: every error this throws is cleaned of it, so it can be shown, stored and logged.
// HUD_LINEAR_API_URL points it elsewhere (a fake in tests).

export const LINEAR_API = "https://api.linear.app/graphql";
const TIMEOUT_MS = 20_000;
const PAGE = 100;
const MAX_PAGES = 20;

export type Project = { id: string; name: string; url: string };
export type StateType = "backlog" | "unstarted" | "started" | "completed" | "canceled" | "triage";
export type Issue = {
  key: string;
  title: string;
  state: string;
  stateType: StateType;
  url: string;
  updatedAt: number;
  milestone: { id: string; name: string; sortOrder: number } | null;
};

// Linear's own words for what went wrong, without the key; "project not found" when the project is not there.
export class LinearError extends Error {}
export const NOT_FOUND = "project not found";

const PROJECT = "id name url";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What a REF names: a project URL (linear.app/WORKSPACE/project/NAME-SLUGID/...), its slugId (or the NAME-SLUGID part
// of the URL), the project's id, or else its exact name.
export function parseProjectRef(raw: string): { by: "id" | "slugId" | "name"; value: string } {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("give a Linear project: its URL, its slugId or its exact name");
  const url = s.match(/linear\.app\/[^/\s]+\/project\/([^/?#\s]+)/i);
  if (!url && /^https?:\/\//i.test(s)) throw new Error(`not a Linear project URL: ${s}`);
  const slug = url ? url[1] : s;
  if (UUID.test(slug)) return { by: "id", value: slug.toLowerCase() };
  const tail = slug.match(/(?:^|-)([0-9a-f]{12})$/i);
  if (tail && /^[a-z0-9-]+$/i.test(slug)) return { by: "slugId", value: tail[1].toLowerCase() };
  if (url) throw new Error(`not a Linear project URL: ${s}`);
  return { by: "name", value: s };
}

export function createLinear(opts: { key: string; url?: string; timeoutMs?: number }) {
  const { key } = opts;
  const url = opts.url || LINEAR_API;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  // Every message that leaves here: the key cut out, one line, short.
  const clean = (msg: string) => (key ? msg.split(key).join("[key]") : msg).replace(/\s+/g, " ").trim().slice(0, 160);

  async function gql(query: string, variables: Record<string, unknown>) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      throw new LinearError(`Linear: ${err.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : clean(err.message)}`);
    }
    const body = (await res.json().catch(() => null)) as { data?: any; errors?: { message?: string; extensions?: { userPresentableMessage?: string } }[] } | null;
    const first = body?.errors?.[0];
    if (first) {
      const msg = first.extensions?.userPresentableMessage || first.message || "error";
      if (/entity not found/i.test(msg)) throw new LinearError(NOT_FOUND);
      throw new LinearError(`Linear: ${clean(msg)}`);
    }
    if (!res.ok || !body?.data) throw new LinearError(`Linear: HTTP ${res.status}`);
    return body.data;
  }

  // One project from a REF (see parseProjectRef). Two projects of that exact name is an error, not a guess.
  async function project(ref: string): Promise<Project> {
    const { by, value } = parseProjectRef(ref);
    if (by === "id") {
      const d = await gql(`query ProjectById($id: String!) { project(id: $id) { ${PROJECT} } }`, { id: value });
      if (!d.project) throw new LinearError(NOT_FOUND);
      return pick(d.project);
    }
    const filter = by === "slugId" ? "{ slugId: { eq: $value } }" : "{ name: { eq: $value } }";
    const d = await gql(`query ProjectBy${by === "slugId" ? "SlugId" : "Name"}($value: String!) { projects(first: 2, filter: ${filter}) { nodes { ${PROJECT} } } }`, { value });
    const nodes = d.projects?.nodes ?? [];
    if (!nodes.length) throw new LinearError(NOT_FOUND);
    if (nodes.length > 1) throw new LinearError(`more than one Linear project is named ${value}: link it by its URL`);
    return pick(nodes[0]);
  }

  // Every issue of a project with the label (any case), with its state, milestone, url and last change.
  async function issues(projectId: string, label: string): Promise<{ project: Project; issues: Issue[] }> {
    const query = `query AcceptanceIssues($id: String!, $label: String!, $first: Int!, $after: String) {
  project(id: $id) {
    ${PROJECT}
    issues(first: $first, after: $after, filter: { labels: { some: { name: { eqIgnoreCase: $label } } } }) {
      nodes { identifier title url updatedAt state { name type } projectMilestone { id name sortOrder } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
    const out: Issue[] = [];
    let after: string | null = null;
    let found: Project | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await gql(query, { id: projectId, label, first: PAGE, after });
      if (!d.project) throw new LinearError(NOT_FOUND);
      found ??= pick(d.project);
      const conn = d.project.issues ?? { nodes: [], pageInfo: {} };
      for (const n of conn.nodes ?? []) {
        const m = n.projectMilestone;
        out.push({
          key: String(n.identifier),
          title: String(n.title ?? ""),
          state: String(n.state?.name ?? ""),
          stateType: String(n.state?.type ?? "") as StateType,
          url: String(n.url ?? ""),
          updatedAt: Date.parse(n.updatedAt) || 0,
          milestone: m ? { id: String(m.id), name: String(m.name ?? ""), sortOrder: Number(m.sortOrder) || 0 } : null,
        });
      }
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
    }
    return { project: found!, issues: out };
  }

  return { project, issues };
}

const pick = (p: any): Project => ({ id: String(p.id), name: String(p.name ?? ""), url: String(p.url ?? "") });
