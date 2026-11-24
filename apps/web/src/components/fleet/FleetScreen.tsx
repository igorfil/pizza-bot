import { useState } from "react";
import { FleetConnectForm, FleetModule } from "./FleetModule.js";
import type { Fleet } from "./use-fleet.js";
import { useFleetClock } from "./use-fleet-clock.js";

export function FleetScreen({ fleet }: { fleet: Fleet }) {
  const [editing, setEditing] = useState(false);
  const model = useFleetClock(fleet.model);

  if (editing || fleet.link.kind === "unconfigured" || fleet.link.kind === "rejected") {
    return (
      <FleetConnectForm
        initial={fleet.connection}
        error={fleet.link.kind === "rejected" ? fleet.link.error : undefined}
        onConnect={(connection) => {
          fleet.connect(connection);
          setEditing(false);
        }}
        onCancel={editing && fleet.link.kind !== "unconfigured" ? () => setEditing(false) : undefined}
      />
    );
  }
  return <FleetModule model={model} link={fleet.link} send={fleet.send} onEditConnection={() => setEditing(true)} />;
}
