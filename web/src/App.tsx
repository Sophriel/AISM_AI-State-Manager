// T13 — 웹 UI. 첫 로드 GET /api/state, 이후 EventSource('/api/events')로 갱신.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeTask,
  fetchState,
  newTask,
  relaunch,
  type NotifyPayload,
  type Role,
  type SessionState,
  type State,
} from "./api";
import TaskCard from "./components/TaskCard";
import Timeline from "./components/Timeline";
import "./App.css";

// 배지·relaunch 판단용 우선순위 (높을수록 "더 활성").
const PRIORITY: Record<string, number> = {
  parked: 6,
  working: 5,
  launching: 4,
  unbound: 3,
  idle: 2,
  detached: 1,
};

function topState(states: SessionState[]): string | null {
  if (states.length === 0) return null;
  return [...states].sort((a, b) => (PRIORITY[b] ?? 0) - (PRIORITY[a] ?? 0))[0];
}

// relaunch는 해당 역할 세션이 detached/없음일 때만.
function canRelaunch(states: SessionState[]): boolean {
  return states.every((s) => s === "detached"); // 빈 배열 → true
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);

  // WebAudio 0.2초 비프 (new Audio 대신).
  const beep = useCallback(() => {
    try {
      if (!audioRef.current) audioRef.current = new AudioContext();
      const ctx = audioRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch {
      /* 오디오 실패 무시 */
    }
  }, []);

  // notify → Notification + 비프. (타임라인은 state 갱신으로 자동 반영.)
  const onNotify = useCallback(
    (n: NotifyPayload) => {
      beep();
      if ("Notification" in window && Notification.permission === "granted") {
        try {
          new Notification(n.message);
        } catch {
          /* ignore */
        }
      }
    },
    [beep],
  );

  // 첫 로드.
  useEffect(() => {
    fetchState()
      .then((s) => {
        setState(s);
        setProject((p) => p || (s.activeTask ? s.activeTask.project : ""));
      })
      .catch((e) => setError(String(e)));
  }, []);

  // SSE.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("state", (e) => {
      try {
        setState(JSON.parse(e.data) as State);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("notify", (e) => {
      try {
        onNotify(JSON.parse(e.data) as NotifyPayload);
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [onNotify]);

  // 첫 클릭 시 Notification 권한 요청.
  const requestPermission = useCallback(() => {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, []);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleNewTask = () => {
    if (!project) return;
    void run(() => newTask(project));
  };
  const handleRelaunch = (role: Role) => void run(() => relaunch(role));
  const handleClose = () => {
    if (!window.confirm("작업을 종료할까요? 모든 대기 중인 세션이 allow로 해제됩니다.")) return;
    void run(() => closeTask());
  };

  const activeTask = state?.activeTask ?? null;
  const projects = state?.projects ?? [];

  const planStates = state
    ? Object.values(state.sessions)
        .filter((s) => s.role === "plan")
        .map((s) => s.state)
    : [];
  const verifyStates = state
    ? Object.values(state.sessions)
        .filter((s) => s.role === "verify")
        .map((s) => s.state)
    : [];

  const selectValue = activeTask ? activeTask.project : project;
  const planDisabled = busy || !canRelaunch(planStates);
  const verifyDisabled = busy || !canRelaunch(verifyStates);

  return (
    <div className="app" onClick={requestPermission}>
      <header className="app-header">
        <h1>AISM</h1>
        {error && <span className="error">{error}</span>}
      </header>

      <TaskCard state={state} planState={topState(planStates)} verifyState={topState(verifyStates)} />

      <div className="controls">
        <div className="control-group">
          <select
            value={selectValue}
            onChange={(e) => setProject(e.target.value)}
            disabled={!!activeTask || busy}
          >
            <option value="">프로젝트 선택</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleNewTask} disabled={!!activeTask || !project || busy}>
            새 작업
          </button>
        </div>
        <button type="button" onClick={() => handleRelaunch("plan")} disabled={planDisabled}>
          PLAN 다시 띄우기
        </button>
        <button type="button" onClick={() => handleRelaunch("verify")} disabled={verifyDisabled}>
          VERIFY 다시 띄우기
        </button>
        <button type="button" onClick={handleClose} disabled={busy || !activeTask}>
          작업 종료
        </button>
      </div>

      <Timeline events={state?.events ?? []} />
    </div>
  );
}

export default App;
