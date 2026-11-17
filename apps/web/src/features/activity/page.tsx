import { RefreshCw } from "lucide-preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { activitySchema, api, type Operation } from "../../lib/api.js";
import type { ManagementData } from "../../lib/types.js";
import type { RunAction } from "../../lib/types.js";
import { ActionButton } from "../../components/actions.js";
import { Select } from "../../components/forms.js";
import { stateLabels } from "../../lib/labels.js";

type Filters = { device_id: string; grant_id: string; tool: string; offset: number };
export function ActivityPage({
  data,
  deviceId,
  grantId,
  refresh,
  run,
}: {
  data: ManagementData;
  deviceId?: string;
  grantId?: string;
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
  if (grantId || filters.grant_id) params.set("grant_id", grantId || filters.grant_id);
  if (filters.tool) params.set("tool", filters.tool);
  const key = params.toString();
  const alive = useRef(true);
  const currentKey = useRef(key);
  const currentData = useRef(data);
  currentKey.current = key;
  currentData.current = data;
  const request = useRef<{ key: string; promise: Promise<void> } | undefined>(undefined);
  const lastAttempt = useRef<{ key: string; data: ManagementData } | undefined>(undefined);
  const [pendingKey, setPendingKey] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const manualRefresh = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current = undefined;
    };
  }, []);
  const load = useCallback(
    (force = true): Promise<void> => {
      if (!alive.current || currentKey.current !== key) return Promise.resolve();
      if (!force && lastAttempt.current?.key === key && lastAttempt.current.data === currentData.current)
        return request.current?.key === key ? request.current.promise : Promise.resolve();
      lastAttempt.current = { key, data: currentData.current };
      // Session polling and a manual refresh share the same in-flight request.
      if (request.current?.key === key) return request.current.promise;
      setPendingKey(key);
      setFailure(undefined);
      const pending = api(`/api/activity?${key}`, activitySchema)
        .then((loaded) => {
          if (!alive.current || request.current?.promise !== pending || currentKey.current !== key) return;
          if (filters.offset > 0 && filters.offset >= loaded.total) {
            setFilters((current) => ({ ...current, offset: 0 }));
            return;
          }
          setResult({ key, ...loaded });
          setFailure(undefined);
        })
        .catch((error: unknown) => {
          if (alive.current && request.current?.promise === pending && currentKey.current === key)
            setFailure({ key, message: error instanceof Error ? error.message : "记录加载失败" });
        })
        .finally(() => {
          if (request.current?.promise !== pending) return;
          request.current = undefined;
          if (alive.current) setPendingKey(undefined);
        });
      request.current = { key, promise: pending };
      return pending;
    },
    [key, filters.offset],
  );
  const currentLoad = useRef(load);
  currentLoad.current = load;
  useEffect(() => {
    if (!manualRefresh.current) void load(false);
  }, [load, data]);
  const reload = async () => {
    if (manualRefresh.current) return;
    manualRefresh.current = true;
    setRefreshing(true);
    let identityReady = false;
    try {
      await refresh();
      identityReady = true;
      if (alive.current) await currentLoad.current();
    } catch (error) {
      if (alive.current)
        setFailure({
          key: currentKey.current,
          message: error instanceof Error ? error.message : "记录加载失败",
        });
      throw error;
    } finally {
      manualRefresh.current = false;
      // A filter/data change during the awaited request may have skipped its effect.
      if (alive.current && identityReady) await currentLoad.current(false);
      if (alive.current) setRefreshing(false);
    }
  };
  const update = (field: "device_id" | "grant_id" | "tool", value: string) => {
    setFailure(undefined);
    setFilters((current) => ({ ...current, [field]: value, offset: 0 }));
  };
  const current = result?.key === key ? result : undefined;
  const error = failure?.key === key ? failure.message : undefined;
  const pending = refreshing || pendingKey === key || (!current && !error);
  const paginationDisabled = pending || Boolean(error) || !current;
  const previousDisabled = paginationDisabled || filters.offset === 0;
  const nextDisabled =
    paginationDisabled || Boolean(current && filters.offset + current.operations.length >= current.total);
  const filtered = Boolean(
    (!deviceId && filters.device_id) || (!grantId && filters.grant_id) || filters.tool,
  );
  return (
    <>
      <div class="page-title">
        {deviceId || grantId ? <h2>操作记录</h2> : <h1>操作记录</h1>}
        <ActionButton
          icon={<RefreshCw aria-hidden="true" />}
          action={reload}
          run={run}
          busyLabel="刷新中…"
          disabled={pending}
        >
          {pending ? "刷新中…" : "刷新"}
        </ActionButton>
      </div>
      <div class="activity-filters" role="group" aria-label="筛选操作记录">
        {!deviceId && (
          <div class="field">
            <label>
              设备
              <Select
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
              </Select>
            </label>
          </div>
        )}
        {!grantId && (
          <div class="field">
            <label>
              Agent
              <Select
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
              </Select>
            </label>
          </div>
        )}
        <div class="field">
          <label>
            操作类型
            <Select value={filters.tool} onChange={(event) => update("tool", event.currentTarget.value)}>
              <option value="">全部操作类型</option>
              {[...new Set([...(result?.tools ?? []), ...(filters.tool ? [filters.tool] : [])])]
                .sort()
                .map((tool) => (
                  <option key={tool} value={tool}>
                    {tool}
                  </option>
                ))}
            </Select>
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
        aria-busy={pending}
      >
        {error ? (
          <div class="empty">
            <p role="alert">{error}</p>
            <ActionButton action={reload} run={run} busyLabel="重试中…" disabled={pending}>
              {pending ? "重试中…" : "重试"}
            </ActionButton>
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
                  {!grantId && <th>Agent</th>}
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
                      {!grantId && (
                        <td>
                          <a href={`#grants/${encodeURIComponent(operation.grant_id)}`}>
                            {data.grants.find((grant) => grant.id === operation.grant_id)?.name ??
                              "已撤销连接"}
                          </a>
                        </td>
                      )}
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
          </>
        ) : (
          <div class="empty">
            <p>{filtered ? "没有符合筛选条件的记录" : "暂无操作记录"}</p>
          </div>
        )}
        {result && (result.total > 50 || filters.offset > 0) && (
          <div class="record-pagination" key="pagination">
            <span class="small muted" role="status">
              {current
                ? `${current.operations.length ? filters.offset + 1 : 0}–${filters.offset + current.operations.length} / ${current.total} 条`
                : ""}
            </span>
            <div class="actions">
              <button
                type="button"
                aria-disabled={previousDisabled}
                onClick={() => {
                  if (!previousDisabled)
                    setFilters((value) => ({ ...value, offset: Math.max(0, value.offset - 50) }));
                }}
              >
                上一页
              </button>
              <button
                type="button"
                aria-disabled={nextDisabled}
                onClick={() => {
                  if (!nextDisabled) setFilters((value) => ({ ...value, offset: value.offset + 50 }));
                }}
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
