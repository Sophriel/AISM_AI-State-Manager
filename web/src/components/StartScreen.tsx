// T9 — 시작 화면. 프로젝트 선택·추가·제외·새 작업, 진행 중 작업(unattached) 이어서 보기.
import { useState } from "react";
import { addProject, newTask, removeProject, type NewProject, type State } from "../api";
import ProjectForm from "./ProjectForm";

interface Props {
  state: State | null;
  busy: boolean;
  run: (fn: () => Promise<void>) => void;
  onOpen: (id: string) => void;
}

function StartScreen({ state, busy, run, onOpen }: Props) {
  const [project, setProject] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const projects = state?.projects ?? [];
  const projectInfo = state?.projectInfo ?? {};
  const unattached = state?.unattached ?? [];

  const projectLabel = (p: string) => {
    const info = projectInfo[p];
    if (!info) return p;
    if (!info.git) return `${p} (폴더)`;
    return info.git.branch ? `${p} (git: ${info.git.branch})` : `${p} (git)`;
  };

  const handleNewTask = () => {
    if (!project) return;
    void run(async () => {
      const id = await newTask(project);
      onOpen(id);
    });
  };

  const handleAddProject = (p: NewProject) => {
    void run(async () => {
      await addProject(p);
      setShowAdd(false);
      if (!project) setProject(p.name);
    });
  };

  const handleRemoveProject = (name: string) => {
    if (!window.confirm(`'${name}' 프로젝트를 목록에서 제외할까요? 설정 파일에서만 빠지고 폴더와 파일은 그대로 남습니다.`)) return;
    void run(async () => {
      try {
        await removeProject(name);
        setProject("");
      } catch (e) {
        const msg = String(e);
        if (msg.includes("409") && msg.includes("project in use")) {
          throw new Error("이 프로젝트에 진행 중인 작업이 있어 제외할 수 없습니다 — 그 작업을 먼저 종료하세요.");
        }
        throw e;
      }
    });
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <>
      {showAdd && <ProjectForm busy={busy} onSubmit={handleAddProject} onCancel={() => setShowAdd(false)} />}

      <div className="controls">
        <div className="control-row">
          <select value={project} onChange={(e) => setProject(e.target.value)} disabled={busy}>
            <option value="">프로젝트 선택</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {projectLabel(p)}
              </option>
            ))}
          </select>
          {project === "" ? (
            <button type="button" onClick={() => setShowAdd(true)} disabled={busy}>
              프로젝트 추가
            </button>
          ) : (
            <button type="button" onClick={() => handleRemoveProject(project)} disabled={busy}>
              프로젝트 제외
            </button>
          )}
          <button type="button" onClick={handleNewTask} disabled={!project || busy}>
            새 작업
          </button>
        </div>
      </div>

      <div className="start-screen">
        <h2>진행 중 작업 이어서 보기</h2>
        {unattached.length === 0 ? (
          <p className="empty">진행 중 작업이 없습니다</p>
        ) : (
          <ul className="task-list">
            {unattached.map((t) => (
              <li key={t.id} onClick={() => onOpen(t.id)}>
                <span className="task-project">{t.project}</span>
                <span className="task-folder">{t.folder ?? "새 작업"}</span>
                <span className="task-time">시작 {formatTime(t.startedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export default StartScreen;
