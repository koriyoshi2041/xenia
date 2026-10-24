import "./style.css";
import { createWalletClient, custom } from "viem";
import { toAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  postBond,
  type ReviewItem as Item,
  type NetworkSnapshot as Network,
  type CommunityQuote as Quote,
} from "@gfh/shared";

const root = document.querySelector<HTMLDivElement>("#app")!;
let network: Network | undefined,
  items: Item[] = [],
  admitted: Item[] = [],
  selected = "",
  view: "review" | "records" = "review",
  login = "",
  pricing: Quote | undefined,
  error = "",
  notice = "",
  busy = false,
  editing = false,
  loading = true;
let quoteTicket = 0;
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const short = (v: string) => `${v.slice(0, 8)}…${v.slice(-6)}`;
const repoUrl = (repo: string) =>
  `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}`;
const prUrl = (repo: string, num: number) => `${repoUrl(repo)}/pull/${num}`;
const queue = () => network?.queues.find((q) => q.id === selected);
const queueName = (id: string) =>
  network?.queues.find((q) => q.id === id)?.repo ?? short(id);
const isPublic = () => network?.runtime.mode === "base-sepolia";
const amount = (units: string) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 6 }).format(
    Number(units) / 1e6,
  );
const verdicts: Record<number, string> = {
  1: "已接受",
  2: "善意关闭",
  3: "部分认可",
  4: "垃圾提交",
  5: "已超时",
};
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const r = await fetch(path, options);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `请求未完成（${r.status}）`);
  return data;
}
const body = (data: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ),
});
function evidence(hash: string, kind: "tx" | "attestation", label: string) {
  const url =
    kind === "tx"
      ? `https://sepolia.basescan.org/tx/${hash}`
      : `https://base-sepolia.easscan.org/attestation/view/${hash}`;
  return isPublic()
    ? `<a href="${url}" target="_blank" rel="noreferrer">${esc(label)} ↗</a>`
    : `<span title="${esc(hash)}">${esc(label)} · ${esc(short(hash))}</span>`;
}
function graph() {
  const nodes = network!.queues;
  const width = Math.max(320, Math.min(1000, root.clientWidth - 40)),
    columns = Math.min(nodes.length, width < 600 ? 2 : 4),
    height = Math.ceil(nodes.length / columns) * 120 + 30;
  const positions = new Map(
    nodes.map((q, i) => [
      q.id,
      {
        x:
          columns === 1
            ? width / 2
            : 80 + ((i % columns) * (width - 160)) / (columns - 1),
        y: 45 + Math.floor(i / columns) * 120,
      },
    ]),
  );
  const paths = new Set(
    (pricing?.recognized ?? []).flatMap((r) =>
      (r.path ?? []).slice(1).map((id, i) => `${r.path![i]}:${id}`),
    ),
  );
  const edges = nodes
    .flatMap((q) =>
      q.trusts
        .filter((e) => positions.has(e.queueId))
        .map((e) => {
          const a = positions.get(q.id)!,
            b = positions.get(e.queueId)!,
            dx = b.x - a.x,
            dy = b.y - a.y,
            len = Math.hypot(dx, dy) || 1;
          return `<g><path class="edge ${paths.has(`${q.id}:${e.queueId}`) ? "recognized" : ""}" d="M${a.x + (dx / len) * 10},${a.y + (dy / len) * 10} L${b.x - (dx / len) * 13},${b.y - (dy / len) * 13}" marker-end="url(#arrow)"/><text class="edge-label" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 10}">${esc(e.weight)}</text></g>`;
        }),
    )
    .join("");
  return `<figure class="network"><svg viewBox="0 0 ${width} ${height}" role="group" aria-label="社区认可关系；箭头从认可方指向记录来源"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" fill="currentColor"/></marker></defs>${edges}${nodes
    .map((q) => {
      const p = positions.get(q.id)!,
        [owner, ...name] = q.repo.split("/");
      return `<g class="node ${q.id === selected ? "selected" : ""}" data-select="${q.id}" tabindex="0" role="button" aria-label="查看 ${esc(q.repo)}" aria-pressed="${q.id === selected}"><circle class="hit" cx="${p.x}" cy="${p.y}" r="24"/><circle cx="${p.x}" cy="${p.y}" r="5"/><text x="${p.x}" y="${p.y + 29}" class="repo-name">${esc(name.join("/"))}</text><text x="${p.x}" y="${p.y + 47}" class="owner-name">${esc(owner)}</text></g>`;
    })
    .join(
      "",
    )}</svg><figcaption>箭头指向被认可的社区。选择一个社区，查看它的准入规则。</figcaption></figure>`;
}
function policy() {
  const q = queue()!;
  return `<section class="policy"><div class="section-line"><h2>这个社区怎样认可贡献</h2><button data-action="edit-policy">${editing ? "收起" : "编辑认可关系"}</button></div><p class="policy-sentence">基础押金 <strong>${q.policy.baseBond} USDC</strong><span>·</span>认可记录达到 <strong>${q.policy.exemptMinRecords}</strong> 后免押<span>·</span>审阅期限 ${q.reviewWindow / 86400} 天</p><p class="muted small">裁决者 <a href="https://sepolia.basescan.org/address/${q.adjudicator}" target="_blank" rel="noreferrer">${short(q.adjudicator)}</a> · 政策版本 ${q.policyRevision ?? 0}</p>${
    editing
      ? `<form id="policy-form"><fieldset><legend>采纳哪些社区的贡献记录</legend>${
          network!.queues
            .filter((n) => n.id !== q.id)
            .map((n) => {
              const edge = q.trusts.find((e) => e.queueId === n.id);
              return `<label class="trust-choice"><input type="checkbox" name="trust" value="${n.id}" ${edge ? "checked" : ""}/><span>${esc(n.repo)}</span><span class="weight-label">权重</span><input aria-label="${esc(n.repo)} 的权重" type="number" name="weight-${n.id}" min="0" max="1" step="0.1" value="${edge?.weight ?? 1}"/></label>`;
            })
            .join("") || '<p class="muted">接入第二个社区后可设置认可关系。</p>'
        }</fieldset><div class="pricing-fields"><label>基础押金（USDC）<input type="number" name="baseBond" value="${q.policy.baseBond}" min="0" step="0.01" required/></label><label>免押所需记录<input type="number" name="exemptMinRecords" value="${q.policy.exemptMinRecords}" min="1" step="0.5" required/></label></div><button type="submit" ${busy ? "disabled" : ""}>用该社区的钱包签署变更 →</button><p class="muted small">签名确认认可规则；已有贡献证明保持原样。</p></form>`
      : ""
  }</section>`;
}
function quotePanel() {
  return `<section class="quote"><form id="quote-form"><label for="login">查询贡献者</label><div class="input-row"><input id="login" name="login" value="${esc(login)}" placeholder="GitHub 用户名" autocomplete="off" required/><button type="submit" ${busy ? "disabled" : ""}>查看准入条件 →</button></div></form>${pricing ? `<div class="quote-result"><p class="quote-answer">${pricing.exempt ? "这位贡献者可以免押进入审阅。" : `本次需要 <strong>${pricing.amount} USDC</strong> 可退押金。`}</p><details open><summary>为什么是这个报价</summary><ul class="reasons">${pricing.reasons.map((r) => `<li>${esc(r.detail)}</li>`).join("")}</ul>${pricing.recognized.length ? `<div class="paths">${pricing.recognized.map((r) => `<p>${(r.path ?? []).map((id) => esc(queueName(id))).join(" → ")}<span>权重 ${r.weight}</span><br/>${evidence(r.uid, "attestation", `贡献 #${r.itemNumber} · ${verdicts[r.verdict] ?? "已记录"}`)}</p>`).join("")}</div>` : ""}${pricing.historical.length ? `<p class="muted small">另有 GitHub 合并记录：${pricing.historical.map((r) => `<a href="${prUrl(r.repo, r.number)}" target="_blank" rel="noreferrer">${esc(r.repo)} #${r.number}</a>`).join("、")}</p>` : ""}</details></div>` : ""}</section>`;
}
function itemRow(i: Item, pay = false) {
  return `<article class="review-row"><div class="item-heading"><a href="${prUrl(i.pr.repo, i.pr.number)}" target="_blank" rel="noreferrer">${esc(i.pr.title ?? `Pull request #${i.pr.number}`)} <span>↗</span></a><span class="item-number">#${i.pr.number}</span></div><p class="item-meta">@${esc(i.pr.authorLogin)}<span>·</span>${i.quote.exempt ? "依据社区规则免押" : `${i.quote.amount} USDC ${i.state === "AWAITING_BOND" ? "待授权" : "押金已确认"}`}</p><details id="proof-${i.queueId}-${i.pr.number}"><summary>准入依据与凭证</summary><ul class="reasons">${i.quote.reasons.map((r) => `<li>${esc(r.detail)}</li>`).join("")}</ul><p class="evidence">${i.txPost ? evidence(i.txPost, "tx", "托管交易") : ""} ${i.txResolve ? evidence(i.txResolve, "tx", "结算交易") : ""} ${i.attestation ? evidence(i.attestation, "attestation", "贡献证明") : ""}</p></details>${pay ? `<button class="pay-action" data-pay="${i.pr.number}" ${busy ? "disabled" : ""}>签署 ${i.quote.amount} USDC 可退押金 →</button>` : ""}</article>`;
}
function review() {
  const ready = admitted.filter((i) => i.queueId === selected);
  const waiting = items.filter(
    (i) =>
      i.queueId === selected &&
      i.state === "AWAITING_BOND" &&
      i.pr.state === "open",
  );
  return `<section class="review"><div class="section-line"><h2>待审阅</h2><button data-action="refresh">刷新</button></div><p class="muted small">已获准且仍开放的 PR。点击标题，在 GitHub 审阅和合并。</p>${ready.map((i) => itemRow(i)).join("") || '<p class="empty-line">当前没有等待审阅的贡献。</p>'}${waiting.length ? `<details class="waiting" id="waiting-contributions"><summary>尚待准入的提交 · ${waiting.length}</summary>${waiting.map((i) => itemRow(i, true)).join("")}</details>` : ""}<details class="sync" id="sync-existing"><summary>同步一个已有 PR</summary><form id="sync-form"><label for="pr-number">${esc(queue()!.repo)} 的 PR 编号</label><div class="input-row"><input id="pr-number" type="number" name="number" min="1" required/><button type="submit" ${busy ? "disabled" : ""}>从 GitHub 同步 →</button></div></form></details></section>`;
}
function records() {
  const facts = network!.records.filter((r) => r.queueId === selected);
  return `<section class="records"><h2>已留下的贡献记录</h2>${facts.map((r) => {
    const current = items.find((i) => i.queueId === r.queueId && i.pr.number === r.itemNumber);
    const item = [current, ...(current?.previousRounds ?? [])].find((i) => i?.attestation === r.uid);
    return `<article class="record-row"><div><a href="${prUrl(queueName(r.queueId), r.itemNumber)}" target="_blank" rel="noreferrer">${esc(queueName(r.queueId))} #${r.itemNumber} ↗</a><p class="muted small">${item ? `@${esc(item.pr.authorLogin)}` : `GitHub ID ${r.githubUserId}`}${r.recordedAt ? ` · ${new Date(r.recordedAt * 1000).toLocaleDateString("zh-CN")}` : ""}</p></div><div class="record-outcome"><span>${verdicts[r.verdict] ?? "已记录"}</span><p class="muted small">${Number(r.bondAmount) === 0 ? "免押贡献" : Number(r.slashedAmount) > 0 ? `${amount(r.slashedAmount)} USDC 进入公共池` : `${amount(r.bondAmount)} USDC 已退回`}</p></div><p class="evidence">${evidence(r.uid, "attestation", "EAS 证明")} ${evidence(r.txHash, "tx", "结算交易")}</p>${item ? `<details class="record-proof" id="record-proof-${r.uid}"><summary>提交时的报价与凭证</summary><p class="small">${esc(item.pr.title ?? `Pull request #${r.itemNumber}`)} · ${item.quote.exempt ? "免押" : `${item.quote.amount.toFixed(2)} USDC 可退押金`}</p><ul class="reasons">${item.quote.reasons.map((reason) => `<li>${esc(reason.detail)}</li>`).join("")}</ul>${item.txPost ? `<p class="evidence">${evidence(item.txPost, "tx", "托管交易")}</p>` : ""}</details>` : ""}</article>`;
  }).join("") || '<p class="empty-line">这个社区尚未发布贡献证明。接受或关闭已获准的 PR 后，记录会出现在这里。</p>'}</section>`;
}
function render() {
  const focus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.id
      : "";
  const open = Array.from(
    root.querySelectorAll<HTMLDetailsElement>("details[open][id]"),
  ).map((d) => d.id);
  const mode =
    network?.runtime.mode === "base-sepolia"
      ? "Base Sepolia"
      : network?.runtime.mode === "base-sepolia-fork"
        ? "Base Sepolia · 本地分叉"
        : "待接入";
  root.innerHTML = `<a class="skip-link" href="#main">跳到内容</a><header><a href="/" class="wordmark">Xenia<span>.</span></a><span class="connection">${mode}</span></header><main id="main"><div class="message error" role="alert" ${error ? "" : "hidden"}>${esc(error)}</div><div class="message notice" role="status" ${notice ? "" : "hidden"}>${esc(notice)}</div>${loading ? '<p class="empty-line">正在读取社区与贡献记录…</p>' : !network ? '<section class="empty-state"><h1>服务暂时未连接</h1><p>连接恢复后，这里会显示真实的审阅队列。</p><button data-action="refresh">重新连接 →</button></section>' : !network.queues.length ? `<section class="empty-state"><p class="eyebrow">贡献网络</p><h1>从第一个社区开始。</h1><p>接入仓库后，在这里查看待审 PR、贡献记录，以及社区之间的认可关系。</p>${network.runtime.requirements?.length ? `<p class="muted">待完成：${network.runtime.requirements.map(esc).join("、")}。</p>` : ""}<a href="https://github.com/koriyoshi2041/xenia/blob/main/.env.example" target="_blank" rel="noreferrer">查看配置示例 ↗</a></section>` : `<div class="workspace-heading"><div><p class="eyebrow">社区</p><h1>${esc(queue()?.repo)}</h1></div><label class="community-picker"><span class="sr-only">切换社区</span><select id="community">${network.queues.map((q) => `<option value="${q.id}" ${q.id === selected ? "selected" : ""}>${esc(q.repo)}</option>`).join("")}</select></label></div>${graph()}<nav aria-label="社区内容"><button data-view="review" ${view === "review" ? 'aria-current="page"' : ""}>审阅队列</button><button data-view="records" ${view === "records" ? 'aria-current="page"' : ""}>贡献记录</button></nav>${view === "review" ? `<div class="workspace">${review()}<aside>${quotePanel()}${policy()}</aside></div>` : records()}`}</main><footer><span>贡献留下历史，社区各自判断。</span><a href="https://github.com/koriyoshi2041/xenia" target="_blank" rel="noreferrer">项目与协议 ↗</a></footer>`;
  for (const id of open) {
    const d = document.getElementById(id);
    if (d instanceof HTMLDetailsElement) d.open = true;
  }
  if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
}
async function refresh() {
  const previous = JSON.stringify([network, admitted, items]);
  const previousPolicy = JSON.stringify(network);
  let shouldRender = loading || Boolean(error);
  try {
    const next = await api<Network>("/api/network");
    network = next;
    if (!next.queues.some((q) => q.id === selected)) {
      selected = next.queues[0]?.id ?? "";
      pricing = undefined;
    }
    if (next.queues.length) {
      const [r, c] = await Promise.all([
        api<{ items: Item[] }>("/api/review-queue"),
        api<{ items: Item[] }>("/api/contributions"),
      ]);
      admitted = r.items;
      items = c.items;
    } else {
      admitted = [];
      items = [];
    }
    error = "";
    shouldRender ||= previous !== JSON.stringify([network, admitted, items]);
    if (login && pricing && previousPolicy !== JSON.stringify(network))
      await lookup();
  } catch (e) {
    error = (e as Error).message;
    shouldRender = true;
  } finally {
    loading = false;
    if (shouldRender) render();
  }
}
async function wallet() {
  const provider = (
    window as unknown as { ethereum?: Parameters<typeof custom>[0] }
  ).ethereum;
  if (!provider)
    throw new Error("请在安装了钱包的浏览器中打开此页面，再进行签名。");
  const client = createWalletClient({
    chain: baseSepolia,
    transport: custom(provider),
  });
  const [address] = await client.requestAddresses();
  if (!address) throw new Error("请选择一个钱包账户");
  await client.switchChain({ id: 84532 });
  return { client, address };
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  error = "";
  notice = "";
  render();
  try {
    await action();
  } catch (e) {
    error = (e as Error).message;
  } finally {
    busy = false;
    render();
  }
}
async function select(id: string) {
  selected = id;
  pricing = undefined;
  editing = false;
  quoteTicket++;
  render();
  if (login) await lookup();
}
async function lookup() {
  const ticket = ++quoteTicket;
  const target = queue();
  if (!target || !login) return;
  const result = await api<Quote>(
    `/api/quote?repo=${encodeURIComponent(target.repo)}&login=${encodeURIComponent(login)}`,
  );
  if (ticket === quoteTicket) {
    pricing = result;
    render();
  }
}
root.addEventListener("click", (e) => {
  const el = (e.target as Element).closest<HTMLElement>(
    "[data-select],[data-action],[data-view],[data-pay]",
  );
  if (!el || busy) return;
  if (el.dataset.select) void run(() => select(el.dataset.select!));
  if (el.dataset.view) {
    view = el.dataset.view as typeof view;
    render();
  }
  if (el.dataset.action === "refresh") void run(refresh);
  if (el.dataset.action === "edit-policy") {
    editing = !editing;
    render();
  }
  if (el.dataset.pay)
    void run(async () => {
      const q = queue()!,
        item = items.find(
          (i) => i.queueId === q.id && i.pr.number === Number(el.dataset.pay),
        )!;
      const { client, address } = await wallet();
      const account = toAccount({
        address,
        signMessage: async () => {
          throw new Error("Only typed payment signatures are used");
        },
        signTransaction: async () => {
          throw new Error("The relayer submits transactions");
        },
        signTypedData: (args) =>
          client.signTypedData({ ...args, account: address } as never),
      });
      await postBond({
        api: location.origin,
        repo: q.repo,
        number: item.pr.number,
        account,
        maxAmountUsdc: item.quote.amount,
      });
      await refresh();
      notice = "押金交易已确认，提交已进入审阅队列。";
    });
});
root.addEventListener("keydown", (e) => {
  if (
    (e.key === "Enter" || e.key === " ") &&
    (e.target as HTMLElement).dataset.select
  ) {
    e.preventDefault();
    void run(() => select((e.target as HTMLElement).dataset.select!));
  }
});
root.addEventListener("change", (e) => {
  if ((e.target as HTMLElement).id === "community")
    void run(() => select((e.target as HTMLSelectElement).value));
});
root.addEventListener("input", (e) => {
  if ((e.target as HTMLElement).id === "login")
    login = (e.target as HTMLInputElement).value.trim();
});
root.addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement,
    data = new FormData(form);
  if (form.id === "quote-form") void run(lookup);
  if (form.id === "sync-form")
    void run(async () => {
      await api(
        `/api/items/${queue()!.repo}/${Number(data.get("number"))}/sync`,
        { method: "POST" },
      );
      await refresh();
      notice = "已读取 GitHub 当前状态。";
    });
  if (form.id === "policy-form")
    void run(async () => {
      const q = queue()!;
      const changes = {
        trusts: data.getAll("trust").map((id) => ({
          queueId: String(id),
          weight: Number(data.get(`weight-${id}`)),
        })),
        policy: {
          ...q.policy,
          baseBond: Number(data.get("baseBond")),
          exemptMinRecords: Number(data.get("exemptMinRecords")),
        },
      };
      const challenge = await api<any>(`/api/queues/${q.id}/policy-challenge`, {
        method: "POST",
        ...body(changes),
      });
      const { client, address } = await wallet();
      if (address.toLowerCase() !== q.adjudicator.toLowerCase())
        throw new Error(`请使用社区裁决账户 ${short(q.adjudicator)} 签名。`);
      const signature = await client.signTypedData({
        ...challenge.typedData,
        account: address,
      } as never);
      await api(`/api/queues/${q.id}/policy`, {
        method: "PATCH",
        ...body({ ...challenge, signature }),
      });
      editing = false;
      await refresh();
      if (login) await lookup();
      notice = "认可规则已更新；贡献证明保持原样。";
    });
});
render();
void refresh();
setInterval(() => {
  if (!busy && !editing && document.activeElement?.tagName !== "INPUT")
    void refresh();
}, 15000);

window.addEventListener("resize", () => {
  if (!busy && !editing) render();
});
