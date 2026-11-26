import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  taskDetailSchema,
  taskListSchema,
  type AdminOverview,
  type TaskEvent,
  type TaskView,
} from "@abridge/protocol";
import { api } from "../../lib/api.js";
import { Form, Modal } from "../../components/forms.js";
import { executionSteps } from "../tasks/trace.js";
import { taskLabels } from "./task-labels.js";

export type ChatDevice = AdminOverview["users"][number]["devices"][number];
const stoppable = ["approval", "queued", "running", "waiting"];

export function DeviceChat({
  device,
  close,
  changed,
}: {
  device: ChatDevice;
  close: () => void;
  changed: () => Promise<void>;
}) {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Retain the same key after an uncertain response, so retry cannot execute twice.
  const submission = useRef<{ prompt: string; request_id: string } | null>(null);
  const path = `/api/admin/devices/${encodeURIComponent(device.id)}/chat`;
  const refresh = useCallback(async () => {
    const result = await api(path, taskListSchema);
    setTasks(result.tasks);
    setError("");
    setLoading(false);
  }, [path]);
  useEffect(() => {
    let alive = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await api(path, taskListSchema);
        if (alive) {
          setTasks(result.tasks);
          setError("");
        }
      } catch (caught) {
        if (alive) setError(caught instanceof Error ? caught.message : "读取对话失败");
      } finally {
        if (alive) setLoading(false);
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path]);
  return (
    <Modal title="设备对话" close={close} className="admin-device-chat">
      <header class="admin-chat-target">
        <strong>{device.name}</strong>
        <span>
          <span class={`dot ${device.status}`} /> {device.status === "online" ? "在线" : "离线"}
          {device.paused ? " · 已暂停" : ""}
        </span>
        <small class="muted">{device.id}</small>
      </header>
      <p class="muted small">
        消息将交给此设备执行；设备所有人确认后排队。离线或暂停时等待设备恢复。关闭对话不会停止任务。
      </p>
      <div class="admin-chat-history" role="log" aria-label="设备对话记录">
        {loading && <p role="status">正在读取对话…</p>}
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        {!loading && !tasks.length && <p class="muted">描述你希望设备完成的事情。</p>}
        {tasks.map((task) => (
          <ChatMessage
            key={task.id}
            task={task}
            changed={async () => {
              await refresh();
              await changed();
            }}
          />
        ))}
      </div>
      <Form
        label="发送"
        onSubmit={async () => {
          const prompt = text.trim();
          if (!prompt) throw new Error("请输入消息");
          if (submission.current?.prompt !== prompt)
            submission.current = { prompt, request_id: crypto.randomUUID() };
          const result = await api(path, taskDetailSchema.pick({ task: true }), submission.current);
          setTasks((previous) => [...previous.filter((task) => task.id !== result.task.id), result.task]);
          setText("");
          submission.current = null;
          void changed();
        }}
      >
        <label class="field">
          <span>消息</span>
          <textarea
            name="prompt"
            value={text}
            onInput={(event) => setText(event.currentTarget.value)}
            required
            maxLength={4000}
            rows={3}
            placeholder="例如：打开时钟，查看明天的闹钟"
          />
        </label>
      </Form>
    </Modal>
  );
}

function ChatMessage({ task, changed }: { task: TaskView; changed: () => Promise<void> }) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void api(`/api/admin/tasks/${encodeURIComponent(task.id)}`, taskDetailSchema)
      .then((detail) => {
        if (alive) {
          setEvents(detail.events);
          setError("");
        }
      })
      .catch((caught) => {
        if (alive) setError(caught instanceof Error ? caught.message : "读取执行记录失败");
      });
    return () => {
      alive = false;
    };
  }, [task.id, task.updated_at, task.status]);
  const steps = executionSteps(events);
  const latest = steps.at(-1);
  return (
    <article class="admin-chat-message">
      <p class="admin-chat-prompt">{task.prompt}</p>
      <div class="admin-chat-progress" aria-live="polite">
        <span class={`task-status status-${task.status}`}>{taskLabels[task.status]}</span>
        {task.queue_position !== null && <span>队列第 {task.queue_position} 位</span>}
        {latest && (
          <p>
            {latest.tool || "执行进度"} · {latest.status}
          </p>
        )}
        {task.queue_blocked && <p>正在等待设备确认清理</p>}
        {task.status === "stopping" && <p>等待设备清理确认，后续任务继续排队。</p>}
        {task.result && <p class="admin-chat-result">{task.result}</p>}
        {task.error && <p class="error">{task.error}</p>}
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </div>
      {!!steps.length && (
        <details class="admin-step">
          <summary>执行记录 · {steps.length} 步</summary>
          {steps.map((step) => (
            <details class="admin-step" key={step.sequence}>
              <summary>
                {step.tool || "执行摘要"} · {step.status}
              </summary>
              {step.summary && <p>{step.summary}</p>}
              {step.arguments && (
                <>
                  <strong>工具参数</strong>
                  <pre>{step.arguments}</pre>
                </>
              )}
              {step.receipt && (
                <>
                  <strong>执行回执</strong>
                  <pre>{step.receipt}</pre>
                </>
              )}
              {step.image && (
                <img class="admin-step-image" src={step.image} alt={`第 ${step.sequence} 步执行截图`} />
              )}
            </details>
          ))}
        </details>
      )}
      {stoppable.includes(task.status) && (
        <Form
          label="停止"
          children={null}
          tone="danger"
          onSubmit={async () => {
            await api(
              `/api/admin/tasks/${encodeURIComponent(task.id)}/stop`,
              taskDetailSchema.pick({ task: true }),
              {},
            );
            await changed();
          }}
        />
      )}
    </article>
  );
}
