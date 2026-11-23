// T13 — 웹 UI. taskId(URL ?task=) 기준: 없으면 시작 화면(StartScreen), 있으면 작업 화면.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearTimeline,
  closeTask,
  commitDone,
  fetchState,
  relaunch,
  saveWindowSize,
  setEndpoint,
  type NotifyPayload,
  type Role,
  type State,
  type Task,
} from "./api";
import StartScreen from "./components/StartScreen";
import TaskCard from "./components/TaskCard";
import Timeline from "./components/Timeline";
import "./App.css";

// relaunch — 배정된 세션 상태 기준 (W4).
function canRelaunch(state: State | null, role: Role): boolean {
  const task = state?.task;
  if (!task) return false;
  if ((role === "verifier" || role === "coder") && task.folder === null) return false;
  const s = state.assignedState[role];
  if (s === null || s === "detached" || s === "idle" || s === "working") return true;
  if (role === "planner" && task.folder === null && s === "unbound") return true;
  return false;
}

// 이어서 띄우기 — 서버 조건과 같음 (S-9).
function canResume(state: State | null, role: Role): boolean {
  const task = state?.task;
  if (!task || task.folder === null) return false;
  const key = task.assigned[role];
  if (!key) return false;
  const s = state.assignedState[role];
  if (s !== "detached" && s !== "idle" && s !== "working") return false;
  return state.sessions[key]?.resumable === true;
}
// 모델 선택 — 세션 창이 열려 있으면 안 됨 (서버 D3 조건과 같음).
function canSelectEndpoint(state: State | null, role: Role): boolean {
  const task = state?.task;
  if (!task) return false;
  const s = state.assignedState[role];
  return s === null || s === "detached";
}

// 창 제목 — 작업 화면이면 `AISM - <프로젝트> - <폴더>`(폴더 없으면 `새 작업`), 아니면 `AISM`.
function windowTitle(task: Task | null | undefined, isTaskScreen: boolean): string {
  if (!isTaskScreen || !task) return "AISM";
  return `AISM - ${task.project} - ${task.folder ?? "새 작업"}`;
}

const ROLES = ["planner", "verifier", "coder"] as const;
const ROLE_LABEL: Record<Role, string> = { planner: "PLANNER", verifier: "VERIFIER", coder: "CODER" };

function App() {
  const [taskId, setTaskId] = useState<string | null>(() => new URLSearchParams(location.search).get("task"));
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const openTask = useCallback((id: string) => {
    history.replaceState(null, "", "?task=" + encodeURIComponent(id));
    setTaskId(id);
  }, []);
  const leaveTask = useCallback(() => {
    history.replaceState(null, "", location.pathname);
    setTaskId(null);
  }, []);

  // 첫 로드 — taskId 기준. 작업 화면에서 task null이면 시작 화면으로.
  useEffect(() => {
    fetchState(taskId)
      .then((s) => {
        setState(s);
        if (taskId && !s.task) leaveTask();
      })
      .catch((e) => setError(String(e)));
  }, [taskId, leaveTask]);

  // SSE — taskId 채널(작업) 또는 lobby(시작 화면). taskId 바뀌면 재연결.
  useEffect(() => {
    const url = taskId ? `/api/events?task=${encodeURIComponent(taskId)}` : "/api/events";
    const es = new EventSource(url);
    es.addEventListener("state", (e) => {
      try {
        const s = JSON.parse(e.data) as State;
        setState(s);
        if (taskId && !s.task) leaveTask();
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
  }, [taskId, onNotify, leaveTask]);

  // 창 크기 자동 저장 (M2 polish §3 E) — 닫을 때 sendBeacon, 크기 변경 1초 뒤 POST.
  useEffect(() => {
    const onHide = () => {
      try {
        navigator.sendBeacon("/api/ui/window", JSON.stringify({ width: window.outerWidth, height: window.outerHeight }));
      } catch {
        /* ignore */
      }
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void saveWindowSize(window.outerWidth, window.outerHeight).catch(() => {});
      }, 1000);
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("resize", onResize);
      if (timer) clearTimeout(timer);
    };
  }, []);

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

  const handleRelaunch = (role: Role, mode: "new" | "resume") => {
    if (!taskId) return;
    const s = state?.assignedState?.[role];
    const label = ROLE_LABEL[role];
    if (s === "working") {
      if (
        !window.confirm(
          `${label}이(가) 작업 중으로 보입니다. 창을 닫았거나 응답이 없을 때만 진행하세요. 진행하면 이전 창은 더 이상 자동으로 지시받지 않습니다.`,
        )
      )
        return;
    } else if (s === "idle" || s === "unbound") {
      if (
        !window.confirm(`이전 ${label} 창이 아직 열려 있다면 닫은 뒤 진행하세요. 이전 창은 더 이상 자동으로 지시받지 않습니다.`)
      )
        return;
    }
    void run(() => relaunch(taskId, role, mode));
  };
  const handleClose = () => {
    if (!taskId) return;
    if (!window.confirm("작업을 종료할까요? 모든 대기 중인 세션이 allow로 해제됩니다.")) return;
    void run(async () => {
      await closeTask(taskId);
      leaveTask();
    });
  };
  const handleClearTimeline = () => {
    if (!taskId) return;
    if (!window.confirm("타임라인을 비울까요? 화면에서만 지워지고 기록 파일(state/tasks/<id>/events.jsonl)은 그대로 남습니다.")) return;
    void run(() => clearTimeline(taskId));
  };
  const handleCommitDone = () => {
    if (!taskId) return;
    if (!window.confirm("커밋을 마쳤나요? 같은 프로젝트에서 기다리는 CODER가 구현을 시작합니다.")) return;
    void run(() => commitDone(taskId));
  };

  const isTaskScreen = taskId !== null;

  useEffect(() => {
    document.title = windowTitle(state?.task, isTaskScreen);
  }, [state?.task?.project, state?.task?.folder, isTaskScreen]);

  return (
    <div className="app" onClick={requestPermission}>
      {(!isTaskScreen || error) && (
        <header className="app-header">
          {!isTaskScreen && <h1>AISM</h1>}
          {error && <span className="error">{error}</span>}
        </header>
      )}

      {isTaskScreen ? (
        <>
          <TaskCard
            state={state}
            planDisplay={state ? state.assignedDisplay.planner : null}
            verifyDisplay={state ? state.assignedDisplay.verifier : null}
            coderDisplay={state ? state.assignedDisplay.coder : null}
          />

          <div className="controls">
            {ROLES.map((r) => (
              <div className="control-row" key={r}>
                <select
                  className="endpoint-select"
                  aria-label={`${ROLE_LABEL[r]} 모델 선택`}
                  title={
                    !canSelectEndpoint(state, r)
                      ? `${ROLE_LABEL[r]} 모델 선택 — 세션 창이 열려 있어 바꿀 수 없습니다`
                      : `${ROLE_LABEL[r]} 모델 선택`
                  }
                  value={state?.endpoints?.[r] ?? ""}
                  disabled={busy || !canSelectEndpoint(state, r)}
                  onChange={(e) => {
                    if (!taskId) return;
                    void run(() => setEndpoint(taskId, r, e.target.value));
                  }}
                >
                  {(state?.endpointNames ?? []).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => handleRelaunch(r, "new")} disabled={busy || !canRelaunch(state, r)}>
                  {ROLE_LABEL[r]} 다시 띄우기
                </button>
                <button type="button" onClick={() => handleRelaunch(r, "resume")} disabled={busy || !canResume(state, r)}>
                  {ROLE_LABEL[r]} 이어서 띄우기
                </button>
              </div>
            ))}
            <div className="control-row">
              {state?.task && state.projectInfo[state.task.project]?.git != null && (
                <button
                  type="button"
                  onClick={handleCommitDone}
                  disabled={busy || state.snapshot?.status !== "DONE" || state.task.commitDone}
                >
                  커밋 완료
                </button>
              )}
              <button type="button" onClick={handleClose} disabled={busy}>
                작업 종료
              </button>
            </div>
          </div>

          <Timeline events={state?.events ?? []} onClear={handleClearTimeline} disabled={busy} />
        </>
      ) : (
        <StartScreen state={state} busy={busy} run={run} onOpen={openTask} />
      )}
    </div>
  );
}

export default App;
