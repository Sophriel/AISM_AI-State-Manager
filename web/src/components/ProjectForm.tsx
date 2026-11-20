// M3 §3 D — 프로젝트 추가 폼.
import { useState } from "react";
import type { NewProject } from "../api";

function ProjectForm({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (p: NewProject) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [plansDir, setPlansDir] = useState(".claude/plans");
  const [prot, setProt] = useState("");
  const [overlay, setOverlay] = useState("");
  const submit = () =>
    onSubmit({
      name: name.trim(),
      root: root.trim(),
      plansDir: plansDir.trim() || ".claude/plans",
      protectedPaths: prot.split(",").map((s) => s.trim()).filter((s) => s !== ""),
      ...(overlay.trim() ? { roleOverlay: overlay.trim() } : {}),
    });
  return (
    <div className="project-form">
      <label>이름 <input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>루트 경로 <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="C:/Users/.../MyRepo" /></label>
      <label>plans 폴더 <input value={plansDir} onChange={(e) => setPlansDir(e.target.value)} /></label>
      <label>보호 경로 <input value={prot} onChange={(e) => setProt(e.target.value)} placeholder="Source/**, Config/** (쉼표로 구분, 비워도 됨)" /></label>
      <label>역할 오버레이 파일 <input value={overlay} onChange={(e) => setOverlay(e.target.value)} placeholder="선택 — AISM 세션에만 덧붙는 지시 (프로젝트 루트 기준 경로)" /></label>
      <div className="control-row">
        <button type="button" onClick={submit} disabled={busy || !name.trim() || !root.trim()}>추가</button>
        <button type="button" onClick={onCancel}>취소</button>
      </div>
    </div>
  );
}

export default ProjectForm;
