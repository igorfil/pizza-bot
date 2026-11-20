import { useState } from "react";
import { FleetConnectForm, FleetModule } from "./FleetModule.js";
import { useFleet } from "./use-fleet.js";

// Mounted only while the Fleet view is open, so the Model stream closes when you leave it.
export function FleetScreen() {
  const fleet = useFleet();
  const [editing, setEditing] = useState(false);

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
  return <FleetModule model={fleet.model} link={fleet.link} send={fleet.send} onEditConnection={() => setEditing(true)} />;
}
