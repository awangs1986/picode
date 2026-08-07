import type { AccountsManager } from "../store/index.ts";

/**
 * /accounts 命令处理器（PICODE-V3-DESIGN.md §3.1）：
 * 列出、切换活跃、打标签、发起 OAuth 登录。
 * 纯逻辑；pi 命令注册与交互提示已在 Adapter Extension 组合根接入。
 */

export async function handleAccountsCommand(
  accounts: AccountsManager,
  argv: string[],
): Promise<string> {
  const [verb, ...rest] = argv;

  switch (verb) {
    case undefined:
    case "list": {
      const list = accounts.list();
      if (!list.ok) return `error: ${list.error.message}`;
      if (list.value.length === 0) {
        return "no accounts. use `/accounts login <provider>` to add one";
      }
      return list.value
        .map((a) => {
          const marker = a.status === "active" ? "*" : " ";
          return `${marker} ${a.id}  [${a.provider}] ${a.label} (${a.status})`;
        })
        .join("\n");
    }

    case "use": {
      const id = rest[0];
      if (id === undefined) return "usage: /accounts use <account-id>";
      const switched = await accounts.setActive(id);
      if (!switched.ok) return `error: ${switched.error.message}`;
      return (
        `active account for ${switched.value.provider}: ${switched.value.label}\n` +
        `context unchanged; new execution epoch started (cache epoch reset)`
      );
    }

    case "label": {
      const [id, ...labelParts] = rest;
      const label = labelParts.join(" ");
      if (id === undefined || label === "") return "usage: /accounts label <account-id> <label>";
      const relabeled = await accounts.relabel(id, label);
      return relabeled.ok ? `labeled ${id}: ${label}` : `error: ${relabeled.error.message}`;
    }

    case "login":
      // OAuth 流实现按 Provider 注入（P1 作者实装；此处只报可用性）
      return "login flows are wired per provider at composition time (see OAuthFlow seam)";

    default:
      return `unknown verb "${verb}" (list | use | label | login)`;
  }
}
