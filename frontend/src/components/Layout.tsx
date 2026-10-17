import type { Layout as L } from "../store/layout";
import { Pane } from "./Pane";

/** Renders the split tree with flexbox (dockview can replace this later behind the same tree). */
export function LayoutView({ node }: { node: L }) {
  if (node.type === "pane") return <Pane id={node.id} />;
  return (
    <div className={`flex h-full min-h-0 w-full min-w-0 gap-px ${node.dir === "row" ? "flex-row" : "flex-col"}`}>
      {node.children.map((c) => (
        <div key={c.type === "pane" ? c.id : JSON.stringify(c)} className="flex min-h-0 min-w-0 flex-1">
          <LayoutView node={c} />
        </div>
      ))}
    </div>
  );
}
