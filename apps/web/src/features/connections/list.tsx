import { ChevronRight, Plus, Search } from "lucide-preact";
import { useState } from "preact/hooks";
import type { Device, Grant } from "../../lib/api.js";
import { Select } from "../../components/forms.js";
import { connectionCapabilities } from "./policy.js";

export function GrantsPage({
  grants,
  devices,
  create,
}: {
  grants: Grant[];
  devices: Device[];
  create: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("active");
  const owned = devices.filter((device) => device.status !== "revoked");
  const filtered = grants.filter(
    (grant) =>
      (filter === "all" || (filter === "revoked" ? grant.revoked_at !== null : grant.revoked_at === null)) &&
      grant.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <>
      <div class="page-title">
        <div>
          <h1>Agent 连接</h1>
        </div>
        <button class="primary" onClick={create}>
          <Plus aria-hidden="true" />
          连接 Agent
        </button>
      </div>
      {grants.length > 0 && (
        <div class="device-toolbar">
          <label class="device-search">
            <span class="sr-only">搜索连接</span>
            <Search aria-hidden="true" />
            <input
              type="search"
              placeholder="搜索连接名称…"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <Select
            aria-label="连接状态"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          >
            <option value="active">未撤销连接</option>
            <option value="all">全部连接</option>
            <option value="revoked">已撤销连接</option>
          </Select>
        </div>
      )}
      <section class="surface" aria-label="Agent 连接列表">
        {filtered.length ? (
          <>
            <div class="list-heading grant-list-heading">
              <span>连接名称</span>
              <span>设备范围</span>
              <span>有效期</span>
              <span />
            </div>
            {filtered.map((grant) => {
              const permitted = owned.filter((device) => connectionCapabilities(grant, device).length > 0);
              const expired = grant.expires_at !== null && grant.expires_at <= Date.now() / 1000;
              return (
                <a
                  class="grant-link-row"
                  href={`#grants/${encodeURIComponent(grant.id)}`}
                  key={grant.id}
                  data-connection-id={grant.id}
                >
                  <div>
                    <span class="name">{grant.name}</span>
                    <div class="device-meta">
                      <span class={`dot ${grant.revoked_at !== null || expired ? "offline" : "online"}`} />
                      {grant.revoked_at !== null ? "已撤销" : expired ? "已到期" : "有效"}
                      <span>/</span>
                      {grant.authentication === "platform" ? "平台授权" : "Agent Key"}
                    </div>
                  </div>
                  <div>
                    <span>
                      {grant.policy.mode === "all"
                        ? "全部设备（含新设备）"
                        : `${permitted.length} 台指定设备`}
                    </span>
                    <p class="small muted truncate">
                      {permitted.map((device) => device.name).join("、") || "暂无已授权设备"}
                    </p>
                  </div>
                  <span class="small muted">
                    {grant.expires_at
                      ? new Date(grant.expires_at * 1000).toLocaleDateString("zh-CN")
                      : "直到撤销"}
                  </span>
                  <ChevronRight aria-hidden="true" />
                </a>
              );
            })}
          </>
        ) : (
          <div class="empty">
            <div>
              <h2>{grants.length ? "没有符合条件的连接" : "暂无 Agent 连接"}</h2>
            </div>
            {grants.length ? (
              <button
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                清除筛选
              </button>
            ) : (
              <button class="primary" onClick={create}>
                连接 Agent
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
