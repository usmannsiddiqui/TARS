// Every project at a glance: its state, when it was last prepared and its next step, and where a new
// project is added. Presentational: data and actions arrive as props.
import { preparedNote, type Honest, type ProjectSummary } from "./model";
import { formatWhen, NewProject, StateNote, StateTag } from "./ui";

export type ProjectsIndexProps = {
  /** null while projects are unavailable; `cloud` then says why. */
  projects: ProjectSummary[] | null;
  cloud?: Honest;
  focusProjectId?: string;
  onOpenProject(projectId: string): void;
  onCreateProject(name: string): Promise<void>;
};

export function ProjectsIndex({ projects, cloud, focusProjectId, onOpenProject, onCreateProject }: ProjectsIndexProps) {
  const prepared = projects?.filter((p) => p.prepared?.status === "ready" && p.prepared.work).length;
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Projects</h1>
        <p className="screen-sub">Each one keeps its own sources, memory and prepared work.</p>
        {projects && (
          <ul className="readout" aria-label="Projects now">
            <li>
              <span className="readout-key">Projects</span> {projects.length}
            </li>
            <li>
              <span className="readout-key">Prepared</span> {prepared}
            </li>
          </ul>
        )}
      </header>
      <div className="index-grid">
        <section className="block" aria-labelledby="index-h">
          <h2 id="index-h" className="block-title">
            All projects
          </h2>
          {projects === null ? (
            <StateNote state={cloud ?? { kind: "loading" }} />
          ) : projects.length === 0 ? (
            <StateNote state={{ kind: "empty", detail: "No projects yet. Add the first thing you are working on." }} />
          ) : (
            <div className="inner">
              <table className="index-table">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">State</th>
                    <th scope="col">Last prepared</th>
                    <th scope="col">Next step</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id}>
                      <th scope="row">
                        <button type="button" className="text-button go" onClick={() => onOpenProject(p.id)}>
                          {p.name}
                        </button>
                        {p.id === focusProjectId && <span className="sub-focus index-focus">Focus</span>}
                      </th>
                      <td>
                        <StateTag state={preparedNote(p)} />
                      </td>
                      <td className="num">{p.prepared?.updatedAt ? formatWhen(p.prepared.updatedAt) : <span className="quiet">Never</span>}</td>
                      <td>{p.prepared?.work?.nextAction ?? <span className="quiet">None yet</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {projects !== null && (
          <aside className="block">
            <NewProject onCreate={onCreateProject} compact />
          </aside>
        )}
      </div>
    </div>
  );
}
