import { useEffect, useState } from "preact/hooks";
import { activitySchema, api, type Operation } from "./api.js";
import type { ManagementData } from "./session.js";
import type { RunAction } from "./pages.js";
import { stateLabels } from "./components.js";

type Filters = { device_id: string; grant_id: string; tool: string; offset: number };
export function ActivityPage({
  data,
  deviceId,
  refresh,
  run,
}: {
  data: ManagementData;
  deviceId?: string;
  refresh: () => Promise<void>;
  run: RunAction;
}) {
  const [filters, setFilters] = useState<Filters>({ device_id: "", grant_id: "", tool: "", offset: 0 });
  const [result, setResult] = useState<{
    key: string;
    operations: Operation[];
    total: number;
    tools: string[];
  }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const params = new URLSearchParams({ offset: String(filters.offset) });
  if (deviceId || filters.device_id) params.set("device_id", deviceId || filters.device_id);
  if (filters.grant_id) params.set("grant_id", filters.grant_id);
  if (filters.tool) params.set("tool", filters.tool);
  const key = params.toString();
  useEffect(() => {
    let active = true;
    void api(`/api/activity?${key}`, activitySchema)
      .then((loaded) => {
        if (!active) return;
        if (filters.offset > 0 && filters.offset >= loaded.total) {
          setFilters((current) => ({ ...current, offset: 0 }));
          return;
        }
        setResult({ key, ...loaded });
        setFailure(undefined);
      })
      .catch((error: unknown) => {
        if (active) setFailure({ key, message: error instanceof Error ? error.message : "记录加载失败" });
      });
    return () => {
      active = false;
    };
  }, [key, data, filters.offset]);
  const update = (field: "device_id" | "grant_id" | "tool", value: string) => {
    setFailure(undefined);
    setFilters((current) => ({ ...current, [field]: value, offset: 0 }));
  };
  const current = result?.key === key ? result : undefined;
  const error = failure?.key === key ? failure.message : undefined;
  const filtered = Boolean((!deviceId && filters.device_id) || filters.grant_id || filters.tool);
  return (
    <>
      <div class="page-title">
        {deviceId ? <h2>执行记录</h2> : <h1>操作记录</h1>}
        <button onClick={() => run(refresh)}>刷新</button>
      </div>
      <div class="activity-filters" role="group" aria-label="筛选操作记录">
        {!deviceId && (
          <div class="field">
            <label>
              设备
              <select
                value={filters.device_id}
                onChange={(event) => update("device_id", event.currentTarget.value)}
              >
                <option value="">全部设备</option>
                {data.devices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                    {device.status === "revoked" ? "（已解绑）" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div class="field">
          <label>
            Agent
            <select
              value={filters.grant_id}
              onChange={(event) => update("grant_id", event.currentTarget.value)}
            >
              <option value="">全部 Agent</option>
              {data.grants.map((grant) => (
                <option key={grant.id} value={grant.id}>
                  {grant.name}
                  {grant.revoked_at !== null ? "（已撤销）" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div class="field">
          <label>
            操作类型
            <select value={filters.tool} onChange={(event) => update("tool", event.currentTarget.value)}>
              <option value="">全部操作类型</option>
              {[...new Set([...(result?.tools ?? []), ...(filters.tool ? [filters.tool] : [])])]
                .sort()
                .map((tool) => (
                  <option key={tool} value={tool}>
                    {tool}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {filtered && (
          <button
            class="text-button"
            onClick={() => {
              setFailure(undefined);
              setFilters({ device_id: "", grant_id: "", tool: "", offset: 0 });
            }}
          >
            清除筛选
          </button>
        )}
      </div>
      <section
        class="surface table-wrap"
        aria-label={deviceId ? "设备执行记录" : "操作记录"}
        aria-busy={!current && !error}
      >
        {error ? (
          <div class="empty">
            <p role="alert">{error}</p>
            <button onClick={() => run(refresh)}>重试</button>
          </div>
        ) : !current ? (
          <div class="empty" role="status">
            <p>正在加载记录…</p>
          </div>
        ) : current.operations.length ? (
          <>
            <table class="record-list">
              <thead>
                <tr>
                  <th>操作</th>
                  {!deviceId && <th>设备</th>}
                  <th>Agent</th>
                  <th>结果</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {current.operations.map((operation) => {
                  const device = data.devices.find((entry) => entry.id === operation.device_id);
                  return (
                    <tr key={operation.id}>
                      <td>
                        <code>{operation.tool}</code>
                      </td>
                      {!deviceId && (
                        <td>
                          {device && device.status !== "revoked" ? (
                            <a href={`#devices/${encodeURIComponent(device.id)}`}>{device.name}</a>
                          ) : (
                            (device?.name ?? "已解绑设备")
                          )}
                        </td>
                      )}
                      <td>{data.grants.find((grant) => grant.id === operation.grant_id)?.name ?? "Agent"}</td>
                      <td class={`state ${operation.status}`}>
                        {stateLabels[operation.status] ?? operation.status}
                      </td>
                      <td class="record-time">
                        {new Date(operation.created_at * 1000).toLocaleString("zh-CN")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div class="record-pagination">
              <span class="small muted" role="status">
                {filters.offset + 1}–{filters.offset + current.operations.length} / {current.total} 条
              </span>
              <div class="actions">
                <button
                  disabled={filters.offset === 0}
                  onClick={() =>
                    setFilters((value) => ({ ...value, offset: Math.max(0, value.offset - 50) }))
                  }
                >
                  上一页
                </button>
                <button
                  disabled={filters.offset + current.operations.length >= current.total}
                  onClick={() => setFilters((value) => ({ ...value, offset: value.offset + 50 }))}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        ) : (
          <div class="empty">
            <p>{filtered ? "没有符合筛选条件的记录" : "暂无操作记录"}</p>
          </div>
        )}
      </section>
    </>
  );
}
