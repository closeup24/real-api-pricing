import { useEffect, useRef, useState } from "react";
import { Calculator, ChartScatter } from "@phosphor-icons/react";
import UpstreamApp from "./UpstreamApp";
import AACosts from "./AACosts";
import "./aa-costs.css";

type WorkspaceView = "tokens" | "aa";

function currentView(): WorkspaceView {
  return new URLSearchParams(location.search).get("view") === "aa" ? "aa" : "tokens";
}

export default function App() {
  const [view, setView] = useState<WorkspaceView>(currentView);
  const tokenTab = useRef<HTMLButtonElement>(null);
  const aaTab = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const update = () => setView(currentView());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  function select(next: WorkspaceView, focus = false) {
    setView(next);
    const url = new URL(location.href);
    if (next === "aa") url.searchParams.set("view", "aa");
    else url.searchParams.delete("view");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    if (focus) (next === "aa" ? aaTab : tokenTab).current?.focus();
  }

  return (
    <>
      <div className="aa-workspace-nav">
        <div role="tablist" aria-label="Разделы Real API Pricing">
          {([
            ["tokens", "Цены токенов", ChartScatter, tokenTab],
            ["aa", "Задачи AA", Calculator, aaTab],
          ] as const).map(([key, label, Icon, ref]) => (
            <button key={key} ref={ref} id={`workspace-${key}-tab`} role="tab" type="button"
              aria-controls={`workspace-${key}`} aria-selected={view === key} tabIndex={view === key ? 0 : -1}
              onClick={() => select(key)} onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                select(event.key === "Home" ? "tokens" : event.key === "End" ? "aa" : key === "aa" ? "tokens" : "aa", true);
              }}>
              <Icon size={17} />{label}
            </button>
          ))}
        </div>
        <a href="/aa-archive/report.html">Предыдущие расчёты и оценка API ↗</a>
      </div>
      <div id="workspace-tokens" role="tabpanel" aria-labelledby="workspace-tokens-tab" hidden={view !== "tokens"}><UpstreamApp /></div>
      <div id="workspace-aa" role="tabpanel" aria-labelledby="workspace-aa-tab" hidden={view !== "aa"}><AACosts /></div>
    </>
  );
}
